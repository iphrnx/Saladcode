-- ============================================================================
-- Migration: 20261127000001_restrict_profile_updates_and_scope_storage_policies.sql
-- Purpose:
--   1. Restrict self-service updates on public.profiles to personal fields
--      (name, phone, avatar, updated_at) for authenticated users, keeping
--      tenant_id, role_id, role, active, and other system/security columns
--      writable only through authorized server operations (service_role).
--   2. Scope storage.objects INSERT and UPDATE policies for menu-images and
--      restaurant-logos to the owning restaurant's folder (<tenant_id>/...)
--      and the caller's existing permissions (menu.manage / settings.manage),
--      while preserving public SELECT rendering and legitimate uploads/upserts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PUBLIC.PROFILES COLUMN-LEVEL PRIVILEGE HARDENING
-- ---------------------------------------------------------------------------
-- Baseline schema granted ALL on public.profiles to anon and authenticated,
-- allowing an authenticated user to PATCH their own tenant_id, role_id, role,
-- or active flag directly via PostgREST despite the row-ownership RLS policy.
-- Revoke broad privileges and grant only SELECT + personal-field UPDATE to
-- authenticated; service_role retains ALL for authorized server operations.

revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (name, phone, avatar, updated_at) on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- 2. TENANT-SCOPED STORAGE ASSET PERMISSION HELPER
-- ---------------------------------------------------------------------------
-- Evaluates whether auth.uid() is an active profile belonging to the tenant
-- named by the first path segment (<tenant_id>/...) and holds p_permission.
-- Uses SECURITY DEFINER because public.roles has RLS enabled with no direct
-- authenticated SELECT policy.

create or replace function public.can_manage_tenant_asset(
  p_object_name text,
  p_permission text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_folder text;
  v_tenant_id uuid;
  v_role_id uuid;
  v_active boolean;
  v_perms text;
  v_perm_list text[];
begin
  if v_uid is null then
    return false;
  end if;

  v_folder := (storage.foldername(p_object_name))[1];
  if v_folder is null or v_folder = '' then
    return false;
  end if;

  select p.tenant_id, p.role_id, p.active
    into v_tenant_id, v_role_id, v_active
    from public.profiles p
   where p.id = v_uid;

  if v_tenant_id is null or coalesce(v_active, false) is false then
    return false;
  end if;

  if v_folder <> v_tenant_id::text then
    return false;
  end if;

  -- Legacy / tenant-creator profile without a role_id holds full permissions
  if v_role_id is null then
    return true;
  end if;

  select r.permissions
    into v_perms
    from public.roles r
   where r.id = v_role_id
     and r.tenant_id = v_tenant_id;

  if v_perms is null or btrim(v_perms) = '' then
    return false;
  end if;

  if left(btrim(v_perms), 1) = '[' then
    begin
      select array_agg(btrim(val))
        into v_perm_list
        from jsonb_array_elements_text(v_perms::jsonb) as val;
    exception when others then
      return false;
    end;
  else
    select array_agg(btrim(val))
      into v_perm_list
      from unnest(string_to_array(v_perms, ',')) as val
     where btrim(val) <> '';
  end if;

  return coalesce(p_permission = any(v_perm_list), false);
end;
$$;

revoke all on function public.can_manage_tenant_asset(text, text) from public, anon;
grant execute on function public.can_manage_tenant_asset(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. STORAGE.OBJECTS POLICIES FOR MENU-IMAGES AND RESTAURANT-LOGOS
-- ---------------------------------------------------------------------------
-- Preserve menu_images_public_read and restaurant_logos_public_read (SELECT
-- for anon, authenticated) for public image rendering.
-- Scope INSERT and UPDATE (both USING and WITH CHECK) to the owning
-- restaurant's folder and the caller's menu.manage / settings.manage permission.

drop policy if exists "menu_images_auth_insert" on storage.objects;
create policy "menu_images_auth_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'menu-images'
    and public.can_manage_tenant_asset(name, 'menu.manage')
  );

drop policy if exists "menu_images_auth_update" on storage.objects;
create policy "menu_images_auth_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'menu-images'
    and public.can_manage_tenant_asset(name, 'menu.manage')
  )
  with check (
    bucket_id = 'menu-images'
    and public.can_manage_tenant_asset(name, 'menu.manage')
  );

drop policy if exists "restaurant_logos_auth_insert" on storage.objects;
create policy "restaurant_logos_auth_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'restaurant-logos'
    and public.can_manage_tenant_asset(name, 'settings.manage')
  );

drop policy if exists "restaurant_logos_auth_update" on storage.objects;
create policy "restaurant_logos_auth_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'restaurant-logos'
    and public.can_manage_tenant_asset(name, 'settings.manage')
  )
  with check (
    bucket_id = 'restaurant-logos'
    and public.can_manage_tenant_asset(name, 'settings.manage')
  );
