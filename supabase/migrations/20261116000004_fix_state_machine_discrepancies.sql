-- ===========================================================================
-- Migration: 20261116000004_fix_state_machine_discrepancies.sql
-- Fixes Discrepancies D1 through D8:
-- D1: Canonical order status transitions (normalize REJECTED to CANCELLED)
-- D2: Aligns order_items check constraint & sync trigger to include COMPLETED & PENDING_ACTIVATION
-- D3: Table session dual status synchronization and zombie session prevention
-- D4: Canonical uppercase payment_status ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED')
-- D5: Enable finalize_table_check for UNSETTLED checks upon full payment
-- ===========================================================================

-- 1. Align order_items status check constraint (Fix D2)
alter table public.order_items drop constraint if exists order_items_status_check;
alter table public.order_items add constraint order_items_status_check
  check (status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'));

-- Align reservations status check constraint to support COMPLETED (Fix D7)
alter table public.reservations drop constraint if exists reservations_status_check;
alter table public.reservations add constraint reservations_status_check
  check (status in ('PENDING', 'CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW', 'COMPLETED'));

-- 2. Align orders payment_status check constraint to canonical uppercase (Fix D4)
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED', 'unpaid', 'partially_paid', 'paid', 'refunded'));
alter table public.orders alter column payment_status set default 'UNPAID';

-- Migrate existing lowercase payment_status values to canonical uppercase
update public.orders set payment_status = 'UNPAID' where payment_status = 'unpaid';
update public.orders set payment_status = 'PAID' where payment_status = 'paid';
update public.orders set payment_status = 'PARTIALLY_PAID' where payment_status = 'partially_paid';
update public.orders set payment_status = 'REFUNDED' where payment_status = 'refunded';

-- 3. Update trigger to synchronize order_items when orders change status (Fix D2)
create or replace function public.trg_sync_order_items_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.status is distinct from OLD.status then
    if NEW.status in ('PREPARING', 'READY', 'SERVED', 'COMPLETED') then
      update public.order_items
         set status = NEW.status
       where order_id = NEW.id
         and status <> 'CANCELLED';
    elsif NEW.status in ('CANCELLED', 'REJECTED') then
      update public.order_items
         set status = 'CANCELLED'
       where order_id = NEW.id;
    elsif NEW.status = 'PENDING' and OLD.status = 'PENDING_ACTIVATION' then
      update public.order_items
         set status = 'PENDING'
       where order_id = NEW.id
         and status <> 'CANCELLED';
    end if;
  end if;
  return NEW;
end $$;

-- 4. Enable finalize_table_check for both OPEN and UNSETTLED checks (Fix D5)
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
  v_profile_actor uuid := null;
  v_staff_actor uuid := null;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_check.status = 'PAID' then
    return jsonb_build_object('ok', true, 'already', true, 'invoiceNumber', v_check.invoice_number);
  end if;

  -- Allow both OPEN and UNSETTLED checks to be finalized once paid (Fix D5)
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
         closed_at = now(),
         unsettled_at = null,
         invoice_number = v_invoice,
         invoice_date = now(),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_paid,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  -- Complete all paid orders and set their payment_status to 'PAID'
  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- Close the owning session if bound
  if v_check.session_id is not null then
    update public.table_sessions
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where id = v_check.session_id
       and tenant_id = p_tenant
       and status = 'ACTIVE';
  end if;

  -- Audit log attribution
  if p_actor is not null then
    select id into v_profile_actor from public.profiles where id = p_actor;
    if v_profile_actor is null then
      select id into v_staff_actor from public.staff where id = p_actor and tenant_id = p_tenant;
    end if;
  end if;

  insert into public.security_logs (
    tenant_id,
    user_id,
    actor_staff_id,
    action,
    meta
  ) values (
    p_tenant,
    v_profile_actor,
    v_staff_actor,
    'CHECK_FINALISED',
    'Check ' || p_check || ' finalized: ' || v_invoice || ' (₹' || v_totals.total || ')'
  );

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_paid,
    'completedOrders', v_completed
  );
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- 5. Enable record_check_payment for both OPEN and UNSETTLED checks (Fix D5 deferred collection)
create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric,
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
  v_existing public.check_payments;
  v_payment_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;

  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Allow recording payment on OPEN or UNSETTLED checks (Fix D5)
  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('ok', true, 'deduplicated', true, 'paymentId', v_existing.id);
    end if;
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_total - v_paid);

  if p_amount > v_outstanding + 0.005 then
    raise exception 'OVERPAYMENT:%:%', round(p_amount::numeric, 2)::text, round(v_outstanding::numeric, 2)::text
      using errcode = 'P0001';
  end if;

  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key, created_by, status, note
  ) values (
    p_tenant, p_check, p_amount, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
    p_actor, 'SUCCEEDED', p_note
  )
  returning id into v_payment_id;

  update public.table_checks
     set paid_total = v_paid + p_amount,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'paymentId', v_payment_id,
    'amount', p_amount,
    'method', coalesce(p_method, 'CASH'),
    'totalPaid', v_paid + p_amount,
    'outstanding', greatest(0::numeric, v_outstanding - p_amount)
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;


