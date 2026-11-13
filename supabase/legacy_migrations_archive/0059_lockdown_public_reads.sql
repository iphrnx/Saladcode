-- The diner-facing menu (and everything else a customer touches) is served
-- through edge functions over the service role. These legacy public-read
-- policies let `anon` — with the anon key that ships in every page bundle —
-- enumerate every *active* tenant's menu, categories, reviews, tables and
-- tenant row with no authentication and no tenant scoping. The tables policy
-- also exposed `qr_token`, which is the credential that mints a table session
-- and places orders on that table: a remote attacker could list every
-- restaurant's tables and open sessions or spam orders without ever visiting.
--
-- Nothing reads these through PostgREST any more (the menu polls the
-- `table-session/validate` edge function), so the safe fix is to revoke the
-- unscoped read and drop the policies. Authenticated access is untouched:
-- those tables keep their `*_owner_all` policies, which are scoped by
-- `is_owner_of(tenant_id)`.

drop policy if exists categories_public_read on public.categories;
drop policy if exists customer_reviews_public_read on public.customer_reviews;
drop policy if exists menu_items_public_read on public.menu_items;
drop policy if exists tables_public_read on public.tables;
drop policy if exists tenants_public_read on public.tenants;

revoke select on public.categories from anon;
revoke select on public.customer_reviews from anon;
revoke select on public.menu_items from anon;
revoke select on public.tables from anon;
revoke select on public.tenants from anon;
