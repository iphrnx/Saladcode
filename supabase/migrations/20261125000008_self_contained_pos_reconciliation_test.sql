-- ============================================================================
-- Migration: 20261125000008_self_contained_pos_reconciliation_test.sql
-- Purpose:
--   Replace test_pos_session_selection_and_reconciliation() with a completely
--   self-contained regression test using isolated temporary fixtures and
--   safe app.purging_tenant = 'true' teardown, removing all dependencies on
--   hardcoded historical tenant/check/session UUIDs.
-- ============================================================================

create or replace function public.test_pos_session_selection_and_reconciliation()
returns table("test" text, "passed" boolean, "detail" text)
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_tenant   uuid := gen_random_uuid();
  v_table    uuid := gen_random_uuid();
  v_cat      uuid := gen_random_uuid();
  v_item_a   uuid := gen_random_uuid();
  v_item_b   uuid := gen_random_uuid();
  v_sess1    uuid := gen_random_uuid();
  v_sess2    uuid := gen_random_uuid();
  v_ord1a    jsonb;
  v_ord1b    jsonb;
  v_ord2a    jsonb;
  v_check1   uuid;
  v_check2   uuid;
  v_s1_count integer;
  v_s2_count integer;
  v_s1_total numeric;
  v_s2_total numeric;
  v_c1_pay   integer;
  v_c2_pay   integer;
  v_c1       record;
  v_c2       record;
  v_res_c1   uuid;
  v_res_c2   uuid;
  v_res_post uuid;
