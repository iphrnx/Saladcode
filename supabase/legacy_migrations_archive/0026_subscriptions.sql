-- ===========================================================================
-- 0026 — Subscriptions
--
-- The plan catalogue, the trial and the subscription columns the Razorpay
-- integration needs.
--
-- What existed already: a plan catalogue (basic / pro / enterprise), a
-- `subscription_payments` table and a `subscription_audit_logs` table, and
-- three columns on `tenants` (`plan`, `subscription_status`, `trial_ends_at`).
-- What did not exist: the trial was never actually given to anybody —
-- `trial_ends_at` was null on every restaurant — and nothing anywhere
-- enforced a plan.
--
-- This migration:
--
--   1. renames `basic` to `starter` and gives both paid plans the features
--      and limits they are sold with, plus the Razorpay plan id, which only
--      the Super Admin knows;
--   2. adds the subscription columns to `tenants`;
--   3. extends `subscription_payments` with the Razorpay ids, the signature
--      and a webhook event id, with a unique index on that id so a retried
--      webhook cannot be processed twice;
--   4. gives the existing restaurants the trial they were supposed to have.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The plan catalogue
-- ---------------------------------------------------------------------------

alter table public.subscription_plans
  add column if not exists razorpay_plan_id text,
  add column if not exists description text,
  add column if not exists max_locations integer,
  add column if not exists max_staff integer,
  add column if not exists max_menu_items integer;

-- No restaurant is on `basic`, so the rename is safe. `enterprise` is not
-- offered in the upgrade screen — the brief describes two plans — but the row
-- is kept so the Super Admin's catalogue still shows the history. It is
-- deactivated, which keeps it out of the plan list owners are shown.
update public.subscription_plans set id = 'starter' where id = 'basic';

update public.subscription_plans set
  name = 'Starter',
  description = 'Everything a single-location restaurant needs to run.',
  price_monthly = 999,
  price_yearly = 0,
  currency = 'INR',
  trial_days = 14,
  features = '["AI menu scanning with instant extraction", "Up to 100 menu items", "1 restaurant location", "Up to 5 staff members with roles", "Basic analytics", "Email support", "QR ordering", "Kitchen display"]'::jsonb,
  max_locations = 1,
  max_staff = 5,
  max_menu_items = 100,
  is_active = true,
  sort_order = 1
where id = 'starter';

update public.subscription_plans set
  name = 'Pro',
  description = 'For a restaurant that has grown past one location.',
  price_monthly = 2499,
  price_yearly = 0,
  currency = 'INR',
  trial_days = 14,
  features = '["Unlimited menu items", "Up to 3 restaurant locations", "Unlimited staff members with roles", "Advanced analytics", "Priority support", "All Starter features, including AI menu scanning, QR ordering, and kitchen display"]'::jsonb,
  max_locations = 3,
  -- null means unlimited
  max_staff = null,
  max_menu_items = null,
  is_active = true,
  sort_order = 2
where id = 'pro';

update public.subscription_plans set
  is_active = false,
  features = '["Unlimited users", "Multi-outlet", "Priority support", "API access"]'::jsonb
where id = 'enterprise';

-- ---------------------------------------------------------------------------
-- 2. The subscription columns on a restaurant
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column if not exists trial_started_at timestamptz,
  add column if not exists subscription_plan text,
  add column if not exists subscription_started_at timestamptz,
  add column if not exists razorpay_subscription_id text,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists subscription_razorpay_payment_id text;

create index if not exists tenants_razorpay_subscription_id_idx
  on public.tenants (razorpay_subscription_id)
  where razorpay_subscription_id is not null;

-- ---------------------------------------------------------------------------
-- 3. The payments table
-- ---------------------------------------------------------------------------

alter table public.subscription_payments
  add column if not exists razorpay_payment_id text,
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_invoice_id text,
  add column if not exists razorpay_signature text,
  add column if not exists razorpay_subscription_id text,
  add column if not exists webhook_event_id text,
  add column if not exists failure_reason text;

-- A webhook is delivered at least once. This is what makes processing it
-- twice harmless: the second delivery cannot insert a second row.
create unique index if not exists subscription_payments_webhook_event_idx
  on public.subscription_payments (webhook_event_id)
  where webhook_event_id is not null;

create unique index if not exists subscription_payments_razorpay_payment_idx
  on public.subscription_payments (razorpay_payment_id)
  where razorpay_payment_id is not null;

alter table public.subscription_audit_logs
  add column if not exists razorpay_event_id text,
  add column if not exists detail jsonb;

-- ---------------------------------------------------------------------------
-- 3b. The processed webhook events
-- ---------------------------------------------------------------------------

-- Razorpay delivers a webhook at least once, and retries it until it is
-- acknowledged. The event id is the primary key, so the second delivery of
-- the same event cannot be inserted — and the webhook answers 200 to a
-- duplicate instead of acting on it twice.
create table if not exists public.subscription_webhook_events (
  event_id     text primary key,
  event_type   text,
  tenant_id    uuid references public.tenants(id) on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  result       text
);

create index if not exists subscription_webhook_events_tenant_idx
  on public.subscription_webhook_events (tenant_id);

-- ---------------------------------------------------------------------------
-- 4. The trial the existing restaurants were never given
-- ---------------------------------------------------------------------------

-- Every restaurant was created with subscription_status = 'trial' and a null
-- trial_ends_at, which meant the trial was never actually given to anybody.
-- Their trial starts when they signed up and runs for the plan's trial days.
update public.tenants t
set trial_started_at = t.created_at,
    trial_ends_at = t.created_at + (p.trial_days || ' days')::interval
from public.subscription_plans p
where p.id = coalesce(t.plan, 'pro')
  and t.subscription_status = 'trial'
  and t.trial_ends_at is null;

-- A restaurant that is mid-trial is on the trial plan, which is Pro.
update public.tenants
set plan = 'pro'
where subscription_status = 'trial' and plan is null;
