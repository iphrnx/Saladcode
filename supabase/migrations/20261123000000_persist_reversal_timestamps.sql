-- ============================================================================
-- Migration: 20261123000000_persist_reversal_timestamps.sql
-- Description: Persist reversal timestamps (voided_at and refunded_at) and
--              update void_check_payment to atomically record reversal time.
--              Preserves original reversal timestamp on idempotent retries.
-- ============================================================================

-- 1. Add voided_at to check_payments
alter table public.check_payments
  add column if not exists voided_at timestamptz;

create index if not exists idx_check_payments_tenant_voided_at
  on public.check_payments (tenant_id, voided_at)
  where status = 'VOID';

-- 2. Add refunded_at to orders
alter table public.orders
  add column if not exists refunded_at timestamptz;

create index if not exists idx_orders_tenant_refunded_at
  on public.orders (tenant_id, refunded_at)
  where payment_status in ('REFUNDED', 'refunded');

-- 3. Update void_check_payment to write voided_at atomically and preserve on retry
create or replace function public.void_check_payment(
  p_tenant uuid,
  p_payment uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.check_payments;
  v_check public.table_checks;
  v_paid numeric(12, 2);
begin
  select * into v_payment
    from public.check_payments
   where id = p_payment and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_payment.status = 'VOID' then
    return jsonb_build_object('ok', true, 'already', true, 'voidedAt', v_payment.voided_at);
  end if;

  select * into v_check
    from public.table_checks
   where id = v_payment.check_id
   for update;

  if v_check.status = 'PAID' then
    raise exception 'INVOICE_SETTLED_CANNOT_VOID_PAYMENT' using errcode = 'P0001';
  end if;

  update public.check_payments
     set status = 'VOID',
         voided_at = coalesce(voided_at, now()),
         note = concat_ws(' | ', note, p_reason)
   where id = v_payment.id;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = v_check.id and status = 'SUCCEEDED';

  update public.table_checks
     set paid_total = v_paid,
         version = version + 1,
         updated_at = now()
   where id = v_check.id;

  return jsonb_build_object('ok', true, 'already', false, 'paidTotal', v_paid);
end $$;

revoke execute on function public.void_check_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.void_check_payment(uuid, uuid, text) to service_role;

-- 4. Backfill historical check_payments.voided_at from security_logs audit trail
update public.check_payments cp
   set voided_at = (
     select min(sl.created_at)
       from public.security_logs sl
      where sl.tenant_id = cp.tenant_id
        and sl.action = 'CHECK_PAYMENT_REVERSED'
        and sl.meta like '%' || cp.id::text || '%'
   )
 where cp.status = 'VOID'
   and cp.voided_at is null;
