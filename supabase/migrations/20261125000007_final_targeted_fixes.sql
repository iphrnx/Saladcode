-- ============================================================================
-- Migration: 20261125000007_final_targeted_fixes.sql
-- Purpose:
--   1. Resolve add_items_to_order_tx overload conflict by dropping the stale
--      (uuid, uuid, jsonb, text) overload and keeping the canonical
--      (uuid, uuid, jsonb, uuid) signature.
--   2. Fix purge_tenant(uuid) by removing its obsolete dining_areas reference
--      and strictly restricting execution to service_role.
--   3. Idempotently schedule prune_rate_limits() via pg_cron (every 15 min)
--      without creating duplicate jobs.
--   4. Fix teardown in test_independent_diner_billing() and
--      test_takeaway_delivery_independent_sessions() to set
--      app.purging_tenant = 'true' so finalised check/payment immutability
--      remains enforced while test fixtures clean up cleanly.
-- ============================================================================

-- 1. Drop stale add_items_to_order_tx overload (text p_idempotency_key)
drop function if exists public.add_items_to_order_tx(uuid, uuid, jsonb, text);

revoke all on function public.add_items_to_order_tx(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.add_items_to_order_tx(uuid, uuid, jsonb, uuid) to service_role;

-- 2. Fix purge_tenant() by removing obsolete dining_areas dependency
create or replace function public.purge_tenant(p_tenant_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $_$
declare
  v_removed jsonb := '{}'::jsonb;
  v_count integer;
begin
  -- Set transaction-scoped configuration flag to bypass invariant triggers during purge
  perform set_config('app.purging_tenant', 'true', true);

  execute 'delete from public.order_items oi using public.orders o where oi.order_id = o.id and o.tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('order_items', v_count);

  execute 'delete from public.orders where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('orders', v_count);

  execute 'delete from public.check_payments where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.table_checks where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.table_sessions where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tables where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.menu_items where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.categories where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.reservations where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.promo_codes where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.customer_reviews where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.staff_sessions where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.staff where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.roles where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.settings where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.security_logs where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tenant_realtime where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.locations where tenant_id = $1' using p_tenant_id;
  execute 'delete from public.tenant_owner_guard where tenant_id = $1' using p_tenant_id;

  execute 'delete from public.profiles where tenant_id = $1' using p_tenant_id;
  get diagnostics v_count = row_count; v_removed := v_removed || jsonb_build_object('profiles', v_count);

  update public.tenants
     set name = 'Deleted restaurant',
         slug = 'deleted-' || replace(p_tenant_id::text, '-', ''),
         logo = null,
         tagline = null,
         address = null,
         phone = null,
         email = null,
         active = false,
         onboarding_done = false,
         subscription_status = 'none',
         subscription_plan = null,
         plan = 'starter',
         trial_started_at = null,
         trial_ends_at = null,
         current_period_end = null,
         payment_mode = null
   where id = p_tenant_id;

  return v_removed;
end;
$_$;

revoke all on function public.purge_tenant(uuid) from public, anon, authenticated;
grant execute on function public.purge_tenant(uuid) to service_role;

-- 3. Idempotently schedule prune_rate_limits() via pg_cron
do $$
begin
  if exists (
    select 1 from pg_extension where extname = 'pg_cron'
  ) or exists (
    select 1 from pg_available_extensions where name = 'pg_cron'
  ) then
    begin
      create extension if not exists pg_cron with schema extensions;
    exception when others then
      null;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('prune-rate-limits');
    exception when others then
      null;
    end;
    begin
      perform cron.schedule(
        'prune-rate-limits',
        '*/15 * * * *',
        'select public.prune_rate_limits();'
      );
    exception when others then
      null;
    end;
  end if;
end;
$$;

-- 4. Fix test_independent_diner_billing() teardown to use app.purging_tenant
create or replace function public.test_independent_diner_billing() returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'extensions', 'pg_temp'
    as $$
declare
  v_results jsonb := '[]'::jsonb;
  v_tenant uuid := gen_random_uuid();
  v_table uuid := gen_random_uuid();
  v_cat uuid := gen_random_uuid();
  v_item_a uuid := gen_random_uuid();
  v_item_b uuid := gen_random_uuid();
  v_sess1 uuid := gen_random_uuid();
  v_sess2 uuid := gen_random_uuid();
  v_ord1 jsonb;
  v_ord2 jsonb;
  v_ord1_r2 jsonb;
  v_check1 uuid;
  v_check2 uuid;
  v_kot1 integer;
  v_kot2 integer;
  v_kot1_r2 integer;
  v_settle1 jsonb;
  v_settle2 jsonb;
  v_chk1_rec record;
  v_chk2_rec record;
  v_sess1_rec record;
  v_sess2_rec record;
  v_pos_ord jsonb;
begin
  insert into public.tenants (id, name, slug, currency, currency_symbol, tax_rate, service_charge, active, onboarding_done)
  values (v_tenant, 'Test Multi-Session Cafe', 'test-multi-session-' || substr(v_tenant::text, 1, 8), 'INR', '₹', 5.0, 0.0, true, true);

  insert into public.tables (id, tenant_id, name, seats, area, qr_token, active)
  values (v_table, v_tenant, 'Table 99', 4, 'Main Hall', encode(gen_random_bytes(16), 'hex'), true);

  insert into public.categories (id, tenant_id, name)
  values (v_cat, v_tenant, 'Main Course');

  insert into public.menu_items (id, tenant_id, category_id, name, price, available)
  values 
    (v_item_a, v_tenant, v_cat, 'Artisan Sourdough', 150.00, true),
    (v_item_b, v_tenant, v_cat, 'Cold Brew Coffee', 200.00, true);

  insert into public.table_sessions (id, tenant_id, table_id, status, activation_status, token, activated_at)
  values 
    (v_sess1, v_tenant, v_table, 'ACTIVE', 'ACTIVE', encode(gen_random_bytes(24), 'hex'), now()),
    (v_sess2, v_tenant, v_table, 'ACTIVE', 'ACTIVE', encode(gen_random_bytes(24), 'hex'), now());

  v_results := v_results || jsonb_build_object(
    'test', '1. Two Simultaneous Active Sessions on Same Table',
    'passed', true,
    'detail', 'Session 1: ' || v_sess1::text || ', Session 2: ' || v_sess2::text
  );

  v_ord1 := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'table_id', v_table,
      'table_session_id', v_sess1,
      'order_type', 'DINE_IN',
      'items_total', 150.00,
      'discount', 0,
      'tax', 7.50,
      'service_charge', 0,
      'total', 157.50
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_a, 'name', 'Artisan Sourdough', 'price', 150.00, 'quantity', 1)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );
  v_check1 := (v_ord1->>'check_id')::uuid;

  v_results := v_results || jsonb_build_object(
    'test', '2. Session 1 Order 1 Check Allocation',
    'passed', v_check1 is not null,
    'detail', 'Check 1: ' || coalesce(v_check1::text, 'null')
  );

  v_ord2 := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'table_id', v_table,
      'table_session_id', v_sess2,
      'order_type', 'DINE_IN',
      'items_total', 200.00,
      'discount', 0,
      'tax', 10.00,
      'service_charge', 0,
      'total', 210.00
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_b, 'name', 'Cold Brew Coffee', 'price', 200.00, 'quantity', 1)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );
  v_check2 := (v_ord2->>'check_id')::uuid;

  v_results := v_results || jsonb_build_object(
    'test', '3. Session 2 Order 2 Check Allocation',
    'passed', v_check2 is not null,
    'detail', 'Check 2: ' || coalesce(v_check2::text, 'null')
  );

  v_results := v_results || jsonb_build_object(
    'test', '4. Independent Checks on Same Physical Table',
    'passed', v_check1 <> v_check2,
    'detail', 'Check 1 (' || v_check1::text || ') <> Check 2 (' || v_check2::text || ')'
  );

  select kot_number into v_kot1 from public.order_items where order_id = (v_ord1->>'order_id')::uuid limit 1;
  select kot_number into v_kot2 from public.order_items where order_id = (v_ord2->>'order_id')::uuid limit 1;

  v_results := v_results || jsonb_build_object(
    'test', '5. Session 1 Initial KOT #1',
    'passed', v_kot1 = 1,
    'detail', 'KOT: ' || v_kot1
  );

  v_results := v_results || jsonb_build_object(
    'test', '6. Session 2 Initial KOT #1 (Independent Scoping)',
    'passed', v_kot2 = 1,
    'detail', 'KOT: ' || v_kot2
  );

  v_ord1_r2 := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'table_id', v_table,
      'table_session_id', v_sess1,
      'order_type', 'DINE_IN',
      'items_total', 200.00,
      'discount', 0,
      'tax', 10.00,
      'service_charge', 0,
      'total', 210.00
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_b, 'name', 'Cold Brew Coffee', 'price', 200.00, 'quantity', 1)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );

  select kot_number into v_kot1_r2 from public.order_items where order_id = (v_ord1_r2->>'order_id')::uuid limit 1;

  v_results := v_results || jsonb_build_object(
    'test', '7. Session 1 Round 2 Attached to Check 1 with Sequential KOT #2',
    'passed', (v_ord1_r2->>'check_id')::uuid = v_check1 and v_kot1_r2 = 2,
    'detail', 'Check: ' || (v_ord1_r2->>'check_id') || ', KOT: ' || v_kot1_r2
  );

  update public.orders set status = 'COMPLETED'
   where id in ((v_ord1->>'order_id')::uuid, (v_ord2->>'order_id')::uuid, (v_ord1_r2->>'order_id')::uuid);

  v_settle1 := public.settle_check_cash_tx(
    v_tenant,
    v_check1,
    null,
    'settle-sess1-' || substr(gen_random_uuid()::text, 1, 8),
    'Session 1 Settlement'
  );

  select * into v_chk1_rec from public.table_checks where id = v_check1;
  select * into v_sess1_rec from public.table_sessions where id = v_sess1;

  v_results := v_results || jsonb_build_object(
    'test', '8. Session 1 Settle Check 1 (PAID & Invoiced)',
    'passed', v_chk1_rec.status = 'PAID' and v_chk1_rec.invoice_number is not null,
    'detail', 'Invoice: ' || coalesce(v_chk1_rec.invoice_number, 'none')
  );

  v_results := v_results || jsonb_build_object(
    'test', '9. Session 1 Transitions to ENDED on Settlement',
    'passed', v_sess1_rec.status = 'ENDED',
    'detail', 'Session 1 Status: ' || v_sess1_rec.status
  );

  select * into v_chk2_rec from public.table_checks where id = v_check2;
  select * into v_sess2_rec from public.table_sessions where id = v_sess2;

  v_results := v_results || jsonb_build_object(
    'test', '10. Session 2 Check 2 Remains OPEN (Independent Bill Protection)',
    'passed', v_chk2_rec.status = 'OPEN' and v_chk2_rec.invoice_number is null,
    'detail', 'Check 2 Status: ' || v_chk2_rec.status || ', Invoice: ' || coalesce(v_chk2_rec.invoice_number, 'none')
  );

  v_results := v_results || jsonb_build_object(
    'test', '11. Session 2 Remains ACTIVE on Table 99',
    'passed', v_sess2_rec.status = 'ACTIVE',
    'detail', 'Session 2 Status: ' || v_sess2_rec.status
  );

  v_settle2 := public.settle_check_cash_tx(
    v_tenant,
    v_check2,
    null,
    'settle-sess2-' || substr(gen_random_uuid()::text, 1, 8),
    'Session 2 Settlement'
  );

  select * into v_chk2_rec from public.table_checks where id = v_check2;
  select * into v_sess2_rec from public.table_sessions where id = v_sess2;

  v_results := v_results || jsonb_build_object(
    'test', '12. Session 2 Settle Check 2 (PAID & Invoiced)',
    'passed', v_chk2_rec.status = 'PAID' and v_chk2_rec.invoice_number is not null,
    'detail', 'Invoice: ' || coalesce(v_chk2_rec.invoice_number, 'none')
  );

  v_results := v_results || jsonb_build_object(
    'test', '13. Independent Invoices Allocated Between Sessions',
    'passed', v_chk1_rec.invoice_number <> v_chk2_rec.invoice_number,
    'detail', 'Invoice 1: ' || v_chk1_rec.invoice_number || ', Invoice 2: ' || v_chk2_rec.invoice_number
  );

  v_results := v_results || jsonb_build_object(
    'test', '14. Session 2 Transitions to ENDED on Settlement',
    'passed', v_sess2_rec.status = 'ENDED',
    'detail', 'Session 2 Status: ' || v_sess2_rec.status
  );

  v_pos_ord := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'table_id', v_table,
      'table_session_id', null,
      'order_type', 'DINE_IN',
      'items_total', 150.00,
      'discount', 0,
      'tax', 7.50,
      'service_charge', 0,
      'total', 157.50
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_a, 'name', 'Artisan Sourdough', 'price', 150.00, 'quantity', 1)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );

  v_results := v_results || jsonb_build_object(
    'test', '15. POS Order Without Session Allocates New Active Session & Check',
    'passed', v_pos_ord->>'check_id' is not null and v_pos_ord->>'table_session_id' is not null,
    'detail', 'Check: ' || (v_pos_ord->>'check_id') || ', Session: ' || (v_pos_ord->>'table_session_id')
  );

  begin
    insert into public.table_checks (tenant_id, table_id, session_id, anchor_session_id, status)
    values (v_tenant, v_table, (v_pos_ord->>'table_session_id')::uuid, (v_pos_ord->>'table_session_id')::uuid, 'OPEN');
    v_results := v_results || jsonb_build_object(
      'test', '16. Active Check Per Session Constraint',
      'passed', false,
      'detail', 'Failed: Duplicate active check allowed for same session'
    );
  exception
    when unique_violation then
      v_results := v_results || jsonb_build_object(
        'test', '16. Active Check Per Session Constraint Enforced',
        'passed', true,
        'detail', 'Passed: Unique constraint prevented duplicate active check on same session'
      );
  end;

  -- Clean up test fixtures using explicit transaction-scoped purge flag
  perform set_config('app.purging_tenant', 'true', true);
  delete from public.check_payments where tenant_id = v_tenant;
  delete from public.order_items where order_id in (select id from public.orders where tenant_id = v_tenant);
  delete from public.orders where tenant_id = v_tenant;
  delete from public.table_checks where tenant_id = v_tenant;
  delete from public.table_sessions where tenant_id = v_tenant;
  delete from public.menu_items where tenant_id = v_tenant;
  delete from public.categories where tenant_id = v_tenant;
  delete from public.tables where tenant_id = v_tenant;
  delete from public.tenants where id = v_tenant;

  return v_results;
