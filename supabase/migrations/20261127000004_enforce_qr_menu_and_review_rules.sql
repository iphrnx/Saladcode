-- ============================================================================
-- Migration: 20261127000004_enforce_qr_menu_and_review_rules.sql
-- Purpose:
--   1. Route diner menu and table reads through QR/session validation
--      (/table-session/validate) by removing direct anon SELECT policies on
--      categories, menu_items, and tables.
--   2. Remove direct client/anon review read & write paths on customer_reviews.
--   3. Enforce at most one review per eligible table_session_id in the database.
-- ============================================================================

drop policy if exists "categories_public_read" on public.categories;
drop policy if exists "menu_items_public_read" on public.menu_items;
drop policy if exists "tables_public_read" on public.tables;

revoke select on table public.categories from anon;
revoke select on table public.menu_items from anon;
revoke select on table public.tables from anon;

drop policy if exists "reviews_public_read" on public.customer_reviews;
drop policy if exists "reviews_public_insert" on public.customer_reviews;

revoke all on table public.customer_reviews from public, anon, authenticated;
grant all on table public.customer_reviews to service_role;

create unique index if not exists idx_customer_reviews_session_unique
  on public.customer_reviews (table_session_id)
  where table_session_id is not null;
