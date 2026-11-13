-- ============================================================================
-- The Salad — Multitenant Restaurant Platform
-- Initial schema. Supabase-native: uuid PKs, RLS everywhere, realtime-ready.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 0. Retire the previous (Focus) prototype tables. They collide by name with
--    the real schema below. Data was exported to .legacy-backup/ first.
-- ---------------------------------------------------------------------------
drop table if exists public.order_items   cascade;
drop table if exists public.orders        cascade;
drop table if exists public.dishes        cascade;
drop table if exists public.categories    cascade;
drop table if exists public.promos        cascade;
drop table if exists public.staff         cascade;
drop table if exists public.restaurants   cascade;

-- ---------------------------------------------------------------------------
-- 1. Tenants (restaurants)
-- ---------------------------------------------------------------------------
create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  logo            text,
  tagline         text,
  currency        text not null default 'INR',
  currency_symbol text not null default '₹',
  address         text,
  phone           text,
  email           text,
  tax_rate        numeric(6,3) not null default 5.0,
  service_charge  numeric(6,3) not null default 0.0,
  plan            text not null default 'pro',
  active          boolean not null default true,
  onboarding_done boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Roles (per-tenant permission sets)
-- ---------------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  description text,
  permissions text not null default '',
  is_system   boolean not null default false,
  color       text not null default '#ff7e6b',
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
create index roles_tenant_idx on public.roles (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Profiles — owner/manager accounts. 1:1 with auth.users.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  email              text not null,
  name               text not null,
  avatar             text,
  role               text not null default 'OWNER',
  role_id            uuid references public.roles(id) on delete set null,
  active             boolean not null default true,
  last_login         timestamptz,
  two_factor_enabled boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, email)
);
create index profiles_tenant_idx on public.profiles (tenant_id);

-- ---------------------------------------------------------------------------
-- 4. Staff — PIN-based, deliberately separate from owner auth
-- ---------------------------------------------------------------------------
create table public.staff (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  employee_id     text not null,
  role_id         uuid references public.roles(id) on delete set null,
  pin_hash        text not null,
  pin_salt        text not null,
  active          boolean not null default true,
  avatar          text,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  last_login      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, employee_id)
);
create index staff_tenant_idx on public.staff (tenant_id);

create table public.staff_sessions (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  token       text not null unique default encode(gen_random_bytes(32), 'hex'),
  created_at  timestamptz not null default now(),
  last_active timestamptz not null default now()
);
create index staff_sessions_staff_idx on public.staff_sessions (staff_id);

