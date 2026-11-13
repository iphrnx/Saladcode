-- Align `start_table_session` with the application's semantics: every QR scan
-- opens a fresh session (a clean cart per diner), rather than joining an
-- existing one.

create or replace function public.start_table_session(p_qr_token text, p_device_fp text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table   public.tables;
  v_tenant  public.tenants;
  v_session public.table_sessions;
begin
  select * into v_table from public.tables
   where qr_token = p_qr_token and active limit 1;

  if not found then
    raise exception 'INVALID_QR' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_table.tenant_id;
  if not found or not v_tenant.active then
    raise exception 'RESTAURANT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  insert into public.table_sessions (tenant_id, table_id, device_fp)
  values (v_table.tenant_id, v_table.id, p_device_fp)
  returning * into v_session;

  return jsonb_build_object(
    'session_token', v_session.token,
    'session_id',    v_session.id,
    'status',        v_session.status,
    'tenant_id',     v_table.tenant_id,
    'table', jsonb_build_object(
      'id', v_table.id, 'name', v_table.name,
      'seats', v_table.seats, 'area', v_table.area
    )
  );
end $$;
