-- ============================================================================
-- Migration: 20261127000007_separate_security_realtime_secret.sql
-- Purpose:
--   Give the Security dashboard its own independent per-tenant Realtime secret
--   in public.tenant_realtime so callers with only security.view never receive
--   the Orders/Tables staffTopic secret (and vice versa).
-- ============================================================================

alter table public.tenant_realtime
  add column if not exists security_secret text not null default encode(gen_random_bytes(24), 'hex');

create or replace function public.ensure_tenant_security_realtime_secret(p_tenant uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
begin
  insert into public.tenant_realtime (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  select security_secret into v_secret from public.tenant_realtime where tenant_id = p_tenant;
  return v_secret;
end;
$$;

revoke execute on function public.ensure_tenant_security_realtime_secret(uuid) from public, anon, authenticated;
grant execute on function public.ensure_tenant_security_realtime_secret(uuid) to service_role;
