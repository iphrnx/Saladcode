-- Migration: 20261116000007_fix_concurrency_vulnerabilities_c1_c5.sql
-- Fix concurrency vulnerabilities C1 (Order Idempotency), C2 (Promo Usage Race),
-- C3 (Table Activation Race), and C5 (Razorpay Webhook Retry Loss).

-- ---------------------------------------------------------------------------
-- 1. SUBSCRIPTION WEBHOOK RETRY & STATUS SCHEMA (Fix C5)
-- ---------------------------------------------------------------------------
alter table public.subscription_webhook_events
  add column if not exists status text not null default 'processing',
  add column if not exists attempts integer not null default 1,
  add column if not exists processed_at timestamptz,
  add column if not exists result text,
  add column if not exists last_error text;

-- Add status constraint if not present
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'subscription_webhook_events_status_check'
  ) then
    alter table public.subscription_webhook_events
      add constraint subscription_webhook_events_status_check
      check (status in ('pending', 'processing', 'processed', 'failed'));
  end if;
end $$;

-- Update existing processed events
update public.subscription_webhook_events
   set status = 'processed',
       processed_at = coalesce(processed_at, received_at)
 where processed_at is not null or status = 'processing';

-- ---------------------------------------------------------------------------
-- 2. ROBUST apply_subscription_event RPC WITH RETRY & LEASING (Fix C5)
-- ---------------------------------------------------------------------------
create or replace function public.apply_subscription_event(
  p_event_id text,
  p_event_type text,
  p_subscription_id text,
  p_event_created_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cursor timestamptz;
  v_existing record;
begin
  if p_event_id is null or length(btrim(p_event_id)) = 0 then
    raise exception 'an event id is required';
  end if;

  -- 1. Check if event was already recorded (with row lock)
  select * into v_existing
    from public.subscription_webhook_events
   where event_id = p_event_id
     for update;

  if found then
    -- If already successfully processed, return duplicate
    if v_existing.status = 'processed' then
      return 'duplicate';
    end if;

    -- If currently being processed by another worker within lease time (5 minutes)
    if v_existing.status = 'processing' and v_existing.received_at > now() - interval '5 minutes' then
      return 'in_progress';
    end if;

    -- If failed or processing lease expired, claim the retry:
    update public.subscription_webhook_events
       set status = 'processing',
           attempts = v_existing.attempts + 1,
           received_at = now()
     where event_id = p_event_id;
  else
    -- First delivery: insert with status = 'processing'
    begin
      insert into public.subscription_webhook_events (
        event_id, event_type, received_at, razorpay_subscription_id, event_created_at, status, attempts
      ) values (
        p_event_id, p_event_type, now(), p_subscription_id, p_event_created_at, 'processing', 1
      );
    exception
      when unique_violation then
        -- Concurrently inserted in parallel transaction: re-lock and inspect
        select * into v_existing
          from public.subscription_webhook_events
         where event_id = p_event_id
           for update;
        if v_existing.status = 'processed' then
          return 'duplicate';
        elsif v_existing.status = 'processing' and v_existing.received_at > now() - interval '5 minutes' then
          return 'in_progress';
        else
          update public.subscription_webhook_events
             set status = 'processing',
                 attempts = v_existing.attempts + 1,
                 received_at = now()
           where event_id = p_event_id;
        end if;
    end;
  end if;

  -- 2. Stale event check against cursor (only for events with subscription_id)
  if p_subscription_id is not null then
    select c.last_event_created_at into v_cursor
      from public.subscription_event_cursors c
     where c.razorpay_subscription_id = p_subscription_id
       for update;

    if v_cursor is not null
       and p_event_created_at is not null
       and p_event_created_at < v_cursor then
      -- Mark as stale so it's not reprocessed
      update public.subscription_webhook_events
         set status = 'processed',
             result = 'stale: out of order delivery',
             processed_at = now()
       where event_id = p_event_id;
      return 'stale';
    end if;

    insert into public.subscription_event_cursors (
      razorpay_subscription_id, last_event_created_at, updated_at
    ) values (
      p_subscription_id, coalesce(p_event_created_at, now()), now()
    )
    on conflict (razorpay_subscription_id) do update
      set last_event_created_at = greatest(
            public.subscription_event_cursors.last_event_created_at,
            coalesce(excluded.last_event_created_at, now())
          ),
          updated_at = now();
  end if;

  return 'applied';
end;
$$;

revoke execute on function public.apply_subscription_event(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_subscription_event(text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 3. STATE-GUARDED refuse_table_activation (Fix C3)
-- ---------------------------------------------------------------------------
create or replace function public.refuse_table_activation(
  p_tenant uuid,
  p_session uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
  v_cancelled integer := 0;
begin
  select * into v_session
    from public.table_sessions
   where id = p_session and tenant_id = p_tenant
     for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Guard against rejecting an already active session
  if v_session.activation_status = 'ACTIVE' then
    raise exception 'SESSION_ALREADY_ACTIVE' using errcode = 'P0001';
  end if;

  -- Idempotency check: if session is already rejected or closed
  if v_session.activation_status = 'REJECTED' or v_session.status <> 'ACTIVE' then
    return jsonb_build_object('ok', true, 'already', true, 'cancelled', 0);
  end if;

  with cancelled as (
    update public.orders
       set status = 'CANCELLED',
           updated_at = now(),
           cancellation_reason = coalesce(p_reason, 'Table not accepted by the restaurant')
     where table_session_id = p_session
       and status = 'PENDING_ACTIVATION'
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  update public.table_sessions
     set activation_status = 'REJECTED',
         status = 'ENDED',
         ended_at = now()
   where id = p_session;

  return jsonb_build_object('ok', true, 'already', false, 'cancelled', v_cancelled);
end $$;

revoke execute on function public.refuse_table_activation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.refuse_table_activation(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. CONCURRENCY-SAFE create_order_tx (Fix C1 & C2)
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
end $$;

revoke execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to service_role;
