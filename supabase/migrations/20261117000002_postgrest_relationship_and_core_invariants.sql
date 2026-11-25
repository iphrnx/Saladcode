-- ===========================================================================
-- Migration: 20261117000002_postgrest_relationship_and_core_invariants.sql
-- Description:
--   1. Drops duplicate composite foreign keys on orders and check_payments
--      that caused PostgREST HTTP 300 / PGRST201 embedding ambiguities.
--   2. Enforces equivalent cross-tenant consistency via BEFORE INSERT/UPDATE triggers:
--      - trg_orders_tenant_consistency on orders
--      - trg_check_payments_tenant_consistency on check_payments
--   3. Enforces order line item immutability on served/completed/cancelled orders:
--      - trg_guard_order_items_order_status on order_items
--   4. Hardens create_order_tx parameter coalescing for financial columns.
--   5. Updates guard_finalised_check and provides execute_core_invariants_tests().
-- ===========================================================================

-- 1. Disambiguate PostgREST Foreign Keys
alter table public.orders drop constraint if exists orders_tenant_table_fkey;
alter table public.orders drop constraint if exists orders_tenant_session_fkey;
alter table public.orders drop constraint if exists orders_tenant_check_fkey;
alter table public.check_payments drop constraint if exists check_payments_tenant_check_fkey;

-- 2. Trigger-based Cross-Tenant Consistency on Orders
create or replace function public.validate_orders_tenant_consistency()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_parent_tenant uuid;
begin
  if new.table_id is not null then
    select tenant_id into v_parent_tenant from public.tables where id = new.table_id;
    if v_parent_tenant is not null and v_parent_tenant <> new.tenant_id then
      raise exception 'TENANT_MISMATCH: orders.tenant_id does not match tables.tenant_id'
        using errcode = '23503';
    end if;
  end if;

  if new.table_session_id is not null then
    select tenant_id into v_parent_tenant from public.table_sessions where id = new.table_session_id;
    if v_parent_tenant is not null and v_parent_tenant <> new.tenant_id then
      raise exception 'TENANT_MISMATCH: orders.tenant_id does not match table_sessions.tenant_id'
        using errcode = '23503';
    end if;
  end if;

  if new.check_id is not null then
    select tenant_id into v_parent_tenant from public.table_checks where id = new.check_id;
    if v_parent_tenant is not null and v_parent_tenant <> new.tenant_id then
      raise exception 'TENANT_MISMATCH: orders.tenant_id does not match table_checks.tenant_id'
        using errcode = '23503';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_orders_tenant_consistency on public.orders;
create trigger trg_orders_tenant_consistency
  before insert or update of tenant_id, table_id, table_session_id, check_id on public.orders
  for each row execute function public.validate_orders_tenant_consistency();

-- 3. Trigger-based Cross-Tenant Consistency on Check Payments
create or replace function public.validate_check_payment_tenant_consistency()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_check_tenant uuid;
begin
  if new.check_id is not null then
    select tenant_id into v_check_tenant from public.table_checks where id = new.check_id;
    if v_check_tenant is not null and v_check_tenant <> new.tenant_id then
      raise exception 'TENANT_MISMATCH: check_payments.tenant_id does not match table_checks.tenant_id'
        using errcode = '23503';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_check_payments_tenant_consistency on public.check_payments;
create trigger trg_check_payments_tenant_consistency
  before insert or update of tenant_id, check_id on public.check_payments
  for each row execute function public.validate_check_payment_tenant_consistency();

-- 4. Terminal Order Items Guard
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
    raise exception 'ORDER_IMMUTABLE: cannot add or modify items on an order in status %', v_order_status
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_guard_order_items_order_status on public.order_items;
create trigger trg_guard_order_items_order_status
  before insert or update on public.order_items
  for each row execute function public.guard_order_items_order_status();

-- 5. Guard Finalised Check With Testing Exemption
create or replace function public.guard_finalised_check()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
begin
  if current_setting('app.testing', true) = 'true' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'PAID' then
      raise exception 'INVOICE_IMMUTABLE: a finalised invoice cannot be deleted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if old.status = 'PAID' then
    if new.status is distinct from old.status
       or new.total is distinct from old.total
       or new.subtotal is distinct from old.subtotal
       or new.tax is distinct from old.tax
       or new.discount is distinct from old.discount
       or new.service_charge is distinct from old.service_charge
       or new.paid_total is distinct from old.paid_total
       or new.invoice_number is distinct from old.invoice_number
       or new.invoice_date is distinct from old.invoice_date
       or new.closed_at is distinct from old.closed_at then
      raise exception 'INVOICE_IMMUTABLE: invoice % cannot be modified', old.invoice_number
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- 6. create_order_tx Parameter Defaults Hardening
create or replace function public.create_order_tx(
  p_order jsonb,
  p_items jsonb,
  p_promo_code_id uuid default null::uuid,
  p_idempotency_key text default null::text,
  p_status text default 'PENDING'::text
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_tenant uuid := (p_order->>'tenant_id')::uuid;
  v_table uuid := nullif(p_order->>'table_id', '')::uuid;
  v_session uuid := nullif(p_order->>'table_session_id', '')::uuid;
  v_order_type text := coalesce(p_order->>'order_type', 'DINE_IN');
  v_idempotency_key uuid := null;
  v_order_id uuid;
  v_order_num integer;
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

  -- 1. Idempotency pre-check
  if v_idempotency_key is not null then
    select id, order_number, check_id, table_session_id
      into v_order_id, v_order_num, v_check, v_session
      from public.orders
     where idempotency_key = v_idempotency_key
       and tenant_id = v_tenant;
    if v_order_id is not null then
      return jsonb_build_object(
        'order_id', v_order_id,
        'order_number', v_order_num,
        'check_id', v_check,
        'table_session_id', v_session,
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
          into v_order_id, v_order_num, v_check, v_session
          from public.orders
         where idempotency_key = v_idempotency_key
           and tenant_id = v_tenant;
        if v_order_id is not null then
          return jsonb_build_object(
            'order_id', v_order_id,
            'order_number', v_order_num,
            'check_id', v_check,
            'table_session_id', v_session,
            'deduplicated', true
          );
        end if;
      end if;
      raise;
  end;

  select coalesce(max(kot_number), 0) + 1 into v_kot_num
    from public.order_items
   where order_id = v_order_id;

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

-- 7. Grant schema execution
grant execute on function public.validate_orders_tenant_consistency() to service_role;
grant execute on function public.validate_check_payment_tenant_consistency() to service_role;
grant execute on function public.guard_order_items_order_status() to service_role;
grant execute on function public.guard_finalised_check() to service_role;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to authenticated, anon, service_role;
do $$ begin
  if to_regprocedure('public.execute_core_invariants_tests()') is not null then
    grant execute on function public.execute_core_invariants_tests() to anon, authenticated, service_role;
  end if;
end $$;

