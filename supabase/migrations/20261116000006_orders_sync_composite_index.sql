-- Migration: 20261116000006_orders_sync_composite_index.sql
-- Description: Safe, reversible composite indexes for high-frequency sync queries on orders and table_sessions.
-- Benchmarked via EXPLAIN ANALYZE: accelerates orders incremental delta sync and table_sessions active lookup.

-- 1. Covering index for orders incremental sync (tenant_id + updated_at + created_at)
CREATE INDEX IF NOT EXISTS idx_orders_tenant_updated
  ON public.orders (tenant_id, updated_at DESC, created_at DESC);

-- 2. Covering index for table_sessions active / recent sitting lookups
CREATE INDEX IF NOT EXISTS idx_table_sessions_tenant_status_created 
  ON public.table_sessions (tenant_id, status, created_at DESC);

-- Down Migration (for reversibility):
-- DROP INDEX IF EXISTS public.idx_orders_tenant_updated;
-- DROP INDEX IF EXISTS public.idx_table_sessions_tenant_status_created;

