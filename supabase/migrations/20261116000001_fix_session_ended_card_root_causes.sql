-- Migration: 20261116000001_fix_session_ended_card_root_causes.sql
-- Fix all 5 root causes identified in the Session Ended card audit:
-- 1. Ensure settled checks and sessions close authoritatively and link cleanly
-- 2. Bind POS-created Dine-In orders to active table sessions and checks (no orphan null sessions)
-- 3. Enforce independent diner sessions: payment closes ONLY the owning session, never other diners at the same table
-- 4. Reconcile historical legacy orders and checks

-- 1. Settle check cash transaction: close only this check's sessions
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
  -- 1. Row-level lock on the table check with strict tenant isolation
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Idempotency: If check is already settled (status = 'PAID'), return existing settlement details idempotently
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

  -- 3. Verify that all non-cancelled orders on this check are served
  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  -- 4. Calculate authoritative order totals
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

  -- 5. Calculate existing succeeded payments
  select coalesce(sum(amount), 0) into v_current_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_totals.total - v_current_paid);

  if p_actor is not null then
    select exists (select 1 from public.profiles where id = p_actor) into v_is_profile;
    select exists (select 1 from public.staff where id = p_actor) into v_is_staff;
  end if;

  -- 6. If outstanding > 0, record Cash payment atomically
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
    -- If already fully covered by previous payments, pick last payment id if present
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;
  end if;

  -- 7. Allocate tenant-scoped sequential invoice number
  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  -- 8. Mark check PAID and update final financial snapshot
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

  -- 9. Complete all paid check orders
  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- 10. End ONLY the sessions bound to this check (enforcing independent diner sessions)
  -- Close ONLY this check's sessions: check.session_id, anchor_session_id, and orders.table_session_id on this check,
  -- NEVER touching other concurrent diners at the same table!
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

  -- Resolve the primary ended session ID for return payload
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

  -- 11. Security audit trail
  insert into public.security_logs (
    tenant_id,
    user_id,
    staff_id,
    actor_staff_id,
    action,
    meta
  ) values (
    p_tenant,
    case when exists (select 1 from public.profiles where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
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

-- 2. Finalize table check: end ONLY the sessions bound to this check
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check  uuid,
  p_actor  uuid default null
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
  v_paid numeric(12, 2);
  v_completed integer;
  v_target_session uuid;
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
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', coalesce(v_check.session_id, v_check.anchor_session_id),
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

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + 0.005 < v_totals.total then
    raise exception 'UNPAID:%', round((v_totals.total - v_paid)::numeric, 2)::text using errcode = 'P0001';
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
         paid_total = v_paid,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- End ONLY the sessions bound to this check (enforcing independent diner sessions)
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
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- 3. Open table check: ensure an active table session is ALWAYS created or resolved
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

  -- If p_session was not provided, lock the table to resolve/create anchor session
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

  -- Ensure check row always has its session IDs assigned
  update public.table_checks
     set session_id = coalesce(session_id, v_active_session),
         anchor_session_id = coalesce(anchor_session_id, v_active_session)
   where id = v_check_id
     and (session_id is null or anchor_session_id is null);

  return v_check_id;
end $$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;

-- 4. Create order transaction: ensure Dine-In orders ALWAYS have valid table_session_id and check_id
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

  -- Atomic promo usage increment with valid_to column
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

-- 5. Backfill historical legacy orders and checks
do $$
declare
  r record;
  v_sess uuid;
begin
  -- Backfill session_id on checks where session_id was null but orders have table_session_id
  for r in
    select distinct c.id as check_id, o.table_session_id
      from public.table_checks c
      join public.orders o on o.check_id = c.id
     where c.session_id is null and o.table_session_id is not null
  loop
    update public.table_checks
       set session_id = r.table_session_id,
           anchor_session_id = coalesce(anchor_session_id, r.table_session_id)
     where id = r.check_id;
  end loop;

  -- For completed & paid orders where table_session_id is null, provision completed sessions
  for r in
    select o.id as order_id, o.tenant_id, o.table_id, o.check_id, o.created_at
      from public.orders o
     where o.order_type = 'DINE_IN'
       and o.table_session_id is null
       and o.table_id is not null
       and o.status in ('COMPLETED', 'PAID')
  loop
    insert into public.table_sessions (
      tenant_id, table_id, status, activation_status, token, created_at, ended_at, activated_at
    ) values (
      r.tenant_id, r.table_id, 'ENDED', 'ACTIVE', encode(extensions.gen_random_bytes(24), 'hex'),
      r.created_at, r.created_at + interval '10 minutes', r.created_at
    ) returning id into v_sess;

    update public.orders
       set table_session_id = v_sess
     where id = r.order_id;

    if r.check_id is not null then
      update public.table_checks
         set session_id = coalesce(session_id, v_sess),
             anchor_session_id = coalesce(anchor_session_id, v_sess)
       where id = r.check_id;
    end if;
  end loop;
end $$;

