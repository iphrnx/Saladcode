-- ===========================================================================
-- 0029 — The plan catalogue is the pricing
--
-- The pricing was written out by hand in the landing page and again in the
-- Settings billing tab, and the two copies disagreed with each other and
-- with the catalogue: the landing page said fifty menu items where the
-- catalogue said a hundred, put AI menu extraction under Pro when the brief
-- has it in Starter, and both left out features the plan actually includes.
--
-- The catalogue is now the only copy. This adds the one thing it was
-- missing — which plan is the popular one — so the marketing page can mark
-- it without hardcoding a rule.
-- ===========================================================================

alter table public.subscription_plans
  add column if not exists is_popular boolean not null default false;

update public.subscription_plans set is_popular = true where id = 'pro';
update public.subscription_plans set is_popular = false where id <> 'pro';

-- The features, exactly as the plans are sold.
update public.subscription_plans set
  features = '["AI menu scanning with instant extraction", "Up to 100 menu items", "1 restaurant location", "Up to 5 staff members with roles", "Basic analytics", "Email support", "QR ordering", "Kitchen display"]'::jsonb
where id = 'starter';

update public.subscription_plans set
  features = '["Unlimited menu items", "Up to 3 restaurant locations", "Unlimited staff members with roles", "Advanced analytics", "Priority support", "All Starter features, including AI menu scanning, QR ordering, and kitchen display"]'::jsonb
where id = 'pro';
