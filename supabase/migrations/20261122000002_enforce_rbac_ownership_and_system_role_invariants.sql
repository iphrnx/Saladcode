-- Migration: 20261122000002_enforce_rbac_ownership_and_system_role_invariants.sql
-- Description: Transactional last-active-Owner protection, system-role immutability,
--              and staff ownership invariants at the database level.

-- ---------------------------------------------------------------------------
-- 1. TRANSACTIONAL LAST ACTIVE OWNER PROTECTION
-- ---------------------------------------------------------------------------
create or replace function public.check_last_active_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_owner boolean := false;
  v_remaining_owners integer := 0;
begin
  -- Allow tenant purge operation to proceed without restriction
  if current_setting('app.purging_tenant', true) = 'true' then
    return coalesce(NEW, OLD);
  end if;

  -- Determine if the old row was an active Owner
  if TG_OP in ('UPDATE', 'DELETE') then
    if OLD.active = true then
      if OLD.role ilike 'owner' then
        v_is_owner := true;
      elsif OLD.role_id is not null and exists (
        select 1 from public.roles r
         where r.id = OLD.role_id
           and r.tenant_id = OLD.tenant_id
           and r.is_system = true
           and r.name = 'Owner'
      ) then
        v_is_owner := true;
      end if;
    end if;
  end if;

  -- If old row was not an active owner, no restriction applies
  if not v_is_owner then
    return coalesce(NEW, OLD);
  end if;

  -- If updating and the profile remains an active owner for the same restaurant, allow it
  if TG_OP = 'UPDATE' then
    if NEW.active = true and NEW.tenant_id = OLD.tenant_id then
      if NEW.role ilike 'owner' then
        return NEW;
      elsif NEW.role_id is not null and exists (
        select 1 from public.roles r
         where r.id = NEW.role_id
           and r.tenant_id = NEW.tenant_id
           and r.is_system = true
           and r.name = 'Owner'
      ) then
        return NEW;
      end if;
    end if;
  end if;

  -- An active owner is being deleted, deactivated, demoted, or transferred.
  -- Verify transactionally with row-level locks that at least one other active owner remains.
  select count(*)
    into v_remaining_owners
    from public.profiles p
   where p.tenant_id = OLD.tenant_id
     and p.id <> OLD.id
     and p.active = true
     and (
       p.role ilike 'owner'
       or exists (
         select 1 from public.roles r
          where r.id = p.role_id
            and r.tenant_id = OLD.tenant_id
            and r.is_system = true
            and r.name = 'Owner'
       )
     )
   for update;

  if v_remaining_owners < 1 then
    raise exception 'CANNOT_REMOVE_LAST_ACTIVE_OWNER: Each restaurant must maintain at least one active owner account.'
      using errcode = 'P0001';
  end if;

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_check_last_active_owner on public.profiles;
create trigger trg_check_last_active_owner
  before update or delete on public.profiles
  for each row
  execute function public.check_last_active_owner();

-- ---------------------------------------------------------------------------
-- 2. SYSTEM ROLE IMMUTABILITY
-- ---------------------------------------------------------------------------
create or replace function public.check_system_role_invariants()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.purging_tenant', true) = 'true' then
    return coalesce(NEW, OLD);
  end if;

  if TG_OP = 'DELETE' then
    if OLD.is_system = true then
      raise exception 'SYSTEM_ROLE_CANNOT_BE_DELETED: System roles are built-in and cannot be deleted.'
        using errcode = 'P0001';
    end if;
    return OLD;
  end if;

  if TG_OP = 'UPDATE' then
    if OLD.is_system = true then
      if NEW.name <> OLD.name then
        raise exception 'SYSTEM_ROLE_CANNOT_BE_RENAMED: System roles cannot be renamed.'
          using errcode = 'P0001';
      end if;
      if NEW.permissions <> OLD.permissions then
        raise exception 'SYSTEM_ROLE_PERMISSIONS_IMMUTABLE: System role permissions are fixed and cannot be modified.'
          using errcode = 'P0001';
      end if;
      if NEW.is_system <> true then
        raise exception 'SYSTEM_ROLE_CANNOT_BE_CONVERTED: System roles cannot be converted to custom roles.'
          using errcode = 'P0001';
      end if;
    end if;
    return NEW;
  end if;

  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_check_system_role_invariants on public.roles;
create trigger trg_check_system_role_invariants
  before update or delete on public.roles
  for each row
  execute function public.check_system_role_invariants();

-- ---------------------------------------------------------------------------
-- 3. STAFF ROLE ASSIGNMENT INVARIANTS
-- ---------------------------------------------------------------------------
create or replace function public.check_staff_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if NEW.role_id is not null then
    if exists (
      select 1 from public.roles r
       where r.id = NEW.role_id
         and r.tenant_id = NEW.tenant_id
         and r.is_system = true
         and r.name = 'Owner'
    ) then
      raise exception 'OWNER_ROLE_NOT_ASSIGNABLE_TO_STAFF: The Owner role is reserved for restaurant account owners and cannot be assigned to staff PIN accounts.'
        using errcode = 'P0001';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_check_staff_role_assignment on public.staff;
create trigger trg_check_staff_role_assignment
  before insert or update on public.staff
  for each row
  execute function public.check_staff_role_assignment();

-- ---------------------------------------------------------------------------
-- 4. UPDATE PURGE_TENANT TO SET TRANSACTION CONTEXT
-- ---------------------------------------------------------------------------
create or replace function public.purge_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removed jsonb := '{}'::jsonb;
  v_count integer;
begin
  -- Set transaction-scoped configuration flag to bypass invariant triggers during purge
  perform set_config('app.purging_tenant', 'true', true);

  execute 'delete from public.order_items oi using public.orders o where oi.order_id = o.id and o.tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('order_items', v_count);

  execute 'delete from public.orders where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('orders', v_count);

  execute 'delete from public.check_payments where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.table_checks where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.table_sessions where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tables where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.dining_areas where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.menu_items where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.categories where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.reservations where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.promo_codes where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.customer_reviews where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.staff_sessions where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.staff where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.roles where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.settings where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.security_logs where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tenant_realtime where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.locations where tenant_id = $1' using p_tenant_id;

  execute 'delete from public.profiles where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('profiles', v_count);

  update public.tenants
     set name = 'Deleted restaurant',
         slug = 'deleted-' || replace(p_tenant_id::text, '-', ''),
         logo = null,
         tagline = null,
         address = null,
         phone = null,
         email = null,
         active = false,
         onboarding_done = false,
         subscription_status = 'none',
         subscription_plan = null,
         plan = 'starter',
         trial_started_at = null,
         trial_ends_at = null,
         current_period_end = null,
         payment_mode = null
   where id = p_tenant_id;

  return v_removed;
end;
$$;
