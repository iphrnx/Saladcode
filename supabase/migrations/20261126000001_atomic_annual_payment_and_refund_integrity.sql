-- Migration: 20261126000001_atomic_annual_payment_and_refund_integrity.sql
-- Fixes:
--   1. Atomic annual (pay_once) payment finalization RPC shared by /subscriptions/verify
--      and razorpay-webhook (row locking, strict validation, single entitlement extension).
--   2. Partial & multiple refund accounting keyed by razorpay_refund_id, preserving
--      existing RLS, privileges, and subscription_payments status compatibility.

-- ---------------------------------------------------------------------------
-- 1. SUBSCRIPTION PAYMENTS: TRACK CUMULATIVE REFUNDED AMOUNT
-- ---------------------------------------------------------------------------
alter table public.subscription_payments
  add column if not exists refunded_amount numeric(10, 2) not null default 0;

update public.subscription_payments
   set refunded_amount = amount
 where status = 'refunded'
   and refunded_amount = 0;

-- ---------------------------------------------------------------------------
-- 2. SUBSCRIPTION REFUNDS LEDGER (PER RAZORPAY REFUND ID)
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_refunds (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  payment_id          uuid not null references public.subscription_payments(id) on delete cascade,
  razorpay_payment_id text not null,
  razorpay_refund_id  text not null unique,
  amount              numeric(10, 2) not null check (amount >= 0),
  currency            text not null default 'INR',
  status              text not null check (status in ('pending', 'processed', 'failed')),
  webhook_event_id    text,
  processed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists subscription_refunds_payment_idx
  on public.subscription_refunds (payment_id, status);

create index if not exists subscription_refunds_tenant_idx
  on public.subscription_refunds (tenant_id, created_at desc);

alter table public.subscription_refunds enable row level security;
revoke all on public.subscription_refunds from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. BILLING REFUNDS: ALLOW MULTIPLE REFUND DOCUMENTS PER PAYMENT
-- ---------------------------------------------------------------------------
drop index if exists public.billing_refunds_payment_id_key;

create unique index if not exists billing_refunds_razorpay_refund_id_key
  on public.billing_refunds (razorpay_refund_id)
  where razorpay_refund_id is not null;

create unique index if not exists billing_refunds_legacy_payment_id_key
  on public.billing_refunds (payment_id)
  where razorpay_refund_id is null;

-- ---------------------------------------------------------------------------
-- 4. ATOMIC ANNUAL ORDER PAYMENT FINALIZATION RPC
-- ---------------------------------------------------------------------------
create or replace function public.finalize_annual_order_payment(
  p_tenant_id            uuid,
  p_razorpay_order_id    text,
  p_razorpay_payment_id  text,
  p_payment_order_id     text,
  p_amount_minor         bigint,
  p_currency             text,
  p_payment_status       text,
  p_payment_method       text default 'razorpay',
  p_razorpay_signature   text default null,
  p_webhook_event_id     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant          record;
  v_checkout        record;
  v_exponent        integer;
  v_expected_minor  bigint;
  v_amount_paid     numeric(10, 2);
  v_now             timestamptz := now();
  v_period_base     timestamptz;
  v_period_end      timestamptz;
  v_payment_uuid    uuid;
begin
  if p_tenant_id is null or length(btrim(coalesce(p_razorpay_order_id, ''))) = 0 or length(btrim(coalesce(p_razorpay_payment_id, ''))) = 0 then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'Missing tenant, order, or payment identifier.'
    );
  end if;

  -- Lock tenant first to serialize any concurrent payments/activations for the
  -- same restaurant in a consistent lock order.
  select id, plan, subscription_plan, current_period_end, razorpay_subscription_id
    into v_tenant
    from public.tenants
   where id = p_tenant_id
     for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'not_found',
      'reason', 'The restaurant no longer exists.'
    );
  end if;

  -- Lock the checkout row so /verify, order.paid, and payment.captured serialize cleanly.
  select *
    into v_checkout
    from public.subscription_checkouts
   where razorpay_order_id = p_razorpay_order_id
     for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'ignore',
      'code', 'not_found',
      'reason', 'That order is not one of ours. Start the checkout again from this restaurant''s billing page.'
    );
  end if;

  if v_checkout.tenant_id <> p_tenant_id then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'That order belongs to another restaurant.'
    );
  end if;

  if coalesce(v_checkout.payment_mode, 'pay_once') <> 'pay_once' then
    return jsonb_build_object(
      'outcome', 'ignore',
      'code', 'mismatch',
      'reason', 'non-pay_once checkout handled by subscription events'
    );
  end if;

  -- Authoritative idempotency check: only checkout status = 'paid' with matching
  -- payment id (committed atomically with tenant activation) proves completion.
  if v_checkout.status = 'paid' and v_checkout.razorpay_payment_id = p_razorpay_payment_id then
    return jsonb_build_object(
      'outcome', 'already',
      'tenant_id', p_tenant_id,
      'plan_id', v_checkout.plan_id,
      'period_end', v_tenant.current_period_end,
      'previous_subscription_id', v_tenant.razorpay_subscription_id
    );
  end if;

  if v_checkout.status = 'paid' and coalesce(v_checkout.razorpay_payment_id, '') <> p_razorpay_payment_id then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'That order was already settled by a different payment.'
    );
  end if;

  -- Strict order, currency, amount, and captured-status verification.
  if length(btrim(coalesce(p_payment_order_id, ''))) = 0 or p_payment_order_id <> v_checkout.razorpay_order_id then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'That payment is for a different order.'
    );
  end if;

  if upper(coalesce(p_currency, '')) <> upper(v_checkout.currency) then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'That payment is in a different currency.'
    );
  end if;

  v_exponent := case when upper(v_checkout.currency) in ('JPY', 'KRW') then 0 else 2 end;
  v_expected_minor := round(v_checkout.amount::numeric * power(10::numeric, v_exponent))::bigint;
  if p_amount_minor is null or p_amount_minor <> v_expected_minor then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'The amount paid does not match this plan.'
    );
  end if;

  if coalesce(p_payment_status, '') <> 'captured' then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'unverified',
      'reason', 'The payment is ' || coalesce(p_payment_status, 'unknown') || ', not captured.'
    );
  end if;

  if v_checkout.status = 'failed' then
    return jsonb_build_object(
      'outcome', 'reject',
      'code', 'mismatch',
      'reason', 'That checkout order has failed.'
    );
  end if;

  v_amount_paid := round((p_amount_minor::numeric / power(10::numeric, v_exponent)), v_exponent);
  v_period_base := greatest(v_now, coalesce(v_tenant.current_period_end, v_now));
  v_period_end := v_period_base + interval '365 days';

  insert into public.subscription_payments (
    tenant_id,
    amount,
    currency,
    status,
    payment_method,
    transaction_id,
    plan_id,
    billing_period,
    payment_mode,
    mandate_id,
    mandate_expires_at,
    renewal_status,
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_subscription_id,
    razorpay_signature,
    webhook_event_id,
    created_at,
    updated_at
  ) values (
    p_tenant_id,
    v_amount_paid,
    upper(p_currency),
    'succeeded',
    coalesce(nullif(btrim(p_payment_method), ''), 'razorpay'),
    p_razorpay_payment_id,
    v_checkout.plan_id,
    'annual',
    'pay_once',
    null,
    null,
    'not_applicable',
    p_razorpay_payment_id,
    v_checkout.razorpay_order_id,
    null,
    p_razorpay_signature,
    p_webhook_event_id,
    v_now,
    v_now
  )
  on conflict (razorpay_payment_id) do update
    set tenant_id = excluded.tenant_id,
        amount = excluded.amount,
        currency = excluded.currency,
        status = case
          when public.subscription_payments.status = 'refunded' then 'refunded'
          else 'succeeded'
        end,
        payment_method = coalesce(excluded.payment_method, public.subscription_payments.payment_method),
        plan_id = excluded.plan_id,
        billing_period = 'annual',
        payment_mode = 'pay_once',
        renewal_status = 'not_applicable',
        razorpay_order_id = excluded.razorpay_order_id,
        razorpay_signature = coalesce(excluded.razorpay_signature, public.subscription_payments.razorpay_signature),
        webhook_event_id = coalesce(excluded.webhook_event_id, public.subscription_payments.webhook_event_id),
        updated_at = v_now
  returning id into v_payment_uuid;

  update public.tenants
     set plan = v_checkout.plan_id,
         subscription_plan = v_checkout.plan_id,
         subscription_status = 'active',
         subscription_started_at = v_now,
         current_period_end = v_period_end,
         cancel_at_period_end = false,
         razorpay_subscription_id = null,
         subscription_razorpay_payment_id = p_razorpay_payment_id,
         billing_interval = 'annual',
         payment_mode = 'pay_once'
   where id = p_tenant_id;

  update public.subscription_checkouts
     set status = 'paid',
         razorpay_payment_id = p_razorpay_payment_id,
         verified_amount = v_amount_paid,
         verified_at = v_now,
         updated_at = v_now
   where id = v_checkout.id
     and status in ('pending', 'expired');

  if not found then
    raise exception 'checkout state changed concurrently for order %', p_razorpay_order_id;
  end if;

  update public.subscription_checkouts
     set status = 'expired',
         updated_at = v_now
   where tenant_id = p_tenant_id
     and status = 'pending'
     and razorpay_subscription_id is null
     and razorpay_order_id <> p_razorpay_order_id;

  return jsonb_build_object(
    'outcome', 'activated',
    'tenant_id', p_tenant_id,
    'plan_id', v_checkout.plan_id,
    'payment_uuid', v_payment_uuid,
    'amount_paid', v_amount_paid,
    'currency', upper(p_currency),
    'period_base', v_period_base,
    'period_end', v_period_end,
    'previous_subscription_id', v_tenant.razorpay_subscription_id,
    'previous_plan', coalesce(v_tenant.subscription_plan, v_tenant.plan)
  );