create table public.staff_activities (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  action     text not null,
  meta       text,
  ip         text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index staff_activities_tenant_idx on public.staff_activities (tenant_id, created_at desc);
create index staff_activities_staff_idx  on public.staff_activities (staff_id);

-- ---------------------------------------------------------------------------
-- 5. Menu
-- ---------------------------------------------------------------------------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  icon       text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index categories_tenant_idx on public.categories (tenant_id, sort_order);

create table public.menu_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  name        text not null,
  description text,
  price       numeric(10,2) not null default 0,
  image       text,
  available   boolean not null default true,
  prep_time   integer not null default 15,
  tags        text,
  calories    integer,
  sort_order  integer not null default 0,
  rating      numeric(3,2) not null default 4.5,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index menu_items_tenant_idx   on public.menu_items (tenant_id, category_id);
create index menu_items_category_idx on public.menu_items (category_id);

-- ---------------------------------------------------------------------------
-- 6. Tables + QR table sessions
-- ---------------------------------------------------------------------------
create table public.tables (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  seats      integer not null default 4,
  area       text not null default 'Main Hall',
  qr_token   text not null unique default encode(gen_random_bytes(18), 'hex'),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index tables_tenant_idx  on public.tables (tenant_id);
create index tables_qr_idx      on public.tables (qr_token);

-- Backend source of truth for "may this customer order right now".
create table public.table_sessions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  table_id   uuid not null references public.tables(id) on delete cascade,
  token      text not null unique default encode(gen_random_bytes(24), 'hex'),
  status     text not null default 'ACTIVE',
  device_fp  text,
  created_at timestamptz not null default now(),
  ended_at   timestamptz
);
create index table_sessions_lookup_idx on public.table_sessions (tenant_id, table_id, status);
create index table_sessions_token_idx  on public.table_sessions (token);

-- ---------------------------------------------------------------------------
-- 7. Orders
-- ---------------------------------------------------------------------------
create sequence if not exists public.order_number_seq;

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  order_number     integer not null default nextval('public.order_number_seq'),
  table_id         uuid references public.tables(id) on delete set null,
  table_session_id uuid references public.table_sessions(id) on delete set null,
  order_type       text not null default 'DINE_IN',
  status           text not null default 'PENDING',
  items_total      numeric(10,2) not null default 0,
  discount         numeric(10,2) not null default 0,
  tax              numeric(10,2) not null default 0,
  service_charge   numeric(10,2) not null default 0,
  total            numeric(10,2) not null default 0,
  promo_code_id    uuid,  -- FK added after promo_codes exists (see below)
  promo_code       text,
  customer_name    text,
  customer_phone   text,
  notes            text,
  payment_method   text,
  payment_status   text not null default 'UNPAID',
  served_by_id     uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index orders_tenant_status_idx  on public.orders (tenant_id, status);
create index orders_tenant_created_idx on public.orders (tenant_id, created_at desc);
create index orders_session_idx        on public.orders (table_session_id);

create table public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid references public.menu_items(id) on delete set null,
  name         text not null,
  price        numeric(10,2) not null default 0,
  quantity     integer not null default 1,
  notes        text,
  status       text not null default 'PENDING'
);
create index order_items_order_idx  on public.order_items (order_id);
create index order_items_menu_idx   on public.order_items (menu_item_id);

-- ---------------------------------------------------------------------------
-- 8. Reservations / promos / settings / audit
-- ---------------------------------------------------------------------------
create table public.reservations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  table_id   uuid references public.tables(id) on delete set null,
  name       text not null,
  phone      text not null,
  email      text,
  party_size integer not null default 2,
  date       text not null,
  time       text not null,
  status     text not null default 'PENDING',
  occasion   text,
  notes      text,
  created_at timestamptz not null default now()
);
create index reservations_tenant_date_idx on public.reservations (tenant_id, date);

create table public.promo_codes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  code         text not null,
  description  text,
  type         text not null default 'PERCENTAGE',
  value        numeric(10,2) not null default 0,
  min_order    numeric(10,2) not null default 0,
  max_discount numeric(10,2) not null default 0,
  usage_limit  integer not null default 0,
  used_count   integer not null default 0,
  valid_from   timestamptz not null default now(),
  valid_to     timestamptz,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (tenant_id, code)
);
create index promo_codes_tenant_idx on public.promo_codes (tenant_id);

-- orders.promo_code_id was declared before promo_codes existed.
alter table public.orders
  add constraint orders_promo_code_fk
  foreign key (promo_code_id) references public.promo_codes(id) on delete set null;

create table public.settings (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  key        text not null,
  value      text not null default '',
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);
create index settings_tenant_idx on public.settings (tenant_id);

create table public.security_logs (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid,
  action     text not null,
  ip         text,
  user_agent text,
  meta       text,
  created_at timestamptz not null default now()
);
create index security_logs_tenant_idx on public.security_logs (tenant_id, created_at desc);

create table public.user_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  token       text not null unique,
  device      text,
  browser     text,
  ip          text,
  location    text,
  current     boolean not null default false,
  last_active timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index user_sessions_user_idx on public.user_sessions (user_id);

