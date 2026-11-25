-- ============================================================================
-- Migration: 20261125000003_fix_track_feature_usage_trigger.sql
-- Purpose:   Nest the `new.updated_at = old.updated_at` check inside an inner
--            IF block in `public.track_feature_usage()` so PostgreSQL does not
--            bind `new.updated_at` on tables without `updated_at` (e.g.
--            `promo_codes`) during UPDATE triggers.
-- ============================================================================

create or replace function public.track_feature_usage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_feature text;
  v_action  text;
begin
  v_tenant := coalesce(new.tenant_id, old.tenant_id);
  v_user   := auth.uid();
  v_action := lower(tg_op);

  if tg_table_name = 'menu_items' then
    v_feature := 'menu';
  elsif tg_table_name = 'promo_codes' then
    v_feature := 'promo';
  elsif tg_table_name = 'table_sessions' then
    v_feature := 'table_session';
  elsif tg_table_name = 'reservations' then
    v_feature := 'reservation';
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
$$;
