-- ============================================================================
-- 0007 — Production hardening
--
-- Two problems, both found by auditing the live database rather than the repo:
--
--   1. The Focus prototype's SQL objects were never removed. 0001 dropped the
--      Focus *tables*, but `drop table` does not drop functions — so four dead
--      helpers survived, two of them SECURITY DEFINER and executable by `anon`
--      over PostgREST. They reference tables that no longer exist. Nothing in
--      the app calls them.
--
--   2. Supabase's advisors flagged missing FK indexes, a mutable search_path
--      on the trigger helper, and over-broad EXECUTE grants on the RLS helpers.
-- ============================================================================

-- ---- 1. Remove the Focus leftovers ----------------------------------------
drop function if exists public.set_updated_at();
drop function if exists public.current_staff_restaurant_ids();
drop function if exists public.next_order_number(uuid);
drop function if exists public.public_menu(text);

-- ---- 2. Pin search_path on the trigger helper -----------------------------
-- Without this, a caller can shadow `public` with a schema of their own and
-- influence how the trigger body resolves names.
alter function public.touch_updated_at() set search_path = public;

-- ---- 3. Cover every foreign key -------------------------------------------
-- PostgREST embedded selects and `on delete cascade` both do FK lookups; an
-- uncovered FK forces a sequential scan on every parent delete.
create index if not exists customer_reviews_table_idx    on public.customer_reviews (table_id);
create index if not exists google_reviews_connection_idx on public.google_reviews (connection_id);
create index if not exists orders_promo_code_idx         on public.orders (promo_code_id);
create index if not exists orders_served_by_idx          on public.orders (served_by_id);
create index if not exists orders_table_idx              on public.orders (table_id);
create index if not exists profiles_role_idx             on public.profiles (role_id);
create index if not exists reservations_table_idx        on public.reservations (table_id);
create index if not exists security_logs_user_idx        on public.security_logs (user_id);
create index if not exists staff_role_idx                on public.staff (role_id);
create index if not exists table_sessions_table_idx      on public.table_sessions (table_id);

-- ---- 4. Stop `anon` from reaching the RLS helpers -------------------------
-- Postgres grants EXECUTE to PUBLIC on every new function, so these were
-- callable without signing in. They are only used by `authenticated` RLS
-- policies; a diner never needs them.
revoke execute on function public.current_tenant_id() from public, anon;
revoke execute on function public.is_owner_of(uuid)   from public, anon;
grant  execute on function public.current_tenant_id() to authenticated, service_role;
grant  execute on function public.is_owner_of(uuid)   to authenticated, service_role;

-- ---- 5. RLS initplan: evaluate auth.uid() once, not once per row ----------
drop policy if exists profiles_self_write on public.profiles;
create policy profiles_self_write on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

notify pgrst, 'reload schema';
