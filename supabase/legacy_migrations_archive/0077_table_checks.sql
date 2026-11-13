-- ===========================================================================
-- 0077 — consolidated table billing
--
-- A sitting is one bill, however many orders it took. Until now a bill was one
-- order: a table with three orders had three bills, three receipt numbers and
-- no way to take one payment for the lot.
--
-- The model:
--
--   table_checks      one row per sitting, at most one OPEN per table
--   orders.check_id   every accepted order belongs to exactly one check
--   check_payments    money in, one row per payment, keyed for idempotency
--   check_invoice_counters  tenant-scoped numbering, allocated once
--
-- What it deliberately does NOT do: recompute tax. Every order is priced and
-- taxed server-side when it is placed (the edge function re-reads every line),
-- so a check is the sum of orders that already carry their own GST. Adding a
-- second tax calculation here would be a second opinion on money.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The check
-- ---------------------------------------------------------------------------
create table if not exists public.table_checks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  table_id        uuid not null references public.tables(id) on delete cascade,
  status          text not null default 'OPEN',

  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,

  -- Totals are a snapshot taken when the check is finalised, from the orders.
  subtotal        numeric(10,2) not null default 0,
  discount        numeric(10,2) not null default 0,
  tax             numeric(10,2) not null default 0,
  service_charge  numeric(10,2) not null default 0,
  total           numeric(10,2) not null default 0,
  paid_total      numeric(10,2) not null default 0,

  -- Allocated exactly once, at finalisation, under an advisory lock.
  invoice_number  text,
  invoice_date    timestamptz,

  -- Bumped on every payment; a stale screen cannot settle twice.
  version         integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint table_checks_status_check check (status in ('OPEN', 'PAID', 'VOID'))
);

-- One open check per table, enforced by the database rather than by hoping two
-- requests do not arrive together.
create unique index if not exists table_checks_one_open_per_table
  on public.table_checks (table_id)
  where status = 'OPEN';

create index if not exists table_checks_tenant_idx on public.table_checks (tenant_id, opened_at desc);
create unique index if not exists table_checks_invoice_uidx
  on public.table_checks (tenant_id, invoice_number)
  where invoice_number is not null;

alter table public.table_checks enable row level security;

-- Readable by the restaurant's own people; written only by the edge functions,
-- which is why there is no insert/update policy at all.
drop policy if exists table_checks_member_read on public.table_checks;
create policy table_checks_member_read on public.table_checks
  for select to authenticated
  using (public.is_member_of(tenant_id));

-- ---------------------------------------------------------------------------
-- 2. The payment ledger
-- ---------------------------------------------------------------------------
create table if not exists public.check_payments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  check_id         uuid not null references public.table_checks(id) on delete cascade,
  amount           numeric(10,2) not null,
  currency         text not null default 'INR',
  method           text not null default 'CASH',
  status           text not null default 'SUCCEEDED',
  /** The client's key for this payment. One payment per key, forever. */
  idempotency_key  uuid,
  note             text,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),

  constraint check_payments_amount_positive check (amount > 0),
  constraint check_payments_method_check check (method in ('CASH')),
  constraint check_payments_status_check check (status in ('SUCCEEDED', 'VOID'))
);

create unique index if not exists check_payments_idem_uidx
  on public.check_payments (idempotency_key)
  where idempotency_key is not null;
create index if not exists check_payments_check_idx on public.check_payments (check_id);

alter table public.check_payments enable row level security;

drop policy if exists check_payments_member_read on public.check_payments;
create policy check_payments_member_read on public.check_payments
  for select to authenticated
  using (public.is_member_of(tenant_id));

-- ---------------------------------------------------------------------------
-- 3. Tenant-scoped invoice numbers
-- ---------------------------------------------------------------------------
create table if not exists public.check_invoice_counters (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  last_seq  bigint not null default 0
);

alter table public.check_invoice_counters enable row level security;
revoke all on public.check_invoice_counters from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Attach every accepted order to the table's open check
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists check_id uuid references public.table_checks(id) on delete set null;

create index if not exists orders_check_idx on public.orders (check_id);

/**
 * The open check for a table, created if there is none.
 *
 * Two concurrent scans race here; the partial unique index decides and the
 * loser reads the winner's row. `on conflict` needs the index predicate to
 * match exactly, which is why it is spelled out.
 */
