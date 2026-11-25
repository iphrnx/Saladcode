-- ============================================================================
-- Migration: 20261125000005_cleanup_obsolete_objects.sql
-- Purpose: Minimal cleanup of confirmed obsolete live DB objects.
--
-- Pre-checks verified against live Supabase project (jeuixphibaasbxgaexfg):
--   1. public.open_session_check_with_type: 0 refs in src/, supabase/functions/,
--      supabase/migrations/, and scripts/. Superseded by open_session_check.
--   2. public.dining_areas: 0 rows in live DB, 0 refs in src/ or
--      supabase/functions/. public.tables uses `area text` instead.
--   3. public.ai_usage_logs: 0 rows in live DB, 0 refs in src/,
--      supabase/functions/, or scripts/ (app uses public.ai_request_logs).
--   4. public.staff_sessions(device_info, ip_address): 0 rows in live DB, 0 refs
--      in src/, supabase/functions/, or scripts/ (app uses device, browser, os,
--      ip, user_agent).
--
-- Retained for active integration test suites:
--   - execute_core_invariants_tests(), test_independent_diner_billing(),
--     test_pos_session_selection_and_reconciliation(),
--     test_takeaway_delivery_independent_sessions()
-- ============================================================================

begin;

-- 1. Drop orphaned RPC
drop function if exists public.open_session_check_with_type;

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
-- 2. Recreate dining_areas & ai_usage_logs from 20261113000000_baseline_schema.sql.
-- ============================================================================
