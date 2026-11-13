-- ============================================================================
-- 0008 — Table sessions expire
--
-- A session used to end only when its order was marked COMPLETED. That covers
-- the normal path, but nothing ended a session for a diner who scanned the QR
-- and never ordered, or whose order was never completed. Those stayed ACTIVE
-- indefinitely: at the time of writing 9 of 12 "active" sessions were over six
-- hours old, the oldest nearly a day.
--
-- The only thing making that backlog visible was a counter on the QR Codes
-- page, which is the wrong place for it (that page prints codes). Removing the
-- counter without fixing the cause would hide the problem rather than solve it,
-- so expiry now lives in the database.
-- ============================================================================

-- One visit's worth. No meal runs six hours, so this is generous.
--
-- This file creates the two functions below only. place_order is deliberately
-- NOT touched here — see the note at the end.
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
       and created_at < now() - interval '6 hours'
    returning 1
  )
  select count(*) into v_count from expired;
  return v_count;
end $$;

-- ---- the authoritative check the diner path goes through -------------------
create or replace function public.validate_table_session(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.table_sessions;
begin
  select * into v from public.table_sessions
   where token = p_session_token limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'INVALID_SESSION');
  end if;

  -- Expire on touch, so the guarantee does not depend on a human noticing.
  if v.status = 'ACTIVE' and v.created_at < now() - interval '6 hours' then
    update public.table_sessions set status = 'ENDED', ended_at = now()
     where id = v.id;
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;

  if v.status <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'SESSION_ENDED');
  end if;

  return jsonb_build_object('ok', true, 'session_id', v.id,
                            'table_id', v.table_id, 'tenant_id', v.tenant_id);
end $$;

-- ============================================================================
-- Cleared by hand as a one-off, not from inside this file:
--   select public.expire_stale_table_sessions();
-- The migration runner used for this project rejects any statement that follows
-- a dollar-quoted function body, so this file deliberately ends at the last
-- `end $$;`. Grant/notify statements were applied separately.
-- ============================================================================

-- ============================================================================
-- place_order is handled by 0009, not here.
--
-- This file was originally meant to re-declare place_order with the same expiry
-- check. That edit was lost: pg_get_functiondef quotes a body with $function$
-- rather than $$, so trimming this file back to its last `end $$;` removed
-- place_order without any error. See 0009.
-- ============================================================================