create or replace function public.open_table_check(p_tenant uuid, p_table uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.table_checks (tenant_id, table_id)
  values (p_tenant, p_table)
  on conflict (table_id) where status = 'OPEN' do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
      from public.table_checks
     where table_id = p_table and status = 'OPEN';
  end if;

  return v_id;
end $$;

revoke execute on function public.open_table_check(uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid) to service_role;

/**
 * Take a payment against a check.
 *
 * Idempotent on the client's key: the same key returns the same payment and
 * changes nothing. Overpayment is refused — the check's total is the sum of
 * orders that were actually cooked, and taking more than that is a mistake
 * that is very hard to unwind later.
 */
create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric,
  p_method text default 'CASH',
  p_idempotency_key uuid default null,
  p_actor uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.table_checks;
  v_paid numeric(10,2);
  v_total numeric(10,2);
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;

  -- Replay: hand back the original payment, write nothing.
  if p_idempotency_key is not null then
    select id into v_id from public.check_payments where idempotency_key = p_idempotency_key;
    if v_id is not null then
      return jsonb_build_object('ok', true, 'deduplicated', true, 'paymentId', v_id);
    end if;
  end if;

  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_check.status <> 'OPEN' then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders
   where check_id = p_check and status not in ('PENDING_ACTIVATION', 'CANCELLED');

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  if v_paid + p_amount > v_total then
    raise exception 'OVERPAYMENT:%.2f:%.2f', v_total - v_paid, p_amount using errcode = 'P0001';
  end if;

  insert into public.check_payments (tenant_id, check_id, amount, method, idempotency_key, created_by, note)
  values (p_tenant, p_check, p_amount, coalesce(p_method, 'CASH'), p_idempotency_key, p_actor, p_note)
  returning id into v_id;

  update public.table_checks
     set paid_total = v_paid + p_amount,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  return jsonb_build_object('ok', true, 'deduplicated', false, 'paymentId', v_id, 'outstanding', v_total - (v_paid + p_amount));
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, uuid, uuid, text) to service_role;

/**
 * Finalise a check: allocate its invoice number, snapshot its totals, close it.
 *
 * Locked and idempotent. The number is allocated exactly once — a second call
 * returns the same invoice rather than burning another.
 */
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

  -- Nothing may still be cooking on the bill. A check is the money for food
  -- that exists, not for food that might.
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

  -- Numbering: one row per tenant, incremented under this check's own lock, so
  -- two tables settling at the same moment cannot take the same number.
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
         version = version + 1,
         updated_at = now()
   where id = p_check;

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paidTotal', v_check.paid_total
  );
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Orders join the check as they are created
--
-- Redefinition of the 0076 function with one addition: the check is resolved
-- from the table and stamped on the row. Held orders join it too — the check
-- sums only what is not held, so an unaccepted order cannot add to a bill it
-- was never part of.
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
begin
  if p_status not in ('PENDING', 'PENDING_ACTIVATION') then
    raise exception 'INVALID_STATUS:%', p_status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select id into v_order_id
      from public.orders
     where idempotency_key = p_idempotency_key;
    if v_order_id is not null then
      return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    select id, tenant_id, available into v_menu
      from public.menu_items
     where id = (v_item->>'menu_item_id')::uuid;
    if v_menu is null or v_menu.tenant_id <> v_tenant or v_menu.available = false then
      raise exception 'ITEM_UNAVAILABLE:%', v_item->>'menu_item_id';
    end if;
  end loop;

  if v_table is not null then
    v_check := public.open_table_check(v_tenant, v_table);
  end if;

  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes,
    served_by_id, idempotency_key, check_id
  ) values (
    v_tenant,
    v_table,
    nullif(p_order->>'table_session_id', '')::uuid,
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
    select id into v_order_id
      from public.orders
     where idempotency_key = p_idempotency_key;
    return jsonb_build_object('order_id', v_order_id, 'deduplicated', true);
  end if;

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

  return jsonb_build_object('order_id', v_order_id, 'deduplicated', false, 'check_id', v_check);
end;
$$;

revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) to service_role;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Backfill: every existing table order joins its table's open check
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_check uuid;
begin
  for r in
    select distinct tenant_id, table_id
      from public.orders
     where table_id is not null
       and check_id is null
       and created_at > now() - interval '12 hours'
  loop
    v_check := public.open_table_check(r.tenant_id, r.table_id);
    update public.orders o
       set check_id = v_check
     where o.table_id = r.table_id
       and o.check_id is null
       and o.created_at > now() - interval '12 hours';
  end loop;
end $$;