begin
  -- 1. Setup isolated temporary fixtures
  insert into public.tenants (id, name, slug, currency, currency_symbol, tax_rate, service_charge, active, onboarding_done)
  values (v_tenant, 'Test POS Reconciliation', 'test-pos-recon-' || substr(v_tenant::text, 1, 8), 'INR', '₹', 5.0, 0.0, true, true);

  insert into public.tables (id, tenant_id, name, seats, area, qr_token, active)
  values (v_table, v_tenant, 'Table R1', 4, 'Main Hall', encode(gen_random_bytes(16), 'hex'), true);

  insert into public.categories (id, tenant_id, name)
  values (v_cat, v_tenant, 'Bowls');

  insert into public.menu_items (id, tenant_id, category_id, name, price, available)
  values
    (v_item_a, v_tenant, v_cat, 'Grain Bowl', 200.00, true),
    (v_item_b, v_tenant, v_cat, 'Matcha Latte', 150.00, true);

  insert into public.table_sessions (id, tenant_id, table_id, status, activation_status, token, activated_at)
  values
    (v_sess1, v_tenant, v_table, 'ACTIVE', 'ACTIVE', encode(gen_random_bytes(24), 'hex'), now()),
    (v_sess2, v_tenant, v_table, 'ACTIVE', 'ACTIVE', encode(gen_random_bytes(24), 'hex'), now());

  -- 2. Sitting 1 places 2 orders (200 + 150 = 350 subtotal, 367.50 total)
  v_ord1a := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant, 'table_id', v_table, 'table_session_id', v_sess1,
      'order_type', 'DINE_IN', 'items_total', 200.00, 'discount', 0, 'tax', 10.00, 'service_charge', 0, 'total', 210.00
    ),
    jsonb_build_array(jsonb_build_object('menu_item_id', v_item_a, 'name', 'Grain Bowl', 'price', 200.00, 'quantity', 1)),
    null, gen_random_uuid()::text, 'PENDING'
  );
  v_ord1b := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant, 'table_id', v_table, 'table_session_id', v_sess1,
      'order_type', 'DINE_IN', 'items_total', 150.00, 'discount', 0, 'tax', 7.50, 'service_charge', 0, 'total', 157.50
    ),
    jsonb_build_array(jsonb_build_object('menu_item_id', v_item_b, 'name', 'Matcha Latte', 'price', 150.00, 'quantity', 1)),
    null, gen_random_uuid()::text, 'PENDING'
  );
  v_check1 := (v_ord1a->>'check_id')::uuid;

  -- Sitting 2 places 1 order (150 subtotal, 157.50 total)
  v_ord2a := public.create_order_tx(
    jsonb_build_object(
      'tenant_id', v_tenant, 'table_id', v_table, 'table_session_id', v_sess2,
      'order_type', 'DINE_IN', 'items_total', 150.00, 'discount', 0, 'tax', 7.50, 'service_charge', 0, 'total', 157.50
    ),
    jsonb_build_array(jsonb_build_object('menu_item_id', v_item_b, 'name', 'Matcha Latte', 'price', 150.00, 'quantity', 1)),
    null, gen_random_uuid()::text, 'PENDING'
  );
  v_check2 := (v_ord2a->>'check_id')::uuid;

  select count(*), coalesce(sum(total), 0) into v_s1_count, v_s1_total
    from public.orders where check_id = v_check1 and table_session_id = v_sess1;
  test := 'Sitting 1 Orders Consolidated to Check 1';
  passed := (v_s1_count = 2 and v_s1_total = 367.50);
  detail := format('Count: %s, Total: ₹%s (Expected: 2, ₹367.50)', v_s1_count, v_s1_total);
  return next;

  select count(*), coalesce(sum(total), 0) into v_s2_count, v_s2_total
    from public.orders where check_id = v_check2 and table_session_id = v_sess2;
  test := 'Sitting 2 Orders Isolated to Check 2';
  passed := (v_s2_count = 1 and v_s2_total = 157.50);
  detail := format('Count: %s, Total: ₹%s (Expected: 1, ₹157.50)', v_s2_count, v_s2_total);
  return next;

  -- 3. Check separation & open_session_check resolution
  v_res_c1 := public.open_session_check(v_tenant, v_table, v_sess1);
  v_res_c2 := public.open_session_check(v_tenant, v_table, v_sess2);

  test := 'Check 1 and Check 2 are Distinct';
  passed := (v_check1 is not null and v_check2 is not null and v_check1 <> v_check2);
  detail := format('Check 1: %s, Check 2: %s', v_check1, v_check2);
  return next;

  test := 'open_session_check Resolves Sitting 1 to Check 1';
  passed := (v_res_c1 = v_check1);
  detail := format('Resolved: %s', v_res_c1);
  return next;

  test := 'open_session_check Resolves Sitting 2 to Check 2';
  passed := (v_res_c2 = v_check2 and v_res_c1 <> v_res_c2);
  detail := format('Resolved: %s (<> %s)', v_res_c2, v_res_c1);
  return next;

  -- 4. Settle Sitting 2 independently while Sitting 1 remains OPEN
  update public.orders set status = 'COMPLETED' where table_session_id = v_sess2;
  perform public.settle_check_cash_tx(v_tenant, v_check2, null, 'recon-settle-' || substr(gen_random_uuid()::text, 1, 8), 'Sitting 2 Settlement');

  select * into v_c1 from public.table_checks where id = v_check1;
  select * into v_c2 from public.table_checks where id = v_check2;
  select count(*) into v_c1_pay from public.check_payments where check_id = v_check1;
  select count(*) into v_c2_pay from public.check_payments where check_id = v_check2;

  test := 'Checks & Payments Reconciliation After Sitting 2 Settlement';
  passed := (v_c1.status = 'OPEN' and v_c1.invoice_number is null and v_c1_pay = 0
             and v_c2.status = 'PAID' and v_c2.invoice_number is not null and v_c2_pay = 1 and v_c2.paid_total = 157.50);
  detail := format('Check 1: %s (pay=%s), Check 2: %s/%s (pay=%s, paid=₹%s)',
                   v_c1.status, v_c1_pay, v_c2.status, v_c2.invoice_number, v_c2_pay, v_c2.paid_total);
  return next;

  -- 5. Post-settlement open_session_check protects finalized Check 2
  v_res_post := public.open_session_check(v_tenant, v_table, v_sess2);
  test := 'open_session_check Protects Finalized Check 2';
  passed := (v_res_post is not null and v_res_post <> v_check2 and v_res_post <> v_check1);
  detail := format('Post-settlement check: %s (distinct from Check 1 and Finalized Check 2)', v_res_post);
  return next;

  -- 6. Safe teardown using app.purging_tenant = 'true'
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
end;
$$;

revoke all on function public.test_pos_session_selection_and_reconciliation() from public, anon, authenticated;
grant execute on function public.test_pos_session_selection_and_reconciliation() to service_role;