-- ---------------------------------------------------------------------------
-- 9. Google Business reviews integration
-- ---------------------------------------------------------------------------
create table public.google_connections (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  access_token     text not null,
  refresh_token    text,
  token_expires_at timestamptz,
  account_name     text,
  location_name    text,
  location_id      text,
  place_id         text,
  enabled          boolean not null default true,
  auto_sync        boolean not null default true,
  sync_interval_mins integer not null default 60,
  show_public      boolean not null default true,
  min_rating_filter integer not null default 0,
  last_synced_at   timestamptz,
  last_sync_error  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index google_connections_tenant_idx on public.google_connections (tenant_id);

create table public.google_reviews (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  connection_id       uuid not null references public.google_connections(id) on delete cascade,
  google_review_id    text not null,
  author_name         text,
  author_photo_url    text,
  rating              integer not null default 5,
  comment             text,
  comment_translated  text,
  create_time         timestamptz,
  update_time         timestamptz,
  reply               text,
  reply_time          timestamptz,
  flagged             boolean not null default false,
  synced_at           timestamptz not null default now(),
  unique (tenant_id, google_review_id)
);
create index google_reviews_tenant_rating_idx on public.google_reviews (tenant_id, rating);

-- ============================================================================
-- 10. updated_at maintenance
-- ============================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'tenants','profiles','staff','menu_items','orders',
    'settings','google_connections'
  ] loop
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

-- ============================================================================
-- 11. RLS helpers
-- ============================================================================

-- The tenant the currently-authenticated owner belongs to.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.profiles where id = auth.uid() limit 1;
$$;

create or replace function public.is_owner_of(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and tenant_id = p_tenant and active
  );
$$;

-- ============================================================================
-- 12. Row Level Security
--
-- Model:
--   * anon          -> public menu + table sessions + placing an order (via RPC)
--   * authenticated -> owners, scoped to their own tenant
--   * service_role  -> server routes (bypasses RLS)
-- ============================================================================

alter table public.tenants            enable row level security;
alter table public.roles              enable row level security;
alter table public.profiles           enable row level security;
alter table public.staff              enable row level security;
alter table public.staff_sessions     enable row level security;
alter table public.staff_activities   enable row level security;
alter table public.categories         enable row level security;
alter table public.menu_items         enable row level security;
alter table public.tables             enable row level security;
alter table public.table_sessions     enable row level security;
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.reservations       enable row level security;
alter table public.promo_codes        enable row level security;
alter table public.settings           enable row level security;
alter table public.security_logs      enable row level security;
alter table public.user_sessions      enable row level security;
alter table public.google_connections enable row level security;
alter table public.google_reviews     enable row level security;

-- ---- Owner (authenticated) policies -------------------------------------
create policy tenants_owner_read  on public.tenants for select to authenticated
  using (id = public.current_tenant_id());
create policy tenants_owner_write on public.tenants for update to authenticated
  using (id = public.current_tenant_id()) with check (id = public.current_tenant_id());

create policy profiles_owner_read on public.profiles for select to authenticated
  using (tenant_id = public.current_tenant_id());
create policy profiles_self_write on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy roles_owner_all on public.roles for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy staff_owner_all on public.staff for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy staff_activities_owner_read on public.staff_activities for select to authenticated
  using (public.is_owner_of(tenant_id));

create policy categories_owner_all on public.categories for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy menu_items_owner_all on public.menu_items for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy tables_owner_all on public.tables for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy table_sessions_owner_all on public.table_sessions for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy orders_owner_all on public.orders for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy order_items_owner_all on public.order_items for all to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_id and public.is_owner_of(o.tenant_id)))
  with check (exists (select 1 from public.orders o
                 where o.id = order_id and public.is_owner_of(o.tenant_id)));

create policy reservations_owner_all on public.reservations for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy promo_codes_owner_all on public.promo_codes for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy settings_owner_all on public.settings for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy security_logs_owner_read on public.security_logs for select to authenticated
  using (public.is_owner_of(tenant_id));

create policy user_sessions_owner_all on public.user_sessions for all to authenticated
  using (exists (select 1 from public.profiles p
                 where p.id = user_id and p.tenant_id = public.current_tenant_id()))
  with check (exists (select 1 from public.profiles p
                 where p.id = user_id and p.tenant_id = public.current_tenant_id()));

