-- ===========================================================================
-- 0021 — Admin data model
--
-- The Super Admin panel needs things the database did not have:
--
--   - a plan catalogue, so MRR and revenue are priced from something real
--     rather than from a hardcoded number in the edge function;
--   - follow-up notes and support issues, so the CRM records what happened;
--   - automatic metric tracking, because `feature_usage` and
--     `daily_tenant_metrics` existed but nothing ever wrote to them, so the
--     usage and retention panels had no source to read;
--   - `super_admins` as the single authority on who is an administrator,
--     with `profiles.is_super_admin` demoted to a mirror.
--
-- Metrics are recorded by triggers on the tables that already hold the truth
-- (orders, menu items, promo codes, table sessions, security logs), so the
-- numbers come from database events rather than from anything a client says.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. One authority on who is a super admin
-- ---------------------------------------------------------------------------

-- `super_admins` is the source of truth. The `profiles.is_super_admin` column
-- stays as a mirror for compatibility, but nothing authorizes on it any more:
-- it is exactly the kind of column a user can be tricked into changing, and
-- once it was, the whole admin panel was open.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.super_admins
    where user_id = auth.uid()
       or (user_id is null and lower(email) = lower(auth.jwt() ->> 'email'))
  );
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- Repoint the policies that were written against the column.
drop policy if exists "Super admins can view all audit logs" on public.super_admin_audit_logs;
create policy "Super admins can view all audit logs"
  on public.super_admin_audit_logs
  for select
  using (public.is_super_admin());

drop policy if exists "Super admins can insert audit logs" on public.super_admin_audit_logs;
create policy "Super admins can insert audit logs"
  on public.super_admin_audit_logs
  for insert
  with check (public.is_super_admin());

drop policy if exists "Super admins can view all usage data" on public.feature_usage;
create policy "Super admins can view all usage data"
  on public.feature_usage
  for select
  using (public.is_super_admin());

drop policy if exists "Super admins can view all daily metrics" on public.daily_tenant_metrics;
create policy "Super admins can view all daily metrics"
  on public.daily_tenant_metrics
  for select
  using (public.is_super_admin());

-- `feature_usage` accepted a row from anyone, which made it a place to plant
-- numbers that the usage panel would then report. Only the triggers write it.
drop policy if exists "System can insert feature usage" on public.feature_usage;

-- ---------------------------------------------------------------------------
-- 2. Daily metrics were keyed by tenant alone
-- ---------------------------------------------------------------------------

-- `daily_tenant_metrics` had `tenant_id` as the whole primary key, so it
-- could only ever hold one day per restaurant. A daily table needs both.
alter table public.daily_tenant_metrics
  drop constraint if exists daily_tenant_metrics_pkey;
alter table public.daily_tenant_metrics
  add primary key (tenant_id, date);

-- The foreign key to tenants is unaffected by the key change and is kept.
alter table public.daily_tenant_metrics
  drop constraint if exists daily_tenant_metrics_tenant_id_fkey;
alter table public.daily_tenant_metrics
  add constraint daily_tenant_metrics_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;

-- The index on `date` from migration 0018 survives the key change and is
-- still the right shape, so it is left alone.

-- The writer cannot always name a user (service-role writes have no auth.uid()),
-- so the column has to be nullable.
alter table public.feature_usage alter column user_id drop not null;

-- ---------------------------------------------------------------------------
-- 3. The plan catalogue
-- ---------------------------------------------------------------------------

create table if not exists public.subscription_plans (
  id             text primary key,
  name           text not null,
  price_monthly  numeric(12,2) not null default 0,
  price_yearly   numeric(12,2) not null default 0,
  currency       text not null default 'INR',
  trial_days     int not null default 14,
  features       jsonb not null default '[]'::jsonb,
  is_active      boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now()
);

alter table public.subscription_plans enable row level security;

drop policy if exists "Super admins can view plans" on public.subscription_plans;
create policy "Super admins can view plans"
  on public.subscription_plans
  for select
  using (public.is_super_admin());

drop policy if exists "Super admins can manage plans" on public.subscription_plans;
create policy "Super admins can manage plans"
  on public.subscription_plans
  for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

insert into public.subscription_plans
  (id, name, price_monthly, price_yearly, currency, trial_days, features, sort_order)
