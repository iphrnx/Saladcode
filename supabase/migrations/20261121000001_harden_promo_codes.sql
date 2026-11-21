-- Migration: 20261121000001_harden_promo_codes.sql
-- Description: Harden promo codes expiry and concurrency with IST timezone safety
-- Rebuilt strictly from canonical 20261118000002 definition, preserving order_items.name, portions, and checks.

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
  v_portion_elem jsonb;
  v_portion_id text;
  v_portion_name text;
  v_portion_price numeric(10, 2);
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
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id' using errcode = 'P0001';
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
        v_check := public.open_session_check(v_tenant, v_table, v_session);
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
      v_check := public.open_session_check(v_tenant, null, v_session);
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

      v_check := public.open_session_check(v_tenant, null, v_session);
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

  -- 5. Insert order items with TEXT portion_id and JSONB portions resolution
  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available, price, name, portions into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;

    v_portion_id := nullif(trim(v_item->>'portion_id'), '');
    v_portion_name := nullif(trim(v_item->>'portion'), '');
    v_portion_price := null;

    -- If portion specified, match against v_menu.portions jsonb array
    if v_portion_id is not null or v_portion_name is not null then
      if v_menu.portions is not null and jsonb_typeof(v_menu.portions) = 'array' then
        for v_portion_elem in select value from jsonb_array_elements(v_menu.portions) loop
          if (v_portion_id is not null and lower(coalesce(v_portion_elem->>'id', '')) = lower(v_portion_id))
             or (v_portion_name is not null and lower(coalesce(v_portion_elem->>'name', '')) = lower(v_portion_name)) then
            v_portion_name := coalesce(v_portion_elem->>'name', v_portion_name);
            v_portion_price := (v_portion_elem->>'price')::numeric;
            v_portion_id := coalesce(v_portion_elem->>'id', v_portion_id);
            exit;
          end if;
        end loop;
      end if;
    end if;

    v_item_price := coalesce(v_portion_price, (v_item->>'price')::numeric, v_menu.price);
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 1));

    insert into public.order_items (
      order_id, menu_item_id, name, portion_id, portion,
      price, quantity, notes, status, kot_number
    ) values (
      v_order_id,
      v_menu.id,
      coalesce(v_item->>'name', v_menu.name),
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

  -- 7. Atomic promo usage increment with IST calendar dates and safe usage limits
  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant
       and active
       and (usage_limit = 0 or usage_limit is null or used_count < usage_limit)
       and (valid_from is null or (valid_from at time zone 'Asia/Kolkata')::date <= (now() at time zone 'Asia/Kolkata')::date)
       and (valid_to is null or (valid_to at time zone 'Asia/Kolkata')::date >= (now() at time zone 'Asia/Kolkata')::date);
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
