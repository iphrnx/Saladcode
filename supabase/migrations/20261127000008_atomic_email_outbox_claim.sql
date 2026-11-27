-- ============================================================================
-- Migration: 20261127000008_atomic_email_outbox_claim.sql
-- Purpose:
--   Atomically claim due pending rows from public.email_events using
--   FOR UPDATE SKIP LOCKED and a short lease on next_attempt_at so concurrent
--   webhook/email workers cannot send duplicate emails, while crashed or
--   failed sends recover automatically once the lease expires.
-- ============================================================================

alter table public.email_events
  drop constraint if exists email_events_status_check;

alter table public.email_events
  add constraint email_events_status_check
  check (status in ('pending', 'sent', 'failed', 'PENDING', 'SENT', 'FAILED'));

create or replace function public.claim_pending_emails(
  p_limit int default 25,
  p_lease_seconds int default 120
)
returns setof public.email_events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select e.id
      from public.email_events e
     where lower(e.status) = 'pending'
       and e.next_attempt_at <= now()
     order by e.created_at asc
     for update skip locked
     limit greatest(1, coalesce(p_limit, 25))
  )
  update public.email_events e
     set next_attempt_at = now() + make_interval(secs => greatest(10, coalesce(p_lease_seconds, 120)))
    from due
   where e.id = due.id
  returning e.*;
end;
$$;

revoke all on function public.claim_pending_emails(int, int) from public, anon, authenticated;
grant execute on function public.claim_pending_emails(int, int) to service_role;
