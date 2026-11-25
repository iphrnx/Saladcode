# Post-Cleanup Repair Report

**Branch:** `cleanup`  
**Recoverable Checkpoint:** `e07d492` (`pre-cleanup-p4`, `pre-cleanup-frontend`)  
**Supabase Project:** `https://jeuixphibaasbxgaexfg.supabase.co`  
**Date:** 2026-11-25

This report records all schema drift, missing database objects, migration-history issues, broken script imports, and test/lint findings discovered during the cleanup audit. **None of these were modified during cleanup** and are queued for the repair phase.

---

## 1. Critical Live Database Schema Drift

### 1.1 Missing Tables Referenced by Active Edge Functions (`10` tables)
The following tables are actively queried/inserted by `supabase/functions/` but **do not exist** in the live `public` schema (they existed in the pre-baseline `0001`–`0085` migrations and were omitted when `20261113000000_baseline_schema.sql` was squashed):

1. `subscription_checkouts` — 20 references (`subscriptions`, `razorpay-webhook`, `_shared/mandate-switch.ts`)
2. `subscription_audit_logs` — 12 references (`subscriptions`, `razorpay-webhook`, `_shared/mandate-switch.ts`)
3. `support_issues` — 4 references (`super-admin`)
4. `super_admin_audit_logs` — 4 references (`super-admin`, `emails`, `_shared/super_admin.ts`)
5. `ai_request_logs` — 4 references (`super-admin`, `_shared/ai-guard.ts`, `_shared/ai-log.ts`) *(Live DB has `ai_usage_logs` instead)*
6. `platform_business_details` — 3 references (`super-admin`, `_shared/billing-documents.ts`)
7. `tenant_notes` — 2 references (`super-admin`)
8. `daily_tenant_metrics` — 2 references (`super-admin`)
9. `ai_provider_settings` — 2 references (`super-admin`, `_shared/gemini.ts`)
10. `feature_usage` — 1 reference (`super-admin`)

### 1.2 Missing RPC Referenced by Active Edge Functions (`1` RPC)
- `public.record_staff_login_attempt(uuid, uuid, boolean, int, int)` — defined in `supabase/migrations/20261116000003_fix_audit_findings.sql` (lines 693–760) and called twice in `supabase/functions/staff/index.ts` (lines 171, 218), but **missing** from the live DB.

### 1.3 Unapplied Incremental Migrations / Missing Columns
- `public.orders` in the live DB is missing `paid_at` and `location_id` (added in `20261121000000_analytics_settlement_paid_at.sql`, `20261121000001_correct_analytics_settlement_paid_at.sql`, and `20261122000001_fix_full_settlement_invoice_location_analytics.sql`), indicating later migrations in `supabase/migrations/` have not been applied to the live DB.

### 1.4 Duplicate Migration Timestamps in `supabase/migrations/`
- `20261121000001_correct_analytics_settlement_paid_at.sql` & `20261121000001_harden_promo_codes.sql`
- `20261122000002_enforce_rbac_ownership_and_system_role_invariants.sql` & `20261122000002_verify_settlement_zero_sales_location.sql`

### 1.5 Unverified Live DB Internals (Requires `DATABASE_URL`)
- `DATABASE_URL` is not configured in `.env.local`, so unexposed schemas, `pg_cron` jobs, triggers, indexes, RLS policy bodies, and `supabase_migrations.schema_migrations` could not be inspected.

---

## 2. Pending Live DB Cleanup (Prepared, Awaiting Explicit Approval)
- `supabase/migrations/20261125000001_cleanup_obsolete_objects.sql` drops:
  - Orphaned RPC: `public.open_session_check_with_type`
  - Test-only RPCs: `execute_core_invariants_tests()`, `test_independent_diner_billing()`, `test_pos_session_selection_and_reconciliation()`, `test_takeaway_delivery_independent_sessions()`
  - Unused tables (0 rows): `public.dining_areas`, `public.ai_usage_logs`
  - Redundant columns (0 rows): `public.staff_sessions(device_info, ip_address)`
- Storage bucket `restaurant-logos` has `0` objects and `0` code references; consider removal if not needed for future tenant logo uploads.

---

## 3. Script & Test Failures Recorded (Not Suppressed)

### 3.1 Pre-Existing Broken Relative Imports in `scripts/`
- `scripts/test-fidelity-audit-fixes.mts`: imports `../src/lib/date-format.js` and `../src/lib/i18n.js` (missing files — pre-existing)
- `scripts/test-promo-harden-suite.mts`: imports `../_shared/promo.ts` (missing relative path from `scripts/` — pre-existing)
- `scripts/deploy-fn.mjs`: references `../_shared/auth.ts` (pre-existing)

### 3.2 Offline Regression Scripts with Partial Failures Against Squashed Baseline SQL
*(Post-cleanup note: these scripts previously read superseded files in `supabase/legacy_migrations_archive/`. After updating their fallback to `supabase/migrations/20261113000000_baseline_schema.sql`, their legacy regexes still expect pre-squash `0044`/`0076`/`0077`/`0080` formatting or split-file counts.)*
- `scripts/test-billing-offline.mts` — **70/72 passed, 2 failed**
- `scripts/test-table-checks-offline.mts` — **21/30 passed, 9 failed**
- `scripts/test-security-hardening-offline.mts` — **33/35 passed, 2 failed**
- `scripts/test-table-activation-offline.mts` — **50/54 passed, 4 failed**

*(Passing offline suites: `test-consolidated-billing-offline.mts` 29/29, `test-security-offline.mts` 72/72, `test-ai-guard-offline.mts` 63/63.)*

---

## 4. Pre-Existing ESLint Warnings & Unused DevDependency
- **ESLint:** `0` errors, `75` pre-existing warnings across `open-next.config.ts`, `src/app/**`, `src/components/**`, `src/lib/sign-out.ts`, and `supabase/functions/_shared/reminders.ts` (mostly `@next/next/no-location-assign-relative-destination` and `react-hooks/set-state-in-effect`).
- **Unused devDependency:** `@types/pg` (`^8.23.1`) in `package.json` is unused (`pg` is not in dependencies or imported anywhere).
