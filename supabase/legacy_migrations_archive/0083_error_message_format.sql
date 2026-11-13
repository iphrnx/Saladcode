-- ===========================================================================
-- 0083 — say the amount, not the format string
--
-- Two error messages used `%.2f`, which PL/pgSQL does not understand: `%` is
-- the placeholder and `.2f` was printed literally, so an overpayment answered
-- "OVERPAYMENT:215.00.2f:999.2f" and the endpoint showed
-- "215.00.2f is still due on this table".
--
-- Found by running the whole payment lifecycle in a transaction and reading
-- what the functions actually said.
-- ===========================================================================

create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric,
  p_method text default 'CASH',
  p_idempotency_key uuid default null,
  p_actor uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.table_checks;
  v_paid numeric(10,2);
  v_total numeric(10,2);
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;

  -- Replay: hand back the original payment, write nothing.
  if p_idempotency_key is not null then
    select id into v_id from public.check_payments where idempotency_key = p_idempotency_key;
    if v_id is not null then
      return jsonb_build_object('ok', true, 'deduplicated', true, 'paymentId', v_id);
    end if;
  end if;

  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_check.status <> 'OPEN' then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders
   where check_id = p_check and status not in ('PENDING_ACTIVATION', 'CANCELLED');

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + p_amount > v_total then
    raise exception 'OVERPAYMENT:%:%', round((v_total - v_paid)::numeric, 2)::text, round(p_amount, 2)::text using errcode = 'P0001';
  end if;

  insert into public.check_payments (tenant_id, check_id, amount, method, idempotency_key, created_by, note)
  values (p_tenant, p_check, p_amount, coalesce(p_method, 'CASH'), p_idempotency_key, p_actor, p_note)
  returning id into v_id;

  update public.table_checks
     set paid_total = v_paid + p_amount,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'paymentId', v_id, 'outstanding', v_total - (v_paid + p_amount));
end $$;

create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(10,2);
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

  if v_check.status <> 'OPEN' then
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

  -- The money, from the ledger. A check is settled when it has been paid, not
  -- when somebody says so: this is the line that stops an unpaid balance being
  -- closed as PAID.
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
     set last_seq = last_seq + 1
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

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paidTotal', v_paid
  );
end $$;

revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) from public, anon, authenticated;
