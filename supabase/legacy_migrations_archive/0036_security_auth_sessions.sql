-- Real session management against Supabase Auth.
--
-- The dashboard's Security page used to read `user_sessions`, a table that
-- nothing ever wrote to: "Active Sessions" was always 0 and "Revoke All
-- Sessions" deleted from the empty table and reported success. The real
-- sessions live in auth.sessions. PostgREST cannot read the auth schema
-- directly, so these SECURITY DEFINER functions expose exactly the operations
-- the security and bootstrap endpoints need, each scoped to one tenant's
-- profiles so a caller can never see or revoke another restaurant's sessions.

create or replace function public.security_list_sessions(p_tenant_id uuid)
returns table (
  id uuid,
  user_id uuid,
  name text,
  email text,
  created_at timestamptz,
  updated_at timestamptz,
  not_after timestamptz,
  user_agent text,
  ip text,
  aal text
)
language sql
security definer
set search_path = public
stable
as $$
  select s.id, s.user_id, p.name, p.email, s.created_at, s.updated_at,
         s.not_after, s.user_agent, s.ip, s.aal
  from auth.sessions s
  join public.profiles p on p.id = s.user_id
  where p.tenant_id = p_tenant_id
    and (s.not_after is null or s.not_after > now())
  order by s.updated_at desc
$$;

-- Revoke one session: refresh tokens first (so it cannot renew mid-delete),
-- then the session row. Returns sessions removed; 0 means the session did not
-- belong to this tenant or no longer exists.
create or replace function public.security_revoke_session(
  p_tenant_id uuid,
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  -- auth.refresh_tokens.user_id is varchar, so profiles.id is cast to text.
  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from public.profiles p
   where r.session_id = p_session_id
     and r.user_id = p.id::text
     and p.tenant_id = p_tenant_id
     and not r.revoked;

  delete from auth.sessions s
   using public.profiles p
   where s.id = p_session_id
     and s.user_id = p.id
     and p.tenant_id = p_tenant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Revoke every session of every profile in the tenant (the "Revoke All"
-- button; the confirm dialog warns it includes the current session).
create or replace function public.security_revoke_all_sessions(p_tenant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  -- auth.refresh_tokens.user_id is varchar, so profiles.id is cast to text.
  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from public.profiles p
   where r.user_id = p.id::text
     and p.tenant_id = p_tenant_id
     and not r.revoked;

  delete from auth.sessions s
   using public.profiles p
   where s.user_id = p.id
     and p.tenant_id = p_tenant_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Only the service role (edge functions) may call these; the owner-facing
-- endpoints enforce security.view / security.manage on top of the tenant id.
revoke all on function public.security_list_sessions(uuid) from public, authenticated;
revoke all on function public.security_revoke_session(uuid, uuid) from public, authenticated;
revoke all on function public.security_revoke_all_sessions(uuid) from public, authenticated;
grant execute on function public.security_list_sessions(uuid) to service_role;
grant execute on function public.security_revoke_session(uuid, uuid) to service_role;
grant execute on function public.security_revoke_all_sessions(uuid) to service_role;
