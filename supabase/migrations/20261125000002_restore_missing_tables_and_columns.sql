-- ============================================================================
-- Migration: 20261125000002_restore_missing_tables_and_columns.sql
-- Purpose:   Additive P0 database compatibility repair.
--            Restores the 10 tables, missing columns, indexes, triggers,
--            RLS policies, and record_staff_login_attempt RPC omitted during
--            the 20261113000000 baseline squash or left unapplied.
--
-- Safety:    100% additive & idempotent (CREATE TABLE IF NOT EXISTS,
--            ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--            CREATE OR REPLACE FUNCTION). Preserves all existing data.
--            Historical DDL sourced from e07d492:supabase/legacy_migrations_archive/.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Super Admin allowlist helper & missing columns on public.super_admins
-- ---------------------------------------------------------------------------
alter table public.super_admins
  add column if not exists label text,
  add column if not exists last_seen_at timestamptz;

update public.super_admins
   set label = name
 where label is null
   and name is not null;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.super_admins
    where user_id = auth.uid()
       or (user_id is null and lower(email) = lower(auth.jwt() ->> 'email'))
  );
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Missing tables (10 tables from historical migrations 0016-0054)
-- ---------------------------------------------------------------------------

-- 2.1 super_admin_audit_logs (0016, 0021, 0054_audit_admin_id_fkey)
create table if not exists public.super_admin_audit_logs (
  id               uuid primary key default gen_random_uuid(),
  admin_id         uuid references auth.users(id) on delete set null,
  action           text not null,
  target_tenant_id uuid,
  details          jsonb,
  created_at       timestamptz not null default now()
);

alter table public.super_admin_audit_logs enable row level security;

drop policy if exists "Super admins can view all audit logs" on public.super_admin_audit_logs;
create policy "Super admins can view all audit logs"
  on public.super_admin_audit_logs
  for select
  to authenticated
  using (public.is_super_admin());

drop policy if exists "Super admins can insert audit logs" on public.super_admin_audit_logs;
create policy "Super admins can insert audit logs"
  on public.super_admin_audit_logs
  for insert
  to authenticated
  with check (public.is_super_admin());

-- 2.2 subscription_audit_logs (0017, 0026)
create table if not exists public.subscription_audit_logs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  old_plan          text,
  new_plan          text,
  change_type       text not null,
  razorpay_event_id text,
  detail            jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_sub_audit_logs_tenant
  on public.subscription_audit_logs (tenant_id, created_at desc);

alter table public.subscription_audit_logs enable row level security;

drop policy if exists "Super admins can manage all audit logs" on public.subscription_audit_logs;
create policy "Super admins can manage all audit logs"
  on public.subscription_audit_logs
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- 2.3 subscription_checkouts (0044, 0050, 0057, 0061, 0062)
create table if not exists public.subscription_checkouts (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  plan_id                  text not null,
  amount                   double precision not null,
  currency                 text not null,
  billing_interval         text,
  payment_mode             text,
  mandate_id               text,
  mandate_expires_at       timestamptz,
  razorpay_order_id        text,
  razorpay_subscription_id text,
  scheduled_start_at       timestamptz,
  status                   text not null default 'pending',
  razorpay_payment_id      text,
  verified_amount          double precision,
  verified_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint subscription_checkouts_status_check
    check (status in ('pending', 'paid', 'failed', 'expired'))
);

create unique index if not exists subscription_checkouts_order_key
  on public.subscription_checkouts (razorpay_order_id)
  where razorpay_order_id is not null;

create index if not exists subscription_checkouts_tenant_idx
  on public.subscription_checkouts (tenant_id, created_at desc);

create unique index if not exists subscription_checkouts_payment_key
  on public.subscription_checkouts (razorpay_payment_id)
  where razorpay_payment_id is not null;

alter table public.subscription_checkouts enable row level security;
revoke all on public.subscription_checkouts from anon, authenticated;

-- 2.4 tenant_notes (0021)
create table if not exists public.tenant_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  admin_id   uuid references auth.users(id) on delete set null,
  body       text not null,
  kind       text not null default 'note',
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_notes_tenant
  on public.tenant_notes (tenant_id, created_at desc);

alter table public.tenant_notes enable row level security;

