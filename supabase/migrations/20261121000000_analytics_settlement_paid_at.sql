-- ============================================================================
-- Migration: 20261121000000_analytics_settlement_paid_at.sql
-- Description: Add paid_at timestamp to orders for settlement-based reporting,
--              create indexes for analytics queries, and update
--              complete_paid_check_orders to record settlement timestamp.
-- ============================================================================

-- 1. Add paid_at column to orders if not exists
alter table public.orders
  add column if not exists paid_at timestamptz;

-- 2. Index for settlement-based analytics and reporting queries
create index if not exists idx_orders_tenant_paid_at
  on public.orders (tenant_id, paid_at desc)
  where paid_at is not null;

create index if not exists idx_orders_tenant_payment_status
  on public.orders (tenant_id, payment_status, status);

-- 3. Backfill paid_at for existing completed/paid orders
update public.orders
   set paid_at = coalesce(completed_at, updated_at, created_at)
 where (payment_status in ('PAID', 'paid') or status = 'COMPLETED')
   and paid_at is null;

-- 4. Update complete_paid_check_orders to record paid_at settlement timestamp
create or replace function public.complete_paid_check_orders(p_tenant uuid, p_check uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer;
  v_settled_at timestamptz := now();
begin
  with done as (
    update public.orders
       set status = 'COMPLETED',
           payment_status = 'PAID',
           paid_at = coalesce(paid_at, v_settled_at),
           completed_at = coalesce(completed_at, v_settled_at),
           updated_at = v_settled_at
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
