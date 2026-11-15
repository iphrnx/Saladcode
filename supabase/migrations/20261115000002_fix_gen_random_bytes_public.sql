-- Migration: 20261115000002_fix_gen_random_bytes_public.sql
-- Description: Expose public.gen_random_bytes wrapper and add extensions to search_path across payment and session RPCs

-- 1. Create public.gen_random_bytes wrapper delegating to extensions.gen_random_bytes
create or replace function public.gen_random_bytes(n integer)
returns bytea
language sql
security definer
set search_path = extensions, pg_temp
as $$
  select extensions.gen_random_bytes(n);
$$;

grant execute on function public.gen_random_bytes(integer) to public, anon, authenticated, service_role;

-- 2. Update settle_check_cash_tx to include extensions in search_path
create or replace function public.settle_check_cash_tx(
  p_tenant uuid,
  p_check uuid,
  p_actor uuid default null,
  p_idempotency_key text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks%rowtype;
  v_seq bigint;
  v_invoice text;
  v_open_orders integer;
  v_totals record;
  v_current_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_payment_id uuid;
  v_completed integer;
  v_target_session uuid;
  v_existing_payment public.check_payments%rowtype;
begin
  -- 1. Row-level lock on the table check with strict tenant isolation
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Idempotency: If check is already settled (status = 'PAID'), return existing settlement details idempotently
  if v_check.status = 'PAID' then
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;

    return jsonb_build_object(
      'ok', true,
      'already', true,
      'invoiceNumber', v_check.invoice_number,
      'total', v_check.total,
      'paid', coalesce(v_check.paid_total, v_check.total),
      'outstanding', 0,
      'endedSessionId', coalesce(v_check.session_id, v_check.anchor_session_id),
      'paymentId', v_payment_id,
      'closedAt', v_check.closed_at
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  -- 3. Verify that all non-cancelled orders on this check are served
  select count(*) into v_open_orders
    from public.orders
   where check_id = p_check
     and status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY');

  if v_open_orders > 0 then
    raise exception 'ORDERS_OPEN:%', v_open_orders using errcode = 'P0001';
  end if;

  -- 4. Calculate authoritative order totals
  select
    coalesce(sum(items_total), 0) as subtotal,
    coalesce(sum(discount), 0)    as discount,
    coalesce(sum(tax), 0)         as tax,
    coalesce(sum(service_charge), 0) as service_charge,
    coalesce(sum(total), 0)       as total
  into v_totals
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  if v_totals.total <= 0 then
    raise exception 'NOTHING_TO_BILL' using errcode = 'P0001';
  end if;

  -- 5. Calculate existing succeeded payments
  select coalesce(sum(amount), 0) into v_current_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0::numeric, v_totals.total - v_current_paid);

  -- 6. If outstanding > 0, record Cash payment atomically
  if v_outstanding > 0 then
    if p_idempotency_key is not null then
      select * into v_existing_payment
        from public.check_payments
       where check_id = p_check and idempotency_key = p_idempotency_key and status = 'SUCCEEDED'
       limit 1;
      if found then
        v_payment_id := v_existing_payment.id;
      end if;
    end if;

    if v_payment_id is null then
      insert into public.check_payments (
        tenant_id, check_id, amount, method, idempotency_key, created_by, status, note
      ) values (
        p_tenant, p_check, v_outstanding, 'CASH',
        coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
        p_actor, 'SUCCEEDED', coalesce(nullif(trim(p_note), ''), 'Cash payment confirmed at POS')
      ) returning id into v_payment_id;

      v_current_paid := v_current_paid + v_outstanding;
    end if;
  else
    -- If already fully covered by previous payments, pick last payment id if present
    select id into v_payment_id
      from public.check_payments
     where check_id = p_check and status = 'SUCCEEDED'
     order by created_at desc
     limit 1;
  end if;

  -- 7. Allocate tenant-scoped sequential invoice number
  insert into public.check_invoice_counters (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  update public.check_invoice_counters
     set last_seq = last_seq + 1,
         updated_at = now()
   where tenant_id = p_tenant
  returning last_seq into v_seq;

  v_invoice := 'INV-' || lpad(v_seq::text, 7, '0');

  -- 8. Mark check PAID and update final financial snapshot
  update public.table_checks
     set status = 'PAID',
         closed_at = now(),
         invoice_number = v_invoice,
         invoice_date = now(),
         subtotal = v_totals.subtotal,
         discount = v_totals.discount,
         tax = v_totals.tax,
         service_charge = v_totals.service_charge,
         total = v_totals.total,
         paid_total = v_current_paid,
         version = version + 1,
         updated_at = now()
   where id = p_check;

  -- 9. Complete all paid check orders
  v_completed := public.complete_paid_check_orders(p_tenant, p_check);

  -- 10. End ONLY the session bound to this check (session isolation on shared tables)
  v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);
  if v_target_session is not null then
    update public.table_sessions
       set status = 'ENDED',
           ended_at = now(),
           updated_at = now()
     where id = v_target_session
       and status = 'ACTIVE';
  end if;

  -- 11. Security audit trail
  insert into public.security_logs (
    tenant_id,
    user_id,
    staff_id,
    actor_staff_id,
    action,
    meta
  ) values (
    p_tenant,
    case when exists (select 1 from public.profiles where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
    case when exists (select 1 from public.staff where id = p_actor) then p_actor else null end,
    'CHECK_SETTLED_CASH',
    'Check ' || p_check || ' settled in cash: ' || v_invoice || ' (₹' || v_totals.total || ')'
  );

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'invoiceNumber', v_invoice,
    'total', v_totals.total,
    'paid', v_current_paid,
    'outstanding', 0,
    'completedOrders', v_completed,
    'endedSessionId', v_target_session,
    'paymentId', v_payment_id,
    'closedAt', now()
  );
end $$;

revoke execute on function public.settle_check_cash_tx(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.settle_check_cash_tx(uuid, uuid, uuid, text, text) to service_role;

-- 3. Update open_table_check to include extensions in search_path
create or replace function public.open_table_check(
  p_tenant uuid,
  p_table  uuid,
  p_session uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_active_session uuid := p_session;
begin
  if v_active_session is not null then
    return public.open_session_check(p_tenant, p_table, v_active_session);
  end if;

  -- If p_session was not provided, lock the table to resolve/create anchor session
  perform pg_advisory_xact_lock(hashtext(p_table::text));

  select id into v_active_session
    from public.table_sessions
   where tenant_id = p_tenant
     and table_id = p_table
     and status = 'ACTIVE'
   order by created_at desc
   limit 1;

  if v_active_session is null then
    insert into public.table_sessions (
      tenant_id, table_id, status, activation_status, token, activated_at
    ) values (
      p_tenant, p_table, 'ACTIVE', 'ACTIVE', encode(extensions.gen_random_bytes(24), 'hex'), now()
    )
    returning id into v_active_session;
  end if;

  return public.open_session_check(p_tenant, p_table, v_active_session);
end $$;

revoke execute on function public.open_table_check(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.open_table_check(uuid, uuid, uuid) to service_role;
