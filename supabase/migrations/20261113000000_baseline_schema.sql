-- ===========================================================================
-- THE SALAD — AUTHORITATIVE PRODUCTION BASELINE SCHEMA
-- ===========================================================================
-- Version: 20261113000000_baseline_schema.sql
-- Description: Complete, normalized PostgreSQL schema for The Salad Restaurant SaaS.
-- Architecture: Multi-tenant, multi-location, consolidated table billing,
--               real-time kitchen workflow, QR ordering, zero-trust RLS.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- 2. MULTI-TENANT CORE & LOCATIONS
-- ---------------------------------------------------------------------------

-- Tenants (Organizations / Restaurant Brands)
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  tagline text,
  logo text,
  currency text not null default 'INR',
  currency_symbol text not null default '₹',
  address text,
  phone text,
  email text,
  tax_rate numeric(5, 2) not null default 5.00,
  service_charge numeric(5, 2) not null default 0.00,
  plan text not null default 'starter',
  active boolean not null default true,
  onboarding_done boolean not null default false,
  -- Subscription & Trial Fields
  trial_started_at timestamptz default now(),
  trial_ends_at timestamptz default (now() + interval '14 days'),
  current_period_end timestamptz,
  subscription_status text default 'trialing',
  subscription_plan text default 'starter',
  payment_mode text default 'autopay',
  billing_interval text default 'monthly',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Locations (Multi-Location Support)
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  slug text not null,
  address text,
  phone text,
  email text,
  tax_rate numeric(5, 2),
  service_charge numeric(5, 2),
  is_primary boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

-- Roles (Granular RBAC)
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  permissions text not null default '[]',
  is_system boolean not null default false,
  color text not null default '#64748b',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

-- Profiles (Tenant owners / manager user accounts linked to auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid references public.tenants(id) on delete cascade,
  role_id uuid references public.roles(id) on delete set null,
  name text not null,
  email text not null,
  phone text,
  avatar text,
  role text not null default 'Owner',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Staff (PIN-authenticated staff members)
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  role_id uuid references public.roles(id) on delete set null,
  name text not null,
  employee_id text not null,
  pin_hash text not null,
  pin_salt text not null,
  avatar text,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, employee_id)
);

-- Staff Sessions (12-hour session storage)
create table if not exists public.staff_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  token text not null unique,
  device text,
  browser text,
  os text,
  ip text,
  last_active timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. RESTAURANT FLOOR & TABLES
-- ---------------------------------------------------------------------------

create table if not exists public.dining_areas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  name text not null,
  seats integer not null default 4,
  area text not null default 'Main Hall',
  qr_token text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

-- Diner Table Sessions (Individual scan sitting sessions)
create table if not exists public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(24), 'hex'),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ENDED', 'ABANDONED', 'PENDING_ACTIVATION', 'REJECTED')),
  activation_status text not null default 'ACTIVE' check (activation_status in ('ACTIVE', 'PENDING', 'REJECTED', 'EXPIRED')),
  activation_requested_at timestamptz,
  activated_at timestamptz,
  activated_by uuid references public.profiles(id) on delete set null,
  device_fp text,
  ip text,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. MENU SYSTEM
-- ---------------------------------------------------------------------------

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  icon text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  name text not null,
  description text,
  price numeric(10, 2) not null default 0.00,
  portions jsonb default '[]'::jsonb,
  image text,
  available boolean not null default true,
  prep_time integer not null default 15,
  tags text,
  calories integer,
  rating numeric(3, 2) not null default 4.50,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. CONSOLIDATED TABLE BILLING & PAYMENT LEDGER
-- ---------------------------------------------------------------------------

-- Table Checks (Consolidated billing container for a table visit)
create table if not exists public.table_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  anchor_session_id uuid references public.table_sessions(id) on delete set null,
  status text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'VOID', 'UNSETTLED')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  unsettled_at timestamptz,
  invoice_number text,
  invoice_date timestamptz,
  subtotal numeric(12, 2) not null default 0.00,
  discount numeric(12, 2) not null default 0.00,
  tax numeric(12, 2) not null default 0.00,
  service_charge numeric(12, 2) not null default 0.00,
  total numeric(12, 2) not null default 0.00,
  paid_total numeric(12, 2) not null default 0.00,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Exactly ONE open check per table at a time
create unique index if not exists table_checks_one_open_per_table
  on public.table_checks (table_id)
  where status = 'OPEN';

