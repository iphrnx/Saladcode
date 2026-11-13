-- One row per device, and nothing that is already dead.
--
-- Every sign-in mints a new auth.sessions row and nothing ever removed the old
-- one, so a laptop that signed in fifteen times showed fifteen "active"
-- sessions. GoTrue cannot be told "one session per device", so the tidy-up is
-- explicit:
--
--   * security_list_session_devices — the list the dashboard reads: only
--     sessions that can still be used (a live, non-revoked refresh token and
--     not_after not passed), grouped by the browser that created them, newest
--     activity per group. Different devices have different user agents, so a
--     phone and a laptop stay two rows.
--   * security_prune_sessions — called right after a successful sign-in: the
--     previous session from the same browser is retired, so repeated logins
--     stop accumulating.
--   * security_revoke_session_device — "Revoke" on a grouped row ends every
--     session behind it, so the action cannot leave ghosts of the same device
--     behind.
--
-- The old security_list_sessions stays in place: the functions deployed before
-- this migration still call it, and it is harmless (it is no longer read).

create or replace function public.security_list_session_devices(p_tenant_id uuid)
returns table (
  id uuid,
  session_ids uuid[],
  session_count integer,
  user_id uuid,
  name text,
  email text,
  created_at timestamptz,
  last_active timestamptz,
  first_seen timestamptz,
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
  with live as (
    select s.id, s.user_id, s.created_at, s.updated_at, s.not_after,
           s.user_agent, s.ip::text as ip, s.aal, p.name, p.email,
           coalesce(s.user_agent, '') as device_key
      from auth.sessions s
      join public.profiles p on p.id = s.user_id
     where p.tenant_id = p_tenant_id
       -- Expiry the session itself carries.
       and (s.not_after is null or s.not_after > now())
       -- A session whose refresh tokens are all revoked is a tombstone: it
       -- cannot be refreshed, so it is not a signed-in device.
       and exists (
         select 1 from auth.refresh_tokens r
          where r.session_id = s.id and not r.revoked
       )
  ), ranked as (
    select live.*,
           row_number() over (
             partition by live.user_id, live.device_key
             order by live.updated_at desc, live.created_at desc
           ) as rn,
           max(live.updated_at) over (partition by live.user_id, live.device_key) as last_active,
           min(live.created_at) over (partition by live.user_id, live.device_key) as first_seen,
           array_agg(live.id) over (partition by live.user_id, live.device_key) as session_ids,
           count(*) over (partition by live.user_id, live.device_key) as session_count
      from live
  )
  select id, session_ids, session_count::integer, user_id, name, email,
         created_at, last_active, first_seen, not_after, user_agent, ip, aal
    from ranked
   where rn = 1
   order by last_active desc
$$;

-- Retire the caller's previous sessions from the same browser. Runs after a
-- successful sign-in; the new session is the one kept.
create or replace function public.security_prune_sessions(
  p_user_id uuid,
  p_keep_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_count integer := 0;
begin
  select coalesce(s.user_agent, '') into v_key
    from auth.sessions s
   where s.id = p_keep_session_id and s.user_id = p_user_id;
  -- No such session (or it belongs to someone else): nothing to do.
  if v_key is null then return 0; end if;

  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from auth.sessions s
   where r.session_id = s.id
     and s.user_id = p_user_id
     and s.id <> p_keep_session_id
     and coalesce(s.user_agent, '') = v_key
     and not r.revoked;

  delete from auth.sessions s
   where s.user_id = p_user_id
     and s.id <> p_keep_session_id
     and coalesce(s.user_agent, '') = v_key;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- End every session shown behind one grouped row. Tenant-scoped: a session id
-- from another restaurant matches nothing and returns 0.
create or replace function public.security_revoke_session_device(
  p_tenant_id uuid,
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_key text;
  v_count integer := 0;
begin
  select s.user_id, coalesce(s.user_agent, '')
    into v_user, v_key
    from auth.sessions s
    join public.profiles p on p.id = s.user_id
   where s.id = p_session_id and p.tenant_id = p_tenant_id;
  if v_user is null then return 0; end if;

  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from auth.sessions s
   where r.session_id = s.id
     and s.user_id = v_user
     and coalesce(s.user_agent, '') = v_key
     and not r.revoked;

  delete from auth.sessions s
    using public.profiles p
   where p.id = s.user_id
     and p.tenant_id = p_tenant_id
     and s.user_id = v_user
     and coalesce(s.user_agent, '') = v_key;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.security_list_session_devices(uuid) from public;
revoke all on function public.security_prune_sessions(uuid, uuid) from public;
revoke all on function public.security_revoke_session_device(uuid, uuid) from public;
grant execute on function public.security_list_session_devices(uuid) to service_role;
grant execute on function public.security_prune_sessions(uuid, uuid) to service_role;
grant execute on function public.security_revoke_session_device(uuid, uuid) to service_role;
