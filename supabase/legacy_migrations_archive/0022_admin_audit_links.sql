-- ===========================================================================
-- 0022 — Link admin records to profiles
--
-- The admin tables recorded who did what with a foreign key to `auth.users`,
-- because that is where the id came from. But PostgREST can only embed a
-- related table when the foreign key points at *that* table, so
-- `profiles!super_admin_audit_logs_admin_id_fkey` and
-- `profiles!tenant_notes_admin_id_fkey` could not be resolved: the audit log
-- and the follow-up notes both failed to load, with a 500.
--
-- `profiles.id` is itself the primary key and a foreign key to `auth.users`,
-- so pointing at `profiles` keeps the same values, keeps referential
-- integrity, and lets the panel show who did what.
-- ===========================================================================

do $$
begin
  alter table public.super_admin_audit_logs
    drop constraint if exists super_admin_audit_logs_admin_id_fkey;
  alter table public.super_admin_audit_logs
    alter column admin_id drop not null;
  alter table public.super_admin_audit_logs
    add constraint super_admin_audit_logs_admin_id_fkey
    foreign key (admin_id) references public.profiles(id) on delete set null;
end $$;

do $$
begin
  alter table public.tenant_notes
    drop constraint if exists tenant_notes_admin_id_fkey;
  alter table public.tenant_notes
    add constraint tenant_notes_admin_id_fkey
    foreign key (admin_id) references public.profiles(id) on delete set null;
end $$;

do $$
begin
  alter table public.support_issues
    drop constraint if exists support_issues_opened_by_fkey;
  alter table public.support_issues
    add constraint support_issues_opened_by_fkey
    foreign key (opened_by) references public.profiles(id) on delete set null;
end $$;
