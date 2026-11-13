-- Annual plans can be bought two ways, and the difference has to be recorded
-- per purchase, not inferred later:
--
--   pay_once  a single Razorpay order for the full year. No subscription, no
--             mandate, nothing that can ever charge again.
--   autopay   a Razorpay subscription on the yearly plan with total_count = 1,
--             which is one billing cycle: one charge now, and the mandate ends
--             when that cycle ends (12 months). Razorpay computes `end_at` from
--             the cycle count and refuses further debits after it.
--
-- Additive only: nullable columns, no rewrites, no deletes, no change to any
-- existing subscription.

alter table public.subscription_checkouts
  add column if not exists payment_mode text,
  add column if not exists mandate_id text,
  add column if not exists mandate_expires_at timestamp with time zone;

alter table public.subscription_payments
  add column if not exists payment_mode text,
  add column if not exists mandate_id text,
  add column if not exists mandate_expires_at timestamp with time zone,
  -- What the renewal path is supposed to do with this row: a pay-once purchase
  -- is never renewed, an autopay one only when a charge actually succeeds.
  add column if not exists renewal_status text;

alter table public.tenants
  add column if not exists payment_mode text;

comment on column public.subscription_checkouts.payment_mode is
  'pay_once | autopay. Set when the checkout is created; the browser cannot change it.';
comment on column public.tenants.payment_mode is
  'How the current period was bought. pay_once never renews.';
