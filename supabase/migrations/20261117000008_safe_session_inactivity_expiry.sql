-- ===========================================================================
-- 20261117000008 — Safe 15-Minute Session Inactivity Expiry
--
-- Safely expire genuinely inactive, empty sessions after 15 minutes of silence
-- or 2 minutes after window/tab unload (pagehide beacon) without affecting:
--   1. Any session with orders (in any status: PENDING_ACTIVATION, PENDING,
--      PREPARING, READY, SERVED, COMPLETED).
--   2. Any session with an OPEN or UNSETTLED table check or balance due.
-- ===========================================================================

-- Add timestamp columns if not already present
alter table public.table_sessions
  add column if not exists last_seen_at timestamptz default now(),
  add column if not exists close_pending_at timestamptz;

-- Read-only predicate to test whether a session is truly abandoned
create or replace function public.session_is_abandoned(p_session_id uuid, p_window interval default interval '15 minutes')
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.table_sessions s
     where s.id = p_session_id
       and s.status = 'ACTIVE'
       and coalesce(s.last_seen_at, s.updated_at, s.created_at) < now() - p_window
       -- Hard invariant 1: Session must have NO orders in any status
       and not exists (
         select 1
           from public.orders o
          where o.table_session_id = s.id
       )
       -- Hard invariant 2: Session must have NO open or unsettled table checks
       and not exists (
         select 1
           from public.table_checks c
          where (c.session_id = s.id or c.anchor_session_id = s.id)
            and c.status in ('OPEN', 'UNSETTLED')
       )
  );
$$;

-- Safely expire genuinely abandoned sessions
create or replace function public.expire_stale_table_sessions(p_after interval default interval '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with closed as (
    update public.table_sessions s
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where s.status = 'ACTIVE'
       and (
         -- Inactive for 15+ minutes with zero orders or checks
         coalesce(s.last_seen_at, s.updated_at, s.created_at) < now() - p_after
         -- Or browser tab was closed (pagehide) > 2 mins ago and no heartbeat landed since
         or (
           s.close_pending_at is not null
           and s.close_pending_at < now() - interval '2 minutes'
           and (s.last_seen_at is null or s.last_seen_at < s.close_pending_at)
         )
       )
       -- Invariant 1: Session has ZERO orders in any status
       and not exists (
         select 1
           from public.orders o
          where o.table_session_id = s.id
       )
       -- Invariant 2: Session has ZERO open or unsettled checks
       and not exists (
         select 1
           from public.table_checks c
          where (c.session_id = s.id or c.anchor_session_id = s.id)
            and c.status in ('OPEN', 'UNSETTLED')
       )
     returning 1
  )
  select count(*) into v_count from closed;
  return v_count;
end;
$$;

revoke execute on function public.session_is_abandoned(uuid, interval) from public, anon, authenticated;
revoke execute on function public.expire_stale_table_sessions(interval) from public, anon, authenticated;
grant execute on function public.session_is_abandoned(uuid, interval) to service_role;
grant execute on function public.expire_stale_table_sessions(interval) to service_role;

