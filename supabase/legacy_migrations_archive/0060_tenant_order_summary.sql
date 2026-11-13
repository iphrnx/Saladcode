-- The board summary (revenue today / orders today / active orders) was computed
-- in the edge function from the newest 200 orders, downloaded every poll. That
-- made it wrong on any tenant with more than 200 orders — the counts silently
-- stopped growing — and cost a 200-row round trip every four seconds per POS.
-- One aggregate answers it in a single row, over the whole tenant.
--
-- SECURITY DEFINER, like the other service-only helpers: only the edge
-- functions call it, and EXECUTE is revoked from the public roles, so the
-- caller never needs its own SELECT privilege on orders.

create or replace function public.tenant_order_summary(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revenue', coalesce(
      sum(total) filter (
        where status = 'COMPLETED' and created_at >= date_trunc('day', now())
      ), 0),
    'ordersToday', count(*) filter (where created_at >= date_trunc('day', now())),
    'activeOrders', count(*) filter (where status not in ('COMPLETED', 'CANCELLED'))
  )
  from public.orders
  where tenant_id = p_tenant;
$$;

revoke execute on function public.tenant_order_summary(uuid) from public, anon, authenticated;
grant execute on function public.tenant_order_summary(uuid) to service_role;
