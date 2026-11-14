-- 20261114000001_tighten_table_sessions.sql
-- Production tightening for table session ownership, POS order binding, and consolidated billing

-- 1. Redefine check_is_live to consider active orders as well as active sessions
create or replace function public.check_is_live(p_check uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.table_checks c
     where c.id = p_check
       and c.status = 'OPEN'
       and (
         exists (
           select 1 from public.table_sessions s
            where s.table_id = c.table_id
              and s.tenant_id = c.tenant_id
              and s.status = 'ACTIVE'
         )
         or exists (
           select 1 from public.orders o
            where o.check_id = c.id
              and o.status not in ('COMPLETED', 'CANCELLED')
         )
       )
  );
$$;

revoke execute on function public.check_is_live(uuid) from public, anon, authenticated;
grant execute on function public.check_is_live(uuid) to service_role;

-- 2. Open or join consolidated check safely without bouncing existing open checks to UNSETTLED
create or replace function public.open_table_check(
  p_tenant uuid,
  p_table uuid,
  p_session uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.table_checks;
  v_active_session uuid := p_session;
  v_id uuid;
begin
  -- Lock the table for concurrent order creation
  perform pg_advisory_xact_lock(hashtext(p_table::text));

  -- If p_session was not provided, look for an active table session or create an anchor session
  if v_active_session is null then
    select id into v_active_session
      from public.table_sessions
     where tenant_id = p_tenant
       and table_id = p_table
       and status = 'ACTIVE'
     order by created_at desc
     limit 1;
  end if;

  -- If still no active session, create one so the table has a canonical anchor session
  if v_active_session is null then
    insert into public.table_sessions (
      tenant_id, table_id, status, activation_status, token, activated_at
    ) values (
      p_tenant, p_table, 'ACTIVE', 'ACTIVE', encode(gen_random_bytes(24), 'hex'), now()
    )
    returning id into v_active_session;
  end if;

  -- Look for an existing OPEN check for this table
  select * into v_existing
    from public.table_checks
   where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'
   for update;

  if found then
    -- If anchor_session_id is missing, attach our active session
    if v_existing.anchor_session_id is null and v_active_session is not null then
      update public.table_checks
         set anchor_session_id = v_active_session,
             updated_at = now()
       where id = v_existing.id;
    end if;

    -- Return the existing open check! Never mark it UNSETTLED during order addition.
    return v_existing.id;
  end if;

  -- Create a new open check
  insert into public.table_checks (
    tenant_id, table_id, anchor_session_id, status, opened_at
  ) values (
    p_tenant, p_table, v_active_session, 'OPEN', now()
  )
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;

-- 3. Update create_order_tx to ensure session and check are always bound together
create or replace function public.create_order_tx(
  p_order jsonb,
  p_items jsonb,
  p_promo_code_id uuid default null,
  p_idempotency_key uuid default null,
  p_status text default 'PENDING'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid := (p_order->>'tenant_id')::uuid;
  v_order_id uuid;
  v_item jsonb;
  v_menu record;
  v_check uuid;
  v_table uuid := nullif(p_order->>'table_id', '')::uuid;
  v_session uuid := nullif(p_order->>'table_session_id', '')::uuid;
begin
  if p_status not in ('PENDING', 'PENDING_ACTIVATION') then
    raise exception 'INVALID_STATUS:%', p_status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select id into v_order_id from public.orders where idempotency_key = p_idempotency_key;
    if v_order_id is not null then
      return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items where id = (v_item->>'menu_item_id')::uuid;
    if v_menu is null or v_menu.tenant_id <> v_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id';
    end if;
  end loop;

  -- For dine-in table orders, ensure check and session are resolved
  if v_table is not null then
    v_check := public.open_table_check(v_tenant, v_table, v_session);
    if v_session is null then
      select anchor_session_id into v_session
        from public.table_checks
       where id = v_check;
    end if;
  end if;

  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes,
    served_by_id, idempotency_key, check_id
  ) values (
    v_tenant,
    v_table,
    v_session,
    coalesce(p_order->>'order_type', 'DINE_IN'),
    p_status,
    (p_order->>'items_total')::numeric,
    (p_order->>'discount')::numeric,
    (p_order->>'tax')::numeric,
    (p_order->>'service_charge')::numeric,
    (p_order->>'total')::numeric,
    nullif(p_order->>'promo_code_id', '')::uuid,
    nullif(p_order->>'promo_code', ''),
    nullif(p_order->>'customer_name', ''),
    nullif(p_order->>'customer_phone', ''),
    nullif(p_order->>'notes', ''),
    nullif(p_order->>'served_by_id', '')::uuid,
    p_idempotency_key,
    v_check
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select id into v_order_id from public.orders where idempotency_key = p_idempotency_key;
    return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
  end if;

  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant and active
       and (usage_limit = 0 or used_count < usage_limit)
       and valid_from <= now()
       and (valid_until is null or valid_until >= now());
  end if;

  insert into public.order_items (
    order_id, menu_item_id, item_name, variant_name, quantity,
    unit_price, total_price, notes
  )
  select
    v_order_id,
    (value->>'menu_item_id')::uuid,
    value->>'name',
    nullif(value->>'variant_name', ''),
    (value->>'quantity')::integer,
    (value->>'price')::numeric,
    (value->>'total')::numeric,
    nullif(value->>'notes', '')
  from jsonb_array_elements(p_items);

  return jsonb_build_object(
    'order_id', v_order_id,
    'check_id', v_check,
    'table_session_id', v_session,
    'deduplicated', false
  );
end $$;

revoke execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) to service_role;

-- 4. Start table session: if table has an open check or active session, new QR scans join immediately as ACTIVE
create or replace function public.start_table_session(p_qr_token text, p_device_fp text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table public.tables;
  v_tenant public.tenants;
  v_session public.table_sessions;
  v_open boolean;
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

  -- A table is considered open if there is an active session OR an open check
  select (
    exists (
      select 1 from public.table_sessions s
       where s.table_id = v_table.id
         and s.status = 'ACTIVE'
         and s.activation_status = 'ACTIVE'
    ) or exists (
      select 1 from public.table_checks c
       where c.table_id = v_table.id
         and c.status = 'OPEN'
    )
  ) into v_open;

  insert into public.table_sessions (
    tenant_id, table_id, device_fp, activation_status, activation_requested_at, activated_at
  ) values (
    v_table.tenant_id, v_table.id, p_device_fp,
    case when v_open then 'ACTIVE' else 'PENDING' end,
    case when v_open then null else now() end,
    case when v_open then now() else null end
  )
  returning * into v_session;

  return jsonb_build_object(
    'session_token', v_session.token,
    'session_id', v_session.id,
    'status', v_session.status,
    'activation_status', v_session.activation_status,
    'table_id', v_table.id,
    'table_name', v_table.name,
    'tenant_id', v_tenant.id,
    'tenant_name', v_tenant.name,
    'tenant_slug', v_tenant.slug
  );
end $$;

revoke execute on function public.start_table_session(text, text) from public, anon, authenticated;
grant execute on function public.start_table_session(text, text) to service_role;

-- 5. Finalize table check: closes check, issues invoice, completes orders, AND ends all active table sessions
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_check.status = 'PAID' then
    return jsonb_build_object('ok', true, 'already', true, 'invoiceNumber', v_check.invoice_number);
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  -- Require all non-cancelled orders to be served before settlement
  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  select
    coalesce(sum(items_total), 0) as subtotal,
    coalesce(sum(discount), 0)    as discount,
    coalesce(sum(tax), 0)         as tax,
    coalesce(sum(service_charge), 0) as service_charge,
    coalesce(sum(total), 0)       as total
  into v_totals
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  if v_totals.total <= 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + 0.005 < v_totals.total then
    raise exception 'UNPAID:%', round((v_totals.total - v_paid)::numeric, 2)::text using errcode = 'P0001';
  end if;

  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  update public.table_checks
     set status = 'PAID',
         closed_at = now(),
         invoice_number = v_invoice,
         invoice_date = now(),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_paid,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- Atomically end all active table sessions for this table
  update public.table_sessions
     set status = 'ENDED',
         ended_at = now(),
         updated_at = now()
   where tenant_id = p_tenant
     and table_id = v_check.table_id
     and status = 'ACTIVE';

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_paid,
    'completedOrders', v_completed
  );
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;
