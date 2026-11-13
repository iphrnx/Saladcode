-- ===========================================================================
-- 0058 — Close detection that cannot end a live session
--
-- The restaurant's ask: a diner who closes the menu tab should release the
-- table within a couple of minutes, not after the 30-minute idle window.
--
-- This existed once and was removed (see the note in the table-session
-- validate route): the page stamped the session as it unloaded and the server
-- ended it three seconds later. But `pagehide` fires on refresh, app
-- switches, phone locks and bfcache entries, so diners who had simply put
-- their phone down came back to an ended session.
--
-- The stamp is back, but it is no longer a verdict. `close_pending_at` only
-- *ends* a session when all of these hold:
--
--   * the stamp is older than two minutes (a refresh reloads in seconds and
--     heartbeats again almost immediately; a closed tab never does);
--   * no heartbeat landed after the stamp (`last_seen_at < close_pending_at`)
--     — a heartbeat newer than the stamp is proof the page came back, which
--     also makes a late-arriving beacon harmless: it can re-stamp a live
--     session, and the page's next heartbeat disproves it within seconds;
--   * the session has no order at all, in any state — the same protection
--     `session_is_abandoned` enforces. An ordered table is the restaurant's
--     to close, never the browser's.
--
-- The 30-minute no-order rule from 0041 stays as the backstop for browsers
-- that never fire `pagehide` (crashes, OS reclaiming the tab).
-- ===========================================================================

alter table public.table_sessions
  add column if not exists close_pending_at timestamptz;

-- Read-only and `security invoker`, exactly like session_is_abandoned.
create or replace function public.session_close_expired(p_session_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
      from public.table_sessions s
     where s.id = p_session_id
       and s.status = 'ACTIVE'
       and s.close_pending_at is not null
       and s.close_pending_at < now() - interval '120 seconds'
       -- A heartbeat newer than the stamp means the unload was a refresh, an
       -- app switch or a phone lock — the diner is still there.
       and s.last_seen_at < s.close_pending_at
       -- Any order at all, in any state.
       and not exists (
         select 1
           from public.orders o
          where o.table_session_id = s.id
       )
  );
$$;

revoke execute on function public.session_close_expired(uuid) from public, anon, authenticated;

-- The sweep now releases two kinds of table: the ones nobody ordered at for
-- thirty minutes (0041) and the ones whose page closed two minutes ago and
-- never came back (this migration). Both predicates carry the same no-order
-- protection.
create or replace function public.expire_stale_table_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.table_sessions s
       set status = 'ENDED',
           ended_at = now()
     where s.status = 'ACTIVE'
       and (
         public.session_is_abandoned(s.id)
         or public.session_close_expired(s.id)
       )
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;

revoke execute on function public.expire_stale_table_sessions() from public, anon, authenticated;