end;
$$;

revoke all on function public.test_independent_diner_billing() from public, anon, authenticated;
grant execute on function public.test_independent_diner_billing() to service_role;

-- 5. Fix test_takeaway_delivery_independent_sessions() teardown to use app.purging_tenant
create or replace function public.test_takeaway_delivery_independent_sessions() returns jsonb
    language plpgsql security definer
    set search_path to 'public', 'extensions', 'pg_temp'
    as $$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_tenant uuid := gen_random_uuid();
  v_cat uuid := gen_random_uuid();
  v_item_a uuid := gen_random_uuid();
  v_item_b uuid := gen_random_uuid();
  v_ord_t1 jsonb;
  v_ord_d1 jsonb;
  v_ord_t2 jsonb;
  v_order_t1_id uuid;
  v_order_d1_id uuid;
  v_order_t2_id uuid;
  v_session_t1 uuid;
  v_check_t1 uuid;
  v_kot_t1 int;
  v_session_d1 uuid;
  v_check_d1 uuid;
  v_kot_d1 int;
  v_session_t2 uuid;
  v_check_t2 uuid;
  v_kot_t2 int;
  v_check_rec record;
  v_session_rec record;
  v_add_items_res jsonb;
  v_settle_res jsonb;
  v_err text;
  v_unsettled_count int;
