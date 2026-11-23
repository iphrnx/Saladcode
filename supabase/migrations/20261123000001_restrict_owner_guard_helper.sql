-- Migration: 20261123000001_restrict_owner_guard_helper.sql
-- Description: Revoke direct execution of lock_tenant_for_owner_change and table access
--              on tenant_owner_guard from PUBLIC, anon, and authenticated.
--              Preserves internal trigger execution via SECURITY DEFINER.

revoke all on function public.lock_tenant_for_owner_change(uuid) from public, anon, authenticated;
revoke all on table public.tenant_owner_guard from public, anon, authenticated;
