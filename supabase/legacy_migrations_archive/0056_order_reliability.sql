-- 0056: Order reliability — idempotent, atomic order creation.
--
-- Two failure modes are closed here:
--
--   1. Duplicate orders. A client whose response was lost (timeout, network
--      drop after the server committed) used to retry blind and create a
--      second order. Every checkout now carries a client-generated
--      idempotency key with a unique index behind it: a replay — retried or
--      concurrent — returns the original order instead of writing a new one.
--
--   2. Partial orders. Order row, order items and the promo usage increment
--      were three separate writes; a failure between them left an empty
--      order, or burned a promo use on an order that never existed. All
--      writes now happen inside create_order_tx(), one transaction: any
--      failure rolls back order, items and promo increment together.
--
-- Pricing and validation stay in the orders edge function (which never trusts
-- client totals — every line is re-read from the menu). The function
-- re-checks the invariants that can change between pricing and commit:
-- each dish still belongs to the tenant and is still available, and the
-- promo is still eligible, incrementing its usage atomically in the same
-- conditional UPDATE. A rejection raises, the transaction rolls back, and
-- the edge function re-prices and retries once with the same key.

alter table public.orders
  add column if not exists idempotency_key uuid default null;

-- One committed order per checkout key, forever. Partial: keys are optional,
-- orders written before this migration (and any written without a key) are
-- unaffected.
create unique index if not exists orders_idempotency_key_uidx
  on public.orders (idempotency_key)
  where idempotency_key is not null;

create or replace function public.create_order_tx(
  p_order jsonb,
  p_items jsonb,
  p_promo_code_id uuid default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := (p_order->>'tenant_id')::uuid;
  v_order_id uuid;
  v_item jsonb;
  v_menu record;
begin
  -- Replay fast path: the key already committed — hand back the original.
  if p_idempotency_key is not null then
    select id into v_order_id
      from public.orders
     where idempotency_key = p_idempotency_key;
    if v_order_id is not null then
      return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
    end if;
  end if;

  -- Invariants that may have changed since the edge function priced the cart:
  -- every dish still exists, still belongs to this tenant, still available.
  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;
    if v_menu is null or v_menu.tenant_id <> v_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id';
    end if;
  end loop;

  -- The order row. On a concurrent same-key commit the unique index decides;
  -- the loser takes the winner's order and writes nothing.
  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes,
    served_by_id, idempotency_key
  ) values (
    v_tenant,
    nullif(p_order->>'table_id', '')::uuid,
    nullif(p_order->>'table_session_id', '')::uuid,
    coalesce(p_order->>'order_type', 'DINE_IN'),
    'PENDING',
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
    p_idempotency_key
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select id into v_order_id
      from public.orders
     where idempotency_key = p_idempotency_key;
    return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
  end if;

  -- The promo burn is conditional and atomic: if the code stopped being
  -- eligible between pricing and commit (usage limit reached, deactivated,
  -- expired) the update matches nothing, the exception rolls the order back
  -- too, and the edge function re-prices without the code and retries.
  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant
       and active
       and (usage_limit = 0 or used_count < usage_limit)
       and valid_from <= now()
       and (valid_to is null or valid_to >= now());
    if not found then
      raise exception 'PROMO_REJECTED';
    end if;
  end if;

  insert into public.order_items (
    order_id, menu_item_id, name, price, quantity, notes, status,
    portion_id, portion
  )
  select
    v_order_id,
    (line->>'menu_item_id')::uuid,
    line->>'name',
    (line->>'price')::numeric,
    (line->>'quantity')::integer,
    nullif(line->>'notes', ''),
    'PENDING',
    nullif(line->>'portion_id', ''),
    nullif(line->>'portion', '')
  from jsonb_array_elements(p_items) as line;

  return jsonb_build_object('order_id', v_order_id, 'deduplicated', false);
end;
$$;

-- Only the edge functions (service role) may call this. SECURITY DEFINER with
-- the default PUBLIC grant would let anyone with the anon key write orders
-- with arbitrary prices — the same hole migration 0039 closed elsewhere.
revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid)
  from public, anon, authenticated;

comment on column public.orders.idempotency_key is
  'Client-generated checkout key. One order per key: replays return the original (0056).';
