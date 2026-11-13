-- ===========================================================================
-- 0047 — drop the tables and columns the audit confirmed dead
--
-- Everything in this migration was checked before dropping: no edge
-- function, no frontend file, no trigger, and no pg_proc body references
-- any of it, and the two tables were empty.
--
--   user_sessions — the pre-0039 owner-session store, superseded by the
--     SECURITY DEFINER functions that read real auth.sessions. 0 rows;
--     its policy and indexes drop with it.
--   super_admin_reports — a reporting idea from the first Super Admin
--     shell that never shipped. 0 rows.
--   daily_tenant_metrics.active_staff — written by a rollup, read by
--     nothing. Held 6 non-null values, all trigger-computed metrics
--     history, not user data.
--   table_sessions.release_at / closing_at — the pre-0040/0041 lifecycle
--     fields, replaced by status + last_seen_at. 0 non-null values; the
--     release_due index goes with the column.
--   subscription_webhook_events.tenant_id — events are identified by the
--     x-razorpay-event-id header since 0044; the column held legacy
--     type-valued history only. 0 non-null values.
--   super_admins.created_by — the allowlist predates any audit trail
--     reading it. 0 non-null values.
--
-- The two "Super admins can manage all …" policies still granted through
-- profiles.is_super_admin — a column no profile has ever carried since the
-- Oct 20 rebuild moved the allowlist to the super_admins table, so both
-- policies were dead: they admitted nobody. Repointed to is_super_admin(),
-- the same function every other super-admin policy uses, so they work for
-- the real allowlist and stay closed to everyone else.
-- ===========================================================================

drop table public.user_sessions;
drop table public.super_admin_reports;

drop index public.table_sessions_release_due_idx;
alter table public.daily_tenant_metrics drop column active_staff;
alter table public.table_sessions drop column release_at;
alter table public.table_sessions drop column closing_at;
alter table public.subscription_webhook_events drop column tenant_id;
alter table public.super_admins drop column created_by;

drop policy "Super admins can manage all payments" on public.subscription_payments;
create policy "Super admins can manage all payments" on public.subscription_payments
  for all to authenticated
  using (is_super_admin());

drop policy "Super admins can manage all audit logs" on public.subscription_audit_logs;
create policy "Super admins can manage all audit logs" on public.subscription_audit_logs
  for all
  using (is_super_admin());
