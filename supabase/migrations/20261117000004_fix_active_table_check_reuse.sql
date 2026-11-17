-- ============================================================================
-- Migration: 20261117000004_fix_active_table_check_reuse.sql
-- Description: Fix critical order-placement failure caused by 23505 unique
--              constraint violation on table_checks_one_active_per_table.
--
-- Root Cause:
--   When placing an order on a table that already has an active check
--   (status IN ('OPEN', 'UNSETTLED')), open_session_check previously searched
--   ONLY by `session_id = p_session`. If the table check had a different session
--   (e.g., from an earlier sitting or staff POS creation), open_session_check
--   blindly attempted to INSERT a duplicate check into public.table_checks.
--   This violated `table_checks_one_active_per_table` (which enforces at most
--   one active check per table), throwing PostgreSQL error 23505 and crashing
--   Edge Function order placement with an unhandled 500.
--
-- Solution:
--   1. Harden open_session_check to check if the specified table already has an
--      active check in ('OPEN', 'UNSETTLED') before inserting a new one.
--   2. If an active check already exists on that table:
--      - Re-link session_id to the incoming active session if the existing session
--        is null or has ended.
--      - Return the existing active check ID.
--   3. Add unique_violation exception handler to catch any concurrent insertion race
--      and return the winning active check cleanly.
--   4. Harden open_table_check to check for existing active checks before creating
--      dummy table_sessions.
-- ============================================================================

-- 1. Harden open_session_check
create or replace function public.open_session_check(
  p_tenant uuid,
  p_table uuid,
  p_session uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.table_checks;
  v_id uuid;
begin
  if p_session is null and p_table is null then
    raise exception 'SESSION_OR_TABLE_REQUIRED' using errcode = 'P0001';
  end if;

  -- 1. Advisory locking: serialize concurrent check operations
  if p_table is not null then
    perform pg_advisory_xact_lock(hashtext(p_table::text));
  elsif p_session is not null then
    perform pg_advisory_xact_lock(hashtext(p_session::text));
  end if;

  -- 2. Check if this exact session already has an active check
  if p_session is not null then
    select * into v_existing
      from public.table_checks
     where tenant_id = p_tenant
       and session_id = p_session
       and status in ('OPEN', 'UNSETTLED')
     order by opened_at desc
     limit 1
     for update;

    if found then
      return v_existing.id;
    end if;
  end if;

  -- 3. If a table is specified, check if the table ALREADY has an active check
  -- (Adhering to the table_checks_one_active_per_table invariant)
  if p_table is not null then
    select * into v_existing
      from public.table_checks
     where tenant_id = p_tenant
       and table_id = p_table
       and status in ('OPEN', 'UNSETTLED')
     order by opened_at desc
     limit 1
     for update;

    if found then
      -- If the check's current session is null or has ended, link it to the incoming active session
      if p_session is not null and (
        v_existing.session_id is null
        or exists (
          select 1 from public.table_sessions
           where id = v_existing.session_id
             and status = 'ENDED'
        )
      ) then
        update public.table_checks
           set session_id = p_session,
               anchor_session_id = coalesce(anchor_session_id, p_session)
         where id = v_existing.id;
      end if;
      return v_existing.id;
    end if;
  end if;

  -- 4. No active check exists for this session or table; create a new open check
  begin
    insert into public.table_checks (
      tenant_id, table_id, session_id, anchor_session_id, status, opened_at
    ) values (
      p_tenant, p_table, p_session, p_session, 'OPEN', now()
    )
    returning id into v_id;

    return v_id;
  exception
    when unique_violation then
      -- Concurrency race safety: if another transaction created an active check concurrently,
      -- retrieve and reuse that active check rather than failing
      if p_table is not null then
        select id into v_id
          from public.table_checks
         where tenant_id = p_tenant
           and table_id = p_table
           and status in ('OPEN', 'UNSETTLED')
         order by opened_at desc
         limit 1;
        if v_id is not null then
          return v_id;
        end if;
      end if;
      raise;
  end;
end;
$$;

revoke execute on function public.open_session_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_session_check(uuid, uuid, uuid) to service_role;

-- 2. Harden open_table_check
create or replace function public.open_table_check(
  p_tenant uuid,
  p_table  uuid,
  p_session uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_active_session uuid := p_session;
  v_check_id uuid;
begin
  if v_active_session is not null then
    return public.open_session_check(p_tenant, p_table, v_active_session);
  end if;

  -- Lock table to prevent race conditions
  perform pg_advisory_xact_lock(hashtext(p_table::text));

  -- First, check if the table already has an active check
  select id, coalesce(session_id, anchor_session_id) into v_check_id, v_active_session
    from public.table_checks
   where tenant_id = p_tenant
     and table_id = p_table
     and status in ('OPEN', 'UNSETTLED')
   order by opened_at desc
   limit 1;

  if v_check_id is not null then
    return v_check_id;
  end if;

  -- If no check exists, resolve or create active session
  select id into v_active_session
    from public.table_sessions
   where tenant_id = p_tenant
     and table_id = p_table
     and status = 'ACTIVE'
   order by created_at desc
   limit 1;

  if v_active_session is null then
    insert into public.table_sessions (
      tenant_id, table_id, status, activation_status, token, activated_at
    ) values (
      p_tenant, p_table, 'ACTIVE', 'ACTIVE', encode(extensions.gen_random_bytes(24), 'hex'), now()
    )
    returning id into v_active_session;
  end if;

  return public.open_session_check(p_tenant, p_table, v_active_session);
end;
$$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;