create policy google_connections_owner_all on public.google_connections for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

create policy google_reviews_owner_all on public.google_reviews for all to authenticated
  using (public.is_owner_of(tenant_id)) with check (public.is_owner_of(tenant_id));

-- ---- Public (anon) read-only policies -----------------------------------
-- A diner who scanned a QR code may browse the menu of that restaurant.
create policy tenants_public_read on public.tenants for select to anon
  using (active);

create policy categories_public_read on public.categories for select to anon
  using (exists (select 1 from public.tenants t where t.id = tenant_id and t.active));

create policy menu_items_public_read on public.menu_items for select to anon
  using (exists (select 1 from public.tenants t where t.id = tenant_id and t.active));

create policy tables_public_read on public.tables for select to anon
  using (active);

create policy google_reviews_public_read on public.google_reviews for select to anon
  using (exists (
    select 1 from public.google_connections c
    where c.id = connection_id and c.enabled and c.show_public
  ));

-- NOTE: table_sessions and orders intentionally have NO anon policies.
-- Customers reach them only through the SECURITY DEFINER RPCs below, so a
-- client can never fabricate a session or write an arbitrary order row.

-- ============================================================================
-- 13. Public RPCs (SECURITY DEFINER) — the only anon write path
-- ============================================================================

-- QR scan: resolve a table's QR token into a fresh ACTIVE session.
create or replace function public.start_table_session(p_qr_token text, p_device_fp text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table  public.tables;
  v_session public.table_sessions;
begin
  select * into v_table from public.tables
   where qr_token = p_qr_token and active limit 1;

  if not found then
    raise exception 'INVALID_QR' using errcode = 'P0001';
  end if;

  -- Reuse an existing live session for this table instead of stacking them up.
  select * into v_session from public.table_sessions
   where table_id = v_table.id and status = 'ACTIVE'
   order by created_at desc limit 1;

  if not found then
    insert into public.table_sessions (tenant_id, table_id, device_fp)
    values (v_table.tenant_id, v_table.id, p_device_fp)
    returning * into v_session;
  end if;

  return jsonb_build_object(
    'session_token', v_session.token,
    'session_id',    v_session.id,
    'status',        v_session.status,
    'tenant_id',     v_table.tenant_id,
    'table', jsonb_build_object(
      'id', v_table.id, 'name', v_table.name,
      'seats', v_table.seats, 'area', v_table.area
    )
  );
end $$;

-- Validate a session token on every customer request.
create or replace function public.validate_table_session(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.table_sessions;
begin
  select * into v from public.table_sessions
   where token = p_session_token limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'INVALID_SESSION');
  end if;
  if v.status <> 'ACTIVE' then
    return jsonb_build_object('ok', false, 'error', 'SESSION_ENDED');
  end if;

  return jsonb_build_object('ok', true, 'session_id', v.id,
                            'table_id', v.table_id, 'tenant_id', v.tenant_id);
end $$;

-- Place a customer order. Prices are recomputed server-side from menu_items;
-- nothing money-related is trusted from the client.
create or replace function public.place_order(
  p_session_token text,
  p_items         jsonb,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_notes         text default null,
  p_order_type    text default 'DINE_IN',
  p_promo_code    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions;
  v_tenant  public.tenants;
  v_item    jsonb;
  v_menu    public.menu_items;
  v_qty     integer;
  v_items_total numeric(10,2) := 0;
  v_discount    numeric(10,2) := 0;
  v_tax         numeric(10,2);
  v_service     numeric(10,2);
  v_total       numeric(10,2);
  v_order   public.orders;
  v_promo   public.promo_codes;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = 'P0001';
  end if;

  if p_session_token is not null then
    select * into v_session from public.table_sessions
     where token = p_session_token and status = 'ACTIVE' limit 1;
    if not found then
      raise exception 'INVALID_SESSION' using errcode = 'P0001';
    end if;
  end if;

  if v_session.id is null then
    raise exception 'SESSION_REQUIRED' using errcode = 'P0001';
  end if;

  select * into v_tenant from public.tenants where id = v_session.tenant_id;

  -- Recompute line prices from the database, never from the client payload.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(coalesce((v_item->>'quantity')::int, 1), 1);
    select * into v_menu from public.menu_items
     where id = (v_item->>'menuItemId')::uuid
       and tenant_id = v_session.tenant_id
       and available
     limit 1;
    if not found then
      raise exception 'ITEM_UNAVAILABLE:%', coalesce(v_item->>'menuItemId','?')
        using errcode = 'P0001';
    end if;
    v_items_total := v_items_total + (v_menu.price * v_qty);
  end loop;

  -- Promo validation
  if p_promo_code is not null and length(trim(p_promo_code)) > 0 then
    select * into v_promo from public.promo_codes
     where tenant_id = v_session.tenant_id
       and upper(code) = upper(trim(p_promo_code))
       and active
       and (valid_to is null or valid_to > now())
       and v_items_total >= min_order
       and (usage_limit = 0 or used_count < usage_limit)
     limit 1;
    if found then
      if v_promo.type = 'PERCENTAGE' then
        v_discount := v_items_total * (v_promo.value / 100.0);
      else
        v_discount := v_promo.value;
      end if;
      if v_promo.max_discount > 0 then
        v_discount := least(v_discount, v_promo.max_discount);
      end if;
      v_discount := least(v_discount, v_items_total);
    else
      v_promo := null;
    end if;
  end if;

  v_tax     := round((v_items_total - v_discount) * (v_tenant.tax_rate / 100.0), 2);
  v_service := round((v_items_total - v_discount) * (v_tenant.service_charge / 100.0), 2);
  v_total   := round(v_items_total - v_discount + v_tax + v_service, 2);

  insert into public.orders (
    tenant_id, table_id, table_session_id, order_type, status,
    items_total, discount, tax, service_charge, total,
    promo_code_id, promo_code, customer_name, customer_phone, notes
  ) values (
    v_session.tenant_id, v_session.table_id, v_session.id,
    coalesce(p_order_type, 'DINE_IN'), 'PENDING',
    v_items_total, v_discount, v_tax, v_service, v_total,
    v_promo.id, v_promo.code, p_customer_name, p_customer_phone, p_notes
  ) returning * into v_order;

  -- Insert line items (price snapshot comes from the DB row).
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := greatest(coalesce((v_item->>'quantity')::int, 1), 1);
    select * into v_menu from public.menu_items
     where id = (v_item->>'menuItemId')::uuid and tenant_id = v_session.tenant_id limit 1;
    insert into public.order_items (order_id, menu_item_id, name, price, quantity, notes)
    values (v_order.id, v_menu.id, v_menu.name, v_menu.price, v_qty, v_item->>'notes');
  end loop;

  if v_promo.id is not null then
    update public.promo_codes set used_count = used_count + 1 where id = v_promo.id;
  end if;

  return jsonb_build_object(
    'order_id',     v_order.id,
    'order_number', v_order.order_number,
    'total',        v_order.total,
    'status',       v_order.status,
    'table_name',   (select name from public.tables where id = v_order.table_id)
  );
end $$;

-- ============================================================================
-- 14. Grants
-- ============================================================================
grant usage on schema public to anon, authenticated;
grant select on public.tenants, public.categories, public.menu_items,
                public.tables, public.google_reviews to anon;
grant execute on function public.start_table_session(text, text) to anon;
grant execute on function public.validate_table_session(text)  to anon;
grant execute on function public.place_order(text, jsonb, text, text, text, text, text) to anon;

-- ============================================================================
-- 15. Realtime — replaces the in-process EventEmitter order bus
-- ============================================================================
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.order_items;
alter publication supabase_realtime add table public.table_sessions;

alter table public.orders        replica identity full;
alter table public.order_items   replica identity full;
alter table public.table_sessions replica identity full;
