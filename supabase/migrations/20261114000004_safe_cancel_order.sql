-- Migration: 20261114000004_safe_cancel_order.sql
-- Description: Production-ready safe cancel order transaction with tenant isolation,
-- row locking, history preservation, check recalculation, and payment validation.

alter table public.orders
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_id uuid;

create or replace function public.cancel_order_tx(
  p_tenant uuid,
  p_order_id uuid,
  p_actor uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_check public.table_checks%rowtype;
  v_remaining_check_total numeric;
  v_check_paid numeric;
  v_new_totals record;
  v_clean_reason text;
begin
  -- 1. Lock and fetch the order with strict tenant isolation
  select * into v_order
    from public.orders
   where id = p_order_id
     and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Idempotency: already cancelled
  if v_order.status = 'CANCELLED' then
    return jsonb_build_object(
      'ok', true,
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'check_id', v_order.check_id,
      'table_id', v_order.table_id,
      'table_session_id', v_order.table_session_id,
      'status', 'CANCELLED',
      'cancellation_reason', v_order.cancellation_reason,
      'already_cancelled', true
    );
  end if;

  -- 3. Invariant checks
  if v_order.status = 'COMPLETED' then
    raise exception 'ORDER_ALREADY_COMPLETED' using errcode = 'P0001';
  end if;

  if v_order.payment_status = 'PAID' then
    raise exception 'ORDER_ALREADY_PAID' using errcode = 'P0001';
  end if;

  -- 4. Check level invariants (if order is attached to a dine-in check)
  if v_order.check_id is not null then
    select * into v_check
      from public.table_checks
     where id = v_order.check_id
       for update;

    if v_check is not null and v_check.status in ('PAID', 'VOID') then
      raise exception 'CHECK_ALREADY_CLOSED' using errcode = 'P0001';
    end if;

    -- Validate check payments vs remaining order totals
    select coalesce(sum(total), 0) into v_remaining_check_total
      from public.orders
     where check_id = v_order.check_id
       and id <> p_order_id
       and status <> 'CANCELLED';

    select coalesce(sum(amount), 0) into v_check_paid
      from public.check_payments
     where check_id = v_order.check_id
       and status = 'SUCCEEDED';

    if v_check_paid > 0 and v_check_paid > (v_remaining_check_total + 0.005) then
      raise exception 'PAYMENT_EXCEEDS_REMAINING_TOTAL:%', round((v_check_paid - v_remaining_check_total)::numeric, 2)::text
        using errcode = 'P0001';
    end if;
  end if;

  v_clean_reason := coalesce(nullif(trim(p_reason), ''), 'Cancelled by staff');

  -- 5. Mark the order CANCELLED and preserve audit history
  update public.orders
     set status = 'CANCELLED',
         cancelled_at = now(),
         cancelled_by_id = p_actor,
         cancellation_reason = v_clean_reason,
         updated_at = now()
   where id = p_order_id;

  -- 6. Mark all order items CANCELLED
  update public.order_items
     set status = 'CANCELLED'
   where order_id = p_order_id
     and status <> 'CANCELLED';

  -- 7. Atomically recalculate check totals (if attached to an active check)
  if v_order.check_id is not null then
    select
      coalesce(sum(items_total), 0) as subtotal,
      coalesce(sum(discount), 0)    as discount,
      coalesce(sum(tax), 0)         as tax,
      coalesce(sum(service_charge), 0) as service_charge,
      coalesce(sum(total), 0)       as total
    into v_new_totals
      from public.orders
     where check_id = v_order.check_id
       and status <> 'CANCELLED';

    update public.table_checks
       set subtotal = v_new_totals.subtotal,
           discount = v_new_totals.discount,
           tax = v_new_totals.tax,
           service_charge = v_new_totals.service_charge,
           total = v_new_totals.total,
           updated_at = now()
     where id = v_order.check_id;
  end if;

  -- 8. Audit trail
  insert into public.security_logs (
    tenant_id,
    user_id,
    staff_id,
    action,
    meta
  ) values (
    p_tenant,
    case when exists (select 1 from public.profiles where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
    'ORDER_CANCELLED',
    'Order #' || v_order.order_number || ' (' || p_order_id || ') cancelled: ' || v_clean_reason
  );

  return jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'check_id', v_order.check_id,
    'table_id', v_order.table_id,
    'table_session_id', v_order.table_session_id,
    'status', 'CANCELLED',
    'cancellation_reason', v_clean_reason,
    'already_cancelled', false
  );
end;
$$;

revoke execute on function public.cancel_order_tx(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_order_tx(uuid, uuid, uuid, text) to service_role;
