-- ============================================================================
-- Migration: 20261122000002_verify_settlement_zero_sales_location.sql
-- Description:
--   1. Finalize valid ₹0 sales in finalize_table_check and settle_check_cash_tx:
--      Distinguishes a valid zero-total sale with billable orders from an empty
--      or all-cancelled check (NOTHING_TO_BILL). Issues exactly one invoice,
--      completes eligible orders, ends only this check's session, without
--      inserting a payment ledger row. Retries return the same invoice.
--   2. Authoritative settlement verification for paid_at repair:
--      Repairs historical orders.paid_at only where there is a verified final total
--      and ledger coverage (cumulative payments >= total > 0) or verified closed
--      paid check evidence (status = 'PAID' with closed_at/invoice_date). Resets
--      unverifiable timestamps (including open checks with unknown total) to NULL.
--   3. Persist sale location on creation and remove cashier staff location fallback:
--      create_order_tx persists verified location on orders and table_checks.
--      Settlement RPCs resolve location strictly from check or linked orders,
--      preventing staff transfers from altering sale attribution.
-- ============================================================================

-- 1. Update public.create_order_tx to persist verified location for new sales
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
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_tenant uuid;
  v_table uuid;
  v_session uuid;
  v_check uuid;
  v_order_type text;
  v_order_id uuid;
  v_item jsonb;
  v_menu_item public.menu_items;
  v_portion jsonb;
  v_portion_id text;
  v_price numeric(10, 2);
  v_existing_id uuid;
  v_existing_status text;
  v_existing_order jsonb;
  v_location uuid := null;
begin
  v_tenant := (p_order->>'tenant_id')::uuid;
  v_table := nullif(p_order->>'table_id', '')::uuid;
  v_session := nullif(p_order->>'table_session_id', '')::uuid;
  v_order_type := coalesce(nullif(p_order->>'order_type', ''), 'DINE_IN');

  if v_tenant is null then
    raise exception 'TENANT_REQUIRED' using errcode = 'P0001';
  end if;

  -- Concurrency-safe idempotency check
  if p_idempotency_key is not null then
    select id, status into v_existing_id, v_existing_status
      from public.orders
     where tenant_id = v_tenant and idempotency_key = p_idempotency_key
     limit 1;

    if v_existing_id is not null then
      select jsonb_build_object(
        'id', o.id,
        'order_number', o.order_number,
        'status', o.status,
        'payment_status', o.payment_status,
        'items_total', o.items_total,
        'discount', o.discount,
        'tax', o.tax,
        'service_charge', o.service_charge,
        'total', o.total,
        'table_id', o.table_id,
        'table_session_id', o.table_session_id,
        'check_id', o.check_id,
        'order_type', o.order_type,
        'customer_name', o.customer_name,
        'customer_phone', o.customer_phone,
        'notes', o.notes,
        'promo_code', o.promo_code,
        'location_id', o.location_id,
        'created_at', o.created_at,
        'items', (
          select jsonb_agg(jsonb_build_object(
            'id', oi.id,
            'menu_item_id', oi.menu_item_id,
            'name', oi.name,
            'price', oi.price,
            'quantity', oi.quantity,
            'portion_id', oi.portion_id,
            'portion_name', oi.portion_name,
            'notes', oi.notes
          ))
          from public.order_items oi
          where oi.order_id = o.id
        )
      ) into v_existing_order
      from public.orders o
      where o.id = v_existing_id;

      return jsonb_build_object('ok', true, 'deduplicated', true, 'order', v_existing_order);
    end if;
  end if;

  -- Resolve session and check based on order_type
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
    v_table := null;
    if v_session is not null then
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

  -- Resolve sale location on creation
  if v_table is not null then
    select location_id into v_location
      from public.tables
     where id = v_table;
  end if;

  if v_location is null and nullif(p_order->>'location_id', '') is not null then
    v_location := (p_order->>'location_id')::uuid;
  end if;

  if v_location is null and nullif(p_order->>'served_by_id', '') is not null then
    select location_id into v_location
      from public.staff
     where id = (p_order->>'served_by_id')::uuid and tenant_id = v_tenant;
  end if;

  -- Insert order with durable location
  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes,
    served_by_id, idempotency_key, check_id, location_id
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
    p_idempotency_key,
    v_check,
    v_location
  )
  returning id into v_order_id;

  -- Persist location on check if not yet assigned
  if v_check is not null and v_location is not null then
    update public.table_checks
       set location_id = coalesce(location_id, v_location)
     where id = v_check and location_id is null;
  end if;

  -- Insert line items
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_menu_item
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid
       and tenant_id = v_tenant;

    if not found then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id' using errcode = 'P0001';
    end if;

    if not v_menu_item.available then
      raise exception 'ITEM_UNAVAILABLE:%', v_menu_item.name using errcode = 'P0001';
    end if;

    v_portion_id := nullif(v_item->>'portion_id', '');
    v_price := coalesce((v_item->>'price')::numeric, v_menu_item.price);

    insert into public.order_items (
      order_id, menu_item_id, name, price, quantity,
      portion_id, portion_name, notes
    ) values (
      v_order_id,
      v_menu_item.id,
      v_menu_item.name,
      v_price,
      coalesce((v_item->>'quantity')::integer, 1),
      v_portion_id,
      nullif(v_item->>'portion_name', ''),
      nullif(v_item->>'notes', '')
    );
  end loop;

  -- Return complete order record
  select jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'status', o.status,
    'payment_status', o.payment_status,
    'items_total', o.items_total,
    'discount', o.discount,
    'tax', o.tax,
    'service_charge', o.service_charge,
    'total', o.total,
    'table_id', o.table_id,
    'table_session_id', o.table_session_id,
    'check_id', o.check_id,
    'order_type', o.order_type,
    'customer_name', o.customer_name,
    'customer_phone', o.customer_phone,
    'notes', o.notes,
    'promo_code', o.promo_code,
    'location_id', o.location_id,
    'created_at', o.created_at,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'id', oi.id,
        'menu_item_id', oi.menu_item_id,
        'name', oi.name,
        'price', oi.price,
        'quantity', oi.quantity,
        'portion_id', oi.portion_id,
        'portion_name', oi.portion_name,
        'notes', oi.notes
      ))
      from public.order_items oi
      where oi.order_id = o.id
    )
  ) into v_existing_order
  from public.orders o
  where o.id = v_order_id;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'order', v_existing_order);
