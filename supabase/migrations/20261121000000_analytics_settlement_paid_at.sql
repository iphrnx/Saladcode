-- ============================================================================
-- Migration: 20261121000000_analytics_settlement_paid_at.sql
-- Description: Add paid_at timestamp to orders for settlement-based reporting,
--              create indexes for analytics queries, and update
--              complete_paid_check_orders to record settlement timestamp.
--              Backfills paid_at strictly from verified settlement records.
-- ============================================================================

-- 1. Add paid_at column to orders if not exists
alter table public.orders
  add column if not exists paid_at timestamptz;

-- 2. Indexes for settlement-based analytics and reporting queries
create index if not exists idx_orders_tenant_paid_at
  on public.orders (tenant_id, paid_at desc)
  where paid_at is not null;

create index if not exists idx_orders_tenant_payment_status
  on public.orders (tenant_id, payment_status, status);

-- 3. Backfill/correct paid_at strictly from verified settlement records
-- Priority A: From successful ledger check payments
with verified_payments as (
  select
    o.id as order_id,
    min(cp.created_at) as verified_settled_at
  from public.orders o
  join public.check_payments cp
    on cp.check_id = o.check_id
   and cp.tenant_id = o.tenant_id
  where cp.status = 'SUCCEEDED'
  group by o.id
)
update public.orders o
   set paid_at = coalesce(o.paid_at, vp.verified_settled_at)
  from verified_payments vp
 where o.id = vp.order_id
   and (o.paid_at is null or o.paid_at != vp.verified_settled_at);

-- Priority B: From closed paid table checks where ledger payments are absent
with verified_checks as (
  select
    o.id as order_id,
    tc.closed_at as verified_settled_at
  from public.orders o
  join public.table_checks tc
    on tc.id = o.check_id
   and tc.tenant_id = o.tenant_id
  where tc.status = 'PAID'
    and tc.closed_at is not null
    and not exists (
      select 1 from public.check_payments cp
      where cp.check_id = tc.id and cp.status = 'SUCCEEDED'
    )
)
update public.orders o
   set paid_at = coalesce(o.paid_at, vc.verified_settled_at)
  from verified_checks vc
 where o.id = vc.order_id
   and o.paid_at is null;

-- Priority C: If paid_at was previously set (e.g. by an earlier run of this migration)
-- on an order where settlement CANNOT be verified (no paid status, no successful payments,
-- no closed paid check), leave/reset paid_at unset (NULL).
update public.orders o
   set paid_at = null
 where o.paid_at is not null
   and o.payment_status not in ('PAID', 'paid')
   and not exists (
     select 1 from public.check_payments cp
      where cp.check_id = o.check_id and cp.status = 'SUCCEEDED'
   )
   and not exists (
     select 1 from public.table_checks tc
      where tc.id = o.check_id and tc.status = 'PAID'
   );

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
