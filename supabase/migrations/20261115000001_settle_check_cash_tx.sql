-- Migration: 20261115000001_settle_check_cash_tx.sql
-- Description: Implement production-safe atomic cash payment workflow, idempotent already-settled handling, and session closure.

-- 1. Atomic settle check cash transaction
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
set search_path = public, pg_temp
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
begin
  -- 1. Row-level lock on the table check with strict tenant isolation
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Idempotency: If check is already settled (status = 'PAID'), return existing settlement details idempotently
  if v_check.status = 'PAID' then
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
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

  -- 3. Verify that all non-cancelled orders on this check are served
  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  -- 4. Calculate authoritative order totals
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

  -- 5. Calculate existing succeeded payments
  select coalesce(sum(amount), 0) into v_current_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_totals.total - v_current_paid);

  -- 6. If outstanding > 0, record Cash payment atomically
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
        tenant_id, check_id, amount, method, idempotency_key, created_by, status, note
      ) values (
        p_tenant, p_check, v_outstanding, 'CASH',
        coalesce(p_idempotency_key, encode(gen_random_bytes(16), 'hex')),
        p_actor, 'SUCCEEDED', coalesce(nullif(trim(p_note), ''), 'Cash payment confirmed at POS')
      ) returning id into v_payment_id;

      v_current_paid := v_current_paid + v_outstanding;
    end if;
  else
    -- If already fully covered by previous payments, pick last payment id if present
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;
  end if;

  -- 7. Allocate tenant-scoped sequential invoice number
  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  -- 8. Mark check PAID and update final financial snapshot
  update public.table_checks
     set status = 'PAID',
         closed_at = now(),
         invoice_number = v_invoice,
         invoice_date = now(),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_current_paid,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  -- 9. Complete all paid check orders
  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- 10. End ONLY the session bound to this check (session isolation on shared tables)
  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is not null then
    update public.table_sessions
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where id = v_target_session
       and status = 'ACTIVE';
  end if;

  -- 11. Security audit trail
  insert into public.security_logs (
    tenant_id,
    user_id,
    staff_id,
    actor_staff_id,
    action,
    meta
  ) values (
    p_tenant,
    case when exists (select 1 from public.profiles where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
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

-- 2. Enhance finalize_table_check to return full settlement snapshot when already paid
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
  v_check public.table_checks%rowtype;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
  v_target_session uuid;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_check.status = 'PAID' then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', coalesce(v_check.session_id, v_check.anchor_session_id),
      'closedAt', v_check.closed_at
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  -- Require all non-cancelled orders on this check to be served before settlement
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

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is not null then
    update public.table_sessions
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where id = v_target_session
       and status = 'ACTIVE';
  end if;

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
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- 3. Enhance record_check_payment to gracefully return already-settled state
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
set search_path = public, pg_temp
as $$
declare
  v_check public.table_checks%rowtype;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_existing public.check_payments%rowtype;
  v_payment_id uuid;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- If check is already paid, return already-settled state idempotently
  if v_check.status = 'PAID' then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'deduplicated', true,
      'paidTotal', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0
    );
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;

  if v_check.status <> 'OPEN' then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED'
     limit 1;
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
    coalesce(p_idempotency_key, encode(gen_random_bytes(16), 'hex')),
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
    'paidTotal', v_paid + p_amount,
    'outstanding', greatest(0::numeric, v_outstanding - p_amount)
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;