end $function$;

grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to authenticated, anon, service_role;

-- 2. Update public.finalize_table_check
-- Handles valid ₹0 sales with billable orders, issues single invoice, completes orders,
-- ends check sessions without inserting payment ledger rows, and resolves location without cashier fallback.
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
  v_target_session uuid := null;
  v_location uuid := null;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Resolve target session id
  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is null then
    select table_session_id into v_target_session
      from public.orders
     where check_id = p_check and table_session_id is not null
     limit 1;
  end if;

  -- Resolve verified sale location:
  -- Priority 1: Table linked to check (Dine-in)
  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  -- Priority 2: Check's own recorded location
  if v_location is null and v_check.location_id is not null then
    v_location := v_check.location_id;
  end if;

  -- Priority 3: Orders location or orders table location
  if v_location is null then
    select location_id into v_location
      from public.orders
     where check_id = p_check and location_id is not null
     limit 1;
  end if;

  if v_location is null then
    select t.location_id into v_location
      from public.orders o
      join public.tables t on t.id = o.table_id
     where o.check_id = p_check and t.location_id is not null
     limit 1;
  end if;
  -- NOTE: Do NOT fall back to cashier staff location (p_actor).
  -- A sale created at branch A and settled by staff from branch B stays at branch A.
  -- Unverifiable historical sales remain NULL.

  -- Handle check already marked PAID (idempotent retries return same invoice)
  if v_check.status = 'PAID' then
    if v_check.invoice_number is null then
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
         set invoice_number = v_invoice,
             invoice_date = coalesce(invoice_date, now()),
             location_id = coalesce(location_id, v_location),
             updated_at = now()
       where id = p_check;

      v_check.invoice_number := v_invoice;
    else
      v_invoice := v_check.invoice_number;
    end if;

    if v_location is not null then
      update public.table_checks
         set location_id = coalesce(location_id, v_location)
       where id = p_check and location_id is null;

      update public.orders
         set location_id = coalesce(location_id, v_location)
       where check_id = p_check and location_id is null;
    end if;

    perform public.complete_paid_check_orders(p_tenant, p_check);

    -- Close only this check's diner sessions
    update public.table_sessions
       set status = 'ENDED',
           ended_at = coalesce(ended_at, now()),
           updated_at = now()
     where id in (
       select v_check.session_id where v_check.session_id is not null
       union
       select v_check.anchor_session_id where v_check.anchor_session_id is not null
       union
       select o.table_session_id from public.orders o where o.check_id = p_check and o.table_session_id is not null
       union
       select v_target_session where v_target_session is not null
     )
     and tenant_id = p_tenant
     and status = 'ACTIVE';

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', v_target_session,
      'closedAt', v_check.closed_at
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  -- Preserve order readiness check
  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  -- Distinguish empty/cancelled check from a valid ₹0 sale with billable orders
  select
    count(*)                      as order_count,
    coalesce(sum(items_total), 0) as subtotal,
    coalesce(sum(discount), 0)    as discount,
    coalesce(sum(tax), 0)         as tax,
    coalesce(sum(service_charge), 0) as service_charge,
    coalesce(sum(total), 0)       as total
  into v_totals
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  if v_totals.order_count = 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  if v_totals.total < 0 then
    raise exception 'INVALID_TOTAL' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  -- Only require payments if total > 0. For valid ₹0 sales, v_totals.total is 0.
  if v_totals.total > 0 and v_paid + 0.005 < v_totals.total then
    raise exception 'UNPAID:%', round((v_totals.total - v_paid)::numeric, 2)::text using errcode = 'P0001';
  end if;

  -- Allocate single tenant-scoped invoice
  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  -- Update check to PAID
  update public.table_checks
     set status = 'PAID',
         closed_at = coalesce(closed_at, now()),
         unsettled_at = null,
         invoice_number = v_invoice,
         invoice_date = coalesce(invoice_date, now()),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_paid,
         session_id = coalesce(session_id, v_target_session),
         anchor_session_id = coalesce(anchor_session_id, v_target_session),
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  -- Complete orders
  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  update public.orders
     set location_id = coalesce(location_id, v_location)
   where check_id = p_check and location_id is null;

  -- Close only this check's sessions (keeping other diner sessions at the same table independent)
  update public.table_sessions
     set status = 'ENDED',
         ended_at = coalesce(ended_at, now()),
         updated_at = now()
   where id in (
     select v_check.session_id where v_check.session_id is not null
     union
     select v_check.anchor_session_id where v_check.anchor_session_id is not null
     union
     select o.table_session_id from public.orders o where o.check_id = p_check and o.table_session_id is not null
     union
     select v_target_session where v_target_session is not null
   )
   and tenant_id = p_tenant
   and status = 'ACTIVE';

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_paid,
    'outstanding', 0,
    'completedOrders', v_completed,
    'endedSessionId', v_target_session,
    'closedAt', now()
  );
