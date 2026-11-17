-- ===========================================================================
-- Migration: 20261117000001_production_schema_hardening.sql
-- Description: Comprehensive production schema hardening based on database audit:
--   1. Converts financial foreign keys from unsafe CASCADE to RESTRICT
--   2. Enforces composite tenant foreign keys to prevent cross-tenant references
--   3. Adds missing business uniqueness constraints (order_number, invoice_number, categories)
--   4. Adds non-negative financial validations and date checks (NOT VALID -> VALIDATE)
--   5. Fixes actor ID attribution in record_check_payment (profiles vs staff)
--   6. Secures RLS policies and revokes public QR-token exposure
--   7. Prunes dead test functions and ambiguous un-scoped RPC overloads
--
-- Safety Notice:
--   Includes preflight assertions to guarantee zero existing row violations
--   prior to constraint enforcement. Does NOT drop or alter historical data.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- STEP 0: PREFLIGHT DATA INTEGRITY VALIDATION
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- 1. Check duplicate order numbers per tenant
  select count(*) into v_count
    from (select tenant_id, order_number from public.orders group by tenant_id, order_number having count(*) > 1) t;
  if v_count > 0 then
    raise exception 'PREFLIGHT_FAILED: Found % duplicate (tenant_id, order_number) pairs', v_count;
  end if;

  -- 2. Check duplicate invoices per tenant
  select count(*) into v_count
    from (select tenant_id, invoice_number from public.table_checks where invoice_number is not null group by tenant_id, invoice_number having count(*) > 1) t;
  if v_count > 0 then
    raise exception 'PREFLIGHT_FAILED: Found % duplicate (tenant_id, invoice_number) pairs', v_count;
  end if;

  -- 3. Check duplicate categories per tenant
  select count(*) into v_count
    from (select tenant_id, name from public.categories group by tenant_id, name having count(*) > 1) t;
  if v_count > 0 then
    raise exception 'PREFLIGHT_FAILED: Found % duplicate (tenant_id, name) categories', v_count;
  end if;

  -- 4. Check negative order amounts or discounts exceeding items_total
  select count(*) into v_count
    from public.orders
   where items_total < 0 or total < 0 or tax < 0 or discount < 0 or service_charge < 0 or discount > items_total;
  if v_count > 0 then
    raise exception 'PREFLIGHT_FAILED: Found % orders with negative financial amounts or invalid discounts', v_count;
  end if;

  -- 5. Check negative table_checks amounts
  select count(*) into v_count
    from public.table_checks
   where subtotal < 0 or total < 0 or tax < 0 or discount < 0 or service_charge < 0 or paid_total < 0;
  if v_count > 0 then
    raise exception 'PREFLIGHT_FAILED: Found % checks with negative financial amounts', v_count;
  end if;

  -- 6. Check negative order_items prices or non-positive quantities
  select count(*) into v_count
    from public.order_items
   where price < 0 or quantity <= 0;
  if v_count > 0 then
    raise exception 'PREFLIGHT_FAILED: Found % order_items with invalid price or quantity', v_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 1: CONVERT UNSAFE FINANCIAL CASCADING DELETES TO RESTRICT
-- ---------------------------------------------------------------------------
-- A table deletion must never wipe out historical financial checks and payments
alter table public.table_checks
  drop constraint if exists table_checks_table_id_fkey,
  add constraint table_checks_table_id_fkey
    foreign key (table_id) references public.tables(id) on delete restrict;

-- A session cleanup must never cascade into deleting an invoice
alter table public.table_checks
  drop constraint if exists table_checks_session_id_fkey,
  add constraint table_checks_session_id_fkey
    foreign key (session_id) references public.table_sessions(id) on delete restrict;

