-- ============================================================================
-- Migration: 20261125000001_cleanup_obsolete_objects.sql
-- Purpose: Minimal cleanup of confirmed obsolete/test-only live DB objects.
-- Status: PREPARED ONLY — DO NOT APPLY WITHOUT EXPLICIT APPROVAL.
--
-- Pre-checks verified against live Supabase project (jeuixphibaasbxgaexfg):
--   1. public.open_session_check_with_type: 0 refs in src/, supabase/functions/,
--      supabase/migrations/, and legacy archive. Superseded by open_session_check.
--   2. public.execute_core_invariants_tests, public.test_independent_diner_billing,
--      public.test_pos_session_selection_and_reconciliation,
--      public.test_takeaway_delivery_independent_sessions: test-only RPCs with
--      0 refs in src/ or supabase/functions/.
--   3. public.dining_areas: 0 rows in live DB, 0 refs in src/, supabase/functions/,
--      or scripts/. public.tables uses `area text` instead.
--   4. public.ai_usage_logs: 0 rows in live DB, 0 refs in src/ or
--      supabase/functions/ (app code uses public.ai_request_logs instead).
--   5. public.staff_sessions(device_info, ip_address): 0 rows in live DB, 0 refs
--      in src/, supabase/functions/, or scripts/ (app uses device, browser, os,
--      ip, user_agent).
--
-- Data-retention considerations:
--   - All affected tables currently contain 0 rows in the live database.
--   - No business data will be lost.
-- ============================================================================

begin;

-- 1. Drop orphaned & test-only RPCs
drop function if exists public.open_session_check_with_type;
drop function if exists public.execute_core_invariants_tests();
drop function if exists public.test_independent_diner_billing();
drop function if exists public.test_pos_session_selection_and_reconciliation();
drop function if exists public.test_takeaway_delivery_independent_sessions();

-- 2. Drop unused tables (0 rows, 0 application references)
drop table if exists public.dining_areas;
drop table if exists public.ai_usage_logs;

-- 3. Drop redundant unused columns on staff_sessions (0 rows, 0 app references)
alter table public.staff_sessions
  drop column if exists device_info,
  drop column if exists ip_address;

commit;

-- ============================================================================
-- ROLLBACK INSTRUCTIONS (if needed after applying)
-- ============================================================================
-- 1. Recreate staff_sessions columns:
--    alter table public.staff_sessions
--      add column if not exists device_info text,
--      add column if not exists ip_address text;
--
-- 2. Recreate dining_areas & ai_usage_logs from 20261113000000_baseline_schema.sql
--    (lines 138-145 and 423-432, plus their RLS policies).
--
-- 3. Recreate execute_core_invariants_tests() from
--    20261117000002_postgrest_relationship_and_core_invariants.sql if needed
--    for test scripts.
-- ============================================================================
