-- Record the browser that actually signed in, not the function that relayed it.
--
-- `/auth/login` calls `signInWithPassword` from the edge runtime, so GoTrue
-- wrote the *runtime's* user agent into auth.sessions — every owner sign-in
-- showed up as "Browser · Device", indistinguishable from every other one, and
-- the device grouping had nothing real to group on. The request carries the
-- browser's own user agent; this puts it where the display reads it.
--
-- The pruning rule changes with it: a session is "the same device" when the
-- browser that just signed in matches the stored agent of an earlier session,
-- which is only knowable from the request.

create or replace function public.security_stamp_session(
  p_session_id uuid,
  p_user_agent text,
  p_ip text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update auth.sessions s
     set user_agent = coalesce(nullif(p_user_agent, ''), s.user_agent),
         -- `ip` is inet: only hand it something that parses.
         ip = case
                when p_ip ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
                  or p_ip ~ '^[0-9a-fA-F:]+$'
                then p_ip::inet
                else s.ip
              end
   where s.id = p_session_id;
end;
$$;

-- Keep one session per browser. `p_user_agent` is the agent of the request
-- that just signed in; when it is omitted the kept session's stored agent is
-- used, so older callers keep working.
drop function if exists public.security_prune_sessions(uuid, uuid);

create or replace function public.security_prune_sessions(
  p_user_id uuid,
  p_keep_session_id uuid,
  p_user_agent text default null
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
  v_key := nullif(p_user_agent, '');
  if v_key is null then
    select nullif(s.user_agent, '') into v_key
      from auth.sessions s
     where s.id = p_keep_session_id and s.user_id = p_user_id;
  end if;
  -- Nothing to compare against: do not guess and delete sessions.
  if v_key is null then return 0; end if;

  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from auth.sessions s
   where r.session_id = s.id
     and s.user_id = p_user_id
     and s.id <> p_keep_session_id
     and s.user_agent = v_key
     and not r.revoked;

  delete from auth.sessions s
   where s.user_id = p_user_id
     and s.id <> p_keep_session_id
     and s.user_agent = v_key;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.security_stamp_session(uuid, text, text) from public;
revoke all on function public.security_prune_sessions(uuid, uuid, text) from public;
grant execute on function public.security_stamp_session(uuid, text, text) to service_role;
grant execute on function public.security_prune_sessions(uuid, uuid, text) to service_role;
