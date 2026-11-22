-- ============================================================================
-- Migration: 20261122000001_fix_full_settlement_invoice_location_analytics.sql
-- Description: Comprehensive forward correction for PR #5:
--              1. Reuses existing finalization logic so checks reach PAID with
--                 an allocated invoice, completed orders, and closed sessions.
--              2. Preserves invoice allocation in finalize_table_check even when
--                 a check was previously marked PAID without an invoice.
--              3. Persists sale location in both Cash (settle_check_cash_tx) and
--                 UPI/Card (record_check_payment & finalize_table_check) paths
--                 across Dine-in, Takeaway, and Delivery.
--              4. Corrects historical orders.paid_at to use verified full-settlement
--                 ledger records (cumulative payments reaching total) instead of
--                 unverified MAX(created_at), preserving verified legacy closures
--                 and leaving unverifiable timestamps unset.
--              5. Preserves independent diner sessions at the same table.
-- ============================================================================

-- 1. Ensure location_id columns and indexes exist
alter table public.orders
  add column if not exists paid_at timestamptz,
  add column if not exists location_id uuid references public.locations(id) on delete set null;

alter table public.table_checks
  add column if not exists location_id uuid references public.locations(id) on delete set null;

alter table public.check_payments
  add column if not exists location_id uuid references public.locations(id) on delete set null;

create index if not exists idx_orders_tenant_paid_at
  on public.orders (tenant_id, paid_at desc)
  where paid_at is not null;

create index if not exists idx_orders_tenant_location
  on public.orders (tenant_id, location_id);

create index if not exists idx_table_checks_tenant_location
  on public.table_checks (tenant_id, location_id);

create index if not exists idx_check_payments_tenant_location
  on public.check_payments (tenant_id, location_id);