drop policy if exists "Super admins can manage notes" on public.tenant_notes;
create policy "Super admins can manage notes"
  on public.tenant_notes
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- 2.5 support_issues (0021)
create table if not exists public.support_issues (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  opened_by   uuid references auth.users(id) on delete set null,
  subject     text not null,
  detail      text,
  status      text not null default 'open',
  priority    text not null default 'normal',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_support_issues_status
  on public.support_issues (status, created_at desc);

alter table public.support_issues enable row level security;

drop policy if exists "Super admins can manage issues" on public.support_issues;
create policy "Super admins can manage issues"
  on public.support_issues
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- 2.6 feature_usage (0018, 0021)
create table if not exists public.feature_usage (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  feature_id text not null,
  action     text,
  created_at timestamptz not null default now()
);

create index if not exists idx_feature_usage_tenant on public.feature_usage (tenant_id);
create index if not exists idx_feature_usage_feature on public.feature_usage (feature_id);

alter table public.feature_usage enable row level security;

drop policy if exists "Super admins can view all usage data" on public.feature_usage;
create policy "Super admins can view all usage data"
  on public.feature_usage
  for select
  to authenticated
  using (public.is_super_admin());

-- 2.7 daily_tenant_metrics (0018, 0021)
create table if not exists public.daily_tenant_metrics (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  date         date not null default current_date,
  order_count  int default 0,
  order_value  numeric(12,2) default 0,
  active_staff int default 0,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, date)
);

create index if not exists idx_daily_metrics_date on public.daily_tenant_metrics (date);

alter table public.daily_tenant_metrics enable row level security;

drop policy if exists "Super admins can view all daily metrics" on public.daily_tenant_metrics;
create policy "Super admins can view all daily metrics"
  on public.daily_tenant_metrics
  for select
  to authenticated
  using (public.is_super_admin());

-- Metric tracking functions & triggers (0021)
create or replace function public.tenant_timezone(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select value from public.settings where tenant_id = p_tenant and key = 'timezone' limit 1),
    'Asia/Kolkata'
  );
$$;

create or replace function public.track_order_metrics()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day date;
begin
  v_day := (new.created_at at time zone public.tenant_timezone(new.tenant_id))::date;
  insert into public.daily_tenant_metrics (tenant_id, date, order_count, order_value, updated_at)
  values (new.tenant_id, v_day, 1, coalesce(new.total, 0), now())
  on conflict (tenant_id, date) do update
    set order_count = public.daily_tenant_metrics.order_count + 1,
        order_value = public.daily_tenant_metrics.order_value + coalesce(new.total, 0),
        updated_at  = now();
  return null;
end;
$$;

drop trigger if exists orders_track_daily_metrics on public.orders;
create trigger orders_track_daily_metrics
  after insert on public.orders
  for each row execute function public.track_order_metrics();

create or replace function public.track_feature_usage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant  uuid;
  v_user    uuid;
  v_feature text;
  v_action  text;
begin
  v_tenant := coalesce(new.tenant_id, old.tenant_id);
  v_user   := auth.uid();
  v_action := lower(tg_op);

  if tg_table_name = 'menu_items' then
    v_feature := 'menu';
  elsif tg_table_name = 'promo_codes' then
    v_feature := 'promo';
  elsif tg_table_name = 'table_sessions' then
    v_feature := 'table_session';
  elsif tg_table_name = 'reservations' then
    v_feature := 'reservation';
  else
    return null;
  end if;

  if v_feature = 'menu' and v_action = 'update' and new.updated_at = old.updated_at then
    return null;
  end if;

  insert into public.feature_usage (tenant_id, user_id, feature_id, action)
  values (v_tenant, v_user, v_feature, v_action);

  return null;
end;
$$;

drop trigger if exists menu_items_track_feature on public.menu_items;
create trigger menu_items_track_feature
  after insert or update or delete on public.menu_items
  for each row execute function public.track_feature_usage();

drop trigger if exists promo_codes_track_feature on public.promo_codes;
create trigger promo_codes_track_feature
  after insert or update or delete on public.promo_codes
  for each row execute function public.track_feature_usage();

drop trigger if exists table_sessions_track_feature on public.table_sessions;
create trigger table_sessions_track_feature
  after insert on public.table_sessions
  for each row execute function public.track_feature_usage();

drop trigger if exists reservations_track_feature on public.reservations;
create trigger reservations_track_feature
  after insert or update or delete on public.reservations
  for each row execute function public.track_feature_usage();