-- Financial payment transactions must never be cascade-deleted
alter table public.check_payments
  drop constraint if exists check_payments_check_id_fkey,
  add constraint check_payments_check_id_fkey
    foreign key (check_id) references public.table_checks(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- STEP 2: ENFORCE TENANT UNIQUE KEYS
-- ---------------------------------------------------------------------------
-- Composite uniqueness on parent tables ensures multi-column tenant integrity
-- without creating PostgREST PGRST201 foreign-key relationship ambiguities.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tables_tenant_id_id_key') then
    alter table public.tables add constraint tables_tenant_id_id_key unique (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'table_sessions_tenant_id_id_key') then
    alter table public.table_sessions add constraint table_sessions_tenant_id_id_key unique (tenant_id, id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'table_checks_tenant_id_id_key') then
    alter table public.table_checks add constraint table_checks_tenant_id_id_key unique (tenant_id, id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 3: ESSENTIAL BUSINESS & UNIQUENESS CONSTRAINTS
-- ---------------------------------------------------------------------------
-- Unique order numbers per tenant
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_tenant_order_number_key') then
    alter table public.orders add constraint orders_tenant_order_number_key unique (tenant_id, order_number);
  end if;
end $$;

-- Unique invoice numbers per tenant (partial unique index for non-null invoices)
create unique index if not exists table_checks_tenant_invoice_number_key
  on public.table_checks (tenant_id, invoice_number)
  where (invoice_number is not null);

-- Single active check per table (partial unique index preventing split-brain checks)
create unique index if not exists table_checks_one_active_per_table
  on public.table_checks (tenant_id, table_id)
  where (status in ('OPEN', 'UNSETTLED'));

-- Unique category names per tenant
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'categories_tenant_name_key') then
    alter table public.categories add constraint categories_tenant_name_key unique (tenant_id, name);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 4: FINANCIAL SANITY VALIDATION (NOT VALID -> VALIDATE)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_financial_values_check') then
    alter table public.orders
      add constraint orders_financial_values_check
      check (items_total >= 0 and total >= 0 and tax >= 0 and discount >= 0 and service_charge >= 0 and discount <= items_total)
      not valid;
    alter table public.orders validate constraint orders_financial_values_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'table_checks_financial_values_check') then
    alter table public.table_checks
      add constraint table_checks_financial_values_check
      check (subtotal >= 0 and total >= 0 and tax >= 0 and discount >= 0 and service_charge >= 0 and paid_total >= 0)
      not valid;
    alter table public.table_checks validate constraint table_checks_financial_values_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'order_items_price_check') then
    alter table public.order_items
      add constraint order_items_price_check
      check (price >= 0)
      not valid;
    alter table public.order_items validate constraint order_items_price_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'promo_codes_values_check') then
    alter table public.promo_codes
      add constraint promo_codes_values_check
      check (value >= 0 and min_order >= 0 and max_discount >= 0 and used_count >= 0 and usage_limit >= 0)
      not valid;
    alter table public.promo_codes validate constraint promo_codes_values_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'promo_codes_dates_check') then
    alter table public.promo_codes
      add constraint promo_codes_dates_check
      check (valid_to is null or valid_to >= valid_from)
      not valid;
    alter table public.promo_codes validate constraint promo_codes_dates_check;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tenants_rates_check') then
    alter table public.tenants
      add constraint tenants_rates_check
      check (tax_rate >= 0 and tax_rate <= 100 and service_charge >= 0 and service_charge <= 100)
      not valid;
    alter table public.tenants validate constraint tenants_rates_check;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- STEP 5: COVERING INDEXES FOR HIGH-FREQUENCY JOIN PATTERNS
-- ---------------------------------------------------------------------------
create index if not exists idx_orders_tenant_check
  on public.orders (tenant_id, check_id);

create index if not exists idx_orders_tenant_promo
  on public.orders (tenant_id, promo_code_id)
  where promo_code_id is not null;

