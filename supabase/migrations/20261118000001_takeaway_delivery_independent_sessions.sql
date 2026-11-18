-- ============================================================================
-- Migration: 20261118000001_takeaway_delivery_independent_sessions.sql
-- Description: Extend proven independent session architecture to Takeaway & Delivery:
--              1. Make table_id nullable on table_sessions & table_checks
--              2. Add order_type and customer metadata to table_sessions & table_checks
--              3. Adapt open_session_check, create_order_tx, and settle_check_on_session_end
--                 to support table-less independent sessions atomically
--              4. Ensure sequential KOT tickets, independent billing, and atomic closure
-- ============================================================================

-- 1. Schema adaptations: Allow table_id to be nullable for table-less sessions
alter table public.table_sessions
  alter column table_id drop not null;

alter table public.table_sessions
  add column if not exists order_type text not null default 'DINE_IN'
    check (order_type in ('DINE_IN', 'TAKEAWAY', 'DELIVERY')),
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists notes text;

update public.table_sessions
   set order_type = 'DINE_IN'
 where order_type is null;

create index if not exists idx_table_sessions_tenant_type_status
  on public.table_sessions (tenant_id, order_type, status, created_at desc);

-- 2. Schema adaptations: Allow table_id to be nullable on table_checks
alter table public.table_checks
  alter column table_id drop not null;

alter table public.table_checks
  add column if not exists order_type text not null default 'DINE_IN'
    check (order_type in ('DINE_IN', 'TAKEAWAY', 'DELIVERY'));

update public.table_checks
   set order_type = 'DINE_IN'
 where order_type is null;

create index if not exists idx_table_checks_tenant_session_status
  on public.table_checks (tenant_id, session_id, status);

