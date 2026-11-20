-- ============================================================================
-- Migration: 20261120000000_align_session_lifecycle_30m_idle.sql
-- Description:
--   1. Align session idle timeout to 30 minutes in public.session_is_abandoned.
--   2. Align session idle timeout to 30 minutes in public.expire_stale_table_sessions.
--   3. Maintain 2-minute close_pending_at grace period and full expiry immunity for orders/payments.
--   4. Schedule expire_stale_table_sessions() via pg_cron every 10 minutes.
-- ============================================================================

-- 1. Redefine session_is_abandoned with 30-minute default window
create or replace function public.session_is_abandoned(
  p_session_id uuid,
  p_window interval default interval '30 minutes'
)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
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

revoke execute on function public.session_is_abandoned(uuid, interval) from public, anon, authenticated;
grant execute on function public.session_is_abandoned(uuid, interval) to service_role;

-- 2. Redefine expire_stale_table_sessions with 30-minute idle window & empty-check voiding
create or replace function public.expire_stale_table_sessions(
  p_after interval default interval '30 minutes'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
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

  -- Void legacy orphan checks (0 orders, 0 payments, opened > 30m ago)
  update public.table_checks
     set status = 'VOID',
         updated_at = now()
   where status in ('OPEN', 'UNSETTLED')
     and opened_at < now() - interval '30 minutes'
     and not exists (select 1 from public.orders o where o.check_id = table_checks.id)
     and not exists (select 1 from public.check_payments cp where cp.check_id = table_checks.id and cp.status = 'SUCCEEDED');

  return v_count;
end;
$$;

revoke execute on function public.expire_stale_table_sessions(interval) from public, anon, authenticated;
grant execute on function public.expire_stale_table_sessions(interval) to service_role;

-- 3. Schedule sweep every 10 minutes via pg_cron if pg_cron is installed/available
do $$
begin
  if exists (
    select 1 from pg_extension where extname = 'pg_cron'
  ) or exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    begin
      create extension if not exists pg_cron with schema extensions;
    exception when others then
      null;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('expire-stale-table-sessions');
    exception when others then
      null;
    end;
    begin
      perform cron.schedule(
        'expire-stale-table-sessions',
        '*/10 * * * *',
        'select public.expire_stale_table_sessions();'
      );
    exception when others then
      null;
    end;
  end if;
end;
$$;
