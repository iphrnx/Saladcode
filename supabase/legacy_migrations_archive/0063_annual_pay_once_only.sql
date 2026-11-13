-- Annual billing is pay-once only. There is no annual mandate, so the yearly
-- Razorpay plan id is a setting with nothing left to configure.
--
-- Reversible: the column can be re-added with
--   alter table public.subscription_plans add column razorpay_plan_id_yearly text;
-- It is empty in every row (annual AutoPay was never switched on in
-- production), so nothing is lost.

alter table public.subscription_plans
  drop column if exists razorpay_plan_id_yearly;

-- The reminder ledger: one row per restaurant per reminder that came due, so a
-- daily run cannot send the same reminder twice, and "was the customer told?"
-- is answerable from data rather than from a log line.
create table if not exists public.renewal_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  /** Which reminder: 30, 7 or 1 day before the paid period ends. */
  days_before integer not null,
  /** The period end this reminder was about. A renewal resets it. */
  period_end timestamp with time zone not null,
  channel text not null default 'in_app',
  created_at timestamp with time zone not null default now(),
  sent_at timestamp with time zone,
  unique (tenant_id, days_before, period_end, channel)
);

create index if not exists renewal_reminders_due_idx
  on public.renewal_reminders (period_end)
  where sent_at is null;

-- Service-role only: the reminder runner writes it, nobody browses it.
alter table public.renewal_reminders enable row level security;
