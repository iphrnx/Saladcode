-- ============================================================================
-- Migration: 20261121000001_correct_analytics_settlement_paid_at.sql
-- Description: Forward corrective migration:
--              1. Adds location_id to table_checks, check_payments, and orders
--                 for durable transaction location attribution.
--              2. Atomically validates full settlement in record_check_payment
--                 inside the transaction after acquiring the check lock,
--                 rejecting underpayment and overpayment while preserving
--                 idempotent retries and already-settled states.
--              3. Repairs historical orders.paid_at whose existing timestamp
--                 conflicts with verified final settlement records (fixing
--                 flawed non-null values from prior migrations).
--              4. Preserves complete_paid_check_orders RPC behavior & permissions.
-- ============================================================================

-- 1. Ensure paid_at and location_id columns exist on core transaction tables
alter table public.orders
  add column if not exists paid_at timestamptz,
  add column if not exists location_id uuid references public.locations(id) on delete set null;

alter table public.table_checks
  add column if not exists location_id uuid references public.locations(id) on delete set null;

alter table public.check_payments
  add column if not exists location_id uuid references public.locations(id) on delete set null;

-- Ensure indexes exist for settlement-based analytics and location scoping
create index if not exists idx_orders_tenant_paid_at
  on public.orders (tenant_id, paid_at desc)
  where paid_at is not null;

create index if not exists idx_orders_tenant_payment_status
  on public.orders (tenant_id, payment_status, status);

create index if not exists idx_orders_tenant_location
  on public.orders (tenant_id, location_id);

create index if not exists idx_table_checks_tenant_location
  on public.table_checks (tenant_id, location_id);

create index if not exists idx_check_payments_tenant_location
  on public.check_payments (tenant_id, location_id);

-- Backfill durable location_id for Dine-in checks and orders from tables
update public.table_checks tc
   set location_id = t.location_id
  from public.tables t
 where tc.table_id = t.id
   and tc.location_id is null
   and t.location_id is not null;

update public.orders o
   set location_id = t.location_id
  from public.tables t
 where o.table_id = t.id
   and o.location_id is null
   and t.location_id is not null;

update public.check_payments cp
   set location_id = tc.location_id
  from public.table_checks tc
 where cp.check_id = tc.id
   and cp.location_id is null
   and tc.location_id is not null;

-- 2. Corrective historical paid_at repair:
-- Repairs affected orders whose existing timestamp conflicts with verified final settlement.
-- Priority A: Authoritative final full-settlement ledger payments
with final_payments as (
  select
    o.id as order_id,
    max(cp.created_at) as verified_settled_at
  from public.orders o
  join public.check_payments cp
    on cp.check_id = o.check_id
   and cp.tenant_id = o.tenant_id
  where cp.status = 'SUCCEEDED'
  group by o.id
)
update public.orders o
   set paid_at = fp.verified_settled_at
  from final_payments fp
 where o.id = fp.order_id
   and o.paid_at is distinct from fp.verified_settled_at;

-- Priority B: Closed paid table checks where ledger payments are absent across history
with verified_checks as (
  select
    o.id as order_id,
    coalesce(tc.closed_at, tc.invoice_date) as verified_settled_at
  from public.orders o
  join public.table_checks tc
    on tc.id = o.check_id
   and tc.tenant_id = o.tenant_id
  where tc.status = 'PAID'
    and coalesce(tc.closed_at, tc.invoice_date) is not null
    and not exists (
      select 1 from public.check_payments cp
      where cp.check_id = tc.id and cp.status = 'SUCCEEDED'
    )
)
update public.orders o
   set paid_at = vc.verified_settled_at
  from verified_checks vc
 where o.id = vc.order_id
   and o.paid_at is distinct from vc.verified_settled_at;

-- Priority C: Reset unverifiable paid_at to NULL where no paid status, no successful
-- ledger payment, and no verified closed paid check exists.
update public.orders o
   set paid_at = null
 where o.paid_at is not null
   and o.payment_status not in ('PAID', 'paid')
   and not exists (
     select 1 from public.check_payments cp
      where cp.check_id = o.check_id and cp.status = 'SUCCEEDED'
   )
   and not exists (
     select 1 from public.table_checks tc
      where tc.id = o.check_id and tc.status = 'PAID'
   );

