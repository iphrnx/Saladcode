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
  elsif p_subscription_id is not null and p_event_created_at is not null
    and p_event_type in ('subscription.paused','subscription.pending','subscription.halted','subscription.resumed')
    and exists (
      select 1 from public.subscription_webhook_events e
      where e.razorpay_subscription_id = p_subscription_id and e.status = 'processed'
        and e.event_created_at > p_event_created_at
        and e.event_type in ('subscription.paused','subscription.pending','subscription.halted','subscription.resumed','subscription.cancelled','subscription.completed','subscription.activated','subscription.charged')
    ) then
    -- Only a new, non-financial status notification can be superseded. Never
    -- discard an event we already started, or a charge or refund.
    insert into public.subscription_webhook_events
      (event_id, event_type, razorpay_subscription_id, event_created_at, status, processed_at, result)
    values (p_event_id, p_event_type, p_subscription_id, p_event_created_at, 'processed', clock_timestamp(), 'superseded status');
    return jsonb_build_object('status', 'duplicate');
  end if;
  -- Do not start a newer subscription transition while an admitted earlier
  -- delivery is unfinished. Razorpay receives a retryable response instead.
  if p_subscription_id is not null and exists (
    select 1 from public.subscription_webhook_events e
    where e.razorpay_subscription_id = p_subscription_id and e.event_id <> p_event_id
      and (e.status = 'processing' and e.received_at > clock_timestamp() - interval '5 minutes'
        or (e.status in ('processing', 'failed') and e.event_created_at is not null
          and (p_event_created_at is null or (e.event_created_at, e.event_id) < (p_event_created_at, p_event_id))))
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
begin
  perform 1 from public.table_sessions where id = p_session and tenant_id = p_tenant and status = 'ACTIVE' for update;
  if not found then return false; end if;
  if exists (select 1 from public.orders where tenant_id = p_tenant and table_session_id = p_session
    and status not in ('COMPLETED','CANCELLED','REJECTED')) then return false; end if;
  update public.table_sessions set status = 'ENDED', ended_at = clock_timestamp()
  where id = p_session and tenant_id = p_tenant;
  return found;
end $$;
revoke all on function public.close_completed_order_sitting(uuid,uuid) from public, anon, authenticated;
grant execute on function public.close_completed_order_sitting(uuid,uuid) to service_role;