end;
$$;

revoke execute on function public.finalize_annual_order_payment(
  uuid, text, text, text, bigint, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.finalize_annual_order_payment(
  uuid, text, text, text, bigint, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 5. ATOMIC SUBSCRIPTION REFUND ACCOUNTING RPC
-- ---------------------------------------------------------------------------
create or replace function public.record_subscription_refund(
  p_tenant_id            uuid,
  p_razorpay_payment_id  text,
  p_razorpay_refund_id   text,
  p_refund_amount        numeric,
  p_currency             text,
  p_refund_status        text,
  p_webhook_event_id     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment         record;
  v_existing        record;
  v_now             timestamptz := now();
  v_effective_amt   numeric(10, 2);
  v_total_refunded  numeric(10, 2);
  v_fully_refunded  boolean;
begin
  if p_tenant_id is null or length(btrim(coalesce(p_razorpay_payment_id, ''))) = 0 then
    return jsonb_build_object('outcome', 'ignore', 'reason', 'missing tenant or payment id');
  end if;

  if p_refund_status not in ('pending', 'processed', 'failed') then
    return jsonb_build_object('outcome', 'ignore', 'reason', 'unsupported refund status');
  end if;

  select *
    into v_payment
    from public.subscription_payments
   where razorpay_payment_id = p_razorpay_payment_id
     and tenant_id = p_tenant_id
     for update;

  if not found then
    return jsonb_build_object('outcome', 'payment_not_found', 'reason', 'payment row not found');
  end if;

  v_effective_amt := coalesce(nullif(p_refund_amount, 0), v_payment.amount);

  if length(btrim(coalesce(p_razorpay_refund_id, ''))) > 0 then
    select *
      into v_existing
      from public.subscription_refunds
     where razorpay_refund_id = p_razorpay_refund_id
       for update;

    if found then
      if v_existing.status = 'processed' then
        -- Already finalized: ignore duplicate or out-of-order pending/failed events.
        return jsonb_build_object(
          'outcome', 'already_processed',
          'payment_uuid', v_payment.id,
          'razorpay_refund_id', p_razorpay_refund_id,
          'total_refunded', v_payment.refunded_amount,
          'is_fully_refunded', v_payment.status = 'refunded'
        );
      end if;

      if p_refund_status = 'pending' then
        return jsonb_build_object(
          'outcome', 'pending_recorded',
          'payment_uuid', v_payment.id,
          'razorpay_refund_id', p_razorpay_refund_id
        );
      end if;

      update public.subscription_refunds
         set status = p_refund_status,
             amount = v_effective_amt,
             currency = coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
             webhook_event_id = coalesce(p_webhook_event_id, webhook_event_id),
             processed_at = case when p_refund_status = 'processed' then v_now else processed_at end,
             updated_at = v_now
       where id = v_existing.id;
    else
      insert into public.subscription_refunds (
        tenant_id,
        payment_id,
        razorpay_payment_id,
        razorpay_refund_id,
        amount,
        currency,
        status,
        webhook_event_id,
        processed_at,
        created_at,
        updated_at
      ) values (
        p_tenant_id,
        v_payment.id,
        p_razorpay_payment_id,
        p_razorpay_refund_id,
        v_effective_amt,
        coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
        p_refund_status,
        p_webhook_event_id,
        case when p_refund_status = 'processed' then v_now else null end,
        v_now,
        v_now
      );
    end if;
  end if;

  if p_refund_status = 'pending' then
    return jsonb_build_object(
      'outcome', 'pending_recorded',
      'payment_uuid', v_payment.id,
      'razorpay_refund_id', p_razorpay_refund_id
    );
  end if;

  if p_refund_status = 'failed' then
    return jsonb_build_object(
      'outcome', 'failed_recorded',
      'payment_uuid', v_payment.id,
      'razorpay_refund_id', p_razorpay_refund_id
    );
  end if;

  -- Recompute cumulative refunded amount from all processed refunds on this payment.
  if length(btrim(coalesce(p_razorpay_refund_id, ''))) > 0 then
    select coalesce(sum(amount), 0)::numeric(10, 2)
      into v_total_refunded
      from public.subscription_refunds
     where payment_id = v_payment.id
       and status = 'processed';
  else
    v_total_refunded := least(v_payment.amount, v_payment.refunded_amount + v_effective_amt);
  end if;

  v_fully_refunded := (v_total_refunded >= v_payment.amount);

  update public.subscription_payments
     set refunded_amount = v_total_refunded,
         status = case when v_fully_refunded then 'refunded' else v_payment.status end,
         updated_at = v_now
   where id = v_payment.id;

  return jsonb_build_object(
    'outcome', 'processed',
    'payment_uuid', v_payment.id,
    'razorpay_refund_id', p_razorpay_refund_id,
    'refund_amount', v_effective_amt,
    'total_refunded', v_total_refunded,
    'is_fully_refunded', v_fully_refunded
  );
end;
$$;

revoke execute on function public.record_subscription_refund(
  uuid, text, text, numeric, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_subscription_refund(
  uuid, text, text, numeric, text, text, text
) to service_role;
