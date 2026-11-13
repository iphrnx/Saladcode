-- Backs /api/reviews. Present in the Prisma schema as CustomerReview but was
-- missed in the initial migration.

create table if not exists public.customer_reviews (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  table_id    uuid references public.tables(id) on delete set null,
  rating      integer not null default 5,
  author_name text,
  comment     text,
  tags        text,
  created_at  timestamptz not null default now()
);

create index if not exists customer_reviews_tenant_idx
  on public.customer_reviews (tenant_id, created_at desc);

alter table public.customer_reviews enable row level security;

-- Owners manage their own reviews. Customers submit through the server route
-- (service role), so there is deliberately no anon policy here — that keeps
-- review spam off a public write path.
drop policy if exists customer_reviews_owner_all on public.customer_reviews;
create policy customer_reviews_owner_all on public.customer_reviews
  for all to authenticated
  using (public.is_owner_of(tenant_id))
  with check (public.is_owner_of(tenant_id));