end $function$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- 3. Update public.settle_check_cash_tx
-- Distinguishes valid ₹0 sales from empty checks, never inserts a payment row for ₹0,
-- issues single invoice, completes orders, ends check session, and removes cashier staff location fallback.
create or replace function public.settle_check_cash_tx(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null,
  p_idempotency_key text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks%rowtype;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_current_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_payment_id uuid := null;
  v_completed integer;
  v_target_session uuid;
  v_existing_payment public.check_payments%rowtype;
  v_is_profile boolean := false;
  v_is_staff boolean := false;
  v_location uuid := null;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_actor is not null then
    select exists (select 1 from public.profiles where id = p_actor) into v_is_profile;
    select exists (select 1 from public.staff where id = p_actor and tenant_id = p_tenant) into v_is_staff;
  end if;

  -- Resolve durable sale location strictly from sale data (no cashier staff fallback)
  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  if v_location is null and v_check.location_id is not null then
    v_location := v_check.location_id;
  end if;

  if v_location is null then
    select location_id into v_location
      from public.orders
     where check_id = p_check and location_id is not null
     limit 1;
  end if;

  if v_location is null then
    select t.location_id into v_location
      from public.orders o
      join public.tables t on t.id = o.table_id
     where o.check_id = p_check and t.location_id is not null
     limit 1;
  end if;

  if v_check.status = 'PAID' then
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;

    if v_check.invoice_number is null then
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
         set invoice_number = v_invoice,
             invoice_date = coalesce(invoice_date, now()),
             location_id = coalesce(location_id, v_location),
             updated_at = now()
       where id = p_check;

      v_check.invoice_number := v_invoice;
    else
      v_invoice := v_check.invoice_number;
    end if;

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_invoice,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', coalesce(v_check.session_id, v_check.anchor_session_id),
      'paymentId', v_payment_id,
      'closedAt', v_check.closed_at
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  select
    count(*)                      as order_count,
    coalesce(sum(items_total), 0) as subtotal,
    coalesce(sum(discount), 0)    as discount,
    coalesce(sum(tax), 0)         as tax,
    coalesce(sum(service_charge), 0) as service_charge,
    coalesce(sum(total), 0)       as total
  into v_totals
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  if v_totals.order_count = 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  if v_totals.total < 0 then
    raise exception 'INVALID_TOTAL' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_current_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_totals.total - v_current_paid);

  -- Only insert payment ledger row if there is outstanding amount to pay (> 0)
  -- A valid ₹0 sale does NOT insert a payment ledger row
  if v_outstanding > 0 then
    if p_idempotency_key is not null then
      select * into v_existing_payment
        from public.check_payments
       where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED'
       limit 1;
      if found then
        v_payment_id := v_existing_payment.id;
      end if;
    end if;

    if v_payment_id is null then
      insert into public.check_payments (
        tenant_id, check_id, amount, method, idempotency_key,
        created_by, staff_id, location_id, status, note, created_at
      ) values (
        p_tenant, p_check, v_outstanding, 'CASH',
        coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
        case when v_is_profile then p_actor else null end,
        case when v_is_staff then p_actor else null end,
        v_location,
        'SUCCEEDED', coalesce(nullif(trim(p_note), ''), 'Cash payment confirmed at POS'), now()
      ) returning id into v_payment_id;

      v_current_paid := v_current_paid + v_outstanding;
    end if;
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
         closed_at = coalesce(closed_at, now()),
         invoice_number = v_invoice,
         invoice_date = coalesce(invoice_date, now()),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_current_paid,
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  update public.orders
     set location_id = coalesce(location_id, v_location)
   where check_id = p_check and location_id is null;

  update public.table_sessions
     set status = 'ENDED',
         ended_at = coalesce(ended_at, now()),
         updated_at = now()
   where id in (
     select v_check.session_id where v_check.session_id is not null
     union
     select v_check.anchor_session_id where v_check.anchor_session_id is not null
     union
     select o.table_session_id from public.orders o where o.check_id = p_check and o.table_session_id is not null
   )
   and tenant_id = p_tenant
   and status = 'ACTIVE';

  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is null then
    select table_session_id into v_target_session
      from public.orders
     where check_id = p_check and table_session_id is not null
     limit 1;
    if v_target_session is not null then
      update public.table_checks
         set session_id = v_target_session,
             anchor_session_id = coalesce(anchor_session_id, v_target_session)
       where id = p_check;
    end if;
  end if;

  insert into public.security_logs (
    tenant_id, user_id, staff_id, actor_staff_id, action, meta
  ) values (
    p_tenant,
    case when v_is_profile then p_actor else null end,
    case when v_is_staff then p_actor else null end,
    case when v_is_staff then p_actor else null end,
    'CHECK_SETTLED_CASH',
    'Check ' || p_check || ' settled in cash: ' || v_invoice || ' (₹' || v_totals.total || ')'
  );

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_current_paid,
    'outstanding', 0,
    'completedOrders', v_completed,
    'endedSessionId', v_target_session,
    'paymentId', v_payment_id,
    'closedAt', now()
  );