BEGIN
  INSERT INTO public.tenants (id, name, slug, currency, currency_symbol, tax_rate, service_charge, active, onboarding_done)
  VALUES (v_tenant, 'Test Takeaway Cafe', 'test-takeaway-' || substr(v_tenant::text, 1, 8), 'INR', '₹', 5.0, 0.0, true, true);

  INSERT INTO public.categories (id, tenant_id, name)
  VALUES (v_cat, v_tenant, 'Main Course');

  INSERT INTO public.menu_items (id, tenant_id, category_id, name, price, available)
  VALUES
    (v_item_a, v_tenant, v_cat, 'Test Takeaway Burger', 150.00, true),
    (v_item_b, v_tenant, v_cat, 'Test Delivery Pizza', 250.00, true);

  v_ord_t1 := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'order_type', 'TAKEAWAY',
      'customer_name', 'Aarav Patel',
      'customer_phone', '9876543210',
      'items_total', 300.00,
      'discount', 0,
      'tax', 15.00,
      'service_charge', 0,
      'total', 315.00
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_a, 'name', 'Test Takeaway Burger', 'quantity', 2, 'price', 150.00)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );

  v_order_t1_id := (v_ord_t1->>'order_id')::uuid;
  v_session_t1 := (v_ord_t1->>'table_session_id')::uuid;
  v_check_t1 := (v_ord_t1->>'check_id')::uuid;
  SELECT kot_number INTO v_kot_t1 FROM public.order_items WHERE order_id = v_order_t1_id LIMIT 1;

  v_results := v_results || jsonb_build_object(
    'test', '1. Takeaway Order 1 atomically creates independent session & check',
    'passed', (v_session_t1 IS NOT NULL AND v_check_t1 IS NOT NULL),
    'detail', 'Session: ' || coalesce(v_session_t1::text, 'null') || ', Check: ' || coalesce(v_check_t1::text, 'null')
  );

  v_results := v_results || jsonb_build_object(
    'test', '2. Takeaway Order 1 allocates KOT #1',
    'passed', (v_kot_t1 = 1),
    'detail', 'KOT: ' || coalesce(v_kot_t1::text, 'null')
  );

  SELECT * INTO v_session_rec FROM public.table_sessions WHERE id = v_session_t1;
  SELECT * INTO v_check_rec FROM public.table_checks WHERE id = v_check_t1;

  v_results := v_results || jsonb_build_object(
    'test', '3. Takeaway session & check have table_id IS NULL and order_type = TAKEAWAY',
    'passed', (v_session_rec.table_id IS NULL AND v_session_rec.order_type = 'TAKEAWAY' AND
               v_check_rec.table_id IS NULL AND v_check_rec.order_type = 'TAKEAWAY' AND
               v_session_rec.customer_name = 'Aarav Patel'),
    'detail', 'Session type: ' || coalesce(v_session_rec.order_type, 'null') || ', Check type: ' || coalesce(v_check_rec.order_type, 'null')
  );

  v_ord_d1 := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'order_type', 'DELIVERY',
      'customer_name', 'Sneha Roy',
      'customer_phone', '9123456780',
      'items_total', 250.00,
      'discount', 0,
      'tax', 12.50,
      'service_charge', 0,
      'total', 262.50
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_b, 'name', 'Test Delivery Pizza', 'quantity', 1, 'price', 250.00)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );

  v_order_d1_id := (v_ord_d1->>'order_id')::uuid;
  v_session_d1 := (v_ord_d1->>'table_session_id')::uuid;
  v_check_d1 := (v_ord_d1->>'check_id')::uuid;
  SELECT kot_number INTO v_kot_d1 FROM public.order_items WHERE order_id = v_order_d1_id LIMIT 1;

  v_results := v_results || jsonb_build_object(
    'test', '4. Delivery Order 1 creates distinct independent session & check',
    'passed', (v_session_d1 IS NOT NULL AND v_session_d1 <> v_session_t1 AND v_check_d1 <> v_check_t1),
    'detail', 'Delivery Session: ' || coalesce(v_session_d1::text, 'null') || ', Delivery Check: ' || coalesce(v_check_d1::text, 'null')
  );

  v_results := v_results || jsonb_build_object(
    'test', '5. Delivery Order 1 allocates independent KOT #1',
    'passed', (v_kot_d1 = 1),
    'detail', 'KOT: ' || coalesce(v_kot_d1::text, 'null')
  );

  v_ord_t2 := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant,
      'order_type', 'TAKEAWAY',
      'table_session_id', v_session_t1,
      'items_total', 150.00,
      'discount', 0,
      'tax', 7.50,
      'service_charge', 0,
      'total', 157.50
    ),
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_a, 'name', 'Test Takeaway Burger', 'quantity', 1, 'price', 150.00)
    ),
    null,
    gen_random_uuid()::text,
    'PENDING'
  );

  v_order_t2_id := (v_ord_t2->>'order_id')::uuid;
  v_session_t2 := (v_ord_t2->>'table_session_id')::uuid;
  v_check_t2 := (v_ord_t2->>'check_id')::uuid;
  SELECT kot_number INTO v_kot_t2 FROM public.order_items WHERE order_id = v_order_t2_id LIMIT 1;

  v_results := v_results || jsonb_build_object(
    'test', '6. Takeaway Order 2 joins existing Session T1 and Check T1',
    'passed', (v_session_t2 = v_session_t1 AND v_check_t2 = v_check_t1),
    'detail', 'Order 2 Check: ' || coalesce(v_check_t2::text, 'null') || ' matches Check T1: ' || coalesce(v_check_t1::text, 'null')
  );

  v_results := v_results || jsonb_build_object(
    'test', '7. Takeaway Order 2 receives sequential KOT #2 on Check T1',
    'passed', (v_kot_t2 = 2),
    'detail', 'KOT: ' || coalesce(v_kot_t2::text, 'null')
  );

  SELECT * INTO v_check_rec FROM public.table_checks WHERE id = v_check_t1;
  v_results := v_results || jsonb_build_object(
    'test', '8. Check T1 consolidates totals across Order 1 and Order 2',
    'passed', (v_check_rec.subtotal = 450.00 AND v_check_rec.total = 472.50),
    'detail', 'Check T1 Subtotal: ' || coalesce(v_check_rec.subtotal::text, '0') || ', Total: ' || coalesce(v_check_rec.total::text, '0')
  );

  v_add_items_res := public.add_items_to_order_tx(
    v_order_t1_id,
    v_tenant,
    jsonb_build_array(
      jsonb_build_object('menu_item_id', v_item_b, 'name', 'Test Delivery Pizza', 'quantity', 1, 'price', 250.00)
    ),
    gen_random_uuid()
  );

  SELECT * INTO v_check_rec FROM public.table_checks WHERE id = v_check_t1;
  v_results := v_results || jsonb_build_object(
    'test', '9. add_items_to_order_tx assigns KOT #3 and updates Check T1 totals',
    'passed', ((v_add_items_res->>'kot_number')::int = 3 AND v_check_rec.subtotal = 700.00),
    'detail', 'KOT: ' || (v_add_items_res->>'kot_number') || ', Check Subtotal: ' || coalesce(v_check_rec.subtotal::text, '0')
  );

  UPDATE public.orders SET status = 'SERVED' WHERE check_id = v_check_t1;

  v_settle_res := public.settle_check_cash_tx(
    v_tenant,
    v_check_t1,
    null,
    'settle-tw-' || substr(gen_random_uuid()::text, 1, 8),
    'Takeaway 1 Cash Settlement'
  );

  SELECT * INTO v_check_rec FROM public.table_checks WHERE id = v_check_t1;
  SELECT * INTO v_session_rec FROM public.table_sessions WHERE id = v_session_t1;

  v_results := v_results || jsonb_build_object(
    'test', '10. Settling Check T1 transitions Check to PAID and Session to ENDED',
    'passed', (v_check_rec.status = 'PAID' AND v_check_rec.invoice_number IS NOT NULL AND v_session_rec.status = 'ENDED'),
    'detail', 'Check Status: ' || coalesce(v_check_rec.status, 'null') || ', Session Status: ' || coalesce(v_session_rec.status, 'null') || ', Invoice: ' || coalesce(v_check_rec.invoice_number, 'none')
  );

  SELECT count(*) INTO v_unsettled_count FROM public.orders WHERE table_session_id = v_session_t1 AND (status <> 'COMPLETED' OR payment_status <> 'PAID');
  v_results := v_results || jsonb_build_object(
    'test', '11. All orders under settled Takeaway session are COMPLETED & PAID',
    'passed', (v_unsettled_count = 0),
    'detail', 'Unsettled orders count: ' || v_unsettled_count::text
  );

  SELECT * INTO v_check_rec FROM public.table_checks WHERE id = v_check_d1;
  SELECT * INTO v_session_rec FROM public.table_sessions WHERE id = v_session_d1;

  v_results := v_results || jsonb_build_object(
    'test', '12. Delivery Session D1 & Check D1 remain untouched and ACTIVE/OPEN',
    'passed', (v_check_rec.status = 'OPEN' AND v_session_rec.status = 'ACTIVE'),
    'detail', 'Delivery Check Status: ' || coalesce(v_check_rec.status, 'null') || ', Session Status: ' || coalesce(v_session_rec.status, 'null')
  );

  BEGIN
    v_ord_t2 := public.create_order_tx(
      jsonb_build_object(
        'tenant_id', v_tenant,
        'order_type', 'TAKEAWAY',
        'table_session_id', v_session_t1,
        'items_total', 150.00,
        'discount', 0,
        'tax', 7.50,
        'service_charge', 0,
        'total', 157.50
      ),
      jsonb_build_array(
        jsonb_build_object('menu_item_id', v_item_a, 'name', 'Test Takeaway Burger', 'quantity', 1, 'price', 150.00)
      ),
      null,
      gen_random_uuid()::text,
      'PENDING'
    );
    v_err := 'DID_NOT_THROW';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;

  v_results := v_results || jsonb_build_object(
    'test', '13. Attempting to join ENDED Takeaway session is rejected',
    'passed', (v_err LIKE '%SESSION_INVALID_OR_ENDED%'),
    'detail', 'Error returned: ' || coalesce(v_err, 'none')
  );

  UPDATE public.orders SET status = 'SERVED' WHERE check_id = v_check_d1;
  v_settle_res := public.settle_check_cash_tx(
    v_tenant,
    v_check_d1,
    null,
    'settle-del-' || substr(gen_random_uuid()::text, 1, 8),
    'Delivery 1 Cash Settlement'
  );
  SELECT * INTO v_check_rec FROM public.table_checks WHERE id = v_check_d1;

  v_results := v_results || jsonb_build_object(
    'test', '14. Delivery Check D1 settles with its own independent invoice number',
    'passed', (v_check_rec.status = 'PAID' AND v_check_rec.invoice_number IS NOT NULL),
    'detail', 'Delivery Invoice: ' || coalesce(v_check_rec.invoice_number, 'none')
  );

  -- Clean up fixtures using explicit transaction-scoped purge flag
  PERFORM set_config('app.purging_tenant', 'true', true);
  DELETE FROM public.check_payments WHERE tenant_id = v_tenant;
  DELETE FROM public.order_items WHERE order_id IN (SELECT id FROM public.orders WHERE tenant_id = v_tenant);
  DELETE FROM public.orders WHERE tenant_id = v_tenant;
  DELETE FROM public.table_checks WHERE tenant_id = v_tenant;
  DELETE FROM public.table_sessions WHERE tenant_id = v_tenant;
  DELETE FROM public.menu_items WHERE tenant_id = v_tenant;
  DELETE FROM public.categories WHERE tenant_id = v_tenant;
  DELETE FROM public.tenants WHERE id = v_tenant;

  RETURN v_results;
END;
$$;

revoke all on function public.test_takeaway_delivery_independent_sessions() from public, anon, authenticated;
grant execute on function public.test_takeaway_delivery_independent_sessions() to service_role;
