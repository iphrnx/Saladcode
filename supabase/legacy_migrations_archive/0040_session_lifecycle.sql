-- ===========================================================================
-- 0040 — a diner session ends when the restaurant ends it
--
-- Two automatic rules used to end sessions, and both guessed from the browser:
--
--   * `closing_at`, stamped by the menu as the page unloaded (POST
--     /table-session/release). `pagehide` fires on a refresh, on switching
--     apps, when a phone locks, and when a browser reclaims a backgrounded
--     page — so it fired constantly for diners who had not gone anywhere. Three
--     seconds later the session was ENDED.
--   * a three-minute idle rule on `last_seen_at`. Mobile browsers throttle
--     timers in a background tab to roughly one a minute and iOS suspends them
--     entirely, so a three-minute gap said nothing about whether anyone was
--     still at the table. The diner's own next heartbeat was what wrote the
--     status, which meant a session with a freshly placed, still-pending order
--     could be closed while the diner waited for their food — and the menu then
--     showed the bill and the review prompt.
--
-- Neither rule lives in the validate path any more (the edge function was
-- changed with this migration). What remains is this sweep, whose only job is
-- to clear a table nobody ever came back to. It now requires a long silence
-- *and* that the kitchen has nothing outstanding on the session.
--
-- (Amended in the same session: the order exclusion now covers both rules, not
-- just the idle one, so the six-hour ceiling cannot close a table with a live
-- order either.)
--
-- A session is otherwise ended by the restaurant: POST /table-session/end,
-- which is the POS action, gated behind `tables.manage`.
-- ===========================================================================

create or replace function public.expire_stale_table_sessions()
returns integer
language plpgsql
security definer
-- Fully qualified below, and pinned so a caller cannot redirect it.
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
       -- Nothing outstanding in the kitchen, whatever else is true. An order
       -- the restaurant is still working on outranks both rules below, so the
       -- sweep can never close a table someone is waiting to be served at.
       and not exists (
         select 1
           from public.orders o
          where o.table_session_id = s.id
            and o.status in ('PENDING', 'PREPARING', 'READY')
       )
       and (
         -- The ceiling: no session lives longer than this.
         s.created_at < now() - interval '6 hours'
         -- Nobody has loaded the menu on this session for two hours.
         or s.last_seen_at < now() - interval '2 hours'
       )
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;

-- A recreated function gets the default grant back: EXECUTE to PUBLIC, which in
-- Supabase means `anon`. This one runs as the owner and takes no arguments, so
-- leaving it open would be an anonymous "end everyone's sessions" button — the
-- same mistake as migration 0036, which 0039 had to clean up. The sweep is
-- called with the service role from the edge functions only.
revoke execute on function public.expire_stale_table_sessions() from public, anon, authenticated;

-- Nothing reads the closing marker any more; clear the stamps left on live
-- sessions so no future reader inherits one.
update public.table_sessions set closing_at = null where closing_at is not null;
