-- ===========================================================================
-- 0041 — the session policy, in one place
--
-- The rule the restaurant asked for:
--
--   * a diner who scans the QR and never orders is released after 30 minutes
--     of inactivity, so the table comes back on the board;
--   * a session with an order on it is never released automatically — not while
--     the order is pending, not while it is being prepared, not after it is
--     served. It ends when the restaurant ends it, from the POS;
--   * an expired session needs a fresh QR scan.
--
-- The predicate below *is* that rule. The sweep uses it, and so does the
-- validate route (in the edge function, which calls it by name) — one
-- definition, so the board and the diner's own page cannot disagree about
-- whether a session is still good.
--
-- It replaces the two-hour idle window from 0040, which is superseded here.
-- ===========================================================================

-- Read-only and deliberately `security invoker`: it runs as the caller, so the
-- service role sees through RLS and nobody else can be handed a definer's
-- rights. A recreated function gets EXECUTE to PUBLIC back, hence the revoke.
create or replace function public.session_is_abandoned(p_session_id uuid)
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
       -- Inactivity is measured from the diner's own heartbeat. While their
       -- page is open it beats every few seconds; a backgrounded tab is
       -- throttled but still beats, so 30 minutes of silence means the page is
       -- gone rather than merely in the background.
       and s.last_seen_at < now() - interval '30 minutes'
       -- Any order at all, in any state. An ordered table is the restaurant's
       -- to close, not the clock's.
       and not exists (
         select 1
           from public.orders o
          where o.table_session_id = s.id
       )
  );
$$;

revoke execute on function public.session_is_abandoned(uuid) from public, anon, authenticated;

-- The sweep now means exactly "release the tables nobody ordered at": the only
-- sessions it can end are those the predicate calls abandoned.
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
       and public.session_is_abandoned(s.id)
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;

revoke execute on function public.expire_stale_table_sessions() from public, anon, authenticated;
