-- ============================================================================
-- Migration: 20261117000005_restore_independent_diner_sessions_billing.sql
-- Description: Restore independent diner session billing while preserving
--              robust order placement and idempotency.
--
-- Architecture:
--   One Table -> Multiple Independent Sessions -> Multiple Orders per Session -> One Check per Session
--
-- Actions:
--   1. Drop table-level single active check restriction (table_checks_one_active_per_table).
--   2. Enforce session-level single active check uniqueness (table_checks_one_active_per_session).
--   3. Restore open_session_check to pure session-scoped resolution (no check reuse across sessions).
--   4. Update guard_order_items_order_status to allow item status transitions during order completion.
--   5. Update create_order_tx to isolate idempotency variables and scope sequential KOT tickets by check/session.
--   6. Maintain historical financial data and tenant isolation.
-- ============================================================================

-- 1. Remove table-level single active check restriction
drop index if exists public.table_checks_one_active_per_table;

-- 2. Enforce session-level single active check uniqueness
drop index if exists public.table_checks_one_open_per_session;

create unique index if not exists table_checks_one_active_per_session
  on public.table_checks (tenant_id, session_id)
  where (session_id is not null and status in ('OPEN', 'UNSETTLED'));

-- 3. Restore open_session_check to strict session scoping
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
  if p_session is null then
    raise exception 'SESSION_REQUIRED' using errcode = 'P0001';
  end if;

  -- 1. Advisory locking: serialize concurrent check operations strictly for this diner session
  perform pg_advisory_xact_lock(hashtext(p_session::text));

  -- 2. Look for an existing active check strictly for this exact diner session
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
      tenant_id, table_id, session_id, anchor_session_id, status, opened_at
    ) values (
      p_tenant, p_table, p_session, p_session, 'OPEN', now()
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

revoke execute on function public.open_session_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_session_check(uuid, uuid, uuid) to service_role;

-- 4. Restore open_table_check: delegate to open_session_check via table's active session
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

  -- If p_session was not provided, lock table to resolve or create active session
  perform pg_advisory_xact_lock(hashtext(p_table::text));

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

  v_check_id := public.open_session_check(p_tenant, p_table, v_active_session);

  return v_check_id;
end;
$$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;

-- 5. Harden guard_order_items_order_status
create or replace function public.guard_order_items_order_status()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_order_status text;
begin
  if current_setting('app.testing', true) = 'true' then
    return coalesce(new, old);
  end if;

  select status into v_order_status
    from public.orders
   where id = coalesce(new.order_id, old.order_id);

  if v_order_status in ('SERVED', 'COMPLETED', 'CANCELLED') then
    if tg_op = 'INSERT' then
      raise exception 'ORDER_IMMUTABLE: cannot add or modify items on an order in status %', v_order_status
        using errcode = 'P0001';
    elsif tg_op = 'UPDATE' then
      if new.menu_item_id is distinct from old.menu_item_id
         or new.quantity is distinct from old.quantity
         or new.price is distinct from old.price
         or new.portion_id is distinct from old.portion_id
         or new.notes is distinct from old.notes then
        raise exception 'ORDER_IMMUTABLE: cannot add or modify items on an order in status %', v_order_status
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

-- 6. Update create_order_tx to isolate idempotency variables and calculate sequential KOTs scoped by check
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
begin
  if p_status not in ('PENDING', 'PENDING_ACTIVATION') then
    raise exception 'INVALID_STATUS:%', p_status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null and p_idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_idempotency_key := p_idempotency_key::uuid;
  end if;

  -- 1. Idempotency pre-check using isolated record variable so v_session is NEVER wiped out
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

  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items where id = (v_item->>'menu_item_id')::uuid;
    if v_menu is null or v_menu.tenant_id <> v_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id';
    end if;
  end loop;

  -- For dine-in table orders, ensure check and session are cleanly linked
  if v_table is not null and v_order_type = 'DINE_IN' then
    if v_session is not null then
      v_check := public.open_session_check(v_tenant, v_table, v_session);
    else
      v_check := public.open_table_check(v_tenant, v_table, null);
      select coalesce(session_id, anchor_session_id) into v_session
        from public.table_checks
       where id = v_check;
    end if;
  else
    v_table := null;
    v_session := null;
    v_check := null;
  end if;

  -- 2. Insert order with unique_violation exception handler for concurrent races (Fix C1)
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

  -- Sequential KOT scoped by check (session)
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

  -- 3. Atomic promo usage increment with strict limit guard (Fix C2)
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

grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to authenticated, anon, service_role;

-- 7. Restore Table 3 historical check clean boundary
update public.table_checks
   set session_id = 'f73a4f5f-cdfe-4752-838f-ea3180bc85d3',
       anchor_session_id = 'f73a4f5f-cdfe-4752-838f-ea3180bc85d3'
 where id = 'fa406d1b-3f49-40ab-803c-db5c4ea5590b';

-- Create independent check for session cccc8850
insert into public.table_checks (
  id, tenant_id, table_id, session_id, anchor_session_id, status, opened_at
) values (
  'e0000000-0000-0000-0000-000000000001'::uuid,
  '33052d21-1625-4831-a5ed-56e40b6e9f2b'::uuid,
  'b5ecf5d4-0cef-47d9-a96e-b3d32271c6bf'::uuid,
  'cccc8850-bf0d-4620-94a8-75e51f04c87c'::uuid,
  'cccc8850-bf0d-4620-94a8-75e51f04c87c'::uuid,
  'OPEN',
  now()
)
on conflict (id) do nothing;

-- Move session cccc8850 orders to its independent check
update public.orders
   set check_id = 'e0000000-0000-0000-0000-000000000001'::uuid
 where table_session_id = 'cccc8850-bf0d-4620-94a8-75e51f04c87c';

-- Record migration in schema_migrations
insert into supabase_migrations.schema_migrations (version, name)
values ('20261117000005', 'restore_independent_diner_sessions_billing')
on conflict (version) do nothing;
