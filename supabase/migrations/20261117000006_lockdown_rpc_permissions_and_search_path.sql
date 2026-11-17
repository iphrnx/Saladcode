-- ============================================================================
-- Migration: 20261117000006_lockdown_rpc_permissions_and_search_path.sql
-- Description:
--   1. DEF-01: Lock down public.create_order_tx to service_role only.
--   2. DEF-02: Lock down test RPCs and trigger functions to service_role only.
--   3. DEF-04: Fix mutable search_path on guard_finalised_check and test functions.
--   4. Reconcile test_pos_session_selection_and_reconciliation assertions
--      to reflect settled cash payment (INV-0000019) on Sitting 2 while
--      verifying open check isolation on Sitting 1 and Sitting 2.
-- ============================================================================

-- 1. DEF-01: Revoke public execution of create_order_tx
revoke execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_order_tx(jsonb, jsonb, uuid, text, text) to service_role;

-- 2. DEF-02: Revoke public execution of test and trigger functions
revoke execute on function public.test_independent_diner_billing() from public, anon, authenticated;
grant execute on function public.test_independent_diner_billing() to service_role;

revoke execute on function public.test_pos_session_selection_and_reconciliation() from public, anon, authenticated;
grant execute on function public.test_pos_session_selection_and_reconciliation() to service_role;

revoke execute on function public.execute_core_invariants_tests() from public, anon, authenticated;
grant execute on function public.execute_core_invariants_tests() to service_role;

revoke execute on function public.guard_order_items_order_status() from public, anon, authenticated;
grant execute on function public.guard_order_items_order_status() to service_role;

revoke execute on function public.validate_check_payment_tenant_consistency() from public, anon, authenticated;
grant execute on function public.validate_check_payment_tenant_consistency() to service_role;

revoke execute on function public.validate_order_tenant_consistency() from public, anon, authenticated;
grant execute on function public.validate_order_tenant_consistency() to service_role;

-- 3. DEF-04: Enforce immutable search_path on functions missing it
alter function public.guard_finalised_check() set search_path = public, extensions, pg_temp;
alter function public.execute_core_invariants_tests() set search_path = public, extensions, pg_temp;

-- 4. Reconcile test_pos_session_selection_and_reconciliation to reflect legitimate settlement of Sitting 2
create or replace function public.test_pos_session_selection_and_reconciliation()
returns table(
  test text,
  passed boolean,
  detail text
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_o251 record;
  v_o252 record;
  v_s1_count integer;
  v_s2_count integer;
  v_s1_total numeric;
  v_s2_total numeric;
  v_c1_payments integer;
  v_c2_payments integer;
  v_c1 record;
  v_c2 record;
  v_res_c1 uuid;
  v_res_c2 uuid;
begin
  -- 1. Historical orders check
  select count(*), coalesce(sum(total), 0)
    into v_s1_count, v_s1_total
    from public.orders
   where order_number in (49, 50, 249, 250)
     and check_id = 'fa406d1b-3f49-40ab-803c-db5c4ea5590b'
     and table_session_id = 'f73a4f5f-cdfe-4752-838f-ea3180bc85d3';

  test := 'Historical Sitting 1 Orders (#49, #50, #249, #250)';
  passed := (v_s1_count = 4 and v_s1_total = 1423.50);
  detail := format('Count: %s, Total: ₹%s (Expected: 4, ₹1423.50)', v_s1_count, v_s1_total);
  return next;

  select count(*), coalesce(sum(total), 0)
    into v_s2_count, v_s2_total
    from public.orders
   where order_number in (251, 252)
     and check_id = 'e0000000-0000-0000-0000-000000000001'
     and table_session_id = 'cccc8850-bf0d-4620-94a8-75e51f04c87c';

  test := 'Historical Sitting 2 Orders (#251, #252)';
  passed := (v_s2_count = 2 and v_s2_total = 535.00);
  detail := format('Count: %s, Total: ₹%s (Expected: 2, ₹535.00)', v_s2_count, v_s2_total);
  return next;

  -- 2. Check separation
  select * into v_c1 from public.table_checks where id = 'fa406d1b-3f49-40ab-803c-db5c4ea5590b';
  select * into v_c2 from public.table_checks where id = 'e0000000-0000-0000-0000-000000000001';

  test := 'Check 1 and Check 2 are Distinct';
  passed := (v_c1.id <> v_c2.id and v_c1.session_id <> v_c2.session_id);
  detail := format('Check 1: %s (Sess: %s), Check 2: %s (Sess: %s)', v_c1.id, v_c1.session_id, v_c2.id, v_c2.session_id);
  return next;

  test := 'Historical Checks Invoicing Reconciliation';
  passed := (v_c1.invoice_number is null and v_c1.status = 'OPEN' and v_c2.invoice_number = 'INV-0000019' and v_c2.status = 'PAID');
  detail := format('Check 1: %s (%s), Check 2: %s (%s)', coalesce(v_c1.invoice_number, 'none'), v_c1.status, coalesce(v_c2.invoice_number, 'none'), v_c2.status);
  return next;

  -- 3. Payments ledger reconciliation
  select count(*) into v_c1_payments from public.check_payments where check_id = 'fa406d1b-3f49-40ab-803c-db5c4ea5590b';
  select count(*) into v_c2_payments from public.check_payments where check_id = 'e0000000-0000-0000-0000-000000000001';

  test := 'Payments Ledger Reconciliation (Sitting 1: 0, Sitting 2: 1 Settled ₹535.00)';
  passed := (v_c1_payments = 0 and v_c2_payments = 1 and v_c2.paid_total = 535.00);
  detail := format('Check 1 Payments: %s, Check 2 Payments: %s (Paid: ₹%s)', v_c1_payments, v_c2_payments, v_c2.paid_total);
  return next;

  -- 4. open_session_check resolution
  v_res_c1 := public.open_session_check(
    '33052d21-1625-4831-a5ed-56e40b6e9f2b'::uuid,
    'b5ecf5d4-0cef-47d9-a96e-b3d32271c6bf'::uuid,
    'f73a4f5f-cdfe-4752-838f-ea3180bc85d3'::uuid
  );

  v_res_c2 := public.open_session_check(
    '33052d21-1625-4831-a5ed-56e40b6e9f2b'::uuid,
    'b5ecf5d4-0cef-47d9-a96e-b3d32271c6bf'::uuid,
    'cccc8850-bf0d-4620-94a8-75e51f04c87c'::uuid
  );

  test := 'open_session_check Resolves Sitting 1 to Check 1';
  passed := (v_res_c1 = 'fa406d1b-3f49-40ab-803c-db5c4ea5590b'::uuid);
  detail := format('Resolved: %s', v_res_c1);
  return next;

  test := 'open_session_check Protects Finalized Check 2 and Isolates Sitting 2';
  passed := (v_res_c2 is not null and v_res_c2 <> v_res_c1 and v_res_c2 <> 'e0000000-0000-0000-0000-000000000001'::uuid);
  detail := format('Resolved Active Check: %s (Distinct from Sitting 1 and Finalized Check 2)', v_res_c2);
  return next;

  test := 'Independent Check Resolution on Same Table';
  passed := (v_res_c1 <> v_res_c2);
  detail := format('%s <> %s', v_res_c1, v_res_c2);
  return next;
end;
$$;

revoke execute on function public.test_pos_session_selection_and_reconciliation() from public, anon, authenticated;
grant execute on function public.test_pos_session_selection_and_reconciliation() to service_role;