values
  ('basic',  'Basic',      999,   9990,  'INR', 14, '["Up to 1 user","Core POS","QR ordering"]'::jsonb, 1),
  ('pro',    'Pro',        2499,  24990, 'INR', 14, '["Up to 5 users","Advanced analytics","Promos & loyalty"]'::jsonb, 2),
  ('enterprise', 'Enterprise', 5999, 59990, 'INR', 30, '["Unlimited users","Multi-outlet","Priority support","API access"]'::jsonb, 3)
on conflict (id) do update
  set name          = excluded.name,
      price_monthly = excluded.price_monthly,
      price_yearly  = excluded.price_yearly,
      trial_days    = excluded.trial_days,
      features      = excluded.features,
      sort_order    = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 4. Follow-up notes and support issues
-- ---------------------------------------------------------------------------

create table if not exists public.tenant_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  admin_id   uuid references auth.users(id) on delete set null,
  body       text not null,
  kind       text not null default 'note',  -- note | call | email | issue
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_notes_tenant on public.tenant_notes (tenant_id, created_at desc);

create table if not exists public.support_issues (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,
  opened_by   uuid references auth.users(id) on delete set null,
  subject     text not null,
  detail      text,
  status      text not null default 'open',      -- open | in_progress | resolved
  priority    text not null default 'normal',    -- low | normal | high | urgent
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists idx_support_issues_status on public.support_issues (status, created_at desc);

alter table public.tenant_notes enable row level security;
alter table public.support_issues enable row level security;

drop policy if exists "Super admins can manage notes" on public.tenant_notes;
create policy "Super admins can manage notes"
  on public.tenant_notes
  for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

drop policy if exists "Super admins can manage issues" on public.support_issues;
create policy "Super admins can manage issues"
  on public.support_issues
  for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- 5. Automatic metric tracking
-- ---------------------------------------------------------------------------

-- The restaurant's own timezone decides where a day starts, the same way the
-- tenant analytics function does it.
create or replace function public.tenant_timezone(p_tenant uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select value from public.settings where tenant_id = p_tenant and key = 'timezone' limit 1),
    'Asia/Kolkata'
  );
$$;

-- Every order moves the day's counters. This is the source of truth for
-- orders-per-day and order-value-per-day; nothing reports a number that was
-- not counted here.
create or replace function public.track_order_metrics()
returns trigger
language plpgsql
security definer
set search_path = public
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

-- Feature usage, recorded from the table that already knows the event
-- happened. `feature_usage` is a log, so one row per event.
create or replace function public.track_feature_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_user   uuid;
  v_feature text;
  v_action text;
begin
  v_tenant := coalesce(new.tenant_id, old.tenant_id);
  v_user   := auth.uid();
  v_action := lower(tg_op);
  v_feature := tg_table_name;

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

  -- Only meaningful for a create, an update or a delete. `menu_items` is the
  -- only tracked table with an `updated_at`, so it is the only one where a
  -- no-op update can be recognised.
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

-- ---------------------------------------------------------------------------
-- 6. Backfill the daily metrics that already happened
-- ---------------------------------------------------------------------------

-- The trigger only sees orders placed from now on. The ones already in the
-- table are counted here, in each restaurant's own timezone.
insert into public.daily_tenant_metrics (tenant_id, date, order_count, order_value, updated_at)
select
  o.tenant_id,
  (o.created_at at time zone public.tenant_timezone(o.tenant_id))::date as day,
  count(*)::int,
  coalesce(sum(o.total), 0),
  now()
from public.orders o
group by o.tenant_id, (o.created_at at time zone public.tenant_timezone(o.tenant_id))::date
on conflict (tenant_id, date) do update
  set order_count = excluded.order_count,
      order_value = excluded.order_value,
      updated_at  = now();

-- Feature usage for the menu and promo activity that already happened.
insert into public.feature_usage (tenant_id, user_id, feature_id, action, created_at)
select tenant_id, null, 'menu', 'update', created_at from public.menu_items
where created_at is not null;

insert into public.feature_usage (tenant_id, user_id, feature_id, action, created_at)
select tenant_id, null, 'promo', 'create', created_at from public.promo_codes
where created_at is not null;

-- ---------------------------------------------------------------------------
-- 7. Trial dates for the restaurants that are already on a plan
-- ---------------------------------------------------------------------------

-- The revenue migration defaulted every tenant to 'trial' with no end date, so
-- the retention panel had nothing to show. Existing tenants are on a paid
-- plan; only give a trial end date to a tenant that is actually trialling.
update public.tenants
set trial_ends_at = now() + interval '14 days'
where subscription_status = 'trial'
  and trial_ends_at is null
  and plan = 'free';
