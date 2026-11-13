-- ============================================================================
-- 0019 — Customer Retention & Reports
--
-- Implements logic for identifying inactive users, expiring trials, 
-- and recording administrative report requests.
-- ============================================================================

-- 1. Report Requests Log
-- Tracks when a super-admin generates a CSV export.
create table if not exists public.super_admin_reports (
  id              uuid primary key default gen_random_uuid(),
  admin_id        uuid not null references auth.users(id),
  report_type     text not null, -- 'revenue', 'usage', 'crm'
  filters         jsonb,
  created_at      timestamptz not null default now()
);

-- 2. Security: RLS
alter table public.super_admin_reports enable row level security;

create policy "Super admins can manage reports"
  on public.super_admin_reports
  for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );
