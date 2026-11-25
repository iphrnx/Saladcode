-- ============================================================================
-- Migration: 20261125000004_security_hardening_and_core_invariants_fix.sql
-- Purpose:
--   1. Restore missing public.prune_rate_limits() from 0080_rate_limits_and_audit.sql.
--   2. Restore missing public.guard_finalised_payment() and its
--      check_payments_finalised_immutable trigger from 0082_invoice_immutability.sql.
--   3. Update execute_core_invariants_tests() fixtures to match current
--      full-payment, idempotency, actor-attribution, and session-lifecycle rules.
-- ============================================================================

-- 1. Restore prune_rate_limits() (0080)
create or replace function public.prune_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.rate_limits where window_start < now() - interval '1 day' returning 1
  )
  select count(*) into v_count from gone;
  return v_count;
end $$;

revoke execute on function public.prune_rate_limits() from public, anon, authenticated;
grant execute on function public.prune_rate_limits() to service_role;

-- 2. Restore guard_finalised_payment() & trigger (0082)
create or replace function public.guard_finalised_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if current_setting('app.purging_tenant', true) = 'true' then
    return coalesce(new, old);
  end if;

  select status into v_status from public.table_checks where id = coalesce(new.check_id, old.check_id);

  if v_status = 'PAID' then
    if tg_op = 'DELETE' then
      raise exception 'INVOICE_IMMUTABLE: a payment on an invoiced bill cannot be deleted'
        using errcode = 'P0001';
    end if;
    if new.amount is distinct from old.amount
       or new.method is distinct from old.method
       or new.check_id is distinct from old.check_id then
      raise exception 'INVOICE_IMMUTABLE: a payment on an invoiced bill cannot be altered'
        using errcode = 'P0001';
    end if;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists check_payments_finalised_immutable on public.check_payments;
create trigger check_payments_finalised_immutable
  before update or delete on public.check_payments
  for each row execute function public.guard_finalised_payment();

revoke execute on function public.guard_finalised_payment() from public, anon, authenticated;
grant execute on function public.guard_finalised_payment() to service_role;

