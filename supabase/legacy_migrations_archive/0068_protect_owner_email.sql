-- The owner's login email belongs to Supabase Auth, not to this database.
--
-- `profiles.email` is a copy made at registration for display and for the
-- audit trail. Nothing may rewrite it: the address a person signs in with is
-- `auth.users.email`, and a profile row that disagrees with it is a lie the
-- interface cannot detect — "your login email" would show one thing while the
-- login accepted another.
--
-- The column grant already stops `authenticated` from writing it (only name,
-- phone, avatar and updated_at are granted). This adds the same rule to the
-- trigger that guards the other privileged columns, so a future grant, a
-- policy change or a query written by hand cannot quietly reopen it.
--
-- The account identifier stays `auth.users.id`, mirrored by `profiles.id`.
-- Nothing here uses an email to decide ownership or super-admin rights.

create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  -- `anon` and `authenticated` are the only two roles a browser can end up as.
  -- The service role, used by the edge functions, is not in this list and
  -- keeps full write access — the functions are what create a profile in the
  -- first place.
  if current_setting('role', true) in ('anon', 'authenticated') then
    if new.is_super_admin        is distinct from old.is_super_admin
       or new.role_id            is distinct from old.role_id
       or new.role               is distinct from old.role
       or new.tenant_id          is distinct from old.tenant_id
       or new.active             is distinct from old.active
       or new.two_factor_enabled is distinct from old.two_factor_enabled
       -- The login email is proved by Supabase Auth, not by an UPDATE.
       or new.email              is distinct from old.email
    then
      raise exception 'privileged profile fields cannot be changed by this session'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

comment on column public.profiles.email is
  'Mirror of auth.users.email, written once at registration. Never editable: the sign-in address is owned by Supabase Auth.';
