-- ===========================================================================
-- 0035 — Internal Review System
--
-- Replaces Google Reviews with an internal customer review system.
-- Stores reviews in `customer_reviews` with restaurant-level data isolation,
-- session validation, duplicate-submission prevention, and RLS.
-- Removes obsolete Google Reviews and Google OAuth tables.
-- ===========================================================================

-- 1. Ensure customer_reviews table has constraints and indexes
alter table public.customer_reviews
  add column if not exists table_session_id uuid references public.table_sessions(id) on delete set null,
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists reply text,
  add column if not exists reply_at timestamptz;

-- Enforce rating constraint between 1 and 5
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customer_reviews_rating_range'
  ) then
    alter table public.customer_reviews
      add constraint customer_reviews_rating_range check (rating >= 1 and rating <= 5);
  end if;
end $$;

-- Enforce duplicate-submission prevention: at most one review per table session
create unique index if not exists customer_reviews_session_uniq
  on public.customer_reviews (table_session_id)
  where table_session_id is not null;

create index if not exists customer_reviews_tenant_created_idx
  on public.customer_reviews (tenant_id, created_at desc);

create index if not exists customer_reviews_tenant_rating_idx
  on public.customer_reviews (tenant_id, rating, created_at desc);

-- 2. Row level security and permissions
alter table public.customer_reviews enable row level security;

-- Owner manages all reviews for their tenant
drop policy if exists customer_reviews_owner_all on public.customer_reviews;
create policy customer_reviews_owner_all on public.customer_reviews
  for all to authenticated
  using (public.is_owner_of(tenant_id))
  with check (public.is_owner_of(tenant_id));

-- Public read for active tenant's reviews
drop policy if exists customer_reviews_public_read on public.customer_reviews;
create policy customer_reviews_public_read on public.customer_reviews
  for select to anon
  using (exists (
    select 1 from public.tenants t
    where t.id = customer_reviews.tenant_id and t.active
  ));

grant select on public.customer_reviews to anon, authenticated;

-- 3. Clean up obsolete Google Reviews tables and OAuth state tables
drop table if exists public.google_oauth_states cascade;
drop table if exists public.google_oauth_tokens cascade;
drop table if exists public.google_reviews cascade;
drop table if exists public.google_connections cascade;
drop table if exists public.google_oauth_config cascade;
