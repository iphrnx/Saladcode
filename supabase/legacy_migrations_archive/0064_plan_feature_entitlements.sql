-- Which gated features a plan actually includes, as machine-readable keys.
--
-- The old rule compared plan *ids* (`planId === "pro"`), so the catalogue
-- could advertise Advanced Analytics on Starter and the server would still
-- refuse it. The `features` column is prose for the pricing page and can
-- never be the authority; this column is.
--
-- Keys are the vocabulary in PRO_ONLY_FEATURES. A plan without a key does
-- not get the feature, whatever its name is.

alter table public.subscription_plans
  add column if not exists feature_keys text[] not null default '{}';

-- Starter now includes Advanced Analytics (monthly and annual — one plan row
-- covers both intervals).
update public.subscription_plans
   set feature_keys = array['advanced_analytics']
 where id in ('starter', 'pro');

-- Legacy one-time customers keep what they paid for while it is still
-- active: their plan row is retired from sale but must still grant the
-- features it was sold with.
update public.subscription_plans
   set feature_keys = array['advanced_analytics']
 where id = 'starter-onetime';

comment on column public.subscription_plans.feature_keys is
  'Gated features this plan grants (see PRO_ONLY_FEATURES in _shared/plans.ts). Authority for checkFeature(); the `features` prose is not.';
