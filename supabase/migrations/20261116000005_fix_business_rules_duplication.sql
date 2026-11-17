-- ===========================================================================
-- Migration: 20261116000005_fix_business_rules_duplication.sql
-- Description: Fix SQL portion price resolution and canonical state constraints
-- ===========================================================================

-- 1. Canonical order status check constraint (Clean up stale REJECTED order status)
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'));

-- 2. Update add_items_to_order_tx to resolve portion prices from menu_items.portions JSONB
create or replace function public.add_items_to_order_tx(
  p_order_id uuid,
  p_tenant uuid,
  p_items jsonb,
  p_idempotency_key text default null
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
  v_p jsonb;
  v_portion_id text;
  v_portion_name text;
  v_portion_price numeric(10, 2);
  v_item_price numeric(10, 2);
  v_next_kot integer;
  v_items_total numeric(12, 2) := 0;
  v_tax_rate numeric(6, 4) := 0.08;
  v_service_rate numeric(6, 4) := 0;
  v_tenant record;
  v_discount numeric(12, 2);
  v_taxable numeric(12, 2);
  v_tax numeric(12, 2);
  v_service_charge numeric(12, 2);
  v_total numeric(12, 2);
  v_existing_kot integer;
  v_count integer := 0;
begin
  -- 1. Row-level exclusive lock on the order row
  select * into v_order
    from public.orders
   where id = p_order_id and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Verify order type (Takeaway or Delivery only)
  if v_order.order_type not in ('TAKEAWAY', 'DELIVERY') then
    raise exception 'INVALID_ORDER_TYPE:%', v_order.order_type using errcode = 'P0001';
  end if;

  -- 3. Verify lifecycle state
  if v_order.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'ORDER_LIFECYCLE_CLOSED:%', v_order.status using errcode = 'P0001';
  end if;

  if v_order.payment_status in ('PAID', 'paid') then
    raise exception 'ORDER_ALREADY_PAID' using errcode = 'P0001';
  end if;

  -- 4. Idempotency check
  if p_idempotency_key is not null then
    select kot_number into v_existing_kot
      from public.order_items
     where order_id = p_order_id and idempotency_key = p_idempotency_key::uuid
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

  -- 5. Calculate next separate KOT number
  select coalesce(max(kot_number), 1) + 1
    into v_next_kot
    from public.order_items
   where order_id = p_order_id;

  -- 6. Insert new items with authoritative server-side price lookup from menu_items.portions JSONB
  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available, price, name, portions into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;

    if v_menu is null or v_menu.tenant_id <> p_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', (v_item->>'menu_item_id') using errcode = 'P0001';
    end if;

    v_portion_id := nullif(v_item->>'portion_id', '');
    v_portion_name := null;
    v_portion_price := null;

    -- Match portion by ID or name in menu_items.portions JSONB array
    if v_portion_id is not null and v_menu.portions is not null and jsonb_typeof(v_menu.portions) = 'array' then
      for v_p in select value from jsonb_array_elements(v_menu.portions) loop
        if lower(coalesce(v_p->>'id', '')) = lower(v_portion_id) or lower(coalesce(v_p->>'name', '')) = lower(v_portion_id) then
          v_portion_id := v_p->>'id';
          v_portion_name := v_p->>'name';
          v_portion_price := (v_p->>'price')::numeric;
          exit;
        end if;
      end loop;
    end if;

    -- Fallback: check by portion name if provided and not yet matched
    if v_portion_price is null and nullif(v_item->>'portion', '') is not null and v_menu.portions is not null and jsonb_typeof(v_menu.portions) = 'array' then
      for v_p in select value from jsonb_array_elements(v_menu.portions) loop
        if lower(coalesce(v_p->>'name', '')) = lower(v_item->>'portion') or lower(coalesce(v_p->>'id', '')) = lower(v_item->>'portion') then
          v_portion_id := v_p->>'id';
          v_portion_name := v_p->>'name';
          v_portion_price := (v_p->>'price')::numeric;
          exit;
        end if;
      end loop;
    end if;

    -- Authoritative server price: portion price if portion chosen, otherwise menu item price
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
      case when p_idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           then p_idempotency_key::uuid else null end
    );
    v_count := v_count + 1;
  end loop;

  -- 7. Recalculate consolidated order totals across all active items
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
  v_discount := least(coalesce(v_order.discount, 0), v_items_total);
  v_taxable := greatest(0::numeric, v_items_total - v_discount);

  v_tax := round((v_taxable * v_tax_rate)::numeric, 2);
  v_service_charge := round((v_items_total * v_service_rate)::numeric, 2);
  v_total := round((v_taxable + v_tax + v_service_charge)::numeric, 2);

  -- 8. Atomically update order
  update public.orders
     set items_total = v_items_total,
         tax = v_tax,
         service_charge = v_service_charge,
         total = v_total,
         status = case when status in ('READY', 'SERVED') then 'PENDING' else status end,
         updated_at = now()
   where id = p_order_id;

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'order_id', p_order_id,
    'kot_number', v_next_kot,
    'items_count', v_count,
    'items_total', v_items_total,
    'total', v_total
  );
end $$;

revoke execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, text) to service_role;