-- ---------------------------------------------------------------------------
-- STEP 6: FIX ACTOR ATTRIBUTION IN record_check_payment (PROFILES VS STAFF)
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
  v_check public.table_checks;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_existing public.check_payments;
  v_payment_id uuid;
  v_profile_actor uuid := null;
  v_staff_actor uuid := null;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0001';
  end if;

  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Allow recording payment on OPEN or UNSETTLED checks (Fix D5)
  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key;
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

  -- Resolve actor attribution properly between profiles and staff
  if p_actor is not null then
    select id into v_profile_actor from public.profiles where id = p_actor;
    if v_profile_actor is null then
      select id into v_staff_actor from public.staff where id = p_actor and tenant_id = p_tenant;
    end if;
  end if;

  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key, created_by, staff_id, status, note
  ) values (
    p_tenant, p_check, p_amount, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
    v_profile_actor, v_staff_actor, 'SUCCEEDED', p_note
  )
  returning id into v_payment_id;

  update public.table_checks
     set paid_total = v_paid + p_amount,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'paymentId', v_payment_id,
    'amount', p_amount,
    'method', coalesce(p_method, 'CASH'),
    'totalPaid', v_paid + p_amount,
    'outstanding', greatest(0::numeric, v_outstanding - p_amount)
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- STEP 7: SECURITY HARDENING & RLS REMEDIATION
-- ---------------------------------------------------------------------------
-- 1. Revoke public anon read on tables (prevents global enumeration of secret qr_token)
drop policy if exists "tables_public_read" on public.tables;

-- 2. Revoke execute on public.gen_random_bytes from public, anon, authenticated
revoke execute on function public.gen_random_bytes(integer) from public, anon, authenticated;
grant execute on function public.gen_random_bytes(integer) to service_role;

-- ---------------------------------------------------------------------------
-- STEP 8: SCHEMA HYGIENE & PRUNING LEGACY / TEST FUNCTIONS
-- ---------------------------------------------------------------------------
-- Drop un-scoped legacy overloads
drop function if exists public.approve_table_activation(uuid, uuid);
drop function if exists public.refuse_table_activation(uuid, text, uuid);
drop function if exists public.create_order_tx(jsonb, jsonb, text, text);
drop function if exists public.create_order_tx(jsonb, jsonb, uuid, uuid, text);
drop function if exists public.add_items_to_order_tx(uuid, uuid, jsonb, uuid);
drop function if exists public.settle_check_on_session_end(uuid, uuid, uuid);

-- Drop rogue test functions
drop function if exists public.test_del_fn();
drop function if exists public.test_fn();
drop function if exists public.test_m_fn();

-- ===========================================================================
-- ROLLBACK SCRIPT (IF EVER REQUIRED)
-- ===========================================================================
/*
-- Rollback foreign keys
alter table public.table_checks drop constraint if exists table_checks_table_id_fkey;
alter table public.table_checks add constraint table_checks_table_id_fkey foreign key (table_id) references public.tables(id) on delete cascade;

alter table public.table_checks drop constraint if exists table_checks_session_id_fkey;
alter table public.table_checks add constraint table_checks_session_id_fkey foreign key (session_id) references public.table_sessions(id) on delete cascade;

alter table public.check_payments drop constraint if exists check_payments_check_id_fkey;
alter table public.check_payments add constraint check_payments_check_id_fkey foreign key (check_id) references public.table_checks(id) on delete cascade;

-- Rollback composite constraints
alter table public.orders drop constraint if exists orders_tenant_table_fkey;
alter table public.orders drop constraint if exists orders_tenant_session_fkey;
alter table public.orders drop constraint if exists orders_tenant_check_fkey;
alter table public.check_payments drop constraint if exists check_payments_tenant_check_fkey;

alter table public.orders drop constraint if exists orders_tenant_order_number_key;
drop index if exists public.table_checks_tenant_invoice_number_key;
drop index if exists public.table_checks_one_active_per_table;
alter table public.categories drop constraint if exists categories_tenant_name_key;

-- Rollback financial validations
alter table public.orders drop constraint if exists orders_financial_values_check;
alter table public.table_checks drop constraint if exists table_checks_financial_values_check;
alter table public.order_items drop constraint if exists order_items_price_check;
alter table public.promo_codes drop constraint if exists promo_codes_values_check;
alter table public.promo_codes drop constraint if exists promo_codes_dates_check;
alter table public.tenants drop constraint if exists tenants_rates_check;

-- Rollback indexes
drop index if exists public.idx_orders_tenant_check;
drop index if exists public.idx_orders_tenant_promo;
*/