-- 3. Atomic record_check_payment enforcing full settlement inside the transaction
create or replace function public.record_check_payment(
  p_tenant uuid,
  p_check uuid,
  p_amount numeric default null,
  p_method text default 'CASH',
  p_idempotency_key text default null,
  p_actor uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_check public.table_checks;
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_amt numeric(12, 2);
  v_existing public.check_payments;
  v_payment_id uuid;
  v_profile_actor uuid := null;
  v_staff_actor uuid := null;
  v_location uuid := null;
begin
  -- 1. Acquire row lock on the table check
  select * into v_check
    from public.table_checks
   where id = p_check and tenant_id = p_tenant
   for update;

  if not found then
    raise exception 'CHECK_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- 2. Preserve idempotent retries on the client key
  if p_idempotency_key is not null then
    select * into v_existing
      from public.check_payments
     where check_id = p_check and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object(
        'ok', true,
        'deduplicated', true,
        'already', true,
        'paymentId', v_existing.id,
        'amount', v_existing.amount,
        'method', v_existing.method
      );
    end if;
  end if;

  -- 3. Check if check is already settled
  if v_check.status = 'PAID' then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'deduplicated', true,
      'message', 'This bill is already settled.'
    );
  end if;

  if v_check.status not in ('OPEN', 'UNSETTLED') then
    raise exception 'CHECK_%', v_check.status using errcode = 'P0001';
  end if;

  -- 4. Calculate authoritative outstanding balance under lock
  select coalesce(round(sum(total), 2), 0.00) into v_total
    from public.orders
   where check_id = p_check and status <> 'CANCELLED';

  select coalesce(round(sum(amount), 2), 0.00) into v_paid
    from public.check_payments
   where check_id = p_check and status = 'SUCCEEDED';

  v_outstanding := greatest(0.00, round(v_total - v_paid, 2));

  if v_outstanding <= 0.00 then
    -- Check has 0 balance due; mark settled
    update public.table_checks
       set status = 'PAID',
           closed_at = coalesce(closed_at, now()),
           updated_at = now()
     where id = p_check;
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'deduplicated', true,
      'message', 'This bill is already settled.'
    );
  end if;

  -- 5. Full settlement validation: compare exact currency amounts
  v_amt := round(coalesce(p_amount, v_outstanding), 2);

  if v_amt < v_outstanding then
    raise exception 'UNDERPAYMENT:%:%', v_amt::text, v_outstanding::text using errcode = 'P0001';
  end if;

  if v_amt > v_outstanding then
    raise exception 'OVERPAYMENT:%:%', v_amt::text, v_outstanding::text using errcode = 'P0001';
  end if;

  -- 6. Resolve actor and durable transaction location
  if p_actor is not null then
    select id into v_profile_actor from public.profiles where id = p_actor;
    if v_profile_actor is null then
      select id, location_id into v_staff_actor, v_location
        from public.staff
       where id = p_actor and tenant_id = p_tenant;
    end if;
  end if;

  if v_check.table_id is not null then
    select location_id into v_location
      from public.tables
     where id = v_check.table_id;
  end if;

  if v_location is null then
    v_location := v_check.location_id;
  end if;

  -- 7. Record authoritative payment record
  insert into public.check_payments (
    tenant_id, check_id, amount, method, idempotency_key,
    created_by, staff_id, location_id, status, note, created_at
  ) values (
    p_tenant, p_check, v_amt, coalesce(p_method, 'CASH'),
    coalesce(p_idempotency_key, encode(extensions.gen_random_bytes(16), 'hex')),
    v_profile_actor, v_staff_actor, v_location, 'SUCCEEDED', p_note, now()
  )
  returning id into v_payment_id;

  -- 8. Atomically update check to settled
  update public.table_checks
     set paid_total = v_paid + v_amt,
         status = 'PAID',
         closed_at = coalesce(closed_at, now()),
         location_id = coalesce(location_id, v_location),
         version = version + 1,
         updated_at = now()
   where id = p_check;

  -- 9. Update orders attached to this check
  update public.orders
     set status = 'COMPLETED',
         payment_status = 'PAID',
         paid_at = coalesce(paid_at, now()),
         completed_at = coalesce(completed_at, now()),
         location_id = coalesce(location_id, v_location),
         updated_at = now()
   where check_id = p_check
     and status in ('PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED');

  return jsonb_build_object(
    'ok', true,
    'deduplicated', false,
    'paymentId', v_payment_id,
    'amount', v_amt,
    'method', coalesce(p_method, 'CASH'),
    'totalPaid', v_paid + v_amt,
    'outstanding', 0.00
  );
end $$;

revoke execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_check_payment(uuid, uuid, numeric, text, text, uuid, text) to service_role;

-- 4. Re-assert complete_paid_check_orders RPC behavior and secure permissions
create or replace function public.complete_paid_check_orders(p_tenant uuid, p_check uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer;
  v_settled_at timestamptz := now();
begin
  with done as (
    update public.orders
       set status = 'COMPLETED',
           payment_status = 'PAID',
           paid_at = coalesce(paid_at, v_settled_at),
           completed_at = coalesce(completed_at, v_settled_at),
           updated_at = v_settled_at
     where tenant_id = p_tenant
       and check_id = p_check
       and status in ('PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED')
     returning 1
  )
  select count(*) into v_count from done;
  return v_count;
end $function$;

revoke execute on function public.complete_paid_check_orders(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_paid_check_orders(uuid, uuid) to service_role;
