-- ===========================================================================
-- Migration: 20261117000003_drop_obsolete_create_order_tx_overload.sql
-- Description:
--   Safely removes obsolete create_order_tx function overloads that cause PostgREST
--   HTTP 300 / PGRST203 candidate function resolution errors during order placement.
--   Preserves the canonical create_order_tx(jsonb, jsonb, uuid, text, text) function,
--   its parameter defaults, permissions, and security definer properties.
-- ===========================================================================

-- 1. Preflight assertion: Ensure the canonical create_order_tx exists before dropping overloads
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_order_tx'
      and pg_get_function_identity_arguments(p.oid) = 'p_order jsonb, p_items jsonb, p_promo_code_id uuid, p_idempotency_key text, p_status text'
  ) then
    raise exception 'PREFLIGHT_FAILED: Canonical create_order_tx(jsonb, jsonb, uuid, text, text) does not exist!'
      using errcode = 'P0001';
  end if;
end;
$$;

-- 2. Safely remove obsolete / inverted argument overloads
drop function if exists public.create_order_tx(jsonb, jsonb, text, text, uuid);
drop function if exists public.create_order_tx(jsonb, jsonb, uuid, uuid, text);
drop function if exists public.create_order_tx(jsonb, jsonb, text, text);

-- 3. Ensure permissions on canonical create_order_tx
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to authenticated, anon, service_role;

-- 4. Postflight assertion: Verify exactly ONE create_order_tx signature remains in public schema
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'create_order_tx';

  if v_count <> 1 then
    raise exception 'POSTFLIGHT_FAILED: Expected exactly 1 create_order_tx function, found %', v_count
      using errcode = 'P0001';
  end if;
end;
$$;

