-- 20261114000002_tighten_takeaway_delivery_add_items.sql
-- Atomic, row-locked, idempotent item addition for Takeaway & Delivery orders with separate KOT and consolidated billing

create or replace function public.add_items_to_order_tx(
  p_order_id uuid,
  p_tenant uuid,
  p_items jsonb,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_item jsonb;
  v_menu record;
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
begin
  -- 1. Row-level exclusive lock on the order row to serialize concurrent writes
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

  -- 3. Verify lifecycle state: cannot add items to closed or cancelled orders
  if v_order.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'ORDER_LIFECYCLE_CLOSED:%', v_order.status using errcode = 'P0001';
  end if;

  if v_order.payment_status in ('PAID', 'paid') then
    raise exception 'ORDER_ALREADY_PAID' using errcode = 'P0001';
  end if;

  -- 4. Idempotency check: if already processed with this key, return previous state
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

  -- 5. Calculate next separate KOT number
  select coalesce(max(kot_number), 1) + 1
    into v_next_kot
    from public.order_items
   where order_id = p_order_id;

  -- 6. Insert new items and validate availability server-side
  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;

    if v_menu is null or v_menu.tenant_id <> p_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', (v_item->>'menu_item_id') using errcode = 'P0001';
    end if;

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
      (v_item->>'menu_item_id')::uuid,
      v_item->>'name',
      nullif(v_item->>'portion_id', ''),
      nullif(v_item->>'portion', ''),
      (v_item->>'price')::numeric,
      greatest(1, (v_item->>'quantity')::integer),
      nullif(v_item->>'notes', ''),
      'PENDING',
      v_next_kot,
      p_idempotency_key
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
  v_discount := coalesce(v_order.discount, 0);

  v_tax := round(((v_items_total - v_discount) * v_tax_rate)::numeric, 2);
  v_service_charge := round((v_items_total * v_service_rate)::numeric, 2);
  v_total := round((v_items_total - v_discount + v_tax + v_service_charge)::numeric, 2);

  -- 8. Atomically update order: update totals and revert status from READY/SERVED to PENDING for the kitchen
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

revoke execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, uuid) to service_role;
