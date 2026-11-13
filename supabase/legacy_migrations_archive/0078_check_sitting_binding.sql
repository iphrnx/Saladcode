-- ===========================================================================
-- 0078 — a check belongs to a sitting, and only while that sitting is live
--
-- 0077 made one OPEN check per table. That was wrong in one direction that
-- costs money: the check never closed while the table was empty, so the next
-- diner to scan that table joined the previous sitting's bill — inheriting
-- their orders, their payments and their outstanding balance.
--
-- It was wrong in a second direction too: `finalize_table_check` set
-- status = 'PAID' without checking that the check had actually been paid. The
-- POS disabled the button until the balance was zero, but the endpoint did not
-- care, so an unpaid check could be closed as settled and the outstanding
-- balance silently disappear.
--
-- The model now:
--
--   * A check is opened by a session and belongs to that table's sitting.
--   * A check is live only while at least one session on its table is ACTIVE.
--   * Scanning a table whose previous check is not live closes that check as
--     UNSETTLED — never PAID, never deleted — keeping its totals, its orders
--     and its payments, and leaving `outstanding` readable as money owed.
--   * Settlement requires the money: finalize refuses while anything is due.
--   * A sweep abandons checks whose sitting ended and which nobody settled.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The status set gains one honest terminal state
-- ---------------------------------------------------------------------------
alter table public.table_checks
  add column if not exists anchor_session_id uuid references public.table_sessions(id) on delete set null,
  add column if not exists unsettled_at timestamptz;

do $$
begin
  alter table public.table_checks drop constraint if exists table_checks_status_check;
  alter table public.table_checks
    add constraint table_checks_status_check
    check (status in ('OPEN', 'PAID', 'VOID', 'UNSETTLED'));
end $$;

comment on column public.table_checks.anchor_session_id is
  'The session that opened this check — the sitting it belongs to (0078).';
comment on column public.table_checks.unsettled_at is
  'Set when the sitting ended with a balance still owed. The record is kept, never voided.';

-- Same rule, still enforced by the database: one OPEN check per table at a
-- time. It is now correct because the previous one is closed, not left open.
drop index if exists public.table_checks_one_open_per_table;
create unique index if not exists table_checks_one_open_per_table
  on public.table_checks (table_id)
  where status = 'OPEN';

-- ---------------------------------------------------------------------------
-- 2. Is this check still attached to a sitting?
-- ---------------------------------------------------------------------------
create or replace function public.check_is_live(p_check uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
      from public.table_checks c
      join public.table_sessions s
        on s.table_id = c.table_id
       and s.tenant_id = c.tenant_id
       and s.status = 'ACTIVE'
     where c.id = p_check
  );
$$;