-- 3. Dedicated atomic RPC to open or retrieve a check for an individual session
create or replace function public.open_session_check(
  p_tenant uuid,
  p_table uuid,
  p_session uuid,
  p_order_type text default 'DINE_IN'
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
  if p_session is null then
    raise exception 'SESSION_REQUIRED' using errcode = 'P0001';
  end if;

  -- 1. Advisory locking: serialize concurrent check operations strictly for this session
  perform pg_advisory_xact_lock(hashtext(p_session::text));

  -- 2. Look for an existing active check strictly for this exact session
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

  -- 3. Create a brand-new independent check strictly bound to this session
  begin
    insert into public.table_checks (
      tenant_id, table_id, session_id, anchor_session_id, order_type, status, opened_at
    ) values (
      p_tenant, p_table, p_session, p_session, coalesce(p_order_type, 'DINE_IN'), 'OPEN', now()
    )
    returning id into v_id;

    return v_id;
  exception
    when unique_violation then
      -- Concurrency race safety: return the active check created by concurrent transaction for this session
      select id into v_id
        from public.table_checks
       where tenant_id = p_tenant
         and session_id = p_session
         and status in ('OPEN', 'UNSETTLED')
       order by opened_at desc
       limit 1;
      if v_id is not null then
        return v_id;
      end if;
      raise;
  end;
end;
$$;

revoke execute on function public.open_session_check(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.open_session_check(uuid, uuid, uuid, text) to service_role;

-- 4. Update settle_check_on_session_end to handle table-less sessions cleanly
create or replace function public.settle_check_on_session_end(
  p_tenant uuid,
  p_table uuid,
  p_actor uuid default null,
  p_session uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks;
  v_open_orders integer;
  v_paid numeric(12, 2);
  v_total numeric(12, 2);
begin
  if p_session is not null then
    select * into v_check
      from public.table_checks
     where tenant_id = p_tenant and session_id = p_session and status = 'OPEN'
     for update;
  elsif p_table is not null then
    select * into v_check
      from public.table_checks
     where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'
     order by opened_at desc
     limit 1
     for update;
  end if;

  if not found or v_check.id is null then
    return jsonb_build_object('ok', true, 'action', 'none');
  end if;

  if public.check_is_live(v_check.id) then
    return jsonb_build_object('ok', true, 'action', 'sitting_open');
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = v_check.id
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    return jsonb_build_object('ok', true, 'action', 'orders_open', 'orders', v_open_orders);
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders where check_id = v_check.id and status <> 'CANCELLED';

  if v_total <= 0 then
    update public.table_checks
       set status = 'VOID', closed_at = now(), updated_at = now()
     where id = v_check.id;
    return jsonb_build_object('ok', true, 'action', 'voided_empty');
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = v_check.id and status = 'SUCCEEDED';

  if v_paid + 0.005 >= v_total then
    return public.finalize_table_check(p_tenant, v_check.id, p_actor);
  end if;

  update public.table_checks
     set status = 'UNSETTLED',
         unsettled_at = now(),
         updated_at = now()
   where id = v_check.id;

  return jsonb_build_object('ok', true, 'action', 'unsettled', 'due', v_total - v_paid);
end;
$$;

revoke execute on function public.settle_check_on_session_end(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_check_on_session_end(uuid, uuid, uuid, uuid) to service_role;

-- 5. Update create_order_tx to support Takeaway & Delivery independent sessions
create or replace function public.create_order_tx(
  p_order jsonb,
  p_items jsonb,
  p_promo_code_id uuid default null,
  p_idempotency_key text default null,
  p_status text default 'PENDING'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_tenant uuid := (p_order->>'tenant_id')::uuid;
  v_table uuid := nullif(p_order->>'table_id', '')::uuid;
  v_session uuid := nullif(p_order->>'table_session_id', '')::uuid;
  v_order_type text := coalesce(p_order->>'order_type', 'DINE_IN');
  v_idempotency_key uuid := null;
  v_order_id uuid;
  v_order_num integer;
  v_existing_order record;
  v_item jsonb;
  v_menu record;
  v_portion record;
  v_portion_id uuid;
  v_portion_price numeric(10, 2);
  v_portion_name text;
  v_item_price numeric(10, 2);
  v_qty integer;
  v_kot_num integer;
  v_check uuid;
  v_check_totals record;
begin
  if p_status not in ('PENDING', 'PENDING_ACTIVATION') then
    raise exception 'INVALID_STATUS:%', p_status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null and p_idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_idempotency_key := p_idempotency_key::uuid;
  end if;

  -- 1. Idempotency pre-check
  if v_idempotency_key is not null then
    select id, order_number, check_id, table_session_id
      into v_existing_order
      from public.orders
     where idempotency_key = v_idempotency_key
       and tenant_id = v_tenant;
    if v_existing_order.id is not null then
      return jsonb_build_object(
        'order_id', v_existing_order.id,
        'order_number', v_existing_order.order_number,
        'check_id', v_existing_order.check_id,
        'table_session_id', v_existing_order.table_session_id,
        'deduplicated', true
      );
    end if;
  end if;

  -- Validate menu items availability
  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items where id = (v_item->>'menu_item_id')::uuid;
    if v_menu is null or v_menu.tenant_id <> v_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id';
    end if;
  end loop;

  -- 2. Session and Check resolution based on order_type
  if v_order_type = 'DINE_IN' then
    if v_table is not null then
      if v_session is not null then
        select id into v_session
          from public.table_sessions
         where id = v_session and tenant_id = v_tenant and table_id = v_table and status = 'ACTIVE';
        if v_session is null then
          raise exception 'SESSION_INVALID_OR_ENDED' using errcode = 'P0001';
        end if;
        v_check := public.open_session_check(v_tenant, v_table, v_session, 'DINE_IN');
      else
        v_check := public.open_table_check(v_tenant, v_table, null);
        select coalesce(session_id, anchor_session_id) into v_session
          from public.table_checks
         where id = v_check;
      end if;
    else
      raise exception 'TABLE_REQUIRED_FOR_DINE_IN' using errcode = 'P0001';
    end if;
  elsif v_order_type in ('TAKEAWAY', 'DELIVERY') then
    v_table := null; -- No physical table
    if v_session is not null then
      -- Explicitly joining an active takeaway/delivery session
      select id into v_session
        from public.table_sessions
       where id = v_session
         and tenant_id = v_tenant
         and order_type = v_order_type
         and status = 'ACTIVE';
      if v_session is null then
        raise exception 'SESSION_INVALID_OR_ENDED' using errcode = 'P0001';
      end if;
      v_check := public.open_session_check(v_tenant, null, v_session, v_order_type);
    else
      -- Brand-new independent Takeaway or Delivery session created atomically
      insert into public.table_sessions (
        tenant_id, table_id, order_type, status, activation_status,
        token, customer_name, customer_phone, notes, activated_at
      ) values (
        v_tenant, null, v_order_type, 'ACTIVE', 'ACTIVE',
        encode(extensions.gen_random_bytes(24), 'hex'),
        nullif(p_order->>'customer_name', ''),
        nullif(p_order->>'customer_phone', ''),
        nullif(p_order->>'notes', ''),
        now()
      )
      returning id into v_session;

      v_check := public.open_session_check(v_tenant, null, v_session, v_order_type);
    end if;
  else
    v_table := null;
    v_session := null;
    v_check := null;
  end if;

  -- 3. Insert order
  begin
    insert into public.orders (
      tenant_id, table_id, table_session_id, order_type, status,
      items_total, discount, tax, service_charge, total,
      promo_code_id, promo_code, customer_name, customer_phone, notes,
      served_by_id, idempotency_key, check_id
    ) values (
      v_tenant,
      v_table,
      v_session,
      v_order_type,
      p_status,
      coalesce((p_order->>'items_total')::numeric, 0),
      coalesce((p_order->>'discount')::numeric, 0),
      coalesce((p_order->>'tax')::numeric, 0),
      coalesce((p_order->>'service_charge')::numeric, 0),
      coalesce((p_order->>'total')::numeric, 0),
      nullif(p_order->>'promo_code_id', '')::uuid,
      nullif(p_order->>'promo_code', ''),
      nullif(p_order->>'customer_name', ''),
      nullif(p_order->>'customer_phone', ''),
      nullif(p_order->>'notes', ''),
      nullif(p_order->>'served_by_id', '')::uuid,
      v_idempotency_key,
      v_check
    )
    returning id, order_number into v_order_id, v_order_num;
  exception
    when unique_violation then
      if v_idempotency_key is not null then
        select id, order_number, check_id, table_session_id
          into v_existing_order
          from public.orders
         where idempotency_key = v_idempotency_key
           and tenant_id = v_tenant;
        if v_existing_order.id is not null then
          return jsonb_build_object(
            'order_id', v_existing_order.id,
            'order_number', v_existing_order.order_number,
            'check_id', v_existing_order.check_id,
            'table_session_id', v_existing_order.table_session_id,
            'deduplicated', true
          );
        end if;
      end if;
      raise;
  end;

  -- 4. Sequential KOT scoped by check (session)
  if v_check is not null then
    select coalesce(max(oi.kot_number), 0) + 1 into v_kot_num
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where o.check_id = v_check;
  elsif v_session is not null then
    select coalesce(max(oi.kot_number), 0) + 1 into v_kot_num
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where o.table_session_id = v_session;
  else
    select coalesce(max(kot_number), 0) + 1 into v_kot_num
      from public.order_items
     where order_id = v_order_id;
  end if;

  -- 5. Insert order items
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_portion_id := nullif(v_item->>'portion_id', '')::uuid;
    v_portion_name := null;
    v_portion_price := null;

    if v_portion_id is not null then
      select id, name, price into v_portion
        from public.dish_portions
       where id = v_portion_id and menu_item_id = (v_item->>'menu_item_id')::uuid;
      if v_portion.id is not null then
        v_portion_name := v_portion.name;
        v_portion_price := v_portion.price;
      end if;
    end if;

    v_item_price := coalesce(v_portion_price, (v_item->>'price')::numeric);
    v_qty := coalesce((v_item->>'quantity')::integer, 1);

    insert into public.order_items (
      order_id, menu_item_id, name, portion_id, portion,
      price, quantity, notes, status, kot_number
    ) values (
      v_order_id,
      (v_item->>'menu_item_id')::uuid,
      v_item->>'name',
      v_portion_id,
      v_portion_name,
      v_item_price,
      v_qty,
      nullif(v_item->>'notes', ''),
      p_status,
      v_kot_num
    );
  end loop;

  -- 6. Update running totals on table_checks if attached
  if v_check is not null then
    select
      coalesce(sum(items_total), 0) as subtotal,
      coalesce(sum(discount), 0)    as discount,
      coalesce(sum(tax), 0)         as tax,
      coalesce(sum(service_charge), 0) as service_charge,
      coalesce(sum(total), 0)       as total
    into v_check_totals
      from public.orders
     where check_id = v_check
       and status not in ('CANCELLED', 'PENDING_ACTIVATION');

    update public.table_checks
       set subtotal = v_check_totals.subtotal,
           discount = v_check_totals.discount,
           tax = v_check_totals.tax,
           service_charge = v_check_totals.service_charge,
           total = v_check_totals.total,
           updated_at = now()
     where id = v_check;
  end if;

  -- 7. Atomic promo usage increment
  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant and active
       and (usage_limit = 0 or used_count < usage_limit)
       and valid_from <= now()
       and (valid_to is null or valid_to >= now());
    if not found then
      raise exception 'PROMO_REJECTED: Promo code is invalid, expired, or usage limit reached' using errcode = 'P0001';
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_num,
    'check_id', v_check,
    'table_session_id', v_session
  );
end;
$$;

revoke execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to service_role;

-- 6. Update add_items_to_order_tx to keep check totals synchronized
create or replace function public.add_items_to_order_tx(
  p_order_id uuid,
  p_tenant uuid,
  p_items jsonb,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_order public.orders;
  v_item jsonb;
  v_menu record;
  v_portion record;
  v_portion_id uuid;
  v_portion_name text;
  v_portion_price numeric(10, 2);
  v_item_price numeric(10, 2);
  v_next_kot integer;
  v_items_total numeric(12, 2) := 0;
  v_tax_rate numeric(6, 4) := 0.08;
  v_service_rate numeric(6, 4) := 0;
  v_tenant record;
  v_discount numeric(12, 2);
  v_tax numeric(12, 2);
  v_service_charge numeric(12, 2);
  v_total numeric(12, 2);
  v_existing_kot integer;
  v_count integer := 0;
  v_check_totals record;
begin
  select * into v_order
    from public.orders
   where id = p_order_id and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_order.order_type not in ('TAKEAWAY', 'DELIVERY') then
    raise exception 'INVALID_ORDER_TYPE:%', v_order.order_type using errcode = 'P0001';
  end if;

  if v_order.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'ORDER_LIFECYCLE_CLOSED:%', v_order.status using errcode = 'P0001';
  end if;

  if v_order.payment_status in ('PAID', 'paid') then
    raise exception 'ORDER_ALREADY_PAID' using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select kot_number into v_existing_kot
      from public.order_items
     where order_id = p_order_id and idempotency_key = p_idempotency_key
     limit 1;
    if v_existing_kot is not null then
      return jsonb_build_object(
        'ok', true,
        'deduplicated', true,
        'order_id', p_order_id,
        'kot_number', v_existing_kot
      );
    end if;
  end if;

  -- Calculate next separate KOT number (scoped by check if present, otherwise by order)
  if v_order.check_id is not null then
    select coalesce(max(kot_number), 0) + 1
      into v_next_kot
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
     where o.check_id = v_order.check_id;
  else
    select coalesce(max(kot_number), 1) + 1
      into v_next_kot
      from public.order_items
     where order_id = p_order_id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available, price, name into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;

    if v_menu is null or v_menu.tenant_id <> p_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', (v_item->>'menu_item_id') using errcode = 'P0001';
    end if;

    v_portion_id := nullif(v_item->>'portion_id', '')::uuid;
    v_portion_name := null;
    v_portion_price := null;

    if v_portion_id is not null then
      select id, name, price into v_portion
        from public.dish_portions
       where id = v_portion_id and menu_item_id = v_menu.id;
      if v_portion.id is not null then
        v_portion_name := v_portion.name;
        v_portion_price := v_portion.price;
      end if;
    end if;

    v_item_price := coalesce(v_portion_price, v_menu.price);

    insert into public.order_items (
      order_id,
      menu_item_id,
      name,
      portion_id,
      portion,
      price,
      quantity,
      notes,
      status,
      kot_number,
      idempotency_key
    ) values (
      p_order_id,
      v_menu.id,
      coalesce(v_item->>'name', v_menu.name),
      v_portion_id,
      v_portion_name,
      v_item_price,
      greatest(1, (v_item->>'quantity')::integer),
      nullif(v_item->>'notes', ''),
      'PENDING',
      v_next_kot,
      p_idempotency_key
    );
    v_count := v_count + 1;
  end loop;

  -- Recalculate consolidated order totals across all active items
  select coalesce(sum(price * quantity), 0)
    into v_items_total
    from public.order_items
   where order_id = p_order_id
     and status <> 'CANCELLED';

  select
    coalesce(tax_rate, 8.0) / 100.0 as tax_rate,
    coalesce(service_charge, 0.0) / 100.0 as service_rate
  into v_tenant
    from public.tenants
   where id = p_tenant;

  v_tax_rate := v_tenant.tax_rate;
  v_service_rate := v_tenant.service_rate;
  v_discount := coalesce(v_order.discount, 0);

  v_tax := round(((v_items_total - v_discount) * v_tax_rate)::numeric, 2);
  v_service_charge := round((v_items_total * v_service_rate)::numeric, 2);
  v_total := round((v_items_total - v_discount + v_tax + v_service_charge)::numeric, 2);

  update public.orders
     set items_total = v_items_total,
         tax = v_tax,
         service_charge = v_service_charge,
         total = v_total,
         status = case when status in ('READY', 'SERVED') then 'PENDING' else status end,
         updated_at = now()
   where id = p_order_id;

  -- Recalculate check totals if attached
  if v_order.check_id is not null then
    select
      coalesce(sum(items_total), 0) as subtotal,
      coalesce(sum(discount), 0)    as discount,
      coalesce(sum(tax), 0)         as tax,
      coalesce(sum(service_charge), 0) as service_charge,
      coalesce(sum(total), 0)       as total
    into v_check_totals
      from public.orders
     where check_id = v_order.check_id
       and status not in ('CANCELLED', 'PENDING_ACTIVATION');

    update public.table_checks
       set subtotal = v_check_totals.subtotal,
           discount = v_check_totals.discount,
           tax = v_check_totals.tax,
           service_charge = v_check_totals.service_charge,
           total = v_check_totals.total,
           updated_at = now()
     where id = v_order.check_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'order_id', p_order_id,
    'kot_number', v_next_kot,
    'items_count', v_count,
    'items_total', v_items_total,
    'total', v_total
  );
end;
$$;

revoke execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, uuid) to service_role;