-- 2b. Ensure canonical 4-arg open_session_check(uuid, uuid, uuid, text) exists
--     (replaces legacy 3-arg overload so create_order_tx resolves unambiguously).
drop function if exists public.open_session_check(uuid, uuid, uuid);
create or replace function public.open_session_check(
  p_tenant uuid,
  p_table uuid,
  p_session uuid,
  p_order_type text default 'DINE_IN'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_existing public.table_checks;
  v_id uuid;
begin
  if p_session is null then
    raise exception 'SESSION_REQUIRED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_session::text));

  select * into v_existing
    from public.table_checks
   where tenant_id = p_tenant
     and session_id = p_session
     and status in ('OPEN', 'UNSETTLED')
   order by opened_at desc
   limit 1
   for update;

  if found then
    return v_existing.id;
  end if;

  begin
    insert into public.table_checks (
      tenant_id, table_id, session_id, anchor_session_id, order_type, status, opened_at
    ) values (
      p_tenant, p_table, p_session, p_session, coalesce(p_order_type, 'DINE_IN'), 'OPEN', now()
    )
    returning id into v_id;

    return v_id;
  exception
    when unique_violation then
      select id into v_id
        from public.table_checks
       where tenant_id = p_tenant
         and session_id = p_session
         and status in ('OPEN', 'UNSETTLED')
       order by opened_at desc
       limit 1;
      if v_id is not null then
        return v_id;
      end if;
      raise;
  end;
end;
$$;

revoke execute on function public.open_session_check(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.open_session_check(uuid, uuid, uuid, text) to service_role;

-- 3. Update execute_core_invariants_tests() fixtures to match current behavior
create or replace function public.execute_core_invariants_tests()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_tenant_id uuid;
  v_other_tenant_id uuid;
  v_table_id uuid;
  v_other_table_id uuid;
  v_session_id uuid;
  v_session_2_id uuid;
  v_profile_id uuid;
  v_created_auth_user boolean := false;
  v_category_id uuid;
  v_menu_item_id uuid;
  v_promo_id uuid;
  v_check_id uuid;
  v_order_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_passed int := 0;
  v_failed int := 0;
  v_res jsonb;
  v_row record;
  v_inv_no text;
  v_pay_count int;
begin
  -- 1. Setup isolated fixtures
  insert into public.tenants (id, name, slug)
  values (gen_random_uuid(), 'Test Tenant Regression Suite', 'test-tenant-' || substr(gen_random_uuid()::text, 1, 8))
  returning id into v_tenant_id;

  insert into public.tenants (id, name, slug)
  values (gen_random_uuid(), 'Other Tenant Regression Suite', 'other-tenant-' || substr(gen_random_uuid()::text, 1, 8))
  returning id into v_other_tenant_id;

  insert into public.tables (tenant_id, name, seats, area, qr_token, active)
  values (v_tenant_id, 'Table T1', 4, 'Main Hall', 'qr_' || substr(gen_random_uuid()::text, 1, 16), true)
  returning id into v_table_id;

  insert into public.tables (tenant_id, name, seats, area, qr_token, active)
  values (v_other_tenant_id, 'Other Table O1', 4, 'Patio', 'qr_' || substr(gen_random_uuid()::text, 1, 16), true)
  returning id into v_other_table_id;

  select id into v_profile_id from public.profiles limit 1;
  if v_profile_id is null then
    v_profile_id := gen_random_uuid();
    insert into auth.users (id, email)
    values (v_profile_id, 'invariant-actor-' || substr(v_profile_id::text, 1, 8) || '@example.com');
    insert into public.profiles (id, tenant_id, name, email, role, active)
    values (v_profile_id, v_tenant_id, 'Invariant Actor', 'invariant-actor-' || substr(v_profile_id::text, 1, 8) || '@example.com', 'Owner', true);
    v_created_auth_user := true;
  end if;

  insert into public.staff (tenant_id, name, employee_id, pin_hash, pin_salt, active)
  values (v_tenant_id, 'Test Waiter', 'EMP_TEST_' || substr(gen_random_uuid()::text, 1, 8), 'hash', 'salt', true);

  insert into public.categories (tenant_id, name)
  values (v_tenant_id, 'Test Category')
  returning id into v_category_id;

  insert into public.menu_items (tenant_id, category_id, name, price, available)
  values (v_tenant_id, v_category_id, 'Invariant Salad', 100.00, true)
  returning id into v_menu_item_id;

  insert into public.promo_codes (tenant_id, code, type, value, min_order, max_discount, usage_limit, used_count, valid_from, valid_to, active)
  values (v_tenant_id, 'RACE50', 'PERCENTAGE', 50, 0, 50, 1, 0, now() - interval '1 hour', now() + interval '1 day', true)
  returning id into v_promo_id;

  -- TEST 1: Financial Non-Negative Check Constraint
  begin
    insert into public.orders (tenant_id, items_total, discount, tax, service_charge, total, order_type)
    values (v_tenant_id, 100, 0, 0, 0, -50, 'DINE_IN');
    v_results := v_results || jsonb_build_object('test', '1. Negative Total Rejected', 'passed', false, 'error', 'Allowed negative total');
    v_failed := v_failed + 1;
  exception when check_violation then
    v_results := v_results || jsonb_build_object('test', '1. Negative Total Rejected', 'passed', true);
    v_passed := v_passed + 1;
  end;

  -- TEST 2: Excess Discount Check Constraint
  begin
    insert into public.orders (tenant_id, items_total, discount, tax, service_charge, total, order_type)
    values (v_tenant_id, 100, 150, 0, 0, 0, 'DINE_IN');
    v_results := v_results || jsonb_build_object('test', '2. Excess Discount Rejected', 'passed', false, 'error', 'Allowed discount > items_total');
    v_failed := v_failed + 1;
  exception when check_violation then
    v_results := v_results || jsonb_build_object('test', '2. Excess Discount Rejected', 'passed', true);
    v_passed := v_passed + 1;
  end;

  -- TEST 3: Independent Multi-Diner Session Creation & Activation
  begin
    insert into public.table_sessions (tenant_id, table_id, token, status, activation_status)
    values (v_tenant_id, v_table_id, encode(gen_random_bytes(16), 'hex'), 'ACTIVE', 'PENDING')
    returning id into v_session_id;

    v_res := public.approve_table_activation(v_tenant_id, v_session_id, v_profile_id);
    if (v_res->>'ok')::boolean = true then
      v_results := v_results || jsonb_build_object('test', '3. Multi-Diner Session Activation', 'passed', true);
      v_passed := v_passed + 1;
    else
      v_results := v_results || jsonb_build_object('test', '3. Multi-Diner Session Activation', 'passed', false, 'error', v_res::text);
      v_failed := v_failed + 1;
    end if;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '3. Multi-Diner Session Activation', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 4: Refuse Activation on Already-Active Session Blocked (C3 Fix)
  begin
    perform public.refuse_table_activation(v_tenant_id, v_session_id, 'Late refusal test');
    v_results := v_results || jsonb_build_object('test', '4. Stale Refusal Guard (C3)', 'passed', false, 'error', 'Allowed refusal on active session');
    v_failed := v_failed + 1;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '4. Stale Refusal Guard (C3)', 'passed', true, 'detail', sqlerrm);
    v_passed := v_passed + 1;
  end;

  -- Create order via create_order_tx (items_total=100, total=100)
  v_res := public.create_order_tx(
    jsonb_build_object('tenant_id', v_tenant_id, 'table_id', v_table_id, 'table_session_id', v_session_id, 'items_total', 100, 'tax', 0, 'total', 100),
    jsonb_build_array(jsonb_build_object('menu_item_id', v_menu_item_id, 'name', 'Invariant Salad', 'price', 100, 'quantity', 1)),
    null::uuid,
    '11111111-1111-1111-1111-111111111111',
    'PENDING'::text
  );
  v_order_id := (v_res->>'order_id')::uuid;
  v_check_id := (v_res->>'check_id')::uuid;

  -- TEST 5: Overpayment Rejection
  begin
    perform public.record_check_payment(v_tenant_id, v_check_id, 150.00, 'CASH', 'idemp_over_1', v_profile_id, 'Overpay');
    v_results := v_results || jsonb_build_object('test', '5. Overpayment Rejection', 'passed', false, 'error', 'Allowed overpayment');
    v_failed := v_failed + 1;
  exception when others then
    if sqlerrm like '%OVERPAYMENT%' then
      v_results := v_results || jsonb_build_object('test', '5. Overpayment Rejection', 'passed', true);
      v_passed := v_passed + 1;
    else
      v_results := v_results || jsonb_build_object('test', '5. Overpayment Rejection', 'passed', false, 'error', sqlerrm);
      v_failed := v_failed + 1;
    end if;
  end;

  -- TEST 6: Settlement Blocked With Open Orders (while order is still PENDING)
  begin
    perform public.settle_check_cash_tx(v_tenant_id, v_check_id, v_profile_id, 'idemp_settle_open', 'Attempt settle');
    v_results := v_results || jsonb_build_object('test', '6. Settlement Blocked With Open Orders', 'passed', false, 'error', 'Allowed settlement with PENDING orders');
    v_failed := v_failed + 1;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '6. Settlement Blocked With Open Orders', 'passed', true, 'note', sqlerrm);
    v_passed := v_passed + 1;
  end;

  -- Serve the order so check payments and settlement can proceed
  update public.orders set status = 'SERVED' where id = v_order_id;

  -- TEST 7: Full Payment Enforcement & Recording (Underpayment Rejected, Full Payment Accepted)
  begin
    begin
      perform public.record_check_payment(v_tenant_id, v_check_id, 40.00, 'CASH', 'idemp_under_1', v_profile_id, 'Underpay');
      v_results := v_results || jsonb_build_object('test', '7. Full Payment Enforcement', 'passed', false, 'error', 'Allowed underpayment');
      v_failed := v_failed + 1;
    exception when others then
      if sqlerrm not like '%UNDERPAYMENT%' then
        raise;
      end if;
      v_res := public.record_check_payment(v_tenant_id, v_check_id, 100.00, 'CASH', 'idemp_full_1', v_profile_id, 'Full pay');
      select paid_total into v_row from public.table_checks where id = v_check_id;
      if v_row.paid_total = 100.00 then
        v_results := v_results || jsonb_build_object('test', '7. Full Payment Enforcement', 'passed', true);
        v_passed := v_passed + 1;
      else
        v_results := v_results || jsonb_build_object('test', '7. Full Payment Enforcement', 'passed', false, 'error', 'Unexpected paid_total=' || v_row.paid_total);
        v_failed := v_failed + 1;
      end if;
    end;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '7. Full Payment Enforcement', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 8: Payment Idempotency Replay
  begin
    v_res := public.record_check_payment(v_tenant_id, v_check_id, 100.00, 'CASH', 'idemp_full_1', v_profile_id, 'Full pay replay');
    select paid_total into v_row from public.table_checks where id = v_check_id;
    if v_row.paid_total = 100.00 and ((v_res->>'deduplicated')::boolean = true or (v_res->>'already')::boolean = true) then
      v_results := v_results || jsonb_build_object('test', '8. Payment Idempotency Replay', 'passed', true);
      v_passed := v_passed + 1;
    else
      v_results := v_results || jsonb_build_object('test', '8. Payment Idempotency Replay', 'passed', false, 'error', 'Double counted or not deduplicated: ' || v_res::text);
      v_failed := v_failed + 1;
    end if;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '8. Payment Idempotency Replay', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 9: Actor Attribution Guard
  begin
    select created_by into v_row from public.check_payments where check_id = v_check_id and idempotency_key = 'idemp_full_1';
    if v_row.created_by = v_profile_id then
      v_results := v_results || jsonb_build_object('test', '9. Actor Attribution to Profile', 'passed', true);
      v_passed := v_passed + 1;
    else
      v_results := v_results || jsonb_build_object('test', '9. Actor Attribution to Profile', 'passed', false, 'error', 'created_by did not match v_profile_id');
      v_failed := v_failed + 1;
    end if;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '9. Actor Attribution to Profile', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 10: Cash Settlement & Sequential Invoice Generation
  begin
    v_res := public.settle_check_cash_tx(v_tenant_id, v_check_id, v_profile_id, 'idemp_settle_success', 'Settled');
    select status, invoice_number into v_row from public.table_checks where id = v_check_id;
    if v_row.status = 'PAID' and v_row.invoice_number is not null then
      v_inv_no := v_row.invoice_number;
      v_results := v_results || jsonb_build_object('test', '10. Cash Settlement & Invoice Allocation', 'passed', true, 'invoice', v_inv_no);
      v_passed := v_passed + 1;
    else
      v_results := v_results || jsonb_build_object('test', '10. Cash Settlement & Invoice Allocation', 'passed', false, 'error', 'Check not PAID or missing invoice');
      v_failed := v_failed + 1;
    end if;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '10. Cash Settlement & Invoice Allocation', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 11: Settled Check Idempotency Replay
  begin
    v_res := public.settle_check_cash_tx(v_tenant_id, v_check_id, v_profile_id, 'idemp_settle_success', 'Settled replay');
    if v_res->>'invoiceNumber' = v_inv_no and (v_res->>'already')::boolean = true then
      v_results := v_results || jsonb_build_object('test', '11. Settled Check Idempotency Replay', 'passed', true);
      v_passed := v_passed + 1;
    else
      v_results := v_results || jsonb_build_object('test', '11. Settled Check Idempotency Replay', 'passed', false, 'error', v_res::text);
      v_failed := v_failed + 1;
    end if;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '11. Settled Check Idempotency Replay', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 12: Payment on Settled Check Does Not Double-Charge (Idempotent / Rejected)
  begin
    select count(*) into v_pay_count from public.check_payments where check_id = v_check_id;
    begin
      v_res := public.record_check_payment(v_tenant_id, v_check_id, 100.00, 'CASH', 'test_tx_post_settle', v_profile_id, 'Post settle');
      if (v_res->>'already')::boolean = true and (select count(*) from public.check_payments where check_id = v_check_id) = v_pay_count then
        v_results := v_results || jsonb_build_object('test', '12. Payment on Settled Check Guard', 'passed', true);
        v_passed := v_passed + 1;
      else
        v_results := v_results || jsonb_build_object('test', '12. Payment on Settled Check Guard', 'passed', false, 'error', 'Allowed new payment on settled check');
        v_failed := v_failed + 1;
      end if;
    exception when others then
      v_results := v_results || jsonb_build_object('test', '12. Payment on Settled Check Guard', 'passed', true);
      v_passed := v_passed + 1;
    end;
  end;

  -- Create a fresh active session for Tests 13 & 14 (since Test 10 ended v_session_id)
  insert into public.table_sessions (tenant_id, table_id, token, status, activation_status)
  values (v_tenant_id, v_table_id, encode(gen_random_bytes(16), 'hex'), 'ACTIVE', 'ACTIVE')
  returning id into v_session_2_id;

  -- TEST 13: Order Idempotency Replay (C1 Fix)
  begin
    declare
      v_o1 jsonb;
      v_o2 jsonb;
      v_idemp text := '33333333-3333-3333-3333-333333333333';
    begin
      v_o1 := public.create_order_tx(
        jsonb_build_object('tenant_id', v_tenant_id, 'table_id', v_table_id, 'table_session_id', v_session_2_id, 'items_total', 100, 'tax', 8, 'total', 108),
        jsonb_build_array(jsonb_build_object('menu_item_id', v_menu_item_id, 'name', 'Invariant Salad', 'price', 100, 'quantity', 1)),
        null::uuid,
        v_idemp,
        'PENDING'::text
      );
      v_o2 := public.create_order_tx(
        jsonb_build_object('tenant_id', v_tenant_id, 'table_id', v_table_id, 'table_session_id', v_session_2_id, 'items_total', 100, 'tax', 8, 'total', 108),
        jsonb_build_array(jsonb_build_object('menu_item_id', v_menu_item_id, 'name', 'Invariant Salad', 'price', 100, 'quantity', 1)),
        null::uuid,
        v_idemp,
        'PENDING'::text
      );
      if v_o1->>'order_id' = v_o2->>'order_id' and (v_o2->>'deduplicated')::boolean = true then
        v_results := v_results || jsonb_build_object('test', '13. Order Idempotency Replay (C1)', 'passed', true);
        v_passed := v_passed + 1;
      else
        v_results := v_results || jsonb_build_object('test', '13. Order Idempotency Replay (C1)', 'passed', false, 'error', 'Mismatch or not deduplicated');
        v_failed := v_failed + 1;
      end if;
    end;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '13. Order Idempotency Replay (C1)', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 14: Promo Exhaustion Race (C2 Fix)
  begin
    declare
      v_p_res1 jsonb;
      v_p_res2 jsonb;
    begin
      v_p_res1 := public.create_order_tx(
        jsonb_build_object('tenant_id', v_tenant_id, 'table_id', v_table_id, 'table_session_id', v_session_2_id, 'items_total', 100, 'discount', 50, 'tax', 4, 'total', 54),
        jsonb_build_array(jsonb_build_object('menu_item_id', v_menu_item_id, 'name', 'Invariant Salad', 'price', 100, 'quantity', 1)),
        v_promo_id,
        '44444444-4444-4444-4444-444444444441',
        'PENDING'::text
      );
      begin
        v_p_res2 := public.create_order_tx(
          jsonb_build_object('tenant_id', v_tenant_id, 'table_id', v_table_id, 'table_session_id', v_session_2_id, 'items_total', 100, 'discount', 50, 'tax', 4, 'total', 54),
          jsonb_build_array(jsonb_build_object('menu_item_id', v_menu_item_id, 'name', 'Invariant Salad', 'price', 100, 'quantity', 1)),
          v_promo_id,
          '44444444-4444-4444-4444-444444444442',
          'PENDING'::text
        );
        v_results := v_results || jsonb_build_object('test', '14. Promo Exhaustion Guard (C2)', 'passed', false, 'error', 'Allowed order with exhausted promo');
        v_failed := v_failed + 1;
      exception when others then
        v_results := v_results || jsonb_build_object('test', '14. Promo Exhaustion Guard (C2)', 'passed', true, 'note', sqlerrm);
        v_passed := v_passed + 1;
      end;
    end;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '14. Promo Exhaustion Guard (C2)', 'passed', false, 'error', sqlerrm);
    v_failed := v_failed + 1;
  end;

  -- TEST 15: Adding Items to Terminal Order Rejected (C4)
  begin
    insert into public.order_items (order_id, menu_item_id, name, price, quantity, status)
    values (v_order_id, v_menu_item_id, 'Late Add Item', 50.00, 1, 'PENDING');
    v_results := v_results || jsonb_build_object('test', '15. Add Item to Terminal Order Rejected', 'passed', false, 'error', 'Allowed adding items to SERVED order');
    v_failed := v_failed + 1;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '15. Add Item to Terminal Order Rejected', 'passed', true);
    v_passed := v_passed + 1;
  end;

  -- TEST 16: Cross-Tenant Table Isolation Trigger
  begin
    insert into public.orders (tenant_id, table_id, items_total, total, order_type)
    values (v_tenant_id, v_other_table_id, 100, 100, 'DINE_IN');
    v_results := v_results || jsonb_build_object('test', '16. Cross-Tenant Table Consistency', 'passed', false, 'error', 'Allowed order with other tenant table');
    v_failed := v_failed + 1;
  exception when others then
    v_results := v_results || jsonb_build_object('test', '16. Cross-Tenant Table Consistency', 'passed', true);
    v_passed := v_passed + 1;
  end;

  -- Cleanup isolated fixtures (best-effort if finalised invoice immutability trigger is active)
  begin
    perform set_config('app.purging_tenant', 'true', true);
    delete from public.tenants where id in (v_tenant_id, v_other_tenant_id);
    if v_created_auth_user then
      delete from auth.users where id = v_profile_id;
    end if;
  exception when others then
    null;
  end;

  return jsonb_build_object('passed', v_passed, 'failed', v_failed, 'results', v_results);
end;
$function$;

revoke execute on function public.execute_core_invariants_tests() from public, anon, authenticated;
grant execute on function public.execute_core_invariants_tests() to service_role;
