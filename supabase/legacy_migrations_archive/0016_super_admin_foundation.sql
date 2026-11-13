-- ============================================================================
-- 0016 — Super Admin Foundation
--
-- Implements a global administrative layer that exists above the tenant level.
-- Super admins can see all tenants and metrics but are stored in a way that
-- prevents regular tenant owners from escalating their own privileges.
-- ============================================================================

-- 1. Add is_super_admin to profiles
-- We use the profiles table as the source of truth for user identities.
alter table public.profiles
  add column if not exists is_super_admin boolean not null default false;

-- 2. Create a dedicated audit log for super-admin actions
-- This ensures every administrative change is traceable.
create table if not exists public.super_admin_audit_logs (
  id              uuid primary key default gen_random_uuid(),
  admin_id        uuid not null references auth.users(id),
  action          text not null,
  target_tenant_id uuid,
  details         jsonb,
  created_at      timestamptz not null default now()
);

-- 3. Security: RLS for the audit log
alter table public.super_admin_audit_logs enable row level security;

create policy "Super admins can view all audit logs"
  on public.super_admin_audit_logs
  for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "Super admins can insert audit logs"
  on public.super_admin_audit_logs
  for insert
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );
