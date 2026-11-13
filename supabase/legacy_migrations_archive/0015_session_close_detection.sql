-- ============================================================================
-- 0015 — Reliable session-close detection with a grace window
--
-- pagehide fires on BOTH tab close and refresh, so we cannot end a session
-- synchronously on pagehide without killing valid sessions on reload. Instead,
-- pagehide stamps closing_at; a heartbeat (validate) arriving within the grace
-- window clears it. Only sessions whose closing_at has aged past the grace
-- window end up ended — i.e. the tab really went away. The 3-minute idle
-- rule stays as the fallback for browsers that never fire pagehide.
-- ============================================================================

alter table public.table_sessions
  add column if not exists closing_at timestamptz;

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
         or (closing_at is not null and closing_at < now() - interval '3 seconds')
       )
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end $$;
