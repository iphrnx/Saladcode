-- ============================================================================
-- 0009 — place_order refuses an expired session
--
-- 0008 introduced session expiry, and was meant to re-declare place_order with
-- the same check. It did not: pg_get_functiondef quotes a function body with
-- $function$, not $$, so the step that trimmed the file back to its last
-- `end $$;` cut place_order out of the migration entirely. 0008 as applied
-- created expire_stale_table_sessions() and validate_table_session() only.
--
-- Consequence: validate_table_session() rejected an expired session, but a
-- client posting straight to place_order with a stale token was still accepted.
-- The diner app always validates first, so this was not reachable through the
-- UI — but the guarantee was supposed to hold at the database, and it did not.
--
-- This re-declares place_order from its live definition (so the double
-- precision money types from 0003 are preserved) with the expiry check added.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.place_order(p_session_token text, p_items jsonb, p_customer_name text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_order_type text DEFAULT 'DINE_IN'::text, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_session public.table_sessions;
  v_tenant  public.tenants;
  v_item    jsonb;
  v_menu    public.menu_items;
  v_qty     integer;
  v_items_total double precision := 0;
  v_discount    double precision := 0;
  v_tax         double precision;
  v_service     double precision;
  v_total       double precision;
  v_order   public.orders;
  v_promo   public.promo_codes;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = 'P0001';
  end if;

  select * into v_session from public.table_sessions
   where token = p_session_token and status = 'ACTIVE' limit 1;
  if not found then
    raise exception 'INVALID_SESSION' using errcode = 'P0001';
  end if;

  -- A session is good for one visit only. See 0008: an abandoned scan used to
  -- stay ACTIVE indefinitely, because only order completion ever ended one.
  --
  -- The raise below aborts this transaction, so the UPDATE is rolled back and
  -- does not mark the row. That is fine — the point here is to refuse the
  -- order. The row is marked ENDED by validate_table_session() (which returns
  -- normally, so its update commits) and by expire_stale_table_sessions().
  if v_session.created_at < now() - interval '6 hours' then
    raise exception 'INVALID_SESSION' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_session.tenant_id;

  -- Recompute line prices from the database, never from the client payload.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(coalesce((v_item->>'quantity')::int, 1), 1);
    select * into v_menu from public.menu_items
     where id = (v_item->>'menuItemId')::uuid
       and tenant_id = v_session.tenant_id
       and available
     limit 1;
    if not found then
      raise exception 'ITEM_UNAVAILABLE:%', coalesce(v_item->>'menuItemId','?')
        using errcode = 'P0001';
    end if;
    v_items_total := v_items_total + (v_menu.price * v_qty);
  end loop;

  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    select * into v_promo from public.promo_codes
     where tenant_id = v_session.tenant_id
       and upper(code) = upper(trim(p_promo_code))
       and active
       and (valid_to is null or valid_to > now())
       and v_items_total >= min_order
       and (usage_limit = 0 or used_count < usage_limit)
     limit 1;
    if found then
      if v_promo.type = 'PERCENTAGE' then
        v_discount := v_items_total * (v_promo.value / 100.0);
      else
        v_discount := v_promo.value;
      end if;
      if v_promo.max_discount > 0 then
        v_discount := least(v_discount, v_promo.max_discount);
      end if;
      v_discount := least(v_discount, v_items_total);
    else
      v_promo := null;
    end if;
  end if;

  v_tax     := round(((v_items_total - v_discount) * (v_tenant.tax_rate / 100.0))::numeric, 2);
  v_service := round(((v_items_total - v_discount) * (v_tenant.service_charge / 100.0))::numeric, 2);
  v_total   := round((v_items_total - v_discount + v_tax + v_service)::numeric, 2);

  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes
  ) values (
    v_session.tenant_id, v_session.table_id, v_session.id,
    coalesce(p_order_type, 'DINE_IN'), 'PENDING',
    v_items_total, v_discount, v_tax, v_service, v_total,
    v_promo.id, v_promo.code, p_customer_name, p_customer_phone, p_notes
  ) returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(coalesce((v_item->>'quantity')::int, 1), 1);
    select * into v_menu from public.menu_items
     where id = (v_item->>'menuItemId')::uuid and tenant_id = v_session.tenant_id limit 1;
    insert into public.order_items (order_id, menu_item_id, name, price, quantity, notes)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty, v_item->>'notes');
  end loop;

  if v_promo.id is not null then
    update public.promo_codes set used_count = used_count + 1 where id = v_promo.id;
  end if;

  return jsonb_build_object(
    'order_id',     v_order.id,
    'order_number', v_order.order_number,
    'total',        v_order.total,
    'status',       v_order.status,
    'table_name',   (select name from public.tables where id = v_order.table_id)
  );
end $function$
