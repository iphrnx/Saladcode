-- ============================================================================
-- 0017 — Revenue & Payment Tracking
--
-- Implements a ledger for subscription payments and a tracking table for 
-- recurring revenue (MRR) and churn.
-- ============================================================================

-- 1. Subscription Payments Ledger
-- Records every payment event (Stripe/Razorpay/Manual).
create table if not exists public.subscription_payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  amount          numeric(12,2) not null,
  currency        text not null default 'INR',
  status          text not null, -- 'pending', 'succeeded', 'failed', 'refunded'
  payment_method  text,           -- 'stripe', 'razorpay', 'manual'
  transaction_id  text unique,     -- External provider ID
  plan_id         text not null,  -- 'basic', 'pro', 'enterprise'
  billing_period  text not null,  -- 'monthly', 'yearly'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 2. Subscription State Tracking
-- Tracks current plan, trial end dates, and renewal status.
alter table public.tenants
  add column if not exists subscription_status text default 'trial', -- 'trial', 'active', 'past_due', 'canceled'
  add column if not exists trial_ends_at timestamptz,
  add column if not exists current_period_end timestamptz;

-- 3. Indexing for analytics
create index if not exists idx_sub_payments_tenant on public.subscription_payments(tenant_id);
create index if not exists idx_sub_payments_status on public.subscription_payments(status);
create index if not exists idx_tenants_sub_status on public.tenants(subscription_status);

-- 4. Audit log for subscription changes
create table if not exists public.subscription_audit_logs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  old_plan        text,
  new_plan        text,
  change_type     text not null, -- 'upgrade', 'downgrade', 'renewal', 'churn'
  created_at      timestamptz not null default now()
);

-- 5. Security: RLS
alter table public.subscription_payments enable row level security;
alter table public.subscription_audit_logs enable row level security;

create policy "Super admins can manage all payments"
  on public.subscription_payments
  for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "Super admins can manage all audit logs"
  on public.subscription_audit_logs
  for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );
