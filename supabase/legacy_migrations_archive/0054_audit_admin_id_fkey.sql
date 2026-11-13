-- super_admin_audit_logs.admin_id pointed at profiles.id. Super admins
-- are platform operators, not tenant users — they legitimately have no
-- profile row — so every audit insert failed with 23503 and the table
-- has never held a row. The failure was console-only by design ("the
-- action already happened"), which made it invisible until now.
--
-- The id is an auth user id; reference auth.users instead, and let an
-- audit row survive the admin's account being deleted.

do $$
declare
  fk_name text;
begin
  select conname into fk_name
  from pg_constraint
  where conrelid = 'public.super_admin_audit_logs'::regclass
    and contype = 'f'
    and pg_get_constraintdef(oid) like '%admin_id%';
  if fk_name is not null then
    execute format('alter table public.super_admin_audit_logs drop constraint %I', fk_name);
  end if;
end $$;

alter table public.super_admin_audit_logs
  add constraint super_admin_audit_logs_admin_id_fkey
  foreign key (admin_id) references auth.users (id) on delete set null;
