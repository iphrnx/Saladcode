-- ============================================================================
-- 0013 — Shorten the idle window to three minutes
--
-- Ten minutes was chosen to be forgiving, but it is the wrong trade for the
-- board: an operator who watches a diner close the menu expects the table to
-- clear, not to linger for ten minutes. The menu polls every 1.5 seconds while
-- open and roughly once a minute when backgrounded, so three minutes of silence
-- still means the menu is genuinely gone.
--
-- This is the fallback. Closing the tab now releases the session directly.
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
         last_seen_at < now() - interval '3 minutes'
         or created_at < now() - interval '6 hours'
       )
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end $$;
