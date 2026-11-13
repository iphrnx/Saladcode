-- ============================================================================
-- Reset the database to an empty, production-ready state.
--
-- Deletes all application data and every owner login. The schema, RLS
-- policies, functions, triggers and indexes are left untouched — this is a
-- data reset, not a schema reset.
--
-- Run this before handing the project to a real restaurant. Afterwards the
-- first user signs up at /?view=register and is taken through onboarding.
--
--   psql "$DATABASE_URL" -f supabase/reset-to-empty.sql
--
-- or run the statements through the Supabase SQL editor / MCP tooling.
-- ============================================================================

begin;

-- Usage, billing and AI log tables reference tenants without a cascade, so
-- they have to go first or the tenant delete below fails.
delete from public.feature_usage;
delete from public.subscription_payments;
delete from public.subscription_audit_logs;
delete from public.subscription_webhook_events;
delete from public.ai_request_logs;

-- Deleting the tenant cascades to every tenant-scoped table:
--   roles, profiles, staff, staff_sessions, staff_activities, categories,
--   menu_items, tables, table_sessions, orders, order_items, reservations,
--   promo_codes, settings, security_logs, customer_reviews
delete from public.tenants;

-- Owner logins live in auth.users, outside the tenant cascade. This clears the
-- demo owner plus the orphaned test accounts left over from the Focus
-- prototype, which never had a profiles row of their own.
delete from auth.users;

-- The first real order should be #1, not #7.
alter sequence public.order_number_seq restart with 1;

commit;

-- ---------------------------------------------------------------------------
-- Restoring the demo restaurant for local development
-- ---------------------------------------------------------------------------
-- 1. Re-run supabase/migrations/0004_seed_demo_tenant.sql
--    (it creates the "Jaegar Resto" tenant, menu, tables, roles and promos)
-- 2. Create the matching owner login:
--      POST /api/auth/register
--      { "email": "owner@jaegarresto.in", "password": "jaegar1234",
--        "name": "Alex Mercer", "restaurantName": "Jaegar Resto" }
