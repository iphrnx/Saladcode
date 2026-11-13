-- ===========================================================================
-- 0079 — one signature for open_table_check
--
-- 0078 added a third argument (the session that anchors the check) and left
-- the two-argument version in place for compatibility. Postgres accepted both,
-- because the third argument has a default — and then refused to choose:
--
--   ERROR: Could not choose the best candidate function between:
--     public.open_table_check(p_tenant => uuid, p_table => uuid),
--     public.open_table_check(p_tenant => uuid, p_table => uuid, p_session => uuid)
--
-- Every caller that passes three arguments (create_order_tx) still resolved,
-- which is why orders kept working; anything calling it with two broke. The
-- lesson: a defaulted argument does NOT make an overload backward compatible.
-- ===========================================================================

drop function if exists public.open_table_check(uuid, uuid);

comment on function public.open_table_check(uuid, uuid, uuid) is
  'The table''s live check; retires an unsettled previous one first (0078). The 2-arg overload was dropped in 0079.';
