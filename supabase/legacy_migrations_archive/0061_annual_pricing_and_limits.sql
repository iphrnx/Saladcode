-- Official pricing: two plans, two intervals each. Annual is 16.7% off
-- (₹1,998 saved on Starter, ₹4,998 on Pro).
--
-- Additive and reversible: one nullable column for the annual Razorpay plan
-- id, and data that brings the catalogue in line with what is sold. No rows
-- are deleted and no subscription, tenant or payment record is touched — the
-- retired one-time plan is only de-activated, so its past payments keep their
-- plan reference and its customers keep the access they paid for.

alter table public.subscription_plans
  add column if not exists razorpay_plan_id_yearly text;

-- Starter — ₹999/month or ₹9,990/year, 100 dishes, one location, five staff.
update public.subscription_plans
   set price_monthly = 999,
       price_yearly = 9990,
       max_menu_items = 100,
       max_locations = 1,
       max_staff = 5,
       features = '[
         "AI menu scanning with instant extraction",
         "QR ordering",
         "Kitchen display",
         "Up to 100 menu items",
         "1 restaurant location",
         "Up to 5 staff members with roles",
         "Advanced analytics",
         "Email support"
       ]'::jsonb
 where id = 'starter';

-- Pro — ₹2,499/month or ₹24,990/year, 200 dishes, three locations, ten staff.
-- The old row said "unlimited" for menu items and staff because the limit
-- columns were null; both are now real numbers, enforced server-side.
update public.subscription_plans
   set price_monthly = 2499,
       price_yearly = 24990,
       max_menu_items = 200,
       max_locations = 3,
       max_staff = 10,
       features = '[
         "AI menu scanning with instant extraction",
         "QR ordering",
         "Kitchen display",
         "Up to 200 menu items",
         "Up to 3 restaurant locations",
         "Up to 10 staff members with roles",
         "Advanced analytics with multi-location insights and consolidated reporting",
         "Priority support"
       ]'::jsonb
 where id = 'pro';

-- Retire the one-time Starter plan. Deactivating hides it from the catalogue
-- and the checkout refuses it; existing purchases, invoices and expiry dates
-- are untouched.
update public.subscription_plans
   set is_active = false
 where id = 'starter-onetime';

-- Which interval a paid tenant is on. Written when a subscription is
-- activated from its checkout record; 'monthly' is the default for everyone
-- who was already paying, so an existing subscriber keeps their interval.
alter table public.tenants
  add column if not exists billing_interval text not null default 'monthly';

alter table public.subscription_checkouts
  add column if not exists billing_interval text;
