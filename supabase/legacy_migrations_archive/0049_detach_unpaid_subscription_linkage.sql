-- 0049_detach_unpaid_subscription_linkage.sql
-- Fix 3 of the Oct 30 billing audit: a checkout used to write
-- tenants.razorpay_subscription_id BEFORE the payment, so an abandoned
-- recurring checkout could overwrite the linkage of a tenant that had
-- already paid (one-time or recurring). That unpaid id in the field is what
-- made the free-upgrade path reachable: the upgrade guard trusted
-- tenants.subscription_status and would have run a plan change against a
-- subscription that was never paid for.
--
-- This detaches any linkage whose subscription id exists only as a pending
-- (unpaid) checkout, restoring the tenant's most recent PAID subscription
-- id when there is one (so valid paid access is preserved, not just
-- cleared). Entitlement is untouched either way: resolvePlan reads
-- subscription_plan, subscription_status and current_period_end, none of
-- which change here. If the pending checkout is paid later, verify()
-- re-writes the linkage from the checkout row.
--
-- Rollback (the linkage is recoverable from subscription_checkouts):
--   UPDATE tenants t
--   SET razorpay_subscription_id = c.razorpay_subscription_id
--   FROM subscription_checkouts c
--   WHERE c.tenant_id = t.id AND c.status = 'pending'
--     AND c.razorpay_subscription_id IS NOT NULL;

WITH paid_link AS (
  -- Each tenant's most recent PAID Razorpay subscription, if any.
  SELECT DISTINCT ON (c.tenant_id)
    c.tenant_id, c.razorpay_subscription_id
  FROM subscription_checkouts c
  WHERE c.status = 'paid'
    AND c.razorpay_subscription_id IS NOT NULL
  ORDER BY c.tenant_id, c.verified_at DESC NULLS LAST
),
dangling AS (
  -- Subscription ids that exist only as pending (unpaid) checkouts.
  SELECT DISTINCT c.tenant_id, c.razorpay_subscription_id
  FROM subscription_checkouts c
  WHERE c.status = 'pending'
    AND c.razorpay_subscription_id IS NOT NULL
)
UPDATE tenants t
SET razorpay_subscription_id = p.razorpay_subscription_id
FROM dangling d
LEFT JOIN paid_link p ON p.tenant_id = d.tenant_id
WHERE t.id = d.tenant_id
  AND t.razorpay_subscription_id = d.razorpay_subscription_id;