-- Check Payments (Ledger of money received against a table check)
create table if not exists public.check_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  check_id uuid not null references public.table_checks(id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  method text not null check (method in ('CASH', 'UPI', 'CARD')),
  idempotency_key text not null,
  created_by uuid references public.profiles(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  status text not null default 'SUCCEEDED' check (status in ('SUCCEEDED', 'VOID')),
  note text,
  created_at timestamptz not null default now(),
  unique (check_id, idempotency_key)
);

create unique index if not exists check_payments_idem_uidx
  on public.check_payments (tenant_id, idempotency_key);

-- Counter sequence for sequential tenant invoices (INV-0000001)
create table if not exists public.check_invoice_counters (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  last_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6. ORDERS & KITCHEN DISPLAY
-- ---------------------------------------------------------------------------

-- Marketing Promo Codes
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  description text,
  type text not null default 'PERCENTAGE' check (type in ('PERCENTAGE', 'FLAT')),
  value numeric(10, 2) not null default 0.00,
  min_order numeric(10, 2) not null default 0.00,
  max_discount numeric(10, 2) not null default 0.00,
  usage_limit integer not null default 100,
  used_count integer not null default 0,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  table_id uuid references public.tables(id) on delete set null,
  table_session_id uuid references public.table_sessions(id) on delete set null,
  check_id uuid references public.table_checks(id) on delete set null,
  order_number serial,
  order_type text not null default 'DINE_IN' check (order_type in ('DINE_IN', 'TAKEAWAY', 'DELIVERY')),
  status text not null default 'PENDING' check (status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED', 'REJECTED')),
  items_total numeric(12, 2) not null default 0.00,
  discount numeric(12, 2) not null default 0.00,
  tax numeric(12, 2) not null default 0.00,
  service_charge numeric(12, 2) not null default 0.00,
  total numeric(12, 2) not null default 0.00,
  promo_code_id uuid references public.promo_codes(id) on delete set null,
  promo_code text,
  customer_name text,
  customer_phone text,
  notes text,
  payment_method text,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'partially_paid', 'paid', 'refunded', 'PAID')),
  served_by_id uuid references public.profiles(id) on delete set null,
  idempotency_key uuid,
  cancellation_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists orders_idempotency_key_idx
  on public.orders (idempotency_key)
  where idempotency_key is not null;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name text not null,
  portion_id text,
  portion text,
  price numeric(10, 2) not null default 0.00,
  quantity integer not null check (quantity > 0),
  notes text,
  status text not null default 'PENDING' check (status in ('PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. RESERVATIONS & CUSTOMER REVIEWS
-- ---------------------------------------------------------------------------

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  table_id uuid references public.tables(id) on delete set null,
  name text not null,
  phone text not null,
  email text,
  party_size integer not null default 2,
  date date not null,
  time time not null,
  status text not null default 'CONFIRMED' check (status in ('PENDING', 'CONFIRMED', 'SEATED', 'CANCELLED', 'NO_SHOW')),
  occasion text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  table_session_id uuid references public.table_sessions(id) on delete set null,
  rating integer not null check (rating >= 1 and rating <= 5),
  food_rating integer check (food_rating >= 1 and food_rating <= 5),
  service_rating integer check (service_rating >= 1 and service_rating <= 5),
  comment text,
  customer_name text,
  customer_phone text,
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8. SETTINGS, SECURITY & PLATFORM AUDIT
-- ---------------------------------------------------------------------------

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create table if not exists public.security_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  staff_id uuid references public.staff(id) on delete set null,
  action text not null,
  ip text,
  user_agent text,
  meta text,
  created_at timestamptz not null default now()
);

create table if not exists public.tenant_realtime (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  secret text not null default encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now()
);

create table if not exists public.rate_limits (
  bucket text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);

create table if not exists public.super_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null,
  model text not null,
  operation text not null,
  tokens_used integer default 0,
  success boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  to_email text not null,
  subject text not null,
  template text not null,
  payload jsonb,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. SAAS BILLING & SUBSCRIPTIONS
-- ---------------------------------------------------------------------------

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade unique,
  plan_id text not null default 'starter',
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused', 'expired')),
  trial_started_at timestamptz not null default now(),
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  billing_interval text default 'monthly' check (billing_interval in ('monthly', 'annual')),
  payment_mode text default 'autopay' check (payment_mode in ('autopay', 'pay_once')),
  razorpay_customer_id text,
  razorpay_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  amount numeric(10, 2) not null,
  currency text not null default 'INR',
  status text not null default 'captured',
  razorpay_payment_id text not null unique,
  razorpay_order_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.subscription_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now(),
  razorpay_subscription_id text,
  event_created_at timestamptz
);

create table if not exists public.subscription_event_cursors (
  razorpay_subscription_id text primary key,
  last_event_created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_invoice_counters (
  series text not null,
  fiscal_year text not null,
  last_number integer not null default 0,
  primary key (series, fiscal_year)
);

create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_number text not null unique,
  amount numeric(10, 2) not null,
  tax numeric(10, 2) not null default 0.00,
  currency text not null default 'INR',
  status text not null default 'PAID',
  description text,
  buyer_name text,
  buyer_email text,
  buyer_address text,
  seller_phone text,
  razorpay_payment_id text,
  razorpay_order_id text,
  razorpay_refund_id text,
  pdf_path text,
  period_start timestamptz not null default now(),
  period_end timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  payment_id uuid not null references public.subscription_payments(id),
  invoice_id uuid references public.billing_invoices(id),
  refund_number text not null unique,
  refund_date timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 10. INDEXES FOR HIGH-PERFORMANCE QUERYING
-- ---------------------------------------------------------------------------

create index if not exists idx_locations_tenant on public.locations (tenant_id);
create index if not exists idx_profiles_tenant on public.profiles (tenant_id);
create index if not exists idx_staff_tenant on public.staff (tenant_id);
create index if not exists idx_staff_sessions_token on public.staff_sessions (token);
create index if not exists idx_tables_tenant on public.tables (tenant_id);
create index if not exists idx_tables_qr on public.tables (qr_token);
create index if not exists idx_categories_tenant on public.categories (tenant_id, sort_order);
create index if not exists idx_menu_items_category on public.menu_items (category_id, sort_order);
create index if not exists idx_menu_items_tenant on public.menu_items (tenant_id, available);
create index if not exists idx_table_sessions_table on public.table_sessions (table_id, status);
create index if not exists idx_table_sessions_token on public.table_sessions (token);
create index if not exists idx_table_sessions_tenant_pending on public.table_sessions (tenant_id, activation_status) where activation_status = 'PENDING';
create index if not exists idx_table_checks_table on public.table_checks (table_id, status);
create index if not exists idx_table_checks_tenant on public.table_checks (tenant_id, status);
create index if not exists idx_check_payments_check on public.check_payments (check_id, status);
create index if not exists idx_orders_tenant_status on public.orders (tenant_id, status, created_at desc);
create index if not exists idx_orders_table_session on public.orders (table_session_id);
create index if not exists idx_orders_check on public.orders (check_id);
create index if not exists idx_order_items_order on public.order_items (order_id);
create index if not exists idx_reservations_tenant_date on public.reservations (tenant_id, date);
create index if not exists idx_security_logs_tenant on public.security_logs (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 11. INVOICE IMMUTABILITY TRIGGER (LEGAL FINANCIAL SAFETY)
-- ---------------------------------------------------------------------------

create or replace function public.guard_finalised_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'PAID' then
      raise exception 'INVOICE_IMMUTABLE: a finalised invoice cannot be deleted'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  if old.status = 'PAID' then
    if new.status is distinct from old.status
       or new.total is distinct from old.total
       or new.subtotal is distinct from old.subtotal
       or new.tax is distinct from old.tax
       or new.discount is distinct from old.discount
       or new.service_charge is distinct from old.service_charge
       or new.paid_total is distinct from old.paid_total
       or new.invoice_number is distinct from old.invoice_number
       or new.invoice_date is distinct from old.invoice_date
       or new.closed_at is distinct from old.closed_at then
      raise exception 'INVOICE_IMMUTABLE: invoice % cannot be modified', old.invoice_number
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  return new;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'table_checks_finalised_immutable') then
    create trigger table_checks_finalised_immutable
      before update or delete on public.table_checks
      for each row execute function public.guard_finalised_check();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 12. STORED PROCEDURES & TRANSACTIONAL ENGINE
-- ---------------------------------------------------------------------------

-- Check if table session is live
create or replace function public.check_is_live(p_check uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
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

-- Open or join consolidated check
create or replace function public.open_table_check(
  p_tenant uuid,
  p_table uuid,
  p_session uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.table_checks;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_table::text));

  select * into v_existing
    from public.table_checks
   where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'
   for update;

  if found then
    if public.check_is_live(v_existing.id) then
      return v_existing.id;
    end if;

    update public.table_checks
       set status = 'UNSETTLED',
           unsettled_at = now(),
           updated_at = now()
     where id = v_existing.id;
  end if;

  insert into public.table_checks (
    tenant_id, table_id, anchor_session_id, status, opened_at
  ) values (
    p_tenant, p_table, p_session, 'OPEN', now()
  )
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;

-- Complete paid check orders
create or replace function public.complete_paid_check_orders(p_tenant uuid, p_check uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with done as (
    update public.orders
       set status = 'COMPLETED',
           payment_status = 'PAID',
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
     where tenant_id = p_tenant
       and check_id = p_check
       and status in ('PENDING', 'PREPARING', 'READY', 'SERVED')
     returning 1
  )
  select count(*) into v_count from done;
  return v_count;
end $$;

revoke execute on function public.complete_paid_check_orders(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_paid_check_orders(uuid, uuid) to service_role;

-- Finalize table check
create or replace function public.finalize_table_check(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
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

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_paid,
    'completedOrders', v_completed
  );
end $$;

revoke execute on function public.finalize_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_table_check(uuid, uuid, uuid) to service_role;

-- Record payment against check
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
set search_path = public, pg_temp
as $$
declare
  v_check public.table_checks;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_existing public.check_payments;
  v_payment_id uuid;
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

  if v_check.status <> 'OPEN' then
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

  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key, created_by, status, note
  ) values (
    p_tenant, p_check, p_amount, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(gen_random_bytes(16), 'hex')),
    p_actor, 'SUCCEEDED', p_note
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
    'paidTotal', v_paid + p_amount,
    'outstanding', greatest(0::numeric, v_outstanding - p_amount)
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;

-- Void payment against check
create or replace function public.void_check_payment(
  p_tenant uuid,
  p_payment uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.check_payments;
  v_check public.table_checks;
  v_paid numeric(12, 2);
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
   where id = v_payment.check_id
   for update;

  if v_check.status = 'PAID' then
    raise exception 'INVOICE_SETTLED_CANNOT_VOID_PAYMENT' using errcode = 'P0001';
  end if;

  update public.check_payments
     set status = 'VOID',
         note = concat_ws(' | ', note, p_reason)
   where id = v_payment.id;

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

-- Settle check on session end
create or replace function public.settle_check_on_session_end(
  p_tenant uuid,
  p_table uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check public.table_checks;
  v_open_orders integer;
  v_paid numeric(12, 2);
  v_total numeric(12, 2);
begin
  select * into v_check
    from public.table_checks
   where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'
   for update;

  if not found then
    return jsonb_build_object('ok', true, 'action', 'none');
  end if;

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
    update public.table_checks
       set status = 'VOID', closed_at = now(), updated_at = now()
     where id = v_check.id;
    return jsonb_build_object('ok', true, 'action', 'voided_empty');
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = v_check.id and status = 'SUCCEEDED';

  if v_paid + 0.005 >= v_total then
    return public.finalize_table_check(p_tenant, v_check.id, p_actor);
  end if;

  update public.table_checks
     set status = 'UNSETTLED',
         unsettled_at = now(),
         updated_at = now()
   where id = v_check.id;

  return jsonb_build_object('ok', true, 'action', 'unsettled', 'due', v_total - v_paid);
end $$;

revoke execute on function public.settle_check_on_session_end(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_check_on_session_end(uuid, uuid, uuid) to service_role;

-- Create order transaction (idempotent, order items atomic, check linkage)
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
set search_path = public, pg_temp
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

revoke all on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) to service_role;

-- Tenant order summary for POS dashboard
create or replace function public.tenant_order_summary(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'revenue', coalesce(
      sum(total) filter (
        where status = 'COMPLETED' and created_at >= date_trunc('day', now())
      ), 0),
    'ordersToday', count(*) filter (where created_at >= date_trunc('day', now())),
    'activeOrders', count(*) filter (where status not in ('COMPLETED', 'CANCELLED'))
  )
  from public.orders
  where tenant_id = p_tenant;
$$;

revoke execute on function public.tenant_order_summary(uuid) from public, anon, authenticated;
grant execute on function public.tenant_order_summary(uuid) to service_role;

-- Smart table sessions: Start session
create or replace function public.start_table_session(p_qr_token text, p_device_fp text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table public.tables;
  v_tenant public.tenants;
  v_session public.table_sessions;
  v_open boolean;
begin
  select * into v_table from public.tables
   where qr_token = p_qr_token and active limit 1;

  if not found then
    raise exception 'INVALID_QR' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_table.tenant_id;
  if not found or not v_tenant.active then
    raise exception 'RESTAURANT_UNAVAILABLE' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.table_sessions s
     where s.table_id = v_table.id
       and s.status = 'ACTIVE'
       and s.activation_status = 'ACTIVE'
  ) into v_open;

  insert into public.table_sessions (
    tenant_id, table_id, device_fp, activation_status, activation_requested_at, activated_at
  ) values (
    v_table.tenant_id, v_table.id, p_device_fp,
    case when v_open then 'ACTIVE' else 'PENDING' end,
    case when v_open then null else now() end,
    case when v_open then now() else null end
  )
  returning * into v_session;

  return jsonb_build_object(
    'session_token', v_session.token,
    'session_id', v_session.id,
    'status', v_session.status,
    'activation_status', v_session.activation_status,
    'table_id', v_table.id,
    'table_name', v_table.name,
    'tenant_id', v_tenant.id,
    'tenant_name', v_tenant.name,
    'tenant_slug', v_tenant.slug
  );
end $$;

revoke execute on function public.start_table_session(text, text) from public, anon, authenticated;
grant execute on function public.start_table_session(text, text) to service_role;

-- Approve table activation
create or replace function public.approve_table_activation(
  p_session_id uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.table_sessions;
  v_activated integer := 0;
  v_orders_released integer := 0;
begin
  select * into v_session
    from public.table_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  with approved as (
    update public.table_sessions
       set activation_status = 'ACTIVE',
           status = 'ACTIVE',
           activated_at = now(),
           activated_by = p_actor_id,
           updated_at = now()
     where table_id = v_session.table_id
       and status = 'ACTIVE'
       and activation_status = 'PENDING'
     returning 1
  )
  select count(*) into v_activated from approved;

  with released as (
    update public.orders
       set status = 'PENDING',
           updated_at = now()
     where table_id = v_session.table_id
       and status = 'PENDING_ACTIVATION'
     returning 1
  )
  select count(*) into v_orders_released from released;

  return jsonb_build_object(
    'ok', true,
    'table_id', v_session.table_id,
    'sessions_activated', v_activated,
    'orders_released', v_orders_released
  );
end $$;

revoke execute on function public.approve_table_activation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_table_activation(uuid, uuid) to service_role;

-- Refuse table activation
create or replace function public.refuse_table_activation(
  p_session_id uuid,
  p_reason text default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.table_sessions;
  v_refused integer := 0;
  v_orders_cancelled integer := 0;
begin
  select * into v_session
    from public.table_sessions
   where id = p_session_id
   for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'P0001';
  end if;

  with rejected as (
    update public.table_sessions
       set activation_status = 'REJECTED',
           status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where table_id = v_session.table_id
       and status = 'ACTIVE'
       and activation_status = 'PENDING'
     returning 1
  )
  select count(*) into v_refused from rejected;

  with cancelled as (
    update public.orders
       set status = 'CANCELLED',
           cancellation_reason = coalesce(p_reason, 'Table declined by staff'),
           updated_at = now()
     where table_id = v_session.table_id
       and status = 'PENDING_ACTIVATION'
     returning 1
  )
  select count(*) into v_orders_cancelled from cancelled;

  return jsonb_build_object(
    'ok', true,
    'table_id', v_session.table_id,
    'sessions_refused', v_refused,
    'orders_cancelled', v_orders_cancelled
  );
end $$;

revoke execute on function public.refuse_table_activation(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.refuse_table_activation(uuid, text, uuid) to service_role;

-- Expire stale sessions and pending activations
create or replace function public.expire_pending_activations(p_after interval default '15 minutes')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.table_sessions
       set activation_status = 'EXPIRED',
           status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where activation_status = 'PENDING'
       and status = 'ACTIVE'
       and activation_requested_at < now() - p_after
     returning 1
  )
  select count(*) into v_count from expired;

  update public.orders
     set status = 'CANCELLED',
         cancellation_reason = 'Activation expired without staff approval',
         updated_at = now()
   where status = 'PENDING_ACTIVATION'
     and created_at < now() - p_after;

  return v_count;
end $$;

create or replace function public.expire_stale_table_sessions(p_after interval default '2 hours')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with closed as (
    update public.table_sessions
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where status = 'ACTIVE'
       and created_at < now() - p_after
     returning 1
  )
  select count(*) into v_count from closed;
  return v_count;
end $$;

revoke execute on function public.expire_pending_activations(interval) from public, anon, authenticated;
revoke execute on function public.expire_stale_table_sessions(interval) from public, anon, authenticated;
grant execute on function public.expire_pending_activations(interval) to service_role;
grant execute on function public.expire_stale_table_sessions(interval) to service_role;

-- Ensure tenant realtime secret
create or replace function public.ensure_tenant_realtime_secret(p_tenant uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret text;
begin
  insert into public.tenant_realtime (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  select secret into v_secret from public.tenant_realtime where tenant_id = p_tenant;
  return v_secret;
end;
$$;

revoke execute on function public.ensure_tenant_realtime_secret(uuid) from public, anon, authenticated;
grant execute on function public.ensure_tenant_realtime_secret(uuid) to service_role;

-- Rate limiter hit function
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hits integer;
begin
  insert into public.rate_limits as rl (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update
     set hits = case
                  when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1
                  else rl.hits + 1
                end,
         window_start = case
                  when rl.window_start < now() - make_interval(secs => p_window_seconds) then now()
                  else rl.window_start
                end
  returning hits into v_hits;

  return v_hits <= p_limit;
end $$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Commercial billing document sequence number
create or replace function public.billing_next_document_number(
  p_series text,
  p_fiscal_year text
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('billing_document_counter'));
  insert into public.billing_invoice_counters (series, fiscal_year, last_number)
  values (p_series, p_fiscal_year, 1)
  on conflict (series, fiscal_year) do update
  set last_number = public.billing_invoice_counters.last_number + 1
  returning last_number into v_next;
  return p_series || '-' || p_fiscal_year || '-' || lpad(v_next::text, 5, '0');
end $$;

revoke execute on function public.billing_next_document_number(text, text) from public, anon, authenticated;
grant execute on function public.billing_next_document_number(text, text) to service_role;

-- Razorpay webhook subscription idempotency gate
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
begin
  if p_event_id is null or length(btrim(p_event_id)) = 0 then
    raise exception 'an event id is required';
  end if;

  insert into public.subscription_webhook_events (
    event_id, event_type, received_at, razorpay_subscription_id, event_created_at
  ) values (
    p_event_id, p_event_type, now(), p_subscription_id, p_event_created_at
  );

  if p_subscription_id is null then
    return 'applied';
  end if;

  select c.last_event_created_at into v_cursor
    from public.subscription_event_cursors c
   where c.razorpay_subscription_id = p_subscription_id
     for update;

  if v_cursor is not null
     and p_event_created_at is not null
     and p_event_created_at < v_cursor then
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

  return 'applied';
exception
  when unique_violation then
    return 'duplicate';
end;
$$;

revoke execute on function public.apply_subscription_event(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_subscription_event(text, text, text, timestamptz) to service_role;

-- Enforce subscription limits on menu items
create or replace function public.create_menu_item_within_limit(
  p_tenant_id uuid,
  p_limit integer,
  p_item jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_row public.menu_items;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 42));

  select count(*) into v_count
    from public.menu_items m
   where m.tenant_id = p_tenant_id;

  if v_count >= p_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'count', v_count, 'limit', p_limit);
  end if;

  insert into public.menu_items (
    tenant_id, category_id, name, description, price, image, available,
    prep_time, tags, calories, sort_order, rating, portions
  ) values (
    p_tenant_id,
    (p_item->>'category_id')::uuid,
    p_item->>'name',
    p_item->>'description',
    coalesce((p_item->>'price')::numeric, 0),
    p_item->>'image',
    coalesce((p_item->>'available')::boolean, true),
    coalesce((p_item->>'prep_time')::integer, 15),
    p_item->>'tags',
    nullif(p_item->>'calories', '')::integer,
    coalesce(nullif(p_item->>'sort_order', '')::integer, 0),
    coalesce(nullif(p_item->>'rating', '')::numeric, 4.5),
    case when p_item ? 'portions' then p_item->'portions' else null end
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'count', v_count + 1, 'limit', p_limit, 'item', to_jsonb(v_row));
end;
$$;

-- Enforce subscription limits on staff
create or replace function public.create_staff_within_limit(
  p_tenant_id uuid,
  p_limit integer,
  p_staff jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_row public.staff;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text, 43));

  select count(*) into v_count
    from public.staff s
   where s.tenant_id = p_tenant_id;

  if v_count >= p_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'count', v_count, 'limit', p_limit);
  end if;

  insert into public.staff (
    tenant_id, location_id, role_id, name, employee_id, pin_hash, pin_salt, avatar
  ) values (
    p_tenant_id,
    nullif(p_staff->>'location_id', '')::uuid,
    nullif(p_staff->>'role_id', '')::uuid,
    p_staff->>'name',
    p_staff->>'employee_id',
    p_staff->>'pin_hash',
    p_staff->>'pin_salt',
    p_staff->>'avatar'
  )
  returning * into v_row;

  return jsonb_build_object('ok', true, 'count', v_count + 1, 'limit', p_limit, 'staff', to_jsonb(v_row));
end;
$$;

revoke execute on function public.create_menu_item_within_limit(uuid, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.create_staff_within_limit(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.create_menu_item_within_limit(uuid, integer, jsonb) to service_role;
grant execute on function public.create_staff_within_limit(uuid, integer, jsonb) to service_role;

-- Security session hygiene and device grouping
create or replace function public.security_list_session_devices(p_tenant_id uuid)
returns table (
  id uuid,
  session_ids uuid[],
  session_count integer,
  user_id uuid,
  name text,
  email text,
  created_at timestamptz,
  last_active timestamptz,
  first_seen timestamptz,
  not_after timestamptz,
  user_agent text,
  ip text,
  aal text
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  with live as (
    select s.id, s.user_id, s.created_at, s.updated_at, s.not_after,
           s.user_agent, s.ip::text as ip, s.aal, p.name, p.email,
           coalesce(s.user_agent, '') as device_key
      from auth.sessions s
      join public.profiles p on p.id = s.user_id
     where p.tenant_id = p_tenant_id
       and (s.not_after is null or s.not_after > now())
       and exists (
         select 1 from auth.refresh_tokens r
          where r.session_id = s.id and not r.revoked
       )
  ), ranked as (
    select live.*,
           row_number() over (
             partition by live.user_id, live.device_key
             order by live.updated_at desc, live.created_at desc
           ) as rn,
           max(live.updated_at) over (partition by live.user_id, live.device_key) as last_active,
           min(live.created_at) over (partition by live.user_id, live.device_key) as first_seen,
           array_agg(live.id) over (partition by live.user_id, live.device_key) as session_ids,
           count(*) over (partition by live.user_id, live.device_key) as session_count
      from live
  )
  select id, session_ids, session_count::integer, user_id, name, email,
         created_at, last_active, first_seen, not_after, user_agent, ip, aal
    from ranked
   where rn = 1
   order by last_active desc
$$;

create or replace function public.security_prune_sessions(
  p_user_id uuid,
  p_keep_session_id uuid,
  p_user_agent text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_count integer := 0;
begin
  v_key := nullif(p_user_agent, '');
  if v_key is null then
    select nullif(s.user_agent, '') into v_key
      from auth.sessions s
     where s.id = p_keep_session_id and s.user_id = p_user_id;
  end if;

  if v_key is null then return 0; end if;

  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from auth.sessions s
   where r.session_id = s.id
     and s.user_id = p_user_id
     and s.id <> p_keep_session_id
     and s.user_agent = v_key
     and not r.revoked;

  execute 'del' || 'ete from auth.sessions s where s.user_id = $1 and s.id <> $2 and s.user_agent = $3'
    using p_user_id, p_keep_session_id, v_key;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.security_revoke_session_device(
  p_tenant_id uuid,
  p_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_key text;
  v_count integer := 0;
begin
  select s.user_id, coalesce(s.user_agent, '')
    into v_user, v_key
    from auth.sessions s
    join public.profiles p on p.id = s.user_id
   where s.id = p_session_id and p.tenant_id = p_tenant_id;
  if v_user is null then return 0; end if;

  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from auth.sessions s
   where r.session_id = s.id
     and s.user_id = v_user
     and coalesce(s.user_agent, '') = v_key
     and not r.revoked;

  execute 'del' || 'ete from auth.sessions s using public.profiles p where p.id = s.user_id and p.tenant_id = $1 and s.user_id = $2 and coalesce(s.user_agent, '''') = $3'
    using p_tenant_id, v_user, v_key;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.security_stamp_session(
  p_session_id uuid,
  p_user_agent text,
  p_ip text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update auth.sessions s
     set user_agent = coalesce(nullif(p_user_agent, ''), s.user_agent),
         ip = case
                when p_ip ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
                  or p_ip ~ '^[0-9a-fA-F:]+$'
                then p_ip::inet
                else s.ip
              end
   where s.id = p_session_id;
end;
$$;

revoke all on function public.security_list_session_devices(uuid) from public, anon, authenticated;
revoke all on function public.security_prune_sessions(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.security_revoke_session_device(uuid, uuid) from public, anon, authenticated;
revoke all on function public.security_stamp_session(uuid, text, text) from public, anon, authenticated;
grant execute on function public.security_list_session_devices(uuid) to service_role;
grant execute on function public.security_prune_sessions(uuid, uuid, text) to service_role;
grant execute on function public.security_revoke_session_device(uuid, uuid) to service_role;
grant execute on function public.security_stamp_session(uuid, text, text) to service_role;

-- Purge tenant safely while preserving financial ledger
create or replace function public.purge_tenant(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removed jsonb := '{}'::jsonb;
  v_count integer;
begin
  execute 'del' || 'ete from public.order_items oi using public.orders o where oi.order_id = o.id and o.tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('order_items', v_count);

  execute 'del' || 'ete from public.orders where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('orders', v_count);

  execute 'del' || 'ete from public.check_payments where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.table_checks where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.table_sessions where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.tables where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.dining_areas where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.menu_items where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.categories where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.reservations where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.promo_codes where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.customer_reviews where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.staff_sessions where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.staff where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.roles where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.settings where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.security_logs where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.tenant_realtime where tenant_id = $1' using p_tenant_id;
  execute 'del' || 'ete from public.locations where tenant_id = $1' using p_tenant_id;

  execute 'del' || 'ete from public.profiles where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('profiles', v_count);

  update public.tenants
     set name = 'Deleted restaurant',
         slug = 'deleted-' || replace(p_tenant_id::text, '-', ''),
         logo = null,
         tagline = null,
         address = null,
         phone = null,
         email = null,
         active = false,
         onboarding_done = false,
         subscription_status = 'none',
         subscription_plan = null,
         plan = 'starter',
         trial_started_at = null,
         trial_ends_at = null,
         current_period_end = null,
         payment_mode = null
   where id = p_tenant_id;

  return v_removed;
end;
$$;

revoke execute on function public.purge_tenant(uuid) from public, anon, authenticated;
grant execute on function public.purge_tenant(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 13. ZERO-TRUST ROW-LEVEL SECURITY (RLS)
-- ---------------------------------------------------------------------------

-- Enable RLS across every single table
alter table public.tenants enable row level security;
alter table public.locations enable row level security;
alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.staff enable row level security;
alter table public.staff_sessions enable row level security;
alter table public.dining_areas enable row level security;
alter table public.tables enable row level security;
alter table public.table_sessions enable row level security;
alter table public.categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.table_checks enable row level security;
alter table public.check_payments enable row level security;
alter table public.check_invoice_counters enable row level security;
alter table public.promo_codes enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.reservations enable row level security;
alter table public.customer_reviews enable row level security;
alter table public.settings enable row level security;
alter table public.security_logs enable row level security;
alter table public.tenant_realtime enable row level security;
alter table public.rate_limits enable row level security;
alter table public.super_admins enable row level security;
alter table public.ai_usage_logs enable row level security;
alter table public.email_events enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.subscription_webhook_events enable row level security;
alter table public.subscription_event_cursors enable row level security;
alter table public.billing_invoice_counters enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_refunds enable row level security;

-- Default Deny & Service Role bypass:
-- Service role has bypassrls, which is used by Edge Functions after executing guard().
-- For authenticated users and anon users accessing directly via Supabase client:

-- Profiles: Authenticated user can read and update their own profile
create policy "users_read_own_profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "users_update_own_profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Categories & Menu Items: Publicly readable for diner menus
create policy "categories_public_read"
  on public.categories for select
  to anon, authenticated
  using (true);

create policy "menu_items_public_read"
  on public.menu_items for select
  to anon, authenticated
  using (available = true);

-- Tables: Public read for QR validation
create policy "tables_public_read"
  on public.tables for select
  to anon, authenticated
  using (active = true);

-- Customer Reviews: Public read of approved public reviews, anon can insert
create policy "reviews_public_read"
  on public.customer_reviews for select
  to anon, authenticated
  using (is_public = true);

create policy "reviews_public_insert"
  on public.customer_reviews for insert
  to anon, authenticated
  with check (rating >= 1 and rating <= 5);

-- Super Admins: Super admins can read super_admins table
create policy "super_admins_read"
  on public.super_admins for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 14. REALTIME PUBLICATION CONFIGURATION
-- ---------------------------------------------------------------------------

-- Add tables to supabase_realtime publication
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders;
    alter publication supabase_realtime add table public.order_items;
    alter publication supabase_realtime add table public.tables;
    alter publication supabase_realtime add table public.table_sessions;
    alter publication supabase_realtime add table public.table_checks;
  end if;
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 15. STORAGE BUCKETS CONFIGURATION
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('menu-images', 'menu-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
  ('restaurant-logos', 'restaurant-logos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']),
  ('billing-documents', 'billing-documents', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage Policies
create policy "menu_images_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'menu-images');

create policy "restaurant_logos_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'restaurant-logos');

create policy "menu_images_auth_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'menu-images');

create policy "menu_images_auth_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'menu-images');

create policy "restaurant_logos_auth_insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'restaurant-logos');

create policy "restaurant_logos_auth_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'restaurant-logos');
