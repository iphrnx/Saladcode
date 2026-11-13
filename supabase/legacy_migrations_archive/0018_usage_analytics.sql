-- ============================================================================
-- 0018 — Usage Analytics
--
-- Tracks feature usage and engagement metrics across the platform.
-- ============================================================================

-- 1. Feature Activity Log
-- Records every time a significant feature is used (e.g., menu update, 
-- promo creation, analytics view).
create table if not exists public.feature_usage (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  user_id         uuid not null references auth.users(id),
  feature_id      text not null, -- 'menu_edit', 'promo_create', 'analytics_view', etc.
  action          text,          -- 'create', 'update', 'delete', 'view'
  created_at      timestamptz not null default now()
);

-- 2. Daily Engagement Summary
-- Aggregated view for fast dashboard loading.
create table if not exists public.daily_tenant_metrics (
  tenant_id       uuid primary key references public.tenants(id),
  date            date not null default current_date,
  order_count     int default 0,
  order_value     numeric(12,2) default 0,
  active_staff    int default 0,
  updated_at      timestamptz not null default now()
);

-- 3. Indexing for fast aggregation
create index if not exists idx_feature_usage_tenant on public.feature_usage(tenant_id);
create index if not exists idx_feature_usage_feature on public.feature_usage(feature_id);
create index if not exists idx_daily_metrics_date on public.daily_tenant_metrics(date);

-- 4. Security: RLS
alter table public.feature_usage enable row level security;
alter table public.daily_tenant_metrics enable row level security;

create policy "Super admins can view all usage data"
  on public.feature_usage
  for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "Super admins can view all daily metrics"
  on public.daily_tenant_metrics
  for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and is_super_admin = true
    )
  );

create policy "System can insert feature usage"
  on public.feature_usage
  for insert
  with check (true); -- Typically inserted via service-role edge functions
