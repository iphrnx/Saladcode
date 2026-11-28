-- ============================================================================
-- Migration: 20261128000002_remove_legacy_reservations_and_shared_billing.sql
-- Purpose:
--   Permanently remove legacy Reservation and Shared-Table Billing database
--   objects now that the platform runs exclusively on independent diner
--   sessions:
--     1. Drop trigger reservations_track_feature on public.reservations.
--     2. Replace public.track_feature_usage() without the reservations branch.
--     3. Replace public.purge_tenant(uuid) without deleting from reservations.
--     4. Drop legacy public.reservations table (verified 0 rows in production).
--     5. Drop legacy public.open_table_check(uuid, uuid, uuid) RPC (superseded
--        by public.open_session_check).
--     6. Replace public.check_is_live(uuid) to remove the shared-table
--        (session_id IS NULL) fallback.
--     7. Replace public.settle_check_on_session_end(uuid, uuid, uuid, uuid) to
--        remove the table-only (p_session IS NULL) shared-check fallback.
-- ============================================================================

begin;

-- 1. Remove reservation feature tracking trigger before dropping the table
drop trigger if exists reservations_track_feature on public.reservations;

-- 2. Replace track_feature_usage() without the reservations branch
create or replace function public.track_feature_usage()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_feature text;
  v_action  text;
begin
  if current_setting('app.purging_tenant', true) = 'true' then
    return null;
  end if;

  v_tenant := coalesce(new.tenant_id, old.tenant_id);
  if v_tenant is null or not exists (select 1 from public.tenants where id = v_tenant) then
    return null;
  end if;

  v_user   := auth.uid();
  v_action := lower(tg_op);

  if tg_table_name = 'menu_items' then
    v_feature := 'menu';
  elsif tg_table_name = 'promo_codes' then
    v_feature := 'promo';
  elsif tg_table_name = 'table_sessions' then
    v_feature := 'table_session';
  else
    return null;
  end if;

  if v_feature = 'menu' and v_action = 'update' then
    if new.updated_at = old.updated_at then
      return null;
    end if;
  end if;

  insert into public.feature_usage (tenant_id, user_id, feature_id, action)
  values (v_tenant, v_user, v_feature, v_action);

  return null;
end;
$function$;

-- 3. Replace purge_tenant(uuid) without public.reservations
create or replace function public.purge_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_removed jsonb := '{}'::jsonb;
  v_count integer;
begin
  -- Set transaction-scoped configuration flag to bypass invariant triggers during purge
  perform set_config('app.purging_tenant', 'true', true);

  execute 'delete from public.order_items oi using public.orders o where oi.order_id = o.id and o.tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('order_items', v_count);

  execute 'delete from public.orders where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('orders', v_count);

  execute 'delete from public.check_payments where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.table_checks where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.table_sessions where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tables where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.menu_items where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.categories where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.promo_codes where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.customer_reviews where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.staff_sessions where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.staff where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.roles where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.settings where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.security_logs where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tenant_realtime where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.locations where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tenant_owner_guard where tenant_id = $1' using p_tenant_id;

  execute 'delete from public.profiles where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('profiles', v_count);

  update public.tenants
     set name = 'Deleted restaurant',
         slug = 'deleted-' || replace(p_tenant_id::text, '-', ''),
         logo = null,
         tagline = null,
         address = null,
         phone = null,
         email = null,
         active = false,
         onboarding_done = false,
         subscription_status = 'none',
         subscription_plan = null,
         plan = 'starter',
         trial_started_at = null,
         trial_ends_at = null,
         current_period_end = null,
         payment_mode = null
   where id = p_tenant_id;

  return v_removed;
end;
$function$;

-- 4. Drop obsolete reservations table (explicit, no blind CASCADE)
drop table if exists public.reservations;

-- 5. Drop legacy shared-table check opener RPC
drop function if exists public.open_table_check(uuid, uuid, uuid);

-- 6. Replace check_is_live(uuid) without shared-table (session_id IS NULL) fallback
create or replace function public.check_is_live(p_check uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
      from public.table_checks c
     where c.id = p_check
       and c.status = 'OPEN'
       and (
         (
           c.session_id is not null and exists (
             select 1 from public.table_sessions s
              where s.id = c.session_id
                and s.status = 'ACTIVE'
           )
         )
         or exists (
           select 1 from public.orders o
            where o.check_id = c.id
              and o.status not in ('COMPLETED', 'CANCELLED')
         )
       )
  );
$function$;

-- 7. Replace settle_check_on_session_end without table-only shared check fallback
create or replace function public.settle_check_on_session_end(
  p_tenant uuid,
  p_table uuid,
  p_actor uuid default null::uuid,
  p_session uuid default null::uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_check public.table_checks;
  v_open_orders integer;
  v_paid numeric(12, 2);
  v_total numeric(12, 2);
begin
  if p_session is null then
    return jsonb_build_object('ok', true, 'action', 'none');
  end if;

  select * into v_check
    from public.table_checks
   where tenant_id = p_tenant
     and (
       session_id = p_session
       or anchor_session_id = p_session
       or id in (select check_id from public.orders where table_session_id = p_session and check_id is not null)
     )
     and status in ('OPEN', 'UNSETTLED')
   order by opened_at desc
   limit 1
   for update;

  if not found or v_check.id is null then
    return jsonb_build_object('ok', true, 'action', 'none');
  end if;

  if public.check_is_live(v_check.id) then
    return jsonb_build_object('ok', true, 'action', 'sitting_open');
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = v_check.id
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    return jsonb_build_object('ok', true, 'action', 'orders_open', 'orders', v_open_orders);
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders where check_id = v_check.id and status <> 'CANCELLED';

  if v_total <= 0 then
    update public.table_checks
       set status = 'VOID', closed_at = now(), updated_at = now()
     where id = v_check.id;
    return jsonb_build_object('ok', true, 'action', 'voided_empty');
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = v_check.id and status = 'SUCCEEDED';

  if v_paid + 0.005 >= v_total then
    return public.finalize_table_check(p_tenant, v_check.id, p_actor);
  end if;

  update public.table_checks
     set status = 'UNSETTLED',
         unsettled_at = now(),
         updated_at = now()
   where id = v_check.id;

  return jsonb_build_object('ok', true, 'action', 'unsettled', 'due', v_total - v_paid);
end;
$function$;

commit;
