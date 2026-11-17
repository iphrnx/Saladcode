-- Migration: 20261116000003_fix_audit_findings.sql
-- Fix findings P0-2, P0-3, P0-4, P1-4, P3-2 from production audit

-- ---------------------------------------------------------------------------
-- 1. DROP AMBIGUOUS OVERLOADS OF create_order_tx
-- ---------------------------------------------------------------------------
drop function if exists public.create_order_tx(jsonb, jsonb, text, text);
drop function if exists public.create_order_tx(jsonb, jsonb, uuid, uuid, text);
drop function if exists public.create_order_tx(jsonb, jsonb, uuid, text, text);

-- ---------------------------------------------------------------------------
-- 2. CANONICAL create_order_tx (Fix P0-2: no subtotal, Fix P0-3: valid_to)
-- ---------------------------------------------------------------------------
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
  returning id, order_number into v_order_id, v_order_num;

  -- Deduplicate fallback if concurrency race on idempotency_key
  if v_order_id is null and p_idempotency_key is not null then
    select id into v_order_id from public.orders where idempotency_key = p_idempotency_key;
    return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
  end if;

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

    -- Notice: NO subtotal column here (Fix P0-2)
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

  -- Atomic promo usage increment with valid_to column (Fix P0-3)
  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant and active
       and (usage_limit = 0 or used_count < usage_limit)
       and valid_from <= now()
       and (valid_to is null or valid_to >= now());
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'order_number', v_order_num,
    'check_id', v_check,
    'table_session_id', v_session
  );
end $$;

revoke execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. SECURE add_items_to_order_tx (Fix P0-4: Server-side Price Validation)
-- ---------------------------------------------------------------------------
drop function if exists public.add_items_to_order_tx(uuid, uuid, jsonb, uuid);
drop function if exists public.add_items_to_order_tx(uuid, uuid, jsonb, text);

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

  -- 6. Insert new items with authoritative server-side price lookup (Fix P0-4)
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

-- ---------------------------------------------------------------------------
-- 4. FIX P3-2: ATTRIBUTED CASH SETTLEMENT AND CHECK PAYMENTS
-- ---------------------------------------------------------------------------
create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric,
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
  v_check public.table_checks%rowtype;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_existing public.check_payments%rowtype;
  v_payment_id uuid;
  v_is_profile boolean := false;
  v_is_staff boolean := false;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_check.status = 'PAID' then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'deduplicated', true,
      'paidTotal', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0
    );
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;

  if v_check.status <> 'OPEN' then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED'
     limit 1;
    if found then
      return jsonb_build_object('ok', true, 'deduplicated', true, 'paymentId', v_existing.id);
    end if;
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_total - v_paid);

  if p_amount > v_outstanding + 0.005 then
    raise exception 'OVERPAYMENT:%:%', round(p_amount::numeric, 2)::text, round(v_outstanding::numeric, 2)::text
      using errcode = 'P0001';
  end if;

  if p_actor is not null then
    select exists (select 1 from public.profiles where id = p_actor) into v_is_profile;
    select exists (select 1 from public.staff where id = p_actor) into v_is_staff;
  end if;

  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key, created_by, staff_id, status, note
  ) values (
    p_tenant, p_check, p_amount, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
    case when v_is_profile then p_actor else null end,
    case when v_is_staff then p_actor else null end,
    'SUCCEEDED', p_note
  )
  returning id into v_payment_id;

  update public.table_checks
     set paid_total = v_paid + p_amount,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  return jsonb_build_object(
    'ok', true,
    'paymentId', v_payment_id,
    'amount', p_amount,
    'paidTotal', v_paid + p_amount,
    'outstanding', greatest(0::numeric, v_outstanding - p_amount)
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;

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
  v_payment_id uuid;
  v_completed integer;
  v_target_session uuid;
  v_existing_payment public.check_payments%rowtype;
  v_is_profile boolean := false;
  v_is_staff boolean := false;
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_check.status = 'PAID' then
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
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

  select coalesce(sum(amount), 0) into v_current_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_totals.total - v_current_paid);

  if p_actor is not null then
    select exists (select 1 from public.profiles where id = p_actor) into v_is_profile;
    select exists (select 1 from public.staff where id = p_actor) into v_is_staff;
  end if;

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
        tenant_id, check_id, amount, method, idempotency_key, created_by, staff_id, status, note
      ) values (
        p_tenant, p_check, v_outstanding, 'CASH',
        coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
        case when v_is_profile then p_actor else null end,
        case when v_is_staff then p_actor else null end,
        'SUCCEEDED', coalesce(nullif(trim(p_note), ''), 'Cash payment confirmed at POS')
      ) returning id into v_payment_id;

      v_current_paid := v_current_paid + v_outstanding;
    end if;
  else
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;
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
         paid_total = v_current_paid,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

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
    tenant_id,
    user_id,
    staff_id,
    actor_staff_id,
    action,
    meta
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

-- ---------------------------------------------------------------------------
-- 5. FIX P1-4: ATOMIC ROW-LOCKED STAFF PIN LOGIN ATTEMPT
-- ---------------------------------------------------------------------------
create or replace function public.record_staff_login_attempt(
  p_tenant uuid,
  p_staff_id uuid,
  p_success boolean,
  p_max_attempts int default 5,
  p_lockout_mins int default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff public.staff%rowtype;
  v_attempts int;
  v_locked_until timestamptz;
  v_is_locked boolean;
begin
  select * into v_staff
    from public.staff
   where id = p_staff_id and tenant_id = p_tenant
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  -- Check existing active lockout
  if v_staff.locked_until is not null and v_staff.locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'locked', true,
      'locked_until', v_staff.locked_until,
      'remaining_seconds', extract(epoch from (v_staff.locked_until - now()))::int
    );
  end if;

  if p_success then
    update public.staff
       set failed_attempts = 0,
           locked_until = null,
           last_login = now()
     where id = p_staff_id;

    return jsonb_build_object('ok', true, 'locked', false);
  else
    v_attempts := coalesce(v_staff.failed_attempts, 0) + 1;
    v_is_locked := v_attempts >= p_max_attempts;
    v_locked_until := case when v_is_locked then now() + (p_lockout_mins || ' minutes')::interval else null end;

    update public.staff
       set failed_attempts = v_attempts,
           locked_until = v_locked_until
     where id = p_staff_id;

    return jsonb_build_object(
      'ok', true,
      'locked', v_is_locked,
      'attempts', v_attempts,
      'attempts_remaining', greatest(0, p_max_attempts - v_attempts),
      'locked_until', v_locked_until,
      'lockout_mins', p_lockout_mins
    );
  end if;
end $$;

revoke execute on function public.record_staff_login_attempt(uuid, uuid, boolean, int, int) from public, anon, authenticated;
grant execute on function public.record_staff_login_attempt(uuid, uuid, boolean, int, int) to service_role;