-- 2. Enhanced complete_paid_check_orders ensuring paid_at is set
create or replace function public.complete_paid_check_orders(p_tenant uuid, p_check uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer;
begin
  with done as (
    update public.orders
       set status = 'COMPLETED',
           payment_status = 'PAID',
           paid_at = coalesce(paid_at, now()),
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
     where tenant_id = p_tenant
       and check_id = p_check
       and status in ('PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED')
     returning 1
  )
  select count(*) into v_count from done;
  return v_count;
end $function$;

revoke execute on function public.complete_paid_check_orders(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_paid_check_orders(uuid, uuid) to service_role;

-- 3. Update public.finalize_table_check
-- Allocates invoice, completes orders, ends check sessions, and persists durable location.
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
  v_target_session uuid := null;
  v_location uuid := null;
  v_is_staff boolean := false;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Resolve target session id
  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is null then
    select table_session_id into v_target_session
      from public.orders
     where check_id = p_check and table_session_id is not null
     limit 1;
  end if;

  -- Resolve verified sale location:
  -- Priority 1: Table linked to check (Dine-in)
  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  -- Priority 2: Check's existing location
  if v_location is null and v_check.location_id is not null then
    v_location := v_check.location_id;
  end if;

  -- Priority 3: Orders location or orders table location
  if v_location is null then
    select location_id into v_location
      from public.orders
     where check_id = p_check and location_id is not null
     limit 1;
  end if;

  if v_location is null then
    select t.location_id into v_location
      from public.orders o
      join public.tables t on t.id = o.table_id
     where o.check_id = p_check and t.location_id is not null
     limit 1;
  end if;

  -- Priority 4: Staff actor location for tableless orders (Takeaway / Delivery)
  if p_actor is not null then
    select exists (select 1 from public.staff where id = p_actor and tenant_id = p_tenant) into v_is_staff;
    if v_location is null and v_is_staff then
      select location_id into v_location
        from public.staff
       where id = p_actor and tenant_id = p_tenant;
    end if;
  end if;

  -- Handle check already marked PAID
  if v_check.status = 'PAID' then
    -- Self-heal: If invoice_number was missing, allocate it now
    if v_check.invoice_number is null then
      insert into public.check_invoice_counters (tenant_id)
      values (p_tenant)
      on conflict (tenant_id) do nothing;

      update public.check_invoice_counters
         set last_seq = last_seq + 1,
             updated_at = now()
       where tenant_id = p_tenant
      returning last_seq into v_seq;

      v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

      update public.table_checks
         set invoice_number = v_invoice,
             invoice_date = coalesce(invoice_date, now()),
             location_id = coalesce(location_id, v_location),
             updated_at = now()
       where id = p_check;

      v_check.invoice_number := v_invoice;
    else
      v_invoice := v_check.invoice_number;
    end if;

    -- Ensure location is persisted on check and orders
    if v_location is not null then
      update public.table_checks
         set location_id = coalesce(location_id, v_location)
       where id = p_check and location_id is null;

      update public.orders
         set location_id = coalesce(location_id, v_location)
       where check_id = p_check and location_id is null;
    end if;

    -- Ensure orders are completed
    perform public.complete_paid_check_orders(p_tenant, p_check);

    -- Ensure all bound sessions for this check are ended
    update public.table_sessions
       set status = 'ENDED',
           ended_at = coalesce(ended_at, now()),
           updated_at = now()
     where id in (
       select v_check.session_id where v_check.session_id is not null
       union
       select v_check.anchor_session_id where v_check.anchor_session_id is not null
       union
       select o.table_session_id from public.orders o where o.check_id = p_check and o.table_session_id is not null
       union
       select v_target_session where v_target_session is not null
     )
     and tenant_id = p_tenant
     and status = 'ACTIVE';

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', v_target_session,
      'closedAt', v_check.closed_at
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  select
    coalesce(sum(items_total), 0) as subtotal,
    coalesce(sum(discount), 0)    as discount,
    coalesce(sum(tax), 0)         as tax,
    coalesce(sum(service_charge), 0) as service_charge,
    coalesce(sum(total), 0)       as total
  into v_totals
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  if v_totals.total <= 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + 0.005 < v_totals.total then
    raise exception 'UNPAID:%', round((v_totals.total - v_paid)::numeric, 2)::text using errcode = 'P0001';
  end if;

  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  update public.table_checks
     set status = 'PAID',
         closed_at = coalesce(closed_at, now()),
         unsettled_at = null,
         invoice_number = v_invoice,
         invoice_date = coalesce(invoice_date, now()),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_paid,
         session_id = coalesce(session_id, v_target_session),
         anchor_session_id = coalesce(anchor_session_id, v_target_session),
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  update public.orders
     set location_id = coalesce(location_id, v_location)
   where check_id = p_check and location_id is null;

  -- End ALL sessions bound to this check (keeping other table sessions independent)
  update public.table_sessions
     set status = 'ENDED',
         ended_at = coalesce(ended_at, now()),
         updated_at = now()
   where id in (
     select v_check.session_id where v_check.session_id is not null
     union
     select v_check.anchor_session_id where v_check.anchor_session_id is not null
     union
     select o.table_session_id from public.orders o where o.check_id = p_check and o.table_session_id is not null
     union
     select v_target_session where v_target_session is not null
   )
   and tenant_id = p_tenant
   and status = 'ACTIVE';

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_paid,
    'outstanding', 0,
    'completedOrders', v_completed,
    'endedSessionId', v_target_session,
    'closedAt', now()
  );
end $function$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- 4. Update public.settle_check_cash_tx
-- Persists durable location_id for cash sales across Dine-in, Takeaway, and Delivery.
create or replace function public.settle_check_cash_tx(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null,
  p_idempotency_key text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks%rowtype;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_current_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_payment_id uuid;
  v_completed integer;
  v_target_session uuid;
  v_existing_payment public.check_payments%rowtype;
  v_is_profile boolean := false;
  v_is_staff boolean := false;
  v_location uuid := null;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_actor is not null then
    select exists (select 1 from public.profiles where id = p_actor) into v_is_profile;
    select exists (select 1 from public.staff where id = p_actor and tenant_id = p_tenant) into v_is_staff;
  end if;

  -- Resolve durable sale location
  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  if v_location is null and v_check.location_id is not null then
    v_location := v_check.location_id;
  end if;

  if v_location is null then
    select location_id into v_location
      from public.orders
     where check_id = p_check and location_id is not null
     limit 1;
  end if;

  if v_location is null then
    select t.location_id into v_location
      from public.orders o
      join public.tables t on t.id = o.table_id
     where o.check_id = p_check and t.location_id is not null
     limit 1;
  end if;

  if v_location is null and v_is_staff then
    select location_id into v_location
      from public.staff
     where id = p_actor and tenant_id = p_tenant;
  end if;

  if v_check.status = 'PAID' then
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;

    -- Ensure missing invoice or location is resolved
    if v_check.invoice_number is null then
      insert into public.check_invoice_counters (tenant_id)
      values (p_tenant)
      on conflict (tenant_id) do nothing;

      update public.check_invoice_counters
         set last_seq = last_seq + 1,
             updated_at = now()
       where tenant_id = p_tenant
      returning last_seq into v_seq;

      v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

      update public.table_checks
         set invoice_number = v_invoice,
             invoice_date = coalesce(invoice_date, now()),
             location_id = coalesce(location_id, v_location),
             updated_at = now()
       where id = p_check;

      v_check.invoice_number := v_invoice;
    else
      v_invoice := v_check.invoice_number;
    end if;

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_invoice,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', coalesce(v_check.session_id, v_check.anchor_session_id),
      'paymentId', v_payment_id,
      'closedAt', v_check.closed_at
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  select
    coalesce(sum(items_total), 0) as subtotal,
    coalesce(sum(discount), 0)    as discount,
    coalesce(sum(tax), 0)         as tax,
    coalesce(sum(service_charge), 0) as service_charge,
    coalesce(sum(total), 0)       as total
  into v_totals
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  if v_totals.total <= 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_current_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_totals.total - v_current_paid);

  if v_outstanding > 0 then
    if p_idempotency_key is not null then
      select * into v_existing_payment
        from public.check_payments
       where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED'
       limit 1;
      if found then
        v_payment_id := v_existing_payment.id;
      end if;
    end if;

    if v_payment_id is null then
      insert into public.check_payments (
        tenant_id, check_id, amount, method, idempotency_key,
        created_by, staff_id, location_id, status, note, created_at
      ) values (
        p_tenant, p_check, v_outstanding, 'CASH',
        coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
        case when v_is_profile then p_actor else null end,
        case when v_is_staff then p_actor else null end,
        v_location,
        'SUCCEEDED', coalesce(nullif(trim(p_note), ''), 'Cash payment confirmed at POS'), now()
      ) returning id into v_payment_id;

      v_current_paid := v_current_paid + v_outstanding;
    end if;
  else
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;
  end if;

  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  update public.table_checks
     set status = 'PAID',
         closed_at = coalesce(closed_at, now()),
         invoice_number = v_invoice,
         invoice_date = coalesce(invoice_date, now()),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_current_paid,
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  update public.orders
     set location_id = coalesce(location_id, v_location)
   where check_id = p_check and location_id is null;

  update public.table_sessions
     set status = 'ENDED',
         ended_at = coalesce(ended_at, now()),
         updated_at = now()
   where id in (
     select v_check.session_id where v_check.session_id is not null
     union
     select v_check.anchor_session_id where v_check.anchor_session_id is not null
     union
     select o.table_session_id from public.orders o where o.check_id = p_check and o.table_session_id is not null
   )
   and tenant_id = p_tenant
   and status = 'ACTIVE';

  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is null then
    select table_session_id into v_target_session
      from public.orders
     where check_id = p_check and table_session_id is not null
     limit 1;
    if v_target_session is not null then
      update public.table_checks
         set session_id = v_target_session,
             anchor_session_id = coalesce(anchor_session_id, v_target_session)
       where id = p_check;
    end if;
  end if;

  insert into public.security_logs (
    tenant_id, user_id, staff_id, actor_staff_id, action, meta
  ) values (
    p_tenant,
    case when v_is_profile then p_actor else null end,
    case when v_is_staff then p_actor else null end,
    case when v_is_staff then p_actor else null end,
    'CHECK_SETTLED_CASH',
    'Check ' || p_check || ' settled in cash: ' || v_invoice || ' (₹' || v_totals.total || ')'
  );

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_current_paid,
    'outstanding', 0,
    'completedOrders', v_completed,
    'endedSessionId', v_target_session,
    'paymentId', v_payment_id,
    'closedAt', now()
  );
