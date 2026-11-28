-- Keep the cursor separate from an in-flight delivery. The attempt number
-- fences completion/failure writes from workers whose lease was reclaimed.
create or replace function public.claim_subscription_delivery(
  p_event_id text, p_event_type text, p_subscription_id text, p_event_created_at timestamptz
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_event public.subscription_webhook_events%rowtype;
  v_attempt integer;
begin
  if p_subscription_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('subscription-delivery:' || p_subscription_id, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('subscription-event:' || p_event_id, 0));
  select * into v_event from public.subscription_webhook_events where event_id = p_event_id for update;
  if found then
    if v_event.status = 'processed' then return jsonb_build_object('status', 'duplicate'); end if;
    if v_event.status = 'processing' and v_event.received_at > clock_timestamp() - interval '5 minutes' then
      return jsonb_build_object('status', 'in_progress');
    end if;
  end if;
  -- Only an active lease serializes other events. Failed/stalled deliveries
  -- remain recoverable by resending their original provider event ID. They
  -- cannot hold newer events hostage after the lease ends.
  if p_subscription_id is not null and exists (
    select 1 from public.subscription_webhook_events e
    where e.razorpay_subscription_id = p_subscription_id and e.event_id <> p_event_id
      and e.status = 'processing' and e.received_at > clock_timestamp() - interval '5 minutes'
  ) then return jsonb_build_object('status', 'in_progress'); end if;

  insert into public.subscription_webhook_events as e
    (event_id, event_type, razorpay_subscription_id, event_created_at, status, received_at, attempts)
  values (p_event_id, p_event_type, p_subscription_id, p_event_created_at, 'processing', clock_timestamp(), 1)
  on conflict (event_id) do update set status = 'processing', received_at = clock_timestamp(),
    attempts = coalesce(e.attempts, 0) + 1
  returning attempts into v_attempt;
  return jsonb_build_object('status', 'claimed', 'attempt', v_attempt);
end $$;

create or replace function public.finish_subscription_delivery(
  p_event_id text, p_attempt integer, p_succeeded boolean, p_result text
) returns boolean language plpgsql set search_path = public, pg_temp as $$
declare v_event public.subscription_webhook_events%rowtype;
begin
  update public.subscription_webhook_events
  set status = case when p_succeeded then 'processed' else 'failed' end,
      processed_at = case when p_succeeded then clock_timestamp() else null end,
      last_error = case when p_succeeded then null else left(p_result, 1000) end,
      result = left(p_result, 1000)
  where event_id = p_event_id and attempts = p_attempt and status = 'processing'
  returning * into v_event;
  if not found then return false; end if;
  if p_succeeded and v_event.razorpay_subscription_id is not null and v_event.event_created_at is not null then
    insert into public.subscription_event_cursors as c
      (razorpay_subscription_id, last_event_created_at, updated_at)
    values (v_event.razorpay_subscription_id, v_event.event_created_at, clock_timestamp())
    on conflict (razorpay_subscription_id) do update set
      last_event_created_at = greatest(c.last_event_created_at, excluded.last_event_created_at),
      updated_at = excluded.updated_at;
  end if;
  return true;
end $$;

revoke all on function public.claim_subscription_delivery(text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.finish_subscription_delivery(text,integer,boolean,text) from public, anon, authenticated;
grant execute on function public.claim_subscription_delivery(text,text,text,timestamptz) to service_role;
grant execute on function public.finish_subscription_delivery(text,integer,boolean,text) to service_role;

-- Entitlements have their own cursor, recorded atomically with the tenant
-- change. Neither non-financial no-ops nor failed receipt work advance it.
alter table public.subscription_webhook_events
  add column subscription_state_applied boolean not null default false,
  add column subscription_state_tenant_id uuid;
update public.subscription_webhook_events set subscription_state_applied = true
where status = 'processed' and (
  (event_type = 'subscription.charged' and result like 'renewed on %') or
  (event_type = 'subscription.activated' and result like 'activated on %') or
  (event_type, result) in (('subscription.cancelled','cancelled'),('subscription.completed','completed'),
    ('subscription.paused','paused'),('subscription.pending','subscription.pending'),
    ('subscription.halted','subscription.halted'),('subscription.resumed','resumed'))
);
update public.subscription_webhook_events e set subscription_state_tenant_id = t.id
from public.tenants t
where e.subscription_state_applied and e.razorpay_subscription_id = t.razorpay_subscription_id;
create index subscription_webhook_applied_state_idx
  on public.subscription_webhook_events (razorpay_subscription_id, event_created_at desc)
  where subscription_state_applied;
create index subscription_webhook_tenant_state_idx
  on public.subscription_webhook_events (subscription_state_tenant_id, event_created_at desc)
  where subscription_state_applied;

-- Razorpay timestamps have second precision. Prefer the protective state on
-- ties (e.g. completion over an equally-timed charge).
create function public.subscription_delivery_state_rank(p_type text)
returns integer language sql immutable set search_path = public, pg_temp as $$
  select case p_type when 'subscription.completed' then 8 when 'subscription.cancelled' then 7
    when 'subscription.halted' then 6 when 'subscription.paused' then 5 when 'subscription.pending' then 4
    when 'subscription.resumed' then 3 when 'subscription.charged' then 2 when 'subscription.activated' then 1 else 0 end;
$$;
revoke all on function public.subscription_delivery_state_rank(text) from public, anon, authenticated;
grant execute on function public.subscription_delivery_state_rank(text) to service_role;

create function public.apply_subscription_delivery_state(
  p_event_id text, p_attempt integer, p_tenant uuid, p_expected_subscription_id text,
  p_plan text, p_interval text, p_start timestamptz, p_end timestamptz
) returns text language plpgsql set search_path = public, pg_temp as $$
declare
  v_event public.subscription_webhook_events%rowtype;
  v_link text;
  v_status text;
  v_renewal_status text;
  v_can_link boolean;
begin
  select * into v_event from public.subscription_webhook_events
    where event_id = p_event_id and status = 'processing' and attempts = p_attempt for update;
  if not found or v_event.received_at <= clock_timestamp() - interval '5 minutes' then return 'lost_claim'; end if;
  if v_event.razorpay_subscription_id is null or v_event.event_created_at is null then return 'superseded'; end if;
  select razorpay_subscription_id into v_link from public.tenants where id = p_tenant for update;
  if not found or v_link is distinct from p_expected_subscription_id then return 'link_changed'; end if;
  if exists (select 1 from public.subscription_webhook_events e
    where (e.razorpay_subscription_id = v_event.razorpay_subscription_id or e.subscription_state_tenant_id = p_tenant)
      and e.subscription_state_applied
      and e.event_id <> p_event_id and (e.event_created_at, public.subscription_delivery_state_rank(e.event_type), e.event_id)
        > (v_event.event_created_at, public.subscription_delivery_state_rank(v_event.event_type), p_event_id))
  then return 'superseded'; end if;

  v_can_link := v_event.event_type in ('subscription.activated','subscription.charged');
  if not v_can_link and v_link is distinct from v_event.razorpay_subscription_id then return 'superseded'; end if;
  if v_event.subscription_state_applied then return 'applied'; end if;
  v_status := case v_event.event_type when 'subscription.completed' then 'expired'
    when 'subscription.cancelled' then 'cancelled' when 'subscription.paused' then 'paused'
    when 'subscription.halted' then 'past_due' when 'subscription.pending' then 'pending'
    when 'subscription.activated' then 'active' when 'subscription.charged' then 'active'
    when 'subscription.resumed' then 'active' end;
  if v_status is null then return 'superseded'; end if;

  update public.tenants t set
    subscription_status = v_status,
    plan = case when v_can_link then coalesce(p_plan, t.plan) else t.plan end,
    subscription_plan = case when v_can_link then coalesce(p_plan, t.subscription_plan) else t.subscription_plan end,
    billing_interval = case when v_can_link then coalesce(p_interval, t.billing_interval) else t.billing_interval end,
    razorpay_subscription_id = case when v_can_link then v_event.razorpay_subscription_id else t.razorpay_subscription_id end,
    subscription_started_at = case when v_can_link then coalesce(p_start, t.subscription_started_at) else t.subscription_started_at end,
    current_period_end = case when v_can_link and v_link is distinct from v_event.razorpay_subscription_id then p_end
      when v_can_link or v_event.event_type = 'subscription.resumed' then greatest(p_end, t.current_period_end)
      else t.current_period_end end,
    cancel_at_period_end = case when v_event.event_type = 'subscription.cancelled' then true
      when v_event.event_type in ('subscription.completed','subscription.activated','subscription.resumed') then false
      else t.cancel_at_period_end end
  where t.id = p_tenant;

  v_renewal_status := case v_event.event_type when 'subscription.completed' then 'mandate_expired'
    when 'subscription.cancelled' then 'mandate_cancelled' when 'subscription.halted' then 'mandate_halted'
    when 'subscription.pending' then 'mandate_halted' end;
  if v_renewal_status is not null then
    update public.subscription_payments set renewal_status = v_renewal_status
    where tenant_id = p_tenant and razorpay_subscription_id = v_event.razorpay_subscription_id and renewal_status = 'scheduled';
  end if;
  update public.subscription_webhook_events set subscription_state_applied = true, subscription_state_tenant_id = p_tenant
  where event_id = p_event_id;
  return 'applied';
end $$;
revoke all on function public.apply_subscription_delivery_state(text,integer,uuid,text,text,text,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.apply_subscription_delivery_state(text,integer,uuid,text,text,text,timestamptz,timestamptz) to service_role;

-- These fields are deliberately not backfilled from order/collection dates.
alter table public.check_payments add column if not exists reversed_at timestamptz;
alter table public.orders add column if not exists reversed_at timestamptz;

create or replace function public.stamp_check_payment_reversal()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status = 'VOID' and old.status is distinct from 'VOID' then
    new.reversed_at := clock_timestamp();
  else
    new.reversed_at := old.reversed_at;
  end if;
  return new;
end $$;

create or replace function public.stamp_order_reversal()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if lower(new.payment_status) = 'refunded' and lower(old.payment_status) is distinct from 'refunded' then
    new.reversed_at := clock_timestamp();
  else
    new.reversed_at := old.reversed_at;
  end if;
  return new;
end $$;

create trigger stamp_check_payment_reversal before update on public.check_payments
  for each row execute function public.stamp_check_payment_reversal();
create trigger stamp_order_reversal before update on public.orders
  for each row execute function public.stamp_order_reversal();
revoke all on function public.stamp_check_payment_reversal() from public, anon, authenticated;
revoke all on function public.stamp_order_reversal() from public, anon, authenticated;
revoke execute on function public.tenant_timezone(uuid) from public, anon, authenticated;
grant execute on function public.tenant_timezone(uuid) to service_role;

-- Close only a persisted sitting. Both new live orders and closing lock its
-- row, so a concurrent checkout cannot enter between the sibling check and
-- the state change.
create or replace function public.guard_new_order_sitting()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_status text;
begin
  if new.table_session_id is null or new.status in ('COMPLETED','CANCELLED','REJECTED') then return new; end if;
  if tg_op = 'UPDATE' and new.table_session_id is not distinct from old.table_session_id then return new; end if;
  select status into v_status from public.table_sessions
  where id = new.table_session_id and tenant_id = new.tenant_id for update;
  if v_status is null or v_status not in ('ACTIVE','PENDING_ACTIVATION') then
    raise exception 'SESSION_ENDED' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger guard_new_order_sitting before insert or update of table_session_id on public.orders
  for each row execute function public.guard_new_order_sitting();
revoke all on function public.guard_new_order_sitting() from public, anon, authenticated;

create or replace function public.close_completed_order_sitting(p_tenant uuid, p_session uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare
  v_session public.table_sessions%rowtype;
  v_closed boolean := false;
  v_settlement jsonb;
begin
  select * into v_session from public.table_sessions
  where id = p_session and tenant_id = p_tenant and status in ('ACTIVE', 'ENDED') for update;
  if not found then return false; end if;
  if exists (select 1 from public.orders where tenant_id = p_tenant and table_session_id = p_session
    and status not in ('COMPLETED','CANCELLED','REJECTED')) then return false; end if;
  if v_session.status = 'ACTIVE' then
    update public.table_sessions set status = 'ENDED', ended_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = p_session and tenant_id = p_tenant;
    v_closed := true;
  elsif not exists (
    -- Repair earlier split writes, without moving the timestamp of an
    -- already-unsettled check on every order-completion retry.
    select 1 from public.table_checks c where c.tenant_id = p_tenant and c.status = 'OPEN'
      and (c.session_id = p_session or c.anchor_session_id = p_session or exists (
        select 1 from public.orders o where o.tenant_id = p_tenant and o.table_session_id = p_session and o.check_id = c.id
      ))
  ) then return false;
  end if;

  v_settlement := public.settle_check_on_session_end(p_tenant, v_session.table_id, null, p_session);
  if (v_settlement->>'ok')::boolean is distinct from true then
    raise exception 'Completed sitting bill could not be settled' using detail = v_settlement::text;
  end if;
  return v_closed;
end $$;
revoke all on function public.close_completed_order_sitting(uuid,uuid) from public, anon, authenticated;
grant execute on function public.close_completed_order_sitting(uuid,uuid) to service_role;
