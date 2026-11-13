-- ===========================================================================
-- 0037 — customer_reviews: public read and safe delete paths
--
-- The applied form of the internal-reviews migration (internal_reviews_system,
-- 2026-10-23) drifted from the repo file 0035_internal_reviews.sql: it added
-- the columns and the unique index, but left anon with no grant — so the
-- public-read policy could never fire — and gave table_id / table_session_id /
-- order_id NO ACTION delete rules, which blocks deleting a tenant that has
-- reviews. That is the exact operation reset-to-empty.sql depends on.
--
-- This reconciles the live database with the intent of 0005 and 0035. It is
-- idempotent, so it is also safe on a database where 0035 ran verbatim.
-- ===========================================================================

-- The public may read reviews of an active restaurant, and nothing else.
grant select on public.customer_reviews to anon;

drop policy if exists customer_reviews_public_read on public.customer_reviews;
create policy customer_reviews_public_read on public.customer_reviews
  for select to anon
  using (exists (
    select 1 from public.tenants t
    where t.id = customer_reviews.tenant_id and t.active
  ));

-- Deleting a table, session or order must not strand or block a tenant
-- delete; the review survives with the reference cleared.
alter table public.customer_reviews drop constraint if exists customer_reviews_table_id_fkey;
alter table public.customer_reviews
  add constraint customer_reviews_table_id_fkey
  foreign key (table_id) references public.tables(id) on delete set null;

alter table public.customer_reviews drop constraint if exists customer_reviews_table_session_id_fkey;
alter table public.customer_reviews
  add constraint customer_reviews_table_session_id_fkey
  foreign key (table_session_id) references public.table_sessions(id) on delete set null;

alter table public.customer_reviews drop constraint if exists customer_reviews_order_id_fkey;
alter table public.customer_reviews
  add constraint customer_reviews_order_id_fkey
  foreign key (order_id) references public.orders(id) on delete set null;