end $$;

revoke execute on function public.settle_check_cash_tx(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.settle_check_cash_tx(uuid, uuid, uuid, text, text) to service_role;

-- 4. Update public.record_check_payment
-- Removes cashier staff location fallback and handles zero-balance finalization cleanly
create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric default null,
  p_method text default 'CASH',
  p_idempotency_key text default null,
  p_actor uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_amt numeric(12, 2);
  v_existing public.check_payments;
  v_payment_id uuid;
  v_profile_actor uuid := null;
  v_staff_actor uuid := null;
  v_location uuid := null;
  v_fin jsonb;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED';
    if found then
      return jsonb_build_object(
        'ok', true,
        'deduplicated', true,
        'already', true,
        'paymentId', v_existing.id,
        'invoiceNumber', v_check.invoice_number,
        'amount', v_existing.amount,
        'method', v_existing.method,
        'totalPaid', coalesce(v_check.paid_total, v_existing.amount),
        'outstanding', 0.00
      );
    end if;
  end if;

  if v_check.status = 'PAID' then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'deduplicated', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paidTotal', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0.00,
      'message', 'This bill is already settled.'
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  select coalesce(round(sum(total), 2), 0.00) into v_total
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  select coalesce(round(sum(amount), 2), 0.00) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0.00, round(v_total - v_paid, 2));

  -- Zero-balance check (including valid ₹0 sale): reuse finalization logic directly
  if v_outstanding <= 0.00 then
    return public.finalize_table_check(p_tenant, p_check, p_actor);
  end if;

  v_amt := round(coalesce(p_amount, v_outstanding), 2);

  if v_amt < v_outstanding then
    raise exception 'UNDERPAYMENT:%:%', v_amt::text, v_outstanding::text using errcode = 'P0001';
  end if;

  if v_amt > v_outstanding then
    raise exception 'OVERPAYMENT:%:%', v_amt::text, v_outstanding::text using errcode = 'P0001';
  end if;

  if p_actor is not null then
    select id into v_profile_actor from public.profiles where id = p_actor;
    if v_profile_actor is null then
      select id into v_staff_actor
        from public.staff
       where id = p_actor and tenant_id = p_tenant;
    end if;
  end if;

  -- Resolve sale location strictly from sale data (no cashier staff fallback)
  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  if v_location is null and v_check.location_id is not null then
    v_location := v_check.location_id;
  end if;

  if v_location is null then
    select location_id into v_location
      from public.orders
     where check_id = p_check and location_id is not null
     limit 1;
  end if;

  if v_location is null then
    select t.location_id into v_location
      from public.orders o
      join public.tables t on t.id = o.table_id
     where o.check_id = p_check and t.location_id is not null
     limit 1;
  end if;

  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key,
    created_by, staff_id, location_id, status, note, created_at
  ) values (
    p_tenant, p_check, v_amt, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
    v_profile_actor, v_staff_actor, v_location, 'SUCCEEDED', p_note, now()
  )
  returning id into v_payment_id;

  update public.table_checks
     set paid_total = v_paid + v_amt,
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  update public.orders
     set location_id = coalesce(location_id, v_location)
   where check_id = p_check and location_id is null;

  v_fin := public.finalize_table_check(p_tenant, p_check, p_actor);

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'paymentId', v_payment_id,
    'invoiceNumber', v_fin->>'invoiceNumber',
    'amount', v_amt,
    'method', coalesce(p_method, 'CASH'),
    'totalPaid', v_paid + v_amt,
    'outstanding', 0.00,
    'endedSessionId', v_fin->>'endedSessionId'
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;

