-- ===========================================================================
-- 0030 — The order counter has to come back down
--
-- `orders_track_daily_metrics` fired on INSERT only. So a deleted order left
-- its count and its value in `daily_tenant_metrics` for ever, and an edited
-- order's new total was never picked up. The Super Admin's order count, its
-- revenue and the per-restaurant figures are all read from that rollup, so
-- they drifted upward and never came back down — the dashboard reported
-- numbers that were not real.
--
-- The trigger now handles all three operations, and the rollup is rebuilt from
-- the orders themselves so the drift that is already there is gone.
-- ===========================================================================

create or replace function public.track_order_metrics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_day date;
  v_count integer := 0;
  v_value numeric := 0;
  v_old_tenant uuid;
  v_old_day date;
  v_old_value numeric := 0;
begin
  if tg_op = 'INSERT' then
    v_tenant := new.tenant_id;
    v_day := (new.created_at at time zone public.tenant_timezone(new.tenant_id))::date;
    v_count := 1;
    v_value := coalesce(new.total, 0);

  elsif tg_op = 'DELETE' then
    v_tenant := old.tenant_id;
    v_day := (old.created_at at time zone public.tenant_timezone(old.tenant_id))::date;
    v_count := -1;
    v_value := -coalesce(old.total, 0);

  else -- UPDATE
    v_old_tenant := old.tenant_id;
    v_old_day := (old.created_at at time zone public.tenant_timezone(old.tenant_id))::date;
    v_old_value := coalesce(old.total, 0);
    v_tenant := new.tenant_id;
    v_day := (new.created_at at time zone public.tenant_timezone(new.tenant_id))::date;
    v_value := coalesce(new.total, 0) - v_old_value;

    if v_tenant is distinct from v_old_tenant or v_day is distinct from v_old_day then
      -- The order moved to another restaurant or another day. Take it off the
      -- old one before it is counted on the new one.
      begin
        insert into public.daily_tenant_metrics (tenant_id, date, order_count, order_value, updated_at)
        values (v_old_tenant, v_old_day, -1, -v_old_value, now())
        on conflict (tenant_id, date) do update
          set order_count = public.daily_tenant_metrics.order_count - 1,
              order_value = public.daily_tenant_metrics.order_value - v_old_value,
              updated_at = now();
      exception when others then
        null;
      end;
      v_count := 1;
      v_value := coalesce(new.total, 0);
    end if;
  end if;

  begin
    insert into public.daily_tenant_metrics (tenant_id, date, order_count, order_value, updated_at)
    values (v_tenant, v_day, v_count, v_value, now())
    on conflict (tenant_id, date) do update
      set order_count = public.daily_tenant_metrics.order_count + v_count,
          order_value = public.daily_tenant_metrics.order_value + v_value,
          updated_at = now();
  exception when others then
    -- A reporting counter must never be able to fail the order that caused it.
    null;
  end;

  return null;
end;
$$;

drop trigger if exists orders_track_daily_metrics on public.orders;

create trigger orders_track_daily_metrics
after insert or update or delete on public.orders
for each row execute function public.track_order_metrics();

-- Rebuild the rollup from the orders themselves, so the drift that is already
-- in the table is gone rather than carried forward.
with truth as (
  select o.tenant_id,
         (o.created_at at time zone public.tenant_timezone(o.tenant_id))::date as day,
         count(*)::int as n,
         sum(coalesce(o.total, 0)) as v
  from public.orders o
  group by 1, 2
)
update public.daily_tenant_metrics m
set order_count = t.n,
    order_value = t.v,
    updated_at = now()
from truth t
where m.tenant_id = t.tenant_id
  and m.date = t.day
  and (m.order_count is distinct from t.n or m.order_value is distinct from t.v);

-- And a day with no orders on it has to count zero, not whatever it drifted to.
update public.daily_tenant_metrics m
set order_count = 0,
    order_value = 0,
    updated_at = now()
where not exists (
  select 1
  from public.orders o
  where o.tenant_id = m.tenant_id
    and (o.created_at at time zone public.tenant_timezone(o.tenant_id))::date = m.date
);
