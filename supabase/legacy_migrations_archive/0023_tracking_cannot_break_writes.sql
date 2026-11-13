-- ===========================================================================
-- 0023 — Tracking must never break a business write
--
-- Migration 0021 attached a `track_feature_usage()` trigger to menu_items,
-- promo_codes, table_sessions and reservations. The function compared
-- `new.updated_at` with `old.updated_at` to recognise a no-op update, but only
-- menu_items has that column. PL/pgSQL evaluates the whole condition, so
-- every write to promo_codes, table_sessions and reservations raised:
--
--     record "new" has no field "updated_at"
--     PL/pgSQL function track_feature_usage() line 28
--
-- and the business write failed with it.
--
-- What that broke:
--
--   - Diner QR scanning, completely. `start_table_session()` inserts a
--     table_sessions row, so no session could be created and every scan
--     landed on "Menu access requires a table session". Between this migration
--     and the fix, 0 of the platform's 134 table sessions were created.
--   - Creating a promo code. POST /promos returned the same error.
--   - Creating a reservation, which has no rows to show for it.
--
-- Two things are fixed here.
--
-- First, the column access is made table-agnostic, so a trigger attached to
-- one table can never fail because a different table has a different shape.
--
-- Second, and more importantly, the trigger can no longer fail a business
-- write at all: the analytics insert is wrapped, so any error inside it is
-- swallowed. A diner scanning a QR must not be able to be blocked by a
-- metrics problem. The same guard is applied to the order counter, which sits
-- on the ordering path.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Feature tracking
-- ---------------------------------------------------------------------------

create or replace function public.track_feature_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_user   uuid;
  v_feature text;
  v_action text;
  v_new_ts text;
  v_old_ts text;
begin
  if tg_op = 'DELETE' then
    v_tenant := old.tenant_id;
  else
    v_tenant := new.tenant_id;
  end if;

  v_user   := auth.uid();
  v_action := lower(tg_op);

  v_feature := case tg_table_name
    when 'menu_items'     then 'menu'
    when 'promo_codes'    then 'promo'
    when 'table_sessions' then 'table_session'
    when 'reservations'   then 'reservation'
    else null
  end;

  if v_feature is null then
    return null;
  end if;

  -- A no-op update is only recognisable on a table that carries updated_at.
  -- A record field that does not exist is a runtime error, and the trigger
  -- runs on tables of different shapes, so the column is read through
  -- to_jsonb() rather than as a field.
  if v_action = 'update' then
    v_new_ts := to_jsonb(new) ->> 'updated_at';
    v_old_ts := to_jsonb(old) ->> 'updated_at';
    if v_new_ts is not null and v_old_ts is not null and v_new_ts = v_old_ts then
      return null;
    end if;
  end if;

  -- The metrics write must never fail the write that triggered it. A diner
  -- scanning a QR cannot be blocked by an analytics problem.
  begin
    insert into public.feature_usage (tenant_id, user_id, feature_id, action)
    values (v_tenant, v_user, v_feature, v_action);
  exception when others then
    -- Deliberately swallowed. See the note above.
    null;
  end;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The order counter
-- ---------------------------------------------------------------------------

-- Same reasoning: this trigger sits on the ordering path, so it must not be
-- able to fail an order.
create or replace function public.track_order_metrics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date;
begin
  begin
    v_day := (new.created_at at time zone public.tenant_timezone(new.tenant_id))::date;
    insert into public.daily_tenant_metrics (tenant_id, date, order_count, order_value, updated_at)
    values (new.tenant_id, v_day, 1, coalesce(new.total, 0), now())
    on conflict (tenant_id, date) do update
      set order_count = public.daily_tenant_metrics.order_count + 1,
          order_value = public.daily_tenant_metrics.order_value + coalesce(new.total, 0),
          updated_at  = now();
  exception when others then
    -- The order is the thing that matters; the counter is a convenience.
    null;
  end;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A QR token identifies exactly one table
-- ---------------------------------------------------------------------------

-- `start_table_session()` resolves a scanned token with `limit 1`, so a
-- duplicate would silently hand one restaurant's diner another restaurant's
-- menu. The tokens are 18 random bytes, so a collision is not a practical
-- risk — but the guarantee should not rest on that alone.
create unique index if not exists tables_qr_token_key
  on public.tables (qr_token);
