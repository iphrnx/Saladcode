-- ===========================================================================
-- 0020 — Super Admin hardening
--
-- Two things were wrong before this migration:
--
--  1. The RLS policy `profiles_self_write` constrained only the row identity
--     (`id = auth.uid()`), not the columns. Any signed-in restaurant owner
--     could therefore update their own profile and set:
--
--       is_super_admin = true   -> instant access to the global admin API
--       role_id        = null    -> guard() reads a missing role row as
--                                   "grant every permission"
--       tenant_id      = <other> -> move into another restaurant
--
--     This was verified live, not theorised: an ordinary owner set
--     `is_super_admin = true` through the normal client and the super-admin
--     endpoint answered 200.
--
--  2. `anon` and `authenticated` held blanket UPDATE on every column of
--     `profiles`, so RLS was the only thing between a user and the privileged
--     columns — and RLS does not police columns.
--
-- The fix is enforced by Postgres itself, not by application code: an untrusted
-- session has no UPDATE privilege on the privileged columns at all, and a
-- trigger raises if one somehow changes. The service role — what the edge
-- functions use — keeps full access, so no existing flow breaks.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Column-level grants
-- ---------------------------------------------------------------------------

revoke update on public.profiles from anon, authenticated;
grant update (name, avatar, updated_at) on public.profiles to authenticated;

-- Nothing in the browser writes a profile; the auth edge function does it with
-- the service role. RLS already denied these inserts (there is no INSERT
-- policy), so revoking the grant changes no behaviour — it just stops the
-- privileged columns from being writable at all.
revoke insert on public.profiles from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Trigger backstop
-- ---------------------------------------------------------------------------

create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  -- `anon` and `authenticated` are the only two roles a browser can end up
  -- as. The service role, which the edge functions use, is not in this list
  -- and keeps full write access.
  if current_setting('role', true) in ('anon', 'authenticated') then
    if new.is_super_admin      is distinct from old.is_super_admin
       or new.role_id          is distinct from old.role_id
       or new.role             is distinct from old.role
       or new.tenant_id        is distinct from old.tenant_id
       or new.active           is distinct from old.active
       or new.two_factor_enabled is distinct from old.two_factor_enabled
    then
      raise exception 'privileged profile fields cannot be changed by this session'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_privileges on public.profiles;
create trigger profiles_protect_privileges
  before update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- ---------------------------------------------------------------------------
-- 3. Tighten the self-write policy
-- ---------------------------------------------------------------------------

-- `current_tenant_id()` reads the caller's tenant from their own profile, so
-- this blocks moving a profile into another restaurant on top of the trigger.
drop policy if exists profiles_self_write on public.profiles;
create policy profiles_self_write on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (
    id = (select auth.uid())
    and tenant_id = current_tenant_id()
  );

-- ---------------------------------------------------------------------------
-- 4. Is this caller a super admin?
-- ---------------------------------------------------------------------------

-- One definition, used by the RLS policies below and available to the app.
-- SECURITY DEFINER so it can read `profiles` regardless of the caller's own
-- row-level visibility.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and is_super_admin
  );
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The super-admin allowlist
-- ---------------------------------------------------------------------------

-- The allowlist is what the login screen checks before it will send a code.
-- Without it, /superadmin/login was an open signup: signInWithOtp creates the
-- account for any address, so two stray accounts (phrnx@icloud.com and
-- phrnx@gmail.com) were created that way before this migration.
create table if not exists public.super_admins (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references auth.users(id) on delete cascade,
  email        text not null unique,
  label        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.super_admins enable row level security;

drop policy if exists super_admins_read_own on public.super_admins;
create policy super_admins_read_own on public.super_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

-- A super admin may manage the allowlist; nobody else may touch it.
drop policy if exists super_admins_manage on public.super_admins;
create policy super_admins_manage on public.super_admins
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Seed the existing administrator. The row is inserted rather than selected so
-- the migration is idempotent.
insert into public.super_admins (user_id, email, label)
values (
  '74f160c4-5405-46fb-b00e-4ab7a57f6167',
  'phrnxs@gmail.com',
  'System Owner'
)
on conflict (email) do update
  set user_id = excluded.user_id,
      label   = excluded.label;
