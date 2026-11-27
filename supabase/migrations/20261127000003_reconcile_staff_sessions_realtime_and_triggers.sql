-- ============================================================================
-- Migration: 20261127000003_reconcile_staff_sessions_realtime_and_triggers.sql
-- Purpose:
--   1. Ensure public.staff_sessions has user_agent (and ip / last_active) on
--      databases upgraded from older schemas where create table if not exists
--      skipped those columns.
--   2. Reconcile supabase_realtime publication for tables the app subscribes to
--      (orders, order_items, tables, table_sessions, table_checks,
--       security_logs, staff_sessions) idempotently.
-- ============================================================================

alter table public.staff_sessions
  add column if not exists user_agent text,
  add column if not exists ip text,
  add column if not exists last_active timestamptz not null default now();

do $$
declare
  v_table text;
  v_tables text[] := array[
    'orders',
    'order_items',
    'tables',
    'table_sessions',
    'table_checks',
    'security_logs',
    'staff_sessions'
  ];
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array v_tables loop
      if exists (
        select 1
          from information_schema.tables
         where table_schema = 'public'
           and table_name = v_table
      ) and not exists (
        select 1
          from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end $$;
