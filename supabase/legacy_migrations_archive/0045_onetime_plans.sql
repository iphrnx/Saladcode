-- One-time plans.
--
-- A "onetime" plan is paid for once and stays active for thirty days. There
-- is no Razorpay subscription and no auto-debit mandate; renewing is buying
-- it again. Recurring stays the default, so every existing row is unchanged.

alter table public.subscription_plans
  add column if not exists billing_mode text not null default 'recurring'
  constraint subscription_plans_billing_mode_check
  check (billing_mode in ('recurring', 'onetime'));

insert into public.subscription_plans (
  id, name, description, price_monthly, currency, trial_days, features,
  is_active, is_popular, sort_order,
  max_locations, max_staff, max_menu_items,
  billing_mode
) values (
  'starter-onetime',
  'Starter — one-time',
  'Everything in Starter, paid once. Active for thirty days, then renew by paying again. No auto-debit.',
  999,
  'INR',
  0,
  '[
    "AI menu scanning with instant extraction",
    "Up to 100 menu items",
    "1 restaurant location",
    "Up to 5 staff members with roles",
    "Basic analytics",
    "Email support",
    "QR ordering",
    "Kitchen display"
  ]'::jsonb,
  true,
  false,
  3,
  1,
  5,
  100,
  'onetime'
)
on conflict (id) do nothing;