end $$;

revoke execute on function public.settle_check_cash_tx(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.settle_check_cash_tx(uuid, uuid, uuid, text, text) to service_role;

-- 5. Update public.record_check_payment
-- Enforces atomic row locking, exact currency validation (underpayment & overpayment rejection),
-- persists sale location, and reuses finalize_table_check so checks reach PAID with their invoice,
-- completed orders, and closed diner sessions.
create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric default null,
  p_method text default 'CASH',
  p_idempotency_key text default null,
  p_actor uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_amt numeric(12, 2);
  v_existing public.check_payments;
  v_payment_id uuid;
  v_profile_actor uuid := null;
  v_staff_actor uuid := null;
  v_is_staff boolean := false;
  v_location uuid := null;
  v_fin jsonb;
begin
  -- 1. Acquire row lock on the table check
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Preserve idempotent retries on the client key
  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED';
    if found then
      return jsonb_build_object(
        'ok', true,
        'deduplicated', true,
        'already', true,
        'paymentId', v_existing.id,
        'invoiceNumber', v_check.invoice_number,
        'amount', v_existing.amount,
        'method', v_existing.method,
        'totalPaid', coalesce(v_check.paid_total, v_existing.amount),
        'outstanding', 0.00
      );
    end if;
  end if;

  -- 3. Check if check is already settled
  if v_check.status = 'PAID' then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'deduplicated', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paidTotal', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0.00,
      'message', 'This bill is already settled.'
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  -- 4. Calculate authoritative outstanding balance under lock
  select coalesce(round(sum(total), 2), 0.00) into v_total
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  select coalesce(round(sum(amount), 2), 0.00) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0.00, round(v_total - v_paid, 2));

  -- 5. Handle zero-balance check by reusing finalization logic
  if v_outstanding <= 0.00 then
    return public.finalize_table_check(p_tenant, p_check, p_actor);
  end if;

  -- 6. Full settlement validation: compare exact currency amounts
  v_amt := round(coalesce(p_amount, v_outstanding), 2);

  if v_amt < v_outstanding then
    raise exception 'UNDERPAYMENT:%:%', v_amt::text, v_outstanding::text using errcode = 'P0001';
  end if;

  if v_amt > v_outstanding then
    raise exception 'OVERPAYMENT:%:%', v_amt::text, v_outstanding::text using errcode = 'P0001';
  end if;

  -- 7. Resolve actor and durable transaction location
  if p_actor is not null then
    select id into v_profile_actor from public.profiles where id = p_actor;
    if v_profile_actor is null then
      select id, location_id into v_staff_actor, v_location
        from public.staff
       where id = p_actor and tenant_id = p_tenant;
      if v_staff_actor is not null then
        v_is_staff := true;
      end if;
    end if;
  end if;

  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  if v_location is null and v_check.location_id is not null then
    v_location := v_check.location_id;
  end if;

  if v_location is null then
    select location_id into v_location
      from public.orders
     where check_id = p_check and location_id is not null
     limit 1;
  end if;

  if v_location is null then
    select t.location_id into v_location
      from public.orders o
      join public.tables t on t.id = o.table_id
     where o.check_id = p_check and t.location_id is not null
     limit 1;
  end if;

  if v_location is null and v_is_staff then
    select location_id into v_location
      from public.staff
     where id = p_actor and tenant_id = p_tenant;
  end if;

  -- 8. Record authoritative payment record
  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key,
    created_by, staff_id, location_id, status, note, created_at
  ) values (
    p_tenant, p_check, v_amt, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
    v_profile_actor, v_staff_actor, v_location, 'SUCCEEDED', p_note, now()
  )
  returning id into v_payment_id;

  -- 9. Update check paid total and location
  update public.table_checks
     set paid_total = v_paid + v_amt,
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  -- 10. Persist location on orders
  update public.orders
     set location_id = coalesce(location_id, v_location)
   where check_id = p_check and location_id is null;

  -- 11. Reuse existing finalization logic so check reaches PAID with invoice and closed session
  v_fin := public.finalize_table_check(p_tenant, p_check, p_actor);

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'paymentId', v_payment_id,
    'invoiceNumber', v_fin->>'invoiceNumber',
    'amount', v_amt,
    'method', coalesce(p_method, 'CASH'),
    'totalPaid', v_paid + v_amt,
    'outstanding', 0.00,
    'endedSessionId', v_fin->>'endedSessionId'
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;

