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

alter table public.email_events
  add column if not exists claim_token uuid;

-- Backfill legacy rows where dispatch fields can be derived reliably.
update public.email_events
   set recipient = coalesce(nullif(btrim(recipient), ''), nullif(btrim(to_email), '')),
       event_type = coalesce(nullif(btrim(event_type), ''), nullif(btrim(template), '')),
       event_key = coalesce(nullif(btrim(event_key), ''), 'legacy:' || id::text)
 where nullif(btrim(recipient), '') is null
    or nullif(btrim(event_type), '') is null
    or nullif(btrim(event_key), '') is null;

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
  -- Explicitly fail pending legacy rows that still lack a usable recipient
  -- or event_type/template so they cannot trigger invalid sends or repeatedly
  -- consume outbox queue capacity.
  update public.email_events e
     set status = 'failed',
         error = 'unsendable legacy email row: missing recipient or event_type',
         claim_token = null
   where lower(e.status) = 'pending'
     and (
       coalesce(nullif(btrim(e.recipient), ''), nullif(btrim(e.to_email), '')) is null
       or coalesce(nullif(btrim(e.event_type), ''), nullif(btrim(e.template), '')) is null
     );

  return query
  with due as (
    select e.id
      from public.email_events e
     where lower(e.status) = 'pending'
       and e.next_attempt_at <= now()
       and coalesce(nullif(btrim(e.recipient), ''), nullif(btrim(e.to_email), '')) is not null
       and coalesce(nullif(btrim(e.event_type), ''), nullif(btrim(e.template), '')) is not null
     order by e.created_at asc
     for update skip locked
     limit greatest(1, coalesce(p_limit, 25))
  )
  update public.email_events e
     set next_attempt_at = now() + make_interval(secs => greatest(10, coalesce(p_lease_seconds, 120))),
         claim_token = gen_random_uuid(),
         recipient = coalesce(nullif(btrim(e.recipient), ''), nullif(btrim(e.to_email), '')),
         event_type = coalesce(nullif(btrim(e.event_type), ''), nullif(btrim(e.template), '')),
         event_key = coalesce(nullif(btrim(e.event_key), ''), 'legacy:' || e.id::text)
    from due
   where e.id = due.id
  returning e.*;
end;
$$;

revoke all on function public.claim_pending_emails(int, int) from public, anon, authenticated;
grant execute on function public.claim_pending_emails(int, int) to service_role;