revoke execute on function public.check_is_live(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Opening a check
--
-- Reuses the open check only while its sitting is live. Otherwise the previous
-- check is closed as UNSETTLED — totals, orders and payments intact — and a
-- new one opens for this diner's sitting.
-- ---------------------------------------------------------------------------
create or replace function public.open_table_check(
  p_tenant uuid,
  p_table uuid,
  p_session uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.table_checks;
  v_id uuid;
begin
  -- Serialise per table: two diners scanning the same empty table at the same
  -- moment must produce one check, not two, and neither may close the other's
  -- sitting out from under it.
  perform pg_advisory_xact_lock(hashtext(p_table::text));

  select * into v_existing
    from public.table_checks
   where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'
   for update;

  if found then
    if public.check_is_live(v_existing.id) then
      return v_existing.id;
    end if;

    -- The sitting is over and the bill was never settled. Close it without
    -- touching a single figure: this is a record of money owed, not a mistake
    -- to be tidied away.
    update public.table_checks
       set status = 'UNSETTLED',
           closed_at = coalesce(closed_at, now()),
           unsettled_at = now(),
           updated_at = now()
     where id = v_existing.id;
  end if;

  insert into public.table_checks (tenant_id, table_id, anchor_session_id)
  values (p_tenant, p_table, p_session)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;

-- The two-argument form stays for any caller that has no session in hand; a
-- defaulted third argument covers both, so this is only documentation.
comment on function public.open_table_check(uuid, uuid, uuid) is
  'The table''s live check, closing an unsettled previous one first (0078).';

-- ---------------------------------------------------------------------------
-- 4. Settlement requires the money
-- ---------------------------------------------------------------------------
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(10,2);
begin
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_check.status = 'PAID' then
    return jsonb_build_object('ok', true, 'already', true, 'invoiceNumber', v_check.invoice_number);
  end if;

  if v_check.status <> 'OPEN' then
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

  -- The money, from the ledger. A check is settled when it has been paid, not
  -- when somebody says so: this is the line that stops an unpaid balance being
  -- closed as PAID.
  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + 0.005 < v_totals.total then
    raise exception 'UNPAID:%.2f', v_totals.total - v_paid using errcode = 'P0001';
  end if;

  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1
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

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paidTotal', v_paid
  );
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Ending a sitting, safely
--
-- Called when the last session on a table ends. A settled check is closed and
-- numbered; an unsettled one is left OPEN and flagged as owing, so the person
-- closing the table sees it in the list rather than losing it.
-- ---------------------------------------------------------------------------
create or replace function public.settle_check_on_session_end(p_tenant uuid, p_table uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.table_checks;
  v_open_orders integer;
  v_paid numeric(10,2);
  v_total numeric(10,2);
begin
  select * into v_check
    from public.table_checks
   where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'
   for update;

  if not found then
    return jsonb_build_object('ok', true, 'action', 'none');
  end if;

  -- Another diner is still at the table: the sitting is not over.
  if public.check_is_live(v_check.id) then
    return jsonb_build_object('ok', true, 'action', 'sitting_open');
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = v_check.id
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    return jsonb_build_object('ok', true, 'action', 'orders_open', 'orders', v_open_orders);
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders where check_id = v_check.id and status <> 'CANCELLED';

  if v_total <= 0 then
    -- Nothing was ever ordered: there is no bill to keep.
    update public.table_checks
       set status = 'VOID', closed_at = coalesce(closed_at, now()), updated_at = now()
     where id = v_check.id;
    return jsonb_build_object('ok', true, 'action', 'voided');
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments where check_id = v_check.id and status = 'SUCCEEDED';

  if v_paid + 0.005 >= v_total then
    -- Paid in full: close it and issue the number. Idempotent by construction.
    perform public.finalize_table_check(p_tenant, v_check.id, p_actor);
    return jsonb_build_object('ok', true, 'action', 'finalized');
  end if;

  -- Money is still owed. The check stays OPEN and visible, with what is due.
  update public.table_checks
     set updated_at = now(),
         version = version + 1
   where id = v_check.id;

  return jsonb_build_object(
    'ok', true,
    'action', 'unsettled',
    'outstanding', v_total - v_paid
  );
end $$;

revoke execute on function public.settle_check_on_session_end(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_check_on_session_end(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The sweep
--
-- A check whose sitting ended and which nobody settled is closed as UNSETTLED
-- after the window, keeping every figure. It is not voided, not paid, not
-- deleted: an unpaid bill is a fact about the restaurant's day.
-- ---------------------------------------------------------------------------
create or replace function public.expire_stale_table_checks(p_after interval default '6 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with gone as (
    update public.table_checks c
       set status = 'UNSETTLED',
           unsettled_at = now(),
           closed_at = coalesce(c.closed_at, now()),
           updated_at = now()
     where c.status = 'OPEN'
       and c.opened_at < now() - p_after
       and not public.check_is_live(c.id)
    returning 1
  )
  select count(*) into v_count from gone;
  return v_count;
end $$;

revoke execute on function public.expire_stale_table_checks(interval) from public, anon, authenticated;
grant execute on function public.expire_stale_table_checks(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Refunds, while the bill is still open
--
-- A payment can be reversed before the check is invoiced: the row is kept and
-- marked VOID, and the balance goes back up. After an invoice exists this is no
-- longer a refund, it is a credit note, and that is a separate document this
-- system does not issue yet — so it is refused rather than approximated.
-- ---------------------------------------------------------------------------
create or replace function public.void_check_payment(
  p_tenant uuid,
  p_payment uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.check_payments;
  v_check public.table_checks;
  v_paid numeric(10,2);
begin
  select * into v_payment
    from public.check_payments
   where id = p_payment and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_payment.status = 'VOID' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  select * into v_check
    from public.table_checks
   where id = v_payment.check_id and tenant_id = p_tenant
   for update;

  if v_check.status <> 'OPEN' then
    raise exception 'INVOICED' using errcode = 'P0001';
  end if;

  update public.check_payments
     set status = 'VOID',
         note = coalesce(p_reason, note)
   where id = p_payment;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = v_check.id and status = 'SUCCEEDED';

  update public.table_checks
     set paid_total = v_paid,
         version = version + 1,
         updated_at = now()
   where id = v_check.id;

  return jsonb_build_object('ok', true, 'already', false, 'paidTotal', v_paid);
end $$;

revoke execute on function public.void_check_payment(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.void_check_payment(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Orders anchor the check to their own session
--
-- Same function as 0077, with one change: the session that placed the first
-- order on a table becomes the check's anchor, so the bill can say which
-- sitting it belongs to.
-- ---------------------------------------------------------------------------
create or replace function public.create_order_tx(
  p_order jsonb,
  p_items jsonb,
  p_promo_code_id uuid default null,
  p_idempotency_key uuid default null,
  p_status text default 'PENDING'
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
  v_check uuid;
  v_table uuid := nullif(p_order->>'table_id', '')::uuid;
  v_session uuid := nullif(p_order->>'table_session_id', '')::uuid;
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

  if v_table is not null then
    v_check := public.open_table_check(v_tenant, v_table, v_session);
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
    coalesce(p_order->>'order_type', 'DINE_IN'),
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
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select id into v_order_id from public.orders where idempotency_key = p_idempotency_key;
    return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
  end if;

  if p_promo_code_id is not null then
    update public.promo_codes
       set used_count = used_count + 1
     where id = p_promo_code_id
       and tenant_id = v_tenant and active
       and (usage_limit = 0 or used_count < usage_limit)
       and valid_from <= now()
       and (valid_to is null or valid_to >= now());
    if not found then raise exception 'PROMO_REJECTED'; end if;
  end if;

  insert into public.order_items (
    order_id, menu_item_id, name, price, quantity, notes, status, portion_id, portion
  )
  select v_order_id, (line->>'menu_item_id')::uuid, line->>'name',
         (line->>'price')::numeric, (line->>'quantity')::integer,
         nullif(line->>'notes', ''), 'PENDING',
         nullif(line->>'portion_id', ''), nullif(line->>'portion', '')
  from jsonb_array_elements(p_items) as line;

  return jsonb_build_object('order_id', v_order_id, 'deduplicated', false, 'check_id', v_check);
end;
$$;

revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) to service_role;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid) to service_role;