-- 2.8 ai_provider_settings (0024, 0027)
create table if not exists public.ai_provider_settings (
  provider    text primary key,
  text_model  text not null default 'gemini-3.8-flash',
  image_model text not null default 'gemini-nano-banana-2.1',
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

alter table public.ai_provider_settings enable row level security;
revoke all on public.ai_provider_settings from anon, authenticated;

insert into public.ai_provider_settings (provider, text_model, image_model)
values ('gemini', 'gemini-3.8-flash', 'gemini-nano-banana-2.1')
on conflict (provider) do nothing;

-- 2.9 ai_request_logs (0027)
create table if not exists public.ai_request_logs (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  model         text,
  action        text not null,
  tenant_id     uuid references public.tenants(id) on delete set null,
  status        text not null,
  duration_ms   integer,
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists ai_request_logs_created_idx
  on public.ai_request_logs (created_at desc);

create index if not exists ai_request_logs_tenant_idx
  on public.ai_request_logs (tenant_id);

alter table public.ai_request_logs enable row level security;
revoke all on public.ai_request_logs from anon, authenticated;

-- 2.10 platform_business_details (0053)
create table if not exists public.platform_business_details (
  singleton  boolean primary key default true check (singleton),
  legal_name text not null default '',
  street     text not null default '',
  city       text not null default '',
  state      text not null default '',
  pin_code   text not null default '',
  country    text not null default 'India',
  email      text not null default '',
  phone      text not null default '',
  gstin      text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.platform_business_details enable row level security;
revoke all on public.platform_business_details from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Missing columns on existing tables (Subscriptions, Billing, Emails, Checks)
-- ---------------------------------------------------------------------------

-- 3.1 public.tenants (0026)
alter table public.tenants
  add column if not exists subscription_started_at timestamptz,
  add column if not exists razorpay_subscription_id text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists subscription_razorpay_payment_id text;

create index if not exists tenants_razorpay_subscription_id_idx
  on public.tenants (razorpay_subscription_id)
  where razorpay_subscription_id is not null;

-- 3.2 public.subscription_payments (0017, 0026, 0062)
alter table public.subscription_payments
  add column if not exists payment_method text,
  add column if not exists transaction_id text,
  add column if not exists plan_id text,
  add column if not exists billing_period text,
  add column if not exists razorpay_invoice_id text,
  add column if not exists razorpay_signature text,
  add column if not exists razorpay_subscription_id text,
  add column if not exists webhook_event_id text,
  add column if not exists failure_reason text,
  add column if not exists payment_mode text,
  add column if not exists mandate_id text,
  add column if not exists mandate_expires_at timestamptz,
  add column if not exists renewal_status text,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists subscription_payments_transaction_id_idx
  on public.subscription_payments (transaction_id)
  where transaction_id is not null;

create unique index if not exists subscription_payments_webhook_event_idx
  on public.subscription_payments (webhook_event_id)
  where webhook_event_id is not null;

create unique index if not exists subscription_payments_razorpay_payment_idx
  on public.subscription_payments (razorpay_payment_id)
  where razorpay_payment_id is not null;

-- 3.3 public.billing_invoices (0050, 0051, 0053)
alter table public.billing_invoices
  add column if not exists payment_id uuid references public.subscription_payments(id),
  add column if not exists invoice_date timestamptz,
  add column if not exists fiscal_year text,
  add column if not exists seller_name text,
  add column if not exists seller_address text,
  add column if not exists seller_email text not null default '',
  add column if not exists total_amount numeric,
  add column if not exists payment_status text not null default 'paid',
  add column if not exists payment_method text;

create unique index if not exists billing_invoices_payment_id_key
  on public.billing_invoices (payment_id)
  where payment_id is not null;

-- 3.4 public.billing_refunds (0051, 0053)
alter table public.billing_refunds
  add column if not exists fiscal_year text,
  add column if not exists seller_name text,
  add column if not exists seller_address text,
  add column if not exists seller_email text not null default '',
  add column if not exists seller_phone text not null default '',
  add column if not exists buyer_name text,
  add column if not exists buyer_email text,
  add column if not exists buyer_address text,
  add column if not exists original_invoice_number text,
  add column if not exists original_invoice_date timestamptz,
  add column if not exists amount numeric,
  add column if not exists currency text not null default 'INR',
  add column if not exists description text,
  add column if not exists razorpay_payment_id text,
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_refund_id text,
  add column if not exists pdf_path text;

create unique index if not exists billing_refunds_payment_id_key
  on public.billing_refunds (payment_id)
  where payment_id is not null;

-- 3.5 public.email_events (0066)
alter table public.email_events
  add column if not exists event_key text,
  add column if not exists event_type text,
  add column if not exists recipient text,
  add column if not exists recipient_name text,
  add column if not exists restaurant_name text,
  add column if not exists plan_name text,
  add column if not exists amount numeric,
  add column if not exists currency text,
  add column if not exists billing_interval text,
  add column if not exists provider_id text,
  add column if not exists error text,
  add column if not exists sent_at timestamptz,
  add column if not exists next_attempt_at timestamptz not null default now();

create unique index if not exists email_events_event_key_idx
  on public.email_events (event_key)
  where event_key is not null;

create index if not exists email_events_pending_idx
  on public.email_events (next_attempt_at)
  where status = 'pending';

-- 3.6 public.table_checks (customer_name for Takeaway/Delivery open checks)
alter table public.table_checks
  add column if not exists customer_name text;

-- ---------------------------------------------------------------------------
-- 4. Missing RPC: public.record_staff_login_attempt (20261116000003)
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

commit;
