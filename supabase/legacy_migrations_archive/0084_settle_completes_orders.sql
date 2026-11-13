-- Settling the bill completes the sitting's orders.
--
-- Payment moved to the consolidated bill: the Orders board no longer offers a
-- per-order "Complete & Pay", so nothing in the UI marks an order COMPLETED any
-- more. Without this, every settled order would stay SERVED for ever — the
-- kitchen would keep seeing work that was paid and eaten, and revenue (which
-- counts COMPLETED orders only, see tenant_order_summary) would read zero.
--
-- So the one place money is taken is the one place an order is finished. This
-- is a status transition, not a new opinion about money: `finalize_table_check`
-- already refuses to run unless the ledger covers the total.
--
-- Only orders on the settled check, only in the caller's tenant, and never one
-- that was cancelled or is still held — a cancelled order stays cancelled, and
-- a held order was never accepted by the kitchen.

create or replace function public.complete_paid_check_orders(p_tenant uuid, p_check uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with done as (
    update public.orders
       set status = 'COMPLETED',
           payment_status = 'PAID',
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
     where tenant_id = p_tenant
       and check_id = p_check
       and status in ('PENDING', 'PREPARING', 'READY', 'SERVED')
    returning 1
  )
  select count(*) into v_count from done;
  return v_count;
end $$;

revoke execute on function public.complete_paid_check_orders(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_paid_check_orders(uuid, uuid) to service_role;

-- finalize_table_check: after the invoice is numbered, finish its orders.
--
-- The body is the 0078 version with one added call at the end; everything the
-- money path does — the open-order guard, the payment check, the invoice
-- counter — is unchanged.
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
  v_completed integer;
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

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + 0.005 < v_totals.total then
    -- `%.2f` is not a PL/pgSQL format: it prints ".2f" after the number. 0083
    -- fixed this once; this body is copied from 0078 and has to carry the fix.
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

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paidTotal', v_paid,
    'ordersCompleted', v_completed
  );
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

comment on function public.complete_paid_check_orders(uuid, uuid) is
  'Marks a settled check''s orders COMPLETED and PAID (0084).';