-- 6. Corrective historical orders.paid_at repair
-- Uses verified full-settlement records (cumulative payments reaching check total)
-- rather than unverified MAX(created_at).
with ranked_payments as (
  select
    cp.id as payment_id,
    cp.check_id,
    cp.amount,
    cp.created_at,
    sum(cp.amount) over (
      partition by cp.check_id
      order by cp.created_at asc, cp.id asc
      rows between unbounded preceding and current row
    ) as cumulative_amount
  from public.check_payments cp
  where cp.status = 'SUCCEEDED'
),
check_full_settlement as (
  select distinct on (rp.check_id)
    rp.check_id,
    rp.created_at as verified_settled_at
  from ranked_payments rp
  join public.table_checks tc on tc.id = rp.check_id
  where rp.cumulative_amount >= coalesce(tc.total, 0.00) - 0.005
  order by rp.check_id, rp.created_at asc, rp.payment_id asc
),
verified_legacy_checks as (
  select
    tc.id as check_id,
    coalesce(tc.closed_at, tc.invoice_date) as verified_settled_at
  from public.table_checks tc
  where tc.status = 'PAID'
    and coalesce(tc.closed_at, tc.invoice_date) is not null
    and not exists (
      select 1 from check_full_settlement cfs where cfs.check_id = tc.id
    )
)
update public.orders o
   set paid_at = cfs.verified_settled_at
  from check_full_settlement cfs
 where o.check_id = cfs.check_id
   and o.paid_at is distinct from cfs.verified_settled_at;

