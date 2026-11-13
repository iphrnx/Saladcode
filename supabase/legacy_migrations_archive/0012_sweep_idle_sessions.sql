-- ============================================================================
-- 0012 — Sweep idle sessions, not just ancient ones
--
-- 0011 made a session end when its own heartbeat goes stale, but that only
-- fires when something polls. A diner who closed the menu never polls again, so
-- the session was never revisited and stayed ACTIVE until the six-hour age cap
-- — the phantom table the change was meant to remove. Measured after 0011:
-- eleven ACTIVE sessions, the oldest silent for 37 minutes.
--
-- The sweep now applies the same idle rule in bulk, so opening the POS board
-- clears anything abandoned. Two rules, either is enough:
--   * silent for 10 minutes  (menu closed)
--   * older than 6 hours      (backstop for a phone that never polled at all)
-- ============================================================================

create or replace function public.expire_stale_table_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.table_sessions
       set status = 'ENDED', ended_at = now()
     where status = 'ACTIVE'
       and (
         last_seen_at < now() - interval '10 minutes'
         or created_at < now() - interval '6 hours'
       )
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end $$;