-- 5. Corrective historical orders.paid_at repair
-- Strictly requires verified total and ledger coverage (> 0 and cumulative >= total),
-- or verified closed paid check evidence (status = 'PAID' and closed_at/invoice_date is not null).
-- Open checks with unknown/partial total or unverified ledger rows have paid_at reset to NULL.

-- Priority A: Verified full-settlement ledger payments
with ranked_payments as (
  select
    cp.id as payment_id,
    cp.check_id,
    cp.amount,
    cp.created_at,
    sum(cp.amount) over (
      partition by cp.check_id
      order by cp.created_at asc, cp.id asc
      rows between unbounded preceding and current row
    ) as cumulative_amount
  from public.check_payments cp
  where cp.status = 'SUCCEEDED'
),
check_full_settlement as (
  select distinct on (rp.check_id)
    rp.check_id,
    rp.created_at as verified_settled_at
  from ranked_payments rp
  join public.table_checks tc on tc.id = rp.check_id
  where tc.total > 0
    and rp.cumulative_amount >= tc.total - 0.005
  order by rp.check_id, rp.created_at asc, rp.payment_id asc
)
update public.orders o
   set paid_at = cfs.verified_settled_at
  from check_full_settlement cfs
 where o.check_id = cfs.check_id
   and o.paid_at is distinct from cfs.verified_settled_at;