with ranked_payments as (
  select
    cp.id as payment_id,
    cp.check_id,
    cp.amount,
    cp.created_at,
    sum(cp.amount) over (
      partition by cp.check_id
      order by cp.created_at asc, cp.id asc
      rows between unbounded preceding and current row
    ) as cumulative_amount
  from public.check_payments cp
  where cp.status = 'SUCCEEDED'
),
check_full_settlement as (
  select distinct on (rp.check_id)
    rp.check_id,
    rp.created_at as verified_settled_at
  from ranked_payments rp
  join public.table_checks tc on tc.id = rp.check_id
  where rp.cumulative_amount >= coalesce(tc.total, 0.00) - 0.005
  order by rp.check_id, rp.created_at asc, rp.payment_id asc
),
verified_legacy_checks as (
  select
    tc.id as check_id,
    coalesce(tc.closed_at, tc.invoice_date) as verified_settled_at
  from public.table_checks tc
  where tc.status = 'PAID'
    and coalesce(tc.closed_at, tc.invoice_date) is not null
    and not exists (
      select 1 from check_full_settlement cfs where cfs.check_id = tc.id
    )
)
update public.orders o
   set paid_at = vlc.verified_settled_at
  from verified_legacy_checks vlc
 where o.check_id = vlc.check_id
   and o.paid_at is distinct from vlc.verified_settled_at;

-- Reset unverifiable paid_at to NULL
with ranked_payments as (
  select
    cp.id as payment_id,
    cp.check_id,
    cp.amount,
    cp.created_at,
    sum(cp.amount) over (
      partition by cp.check_id
      order by cp.created_at asc, cp.id asc
      rows between unbounded preceding and current row
    ) as cumulative_amount
  from public.check_payments cp
  where cp.status = 'SUCCEEDED'
),
check_full_settlement as (
  select distinct on (rp.check_id)
    rp.check_id
  from ranked_payments rp
  join public.table_checks tc on tc.id = rp.check_id
  where rp.cumulative_amount >= coalesce(tc.total, 0.00) - 0.005
  order by rp.check_id, rp.created_at asc, rp.payment_id asc
),
verified_legacy_checks as (
  select
    tc.id as check_id
  from public.table_checks tc
  where tc.status = 'PAID'
    and coalesce(tc.closed_at, tc.invoice_date) is not null
)
update public.orders o
   set paid_at = null
 where o.paid_at is not null
   and not exists (select 1 from check_full_settlement cfs where cfs.check_id = o.check_id)
   and not exists (select 1 from verified_legacy_checks vlc where vlc.check_id = o.check_id)
   and not (o.check_id is null and o.payment_status in ('PAID', 'paid') and o.status = 'COMPLETED');
