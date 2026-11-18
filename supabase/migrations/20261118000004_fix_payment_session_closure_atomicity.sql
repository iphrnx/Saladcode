-- Migration: 20261118000004_fix_payment_session_closure_atomicity.sql
-- Goal: Fix Active Sessions card not disappearing after payment.
-- 1. Ensure public.finalize_table_check ends ALL sessions linked to the check (session_id, anchor_session_id, orders.table_session_id)
-- 2. Return endedSessionId and full closure payload from finalize_table_check (including when already PAID)
-- 3. Ensure complete_paid_check_orders updates payment_status='PAID' even for already COMPLETED orders
-- 4. Update settle_check_on_session_end to locate checks via session_id, anchor_session_id, or orders
-- 5. Clean up any abandoned zero-total / all-cancelled sessions.

-- 1. Update public.complete_paid_check_orders
CREATE OR REPLACE FUNCTION public.complete_paid_check_orders(p_tenant uuid, p_check uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count integer;
begin
  with done as (
    update public.orders
       set status = 'COMPLETED',
           payment_status = 'PAID',
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
     where tenant_id = p_tenant
       and check_id = p_check
       and status in ('PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED')
     returning 1
  )
  select count(*) into v_count from done;
  return v_count;
end $function$;

-- 2. Update public.finalize_table_check
CREATE OR REPLACE FUNCTION public.finalize_table_check(p_tenant uuid, p_check uuid, p_actor uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_check public.table_checks;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_paid numeric(12, 2);
  v_completed integer;
  v_profile_actor uuid := null;
  v_staff_actor uuid := null;
  v_target_session uuid := null;
BEGIN
  SELECT * INTO v_check
    FROM public.table_checks
   WHERE id = p_check AND tenant_id = p_tenant
   FOR UPDATE;

  IF NOT found THEN
    RAISE EXCEPTION 'CHECK_NOT_FOUND' USING errcode = 'P0001';
  END IF;

  -- Resolve target session id
  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  IF v_target_session IS NULL THEN
    SELECT table_session_id INTO v_target_session
      FROM public.orders
     WHERE check_id = p_check AND table_session_id IS NOT NULL
     LIMIT 1;
  END IF;

  IF v_check.status = 'PAID' THEN
    -- Ensure all bound sessions are ended even if check was already paid
    UPDATE public.table_sessions
       SET status = 'ENDED',
           ended_at = coalesce(ended_at, now()),
           updated_at = now()
     WHERE id IN (
       SELECT v_check.session_id WHERE v_check.session_id IS NOT NULL
       UNION
       SELECT v_check.anchor_session_id WHERE v_check.anchor_session_id IS NOT NULL
       UNION
       SELECT o.table_session_id FROM public.orders o WHERE o.check_id = p_check AND o.table_session_id IS NOT NULL
     )
     AND tenant_id = p_tenant
     AND status = 'ACTIVE';

    RETURN jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', v_target_session,
      'closedAt', v_check.closed_at
    );
  END IF;

  IF v_check.status NOT IN ('OPEN', 'UNSETTLED') THEN
    RAISE EXCEPTION 'CHECK_%', v_check.status USING errcode = 'P0001';
  END IF;

  SELECT count(*) INTO v_open_orders
    FROM public.orders
   WHERE check_id = p_check
     AND status IN ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  IF v_open_orders > 0 THEN
    RAISE EXCEPTION 'ORDERS_OPEN:%', v_open_orders USING errcode = 'P0001';
  END IF;

  SELECT
    coalesce(sum(items_total), 0) AS subtotal,
    coalesce(sum(discount), 0)    AS discount,
    coalesce(sum(tax), 0)         AS tax,
    coalesce(sum(service_charge), 0) AS service_charge,
    coalesce(sum(total), 0)       AS total
  INTO v_totals
    FROM public.orders
   WHERE check_id = p_check AND status <> 'CANCELLED';

  IF v_totals.total <= 0 THEN
    RAISE EXCEPTION 'NOTHING_TO_BILL' USING errcode = 'P0001';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_paid
    FROM public.check_payments
   WHERE check_id = p_check AND status = 'SUCCEEDED';

  IF v_paid + 0.005 < v_totals.total THEN
    RAISE EXCEPTION 'UNPAID:%', round((v_totals.total - v_paid)::numeric, 2)::text USING errcode = 'P0001';
  END IF;

  INSERT INTO public.check_invoice_counters (tenant_id)
  VALUES (p_tenant)
  ON CONFLICT (tenant_id) DO NOTHING;

  UPDATE public.check_invoice_counters
     SET last_seq = last_seq + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant
  RETURNING last_seq INTO v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  UPDATE public.table_checks
     SET status = 'PAID',
         closed_at = now(),
         unsettled_at = null,
         invoice_number = v_invoice,
         invoice_date = now(),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_paid,
         session_id = coalesce(session_id, v_target_session),
         anchor_session_id = coalesce(anchor_session_id, v_target_session),
         version = version + 1,
         updated_at = now()
   WHERE id = p_check;

  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- End ALL sessions bound to this check (main session, anchor session, and order sessions)
  UPDATE public.table_sessions
     SET status = 'ENDED',
         ended_at = coalesce(ended_at, now()),
         updated_at = now()
   WHERE id IN (
     SELECT v_check.session_id WHERE v_check.session_id IS NOT NULL
     UNION
     SELECT v_check.anchor_session_id WHERE v_check.anchor_session_id IS NOT NULL
     UNION
     SELECT o.table_session_id FROM public.orders o WHERE o.check_id = p_check AND o.table_session_id IS NOT NULL
     UNION
     SELECT v_target_session WHERE v_target_session IS NOT NULL
   )
   AND tenant_id = p_tenant
   AND status = 'ACTIVE';

  IF p_actor IS NOT NULL THEN
    SELECT id INTO v_profile_actor FROM public.profiles WHERE id = p_actor;
    IF v_profile_actor IS NULL THEN
      SELECT id INTO v_staff_actor FROM public.staff WHERE id = p_actor AND tenant_id = p_tenant;
    END IF;
  END IF;

  INSERT INTO public.security_logs (
    tenant_id,
    user_id,
    actor_staff_id,
    action,
    meta
  ) VALUES (
    p_tenant,
    v_profile_actor,
    v_staff_actor,
    'CHECK_FINALISED',
    'Check ' || p_check || ' finalized: ' || v_invoice || ' (₹' || v_totals.total || ')'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_paid,
    'outstanding', 0,
    'completedOrders', v_completed,
    'endedSessionId', v_target_session,
    'closedAt', now()
  );
END $function$;

-- 3. Update public.settle_check_on_session_end
CREATE OR REPLACE FUNCTION public.settle_check_on_session_end(p_tenant uuid, p_table uuid, p_actor uuid DEFAULT NULL::uuid, p_session uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  v_check public.table_checks;
  v_open_orders integer;
  v_paid numeric(12, 2);
  v_total numeric(12, 2);
begin
  if p_session is not null then
    select * into v_check
      from public.table_checks
     where tenant_id = p_tenant
       and (
         session_id = p_session
         or anchor_session_id = p_session
         or id in (select check_id from public.orders where table_session_id = p_session and check_id is not null)
       )
       and status in ('OPEN', 'UNSETTLED')
     order by opened_at desc
     limit 1
     for update;
  elsif p_table is not null then
    select * into v_check
      from public.table_checks
     where tenant_id = p_tenant and table_id = p_table and status in ('OPEN', 'UNSETTLED')
     order by opened_at desc
     limit 1
     for update;
  end if;

  if not found or v_check.id is null then
    return jsonb_build_object('ok', true, 'action', 'none');
  end if;

  if public.check_is_live(v_check.id) then
    return jsonb_build_object('ok', true, 'action', 'sitting_open');
  end if;

  select count(*) into v_open_orders
    from public.orders
   where check_id = v_check.id
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    return jsonb_build_object('ok', true, 'action', 'orders_open', 'orders', v_open_orders);
  end if;

  select coalesce(sum(total), 0) into v_total
    from public.orders where check_id = v_check.id and status <> 'CANCELLED';

  if v_total <= 0 then
    update public.table_checks
       set status = 'VOID', closed_at = now(), updated_at = now()
     where id = v_check.id;
    return jsonb_build_object('ok', true, 'action', 'voided_empty');
  end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.check_payments
   where check_id = v_check.id and status = 'SUCCEEDED';

  if v_paid + 0.005 >= v_total then
    return public.finalize_table_check(p_tenant, v_check.id, p_actor);
  end if;

  update public.table_checks
     set status = 'UNSETTLED',
         unsettled_at = now(),
         updated_at = now()
   where id = v_check.id;

  return jsonb_build_object('ok', true, 'action', 'unsettled', 'due', v_total - v_paid);
end;
$function$;

-- 4. Clean up existing stale abandoned sessions and checks that have zero active orders and zero due
UPDATE public.table_sessions ts
   SET status = 'ENDED', ended_at = now(), updated_at = now()
 WHERE ts.status = 'ACTIVE'
   AND NOT EXISTS (
     SELECT 1 FROM public.orders o
      WHERE o.table_session_id = ts.id
        AND o.status NOT IN ('CANCELLED', 'COMPLETED')
   )
   AND (
     NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.table_session_id = ts.id AND o.status <> 'CANCELLED')
     OR EXISTS (
       SELECT 1 FROM public.table_checks tc
        WHERE (tc.session_id = ts.id OR tc.anchor_session_id = ts.id)
          AND tc.status = 'PAID'
     )
   );

UPDATE public.table_checks tc
   SET status = 'VOID', closed_at = now(), updated_at = now()
 WHERE tc.status = 'OPEN'
   AND tc.total = 0
   AND NOT EXISTS (
     SELECT 1 FROM public.orders o
      WHERE o.check_id = tc.id
        AND o.status <> 'CANCELLED'
   );