-- Priority B: Authoritative closed paid checks (including ₹0 sales with invoices, or legacy checks)
with ranked_payments as (
  select
    cp.id as payment_id,
    cp.check_id,
    cp.amount,
    cp.created_at,
    sum(cp.amount) over (
      partition by cp.check_id
      order by cp.created_at asc, cp.id asc
      rows between unbounded preceding and current row
    ) as cumulative_amount
  from public.check_payments cp
  where cp.status = 'SUCCEEDED'
),
check_full_settlement as (
  select distinct on (rp.check_id)
    rp.check_id
  from ranked_payments rp
  join public.table_checks tc on tc.id = rp.check_id
  where tc.total > 0
    and rp.cumulative_amount >= tc.total - 0.005
  order by rp.check_id, rp.created_at asc, rp.payment_id asc
),
verified_closed_checks as (
  select
    tc.id as check_id,
    coalesce(tc.closed_at, tc.invoice_date) as verified_settled_at
  from public.table_checks tc
  where tc.status = 'PAID'
    and coalesce(tc.closed_at, tc.invoice_date) is not null
    and not exists (
      select 1 from check_full_settlement cfs where cfs.check_id = tc.id
    )
)
update public.orders o
   set paid_at = vcc.verified_settled_at
  from verified_closed_checks vcc
 where o.check_id = vcc.check_id
   and o.paid_at is distinct from vcc.verified_settled_at;

-- Priority C: Reset unverifiable paid_at to NULL
-- Orders on checks without verified full settlement or closed check evidence are reset to NULL.
with ranked_payments as (
  select
    cp.id as payment_id,
    cp.check_id,
    cp.amount,
    cp.created_at,
    sum(cp.amount) over (
      partition by cp.check_id
      order by cp.created_at asc, cp.id asc
      rows between unbounded preceding and current row
    ) as cumulative_amount
  from public.check_payments cp
  where cp.status = 'SUCCEEDED'
),
check_full_settlement as (
  select distinct on (rp.check_id)
    rp.check_id
  from ranked_payments rp
  join public.table_checks tc on tc.id = rp.check_id
  where tc.total > 0
    and rp.cumulative_amount >= tc.total - 0.005
  order by rp.check_id, rp.created_at asc, rp.payment_id asc
),
verified_closed_checks as (
  select
    tc.id as check_id
  from public.table_checks tc
  where tc.status = 'PAID'
    and coalesce(tc.closed_at, tc.invoice_date) is not null
)
update public.orders o
   set paid_at = null
 where o.paid_at is not null
   and not exists (select 1 from check_full_settlement cfs where cfs.check_id = o.check_id)
   and not exists (select 1 from verified_closed_checks vcc where vcc.check_id = o.check_id)
   and not (o.check_id is null and o.payment_status in ('PAID', 'paid') and o.status = 'COMPLETED');
