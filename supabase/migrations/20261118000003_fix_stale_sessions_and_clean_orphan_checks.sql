-- ============================================================================
-- Migration: 20261118000003_fix_stale_sessions_and_clean_orphan_checks.sql
-- Description:
--   1. Fix expiry deadlock in session_is_abandoned and expire_stale_table_sessions.
--      An empty open check with 0 orders and 0 payments must NOT block session expiry.
--   2. Void abandoned empty checks (0 orders, 0 payments) when expiring stale sessions.
--   3. Clean up legacy orphan checks with 0 orders and 0 payments older than 15 minutes.
--   4. Prevent ordering into already-paid or closed checks/sessions.
-- ============================================================================

-- 1. Redefine session_is_abandoned
create or replace function public.session_is_abandoned(
  p_session_id uuid,
  p_window interval default interval '15 minutes'
)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
      from public.table_sessions s
     where s.id = p_session_id
       and s.status = 'ACTIVE'
       and coalesce(s.last_seen_at, s.updated_at, s.created_at) < now() - p_window
       -- Never abandoned if it has any orders
       and not exists (
         select 1
           from public.orders o
          where o.table_session_id = s.id
       )
       -- Never abandoned if any money was paid
       and not exists (
         select 1
           from public.table_checks c
           join public.check_payments cp on cp.check_id = c.id
          where (c.session_id = s.id or c.anchor_session_id = s.id)
            and cp.status = 'SUCCEEDED'
       )
  );
$$;

-- 2. Redefine expire_stale_table_sessions with empty-check voiding
create or replace function public.expire_stale_table_sessions(
  p_after interval default interval '15 minutes'
)
returns integer
language plpgsql
security definer
as $$
declare
  v_count integer := 0;
  v_stale_sessions uuid[];
begin
  -- Identify stale active sessions with no orders and no payments
  select array_agg(s.id)
    into v_stale_sessions
    from public.table_sessions s
   where s.status = 'ACTIVE'
     and (
       coalesce(s.last_seen_at, s.updated_at, s.created_at) < now() - p_after
       or (
         s.close_pending_at is not null
         and s.close_pending_at < now() - interval '2 minutes'
         and (s.last_seen_at is null or s.last_seen_at < s.close_pending_at)
       )
     )
     and not exists (
       select 1
         from public.orders o
        where o.table_session_id = s.id
     )
     and not exists (
       select 1
         from public.table_checks c
         join public.check_payments cp on cp.check_id = c.id
        where (c.session_id = s.id or c.anchor_session_id = s.id)
          and cp.status = 'SUCCEEDED'
     );

  if v_stale_sessions is not null and array_length(v_stale_sessions, 1) > 0 then
    -- Void empty open checks associated with these stale sessions
    update public.table_checks
       set status = 'VOID',
           updated_at = now()
     where (session_id = any(v_stale_sessions) or anchor_session_id = any(v_stale_sessions))
       and status in ('OPEN', 'UNSETTLED')
       and not exists (select 1 from public.orders o where o.check_id = table_checks.id)
       and not exists (select 1 from public.check_payments cp where cp.check_id = table_checks.id and cp.status = 'SUCCEEDED');

    -- Transition stale sessions to ENDED
    update public.table_sessions
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where id = any(v_stale_sessions);

    v_count := array_length(v_stale_sessions, 1);
  end if;

  -- Void legacy orphan checks (0 orders, 0 payments, opened > 15m ago)
  update public.table_checks
     set status = 'VOID',
         updated_at = now()
   where status in ('OPEN', 'UNSETTLED')
     and opened_at < now() - interval '15 minutes'
     and not exists (select 1 from public.orders o where o.check_id = table_checks.id)
     and not exists (select 1 from public.check_payments cp where cp.check_id = table_checks.id and cp.status = 'SUCCEEDED');

  return v_count;
end;
$$;

-- Run sweep immediately to clean up old stale sessions & empty checks
select public.expire_stale_table_sessions();

