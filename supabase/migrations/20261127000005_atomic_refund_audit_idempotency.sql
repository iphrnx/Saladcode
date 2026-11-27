-- ============================================================================
-- Migration: 20261127000005_atomic_refund_audit_idempotency.sql
-- Purpose:
--   Enforce database-level idempotency for refund audit rows in
--   public.subscription_audit_logs so concurrent webhook deliveries with
--   different razorpay_event_id values for the same refund produce a single
--   audit entry, while distinct refunds on the same payment keep distinct rows.
-- ============================================================================

create unique index if not exists idx_sub_audit_logs_refund_id_unique
  on public.subscription_audit_logs (tenant_id, (detail->>'refundId'))
  where change_type = 'refunded'
    and detail->>'refundId' is not null;

create unique index if not exists idx_sub_audit_logs_refund_event_unique
  on public.subscription_audit_logs (tenant_id, razorpay_event_id)
  where change_type = 'refunded'
    and detail->>'refundId' is null
    and razorpay_event_id is not null;
