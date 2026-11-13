-- 0048_payment_ledger_constraint.sql
-- Fix 1 of the Oct 30 billing audit: the payment ledger never recorded a row.
--
-- Every insert into subscription_payments used ON CONFLICT (razorpay_payment_id),
-- but that column only had a PARTIAL unique index (WHERE razorpay_payment_id IS
-- NOT NULL). Postgres refuses an ON CONFLICT target that does not match a full
-- unique constraint, so every payment-record upsert errored (42P10) — and the
-- callers did not check, so the first real checkout (pay_Ttz79MR5wVAvHD,
-- Rs 999, verified 30 Oct 2026 04:17:52 UTC) verified, activated and was
-- audited while the ledger stayed empty. Billing history showed nothing.
--
-- This migration:
--   1. replaces the partial index with a full UNIQUE constraint, which is what
--      the code's ON CONFLICT target needs. UNIQUE allows multiple NULLs, so
--      rows without a Razorpay payment id keep working exactly as before.
--   2. backfills the one payment the old code could not record, from the
--      verified checkout row — the same evidence the verify path itself used.
--      Idempotent: ON CONFLICT DO NOTHING.
--
-- Rollback:
--   ALTER TABLE subscription_payments
--     DROP CONSTRAINT subscription_payments_razorpay_payment_id_key;
--   CREATE UNIQUE INDEX subscription_payments_razorpay_payment_idx
--     ON subscription_payments (razorpay_payment_id)
--     WHERE razorpay_payment_id IS NOT NULL;
--   DELETE FROM subscription_payments WHERE razorpay_payment_id = 'pay_Ttz79MR5wVAvHD';

-- 1. The constraint the upserts target.
DROP INDEX IF EXISTS subscription_payments_razorpay_payment_idx;
ALTER TABLE subscription_payments
  ADD CONSTRAINT subscription_payments_razorpay_payment_id_key UNIQUE (razorpay_payment_id);

-- 2. Backfill the verified starter-onetime payment of 30 Oct 2026.
--    The tenant is resolved through the checkout row, not hardcoded, and the
--    payment method is recorded as "razorpay" because the per-method detail
--    (card/upi/...) lives only in Razorpay's record, which this migration
--    cannot reach. That matches what the verify path itself writes when the
--    fetched payment carries no method.
INSERT INTO subscription_payments (
  tenant_id, amount, currency, status, payment_method, transaction_id,
  plan_id, billing_period, razorpay_payment_id, razorpay_order_id,
  razorpay_subscription_id, created_at, updated_at
)
SELECT
  c.tenant_id,
  c.verified_amount,
  c.currency,
  'succeeded',
  'razorpay',
  c.razorpay_payment_id,
  c.plan_id,
  'monthly',
  c.razorpay_payment_id,
  c.razorpay_order_id,
  c.razorpay_subscription_id,
  c.verified_at,
  c.verified_at
FROM subscription_checkouts c
WHERE c.razorpay_payment_id = 'pay_Ttz79MR5wVAvHD'
  AND c.status = 'paid'
  AND c.verified_amount IS NOT NULL
ON CONFLICT (razorpay_payment_id) DO NOTHING;
