-- ===========================================================================
-- 0038 — a trial always has a clock
--
-- `tenants.subscription_status` defaults to 'trial', but `trial_started_at`
-- and `trial_ends_at` had no default at all. So a tenant created by an insert
-- that did not name them — which was the registration path — came out as a
-- trial with no end date. `resolvePlan` reads a trial with no end date as a
-- trial that is over, so a brand-new restaurant was told "Your free trial has
-- ended" on the dashboard and in Settings → Billing before it had served a
-- single order, and its paid features were switched off.
--
-- Two changes: the columns get the same default treatment as the status, so no
-- insert can produce a trial without dates again (this also covers the legacy
-- `create_restaurant` function, which has no source in this repo and writes a
-- tenant itself), and the rows already in that state are given the window they
-- should have had.
--
-- The authoritative trial length is `subscription_plans.trial_days` (14 for the
-- plan a trial runs on); every code path reads it from there. The interval
-- below is only the safety net for an insert that names no dates, and a net
-- that is a day too generous is better than one that expires a new account.
-- ===========================================================================

alter table public.tenants alter column trial_started_at set default now();
alter table public.tenants alter column trial_ends_at set default now() + interval '14 days';

-- The window runs from when the account was made, which is what the trial
-- would have been had the dates been written at the time. A restaurant old
-- enough for that window to have passed is left expired, correctly.
update public.tenants
   set trial_started_at = coalesce(trial_started_at, created_at),
       trial_ends_at    = coalesce(trial_ends_at, created_at + interval '14 days')
 where subscription_status = 'trial'
   and (trial_started_at is null or trial_ends_at is null);
