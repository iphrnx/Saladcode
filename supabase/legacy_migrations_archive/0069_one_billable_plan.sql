-- One restaurant, one pending mandate — the database backstop.
--
-- The duplicate-subscription bug lived in the checkout flow: every request
-- created a fresh Razorpay subscription, so repeated clicks, retries and
-- second tabs each minted a billable mandate (one test restaurant reached
-- seven pending mandates, another fifteen). The application fix (reuse,
-- replace-or-cancel, verified at Razorpay) ships in the `subscriptions`
-- edge function; THIS migration is the hard floor beneath it:
--
--   * at most ONE pending mandate checkout per restaurant — two concurrent
--     requests cannot both insert, and the loser reuses the winner's
--     mandate instead of creating a second one;
--   * at most one pending pay-once ORDER per restaurant + plan + interval —
--     same race, same convergence (orders never bill twice, but twenty
--     three dangling payable links for one restaurant is not a ledger).
--
-- DEPLOY ORDER — this migration runs LAST:
--
--   1. deploy the `subscriptions` function (with /mandates-audit);
--   2. run mandates-audit for every affected restaurant and cancel the
--      Razorpay-billable duplicates (authenticated/active, paid_count=0) —
--      expiring a row here does NOT cancel the mandate at Razorpay, so the
--      Razorpay-side cleanup must happen first, with the owner's approval;
--   3. only then apply this migration.
--
-- Existing duplicates are expired below — never deleted: the record of
-- what was created stays, and mandates-audit still lists them with their
-- live Razorpay status. Nothing paid is touched: only rows that never
-- settled are expired, and per restaurant the newest one is kept.

-- 1. Pending MANDATE checkouts: keep the newest per restaurant, expire the
--    rest. (For the affected test restaurants the Razorpay-side mandates
--    behind the expired rows were individually cancelled first — see the
--    deploy order above.)
with ranked as (
  select
    id,
    row_number() over (
      partition by tenant_id
      order by created_at desc, id desc
    ) as rn
  from public.subscription_checkouts
  where status = 'pending'
    and razorpay_subscription_id is not null
)
update public.subscription_checkouts c
set status = 'expired', updated_at = now()
from ranked r
where c.id = r.id
  and r.rn > 1;

-- 2. Pending ORDER checkouts (pay-once): keep the newest per restaurant +
--    plan + interval, expire the rest. Orders are inert until paid, so this
--    is ledger hygiene, not a billing change.
with ranked as (
  select
    id,
    row_number() over (
      partition by tenant_id, plan_id, coalesce(billing_interval, '')
      order by created_at desc, id desc
    ) as rn
  from public.subscription_checkouts
  where status = 'pending'
    and razorpay_subscription_id is null
    and razorpay_order_id is not null
)
update public.subscription_checkouts c
set status = 'expired', updated_at = now()
from ranked r
where c.id = r.id
  and r.rn > 1;

-- 3. The backstops. Partial unique indexes: they constrain only open
--    checkouts, so the history of paid, failed and expired rows is free to
--    be exactly as long as reality was.
create unique index if not exists one_pending_mandate_per_tenant
  on public.subscription_checkouts (tenant_id)
  where status = 'pending'
    and razorpay_subscription_id is not null;

create unique index if not exists one_pending_order_per_tenant_plan
  on public.subscription_checkouts (tenant_id, plan_id, (coalesce(billing_interval, '')))
  where status = 'pending'
    and razorpay_subscription_id is null
    and razorpay_order_id is not null;

-- The two indexes are disjoint by construction: a mandate row carries a
-- subscription id, an order row does not, so neither can shadow the other.

comment on index public.one_pending_mandate_per_tenant is
  'One restaurant has at most one pending AutoPay mandate checkout. Backstop for checkout dedupe in the subscriptions edge function (reuse/replace + verified cancel). Part of one-billable-plan (0069).';

comment on index public.one_pending_order_per_tenant_plan is
  'One restaurant has at most one pending pay-once order per plan and interval. Backstop for order reuse in the subscriptions edge function. Part of one-billable-plan (0069).';
