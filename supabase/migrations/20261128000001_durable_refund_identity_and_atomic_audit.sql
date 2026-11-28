-- ============================================================================
-- Migration: 20261128000001_durable_refund_identity_and_atomic_audit.sql
-- Purpose:
--   1. Add durable internal refund_id (subscription_refunds.id) linkage on
--      billing_refunds and subscription_audit_logs.
--   2. Add subscription_refund_reconciliations for incoming refund events
--      that lack a verified provider refund ID, keeping them pending
--      reconciliation without applying amounts or issuing receipts.
--   3. Make record_subscription_refund write the ledger mutation and refund
--      audit entry atomically in the same transaction.
--   4. Update claim_billing_refund_document to match strictly by verified
--      refund identity (refund_id / razorpay_refund_id / linked_razorpay_refund_id)
--      and leave ambiguous legacy receipts unresolved without allocating a
--      duplicate receipt.
-- ============================================================================

create table if not exists public.subscription_refund_reconciliations (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  payment_id          uuid references public.subscription_payments(id) on delete cascade,
  razorpay_payment_id text not null,
  amount              numeric(10, 2) not null default 0,
  currency            text not null default 'INR',
  status              text not null default 'pending_reconciliation'
                      check (status in ('pending_reconciliation', 'reconciled', 'ignored')),
  webhook_event_id    text unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists subscription_refund_reconciliations_tenant_idx
  on public.subscription_refund_reconciliations (tenant_id, status, created_at desc);

alter table public.subscription_refund_reconciliations enable row level security;
revoke all on public.subscription_refund_reconciliations from anon, authenticated;

alter table public.billing_refunds
  add column if not exists refund_id uuid references public.subscription_refunds(id);

create unique index if not exists billing_refunds_refund_id_key
  on public.billing_refunds (refund_id)
  where refund_id is not null;

-- Backfill durable refund_id for existing receipts that already have a
-- verified provider refund association.
update public.billing_refunds br
   set refund_id = sr.id
  from public.subscription_refunds sr
 where br.refund_id is null
   and sr.payment_id = br.payment_id
   and sr.razorpay_refund_id = coalesce(nullif(btrim(br.linked_razorpay_refund_id), ''), nullif(btrim(br.razorpay_refund_id), ''));

create unique index if not exists idx_sub_audit_logs_internal_refund_id_unique
  on public.subscription_audit_logs (tenant_id, (detail->>'internalRefundId'))
  where change_type = 'refunded'
    and detail->>'internalRefundId' is not null;

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
  v_tenant_plan     text;
  v_existing        record;
  v_refund_uuid     uuid;
  v_now             timestamptz := now();
  v_effective_amt   numeric(10, 2);
  v_total_refunded  numeric(10, 2);
  v_fully_refunded  boolean;
  v_refund_id       text := nullif(btrim(coalesce(p_razorpay_refund_id, '')), '');
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

  select coalesce(subscription_plan, plan)
    into v_tenant_plan
    from public.tenants
   where id = p_tenant_id;

  v_effective_amt := coalesce(nullif(p_refund_amount, 0), v_payment.amount);

  -- Events without a verified provider refund ID cannot be tied to a verified
  -- refund: keep them pending reconciliation without applying the amount.
  if v_refund_id is null then
    insert into public.subscription_refund_reconciliations (
      tenant_id,
      payment_id,
      razorpay_payment_id,
      amount,
      currency,
      status,
      webhook_event_id,
      created_at,
      updated_at
    ) values (
      p_tenant_id,
      v_payment.id,
      p_razorpay_payment_id,
      v_effective_amt,
      coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
      'pending_reconciliation',
      p_webhook_event_id,
      v_now,
      v_now
    )
    on conflict (webhook_event_id) do nothing;

    return jsonb_build_object(
      'outcome', 'pending_reconciliation',
      'payment_uuid', v_payment.id
    );
  end if;

  select *
    into v_existing
    from public.subscription_refunds
   where razorpay_refund_id = v_refund_id
     for update;

  if found then
    v_refund_uuid := v_existing.id;
    if v_existing.status = 'processed' then
      -- Ensure the audit entry exists even if an earlier legacy row lacked one.
      begin
        insert into public.subscription_audit_logs (
          tenant_id, old_plan, new_plan, change_type, razorpay_event_id, detail
        ) values (
          p_tenant_id,
          v_tenant_plan,
          v_payment.plan_id,
          'refunded',
          p_webhook_event_id,
          jsonb_build_object(
            'paymentId', p_razorpay_payment_id,
            'refundId', v_refund_id,
            'internalRefundId', v_refund_uuid::text,
            'totalRefunded', v_payment.refunded_amount,
            'isFullyRefunded', v_payment.status = 'refunded'
          )
        );
      exception when unique_violation then
        null;
      end;

      return jsonb_build_object(
        'outcome', 'already_processed',
        'payment_uuid', v_payment.id,
        'refund_uuid', v_refund_uuid,
        'razorpay_refund_id', v_refund_id,
        'total_refunded', v_payment.refunded_amount,
        'is_fully_refunded', v_payment.status = 'refunded'
      );
    end if;

    if p_refund_status = 'pending' then
      return jsonb_build_object(
        'outcome', 'pending_recorded',
        'payment_uuid', v_payment.id,
        'refund_uuid', v_refund_uuid,
        'razorpay_refund_id', v_refund_id
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
      v_refund_id,
      v_effective_amt,
      coalesce(nullif(btrim(p_currency), ''), v_payment.currency),
      p_refund_status,
      p_webhook_event_id,
      case when p_refund_status = 'processed' then v_now else null end,
      v_now,
      v_now
    )
    returning id into v_refund_uuid;
  end if;

  if p_refund_status = 'pending' then
    return jsonb_build_object(
      'outcome', 'pending_recorded',
      'payment_uuid', v_payment.id,
      'refund_uuid', v_refund_uuid,
      'razorpay_refund_id', v_refund_id
    );
  end if;

  if p_refund_status = 'failed' then
    return jsonb_build_object(
      'outcome', 'failed_recorded',
      'payment_uuid', v_payment.id,
      'refund_uuid', v_refund_uuid,
      'razorpay_refund_id', v_refund_id
    );
  end if;

  select coalesce(sum(amount), 0)::numeric(10, 2)
    into v_total_refunded
    from public.subscription_refunds
   where payment_id = v_payment.id
     and status = 'processed';

  v_fully_refunded := (v_total_refunded >= v_payment.amount);

  update public.subscription_payments
     set refunded_amount = v_total_refunded,
         status = case when v_fully_refunded then 'refunded' else v_payment.status end,
         updated_at = v_now
   where id = v_payment.id;

  -- Atomic audit write in the same transaction as the ledger mutation.
  begin
    insert into public.subscription_audit_logs (
      tenant_id, old_plan, new_plan, change_type, razorpay_event_id, detail
    ) values (
      p_tenant_id,
      v_tenant_plan,
      v_payment.plan_id,
      'refunded',
      p_webhook_event_id,
      jsonb_build_object(
        'paymentId', p_razorpay_payment_id,
        'refundId', v_refund_id,
        'internalRefundId', v_refund_uuid::text,
        'totalRefunded', v_total_refunded,
        'isFullyRefunded', v_fully_refunded
      )
    );
  exception when unique_violation then
    null;
  end;

  return jsonb_build_object(
    'outcome', 'processed',
    'payment_uuid', v_payment.id,
    'refund_uuid', v_refund_uuid,
    'razorpay_refund_id', v_refund_id,
    'refund_amount', v_effective_amt,
    'total_refunded', v_total_refunded,
    'is_fully_refunded', v_fully_refunded
  );
end;
$$;

create or replace function public.claim_billing_refund_document(
  p_tenant_id               uuid,
  p_payment_id              uuid,
  p_invoice_id              uuid,
  p_refund_date             timestamptz,
  p_fiscal_year             text,
  p_seller_name             text,
  p_seller_address          text,
  p_seller_email            text,
  p_seller_phone            text,
  p_buyer_name              text,
  p_buyer_email             text,
  p_buyer_address           text,
  p_original_invoice_number text,
  p_original_invoice_date   timestamptz,
  p_amount                  numeric,
  p_currency                text,
  p_description             text,
  p_razorpay_payment_id     text,
  p_razorpay_order_id       text,
  p_razorpay_refund_id      text
)
returns public.billing_refunds
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing            public.billing_refunds;
  v_inserted            public.billing_refunds;
  v_number              text;
  v_lock_key            text;
  v_refund_id           text := nullif(btrim(p_razorpay_refund_id), '');
  v_refund_uuid         uuid;
  v_currency            text := upper(coalesce(nullif(btrim(p_currency), ''), 'INR'));
  v_processed_count     int := 0;
  v_legacy_count        int := 0;
  v_total_receipt_count int := 0;
begin
  v_lock_key := 'billing_refund:' || p_payment_id::text;
  perform pg_advisory_xact_lock(hashtext(v_lock_key));

  select count(*)::int
    into v_processed_count
    from public.subscription_refunds
   where payment_id = p_payment_id
     and status = 'processed';

  select count(*)::int,
         count(*) filter (
           where razorpay_refund_id is null
             and linked_razorpay_refund_id is null
             and refund_id is null
         )::int
    into v_total_receipt_count, v_legacy_count
    from public.billing_refunds
   where payment_id = p_payment_id
     and tenant_id = p_tenant_id;

  if v_refund_id is null then
    -- Without a verified provider refund ID, never mint a new receipt;
    -- only return an existing legacy ID-less receipt when no processed
    -- provider refunds exist on this payment.
    if v_processed_count = 0 and v_total_receipt_count = 1 and v_legacy_count = 1 then
      select *
        into v_existing
        from public.billing_refunds br
       where br.payment_id = p_payment_id
         and br.tenant_id = p_tenant_id
         and br.razorpay_refund_id is null
         and br.linked_razorpay_refund_id is null
         and br.refund_id is null
       limit 1;
      if found then
        if nullif(btrim(v_existing.pdf_path), '') is null then
          update public.billing_refunds
             set pdf_path = v_existing.tenant_id::text || '/' || v_existing.refund_number || '.pdf'
           where id = v_existing.id
          returning * into v_existing;
        end if;
        return v_existing;
      end if;
    end if;
    return null;
  end if;

  select sr.id
    into v_refund_uuid
    from public.subscription_refunds sr
   where sr.razorpay_refund_id = v_refund_id
     and sr.payment_id = p_payment_id
     and sr.tenant_id = p_tenant_id
   limit 1;

  -- Match strictly by verified refund identity (durable refund_id or provider
  -- refund ID columns). Amount, currency, timestamps, and row counts never
  -- establish a match on their own.
  select *
    into v_existing
    from public.billing_refunds br
   where (v_refund_uuid is not null and br.refund_id = v_refund_uuid)
      or br.razorpay_refund_id = v_refund_id
      or br.linked_razorpay_refund_id = v_refund_id
   limit 1;

  if found then
    if (v_refund_uuid is not null and v_existing.refund_id is null)
       or nullif(btrim(v_existing.pdf_path), '') is null
    then
      update public.billing_refunds
         set refund_id = coalesce(refund_id, v_refund_uuid),
             linked_razorpay_refund_id = coalesce(linked_razorpay_refund_id, v_refund_id),
             pdf_path = coalesce(nullif(btrim(pdf_path), ''), tenant_id::text || '/' || refund_number || '.pdf')
       where id = v_existing.id
      returning * into v_existing;
    end if;
    return v_existing;
  end if;

  -- Leave ambiguous historical ID-less receipts unresolved without
  -- allocating another receipt for a potentially already documented refund.
  if v_legacy_count > 0 and exists (
    select 1
      from public.billing_refunds br
     where br.payment_id = p_payment_id
       and br.tenant_id = p_tenant_id
       and br.razorpay_refund_id is null
       and br.linked_razorpay_refund_id is null
       and br.refund_id is null
       and (br.amount is null or (p_amount is not null and br.amount = p_amount))
       and upper(coalesce(nullif(btrim(br.currency), ''), 'INR')) = v_currency
  ) then
    return null;
  end if;

  v_number := public.billing_next_document_number('RFND', p_fiscal_year);

  insert into public.billing_refunds (
    tenant_id,
    payment_id,
    invoice_id,
    refund_id,
    refund_number,
    refund_date,
    fiscal_year,
    seller_name,
    seller_address,
    seller_email,
    seller_phone,
    buyer_name,
    buyer_email,
    buyer_address,
    original_invoice_number,
    original_invoice_date,
    amount,
    currency,
    description,
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_refund_id,
    linked_razorpay_refund_id,
    pdf_path
  ) values (
    p_tenant_id,
    p_payment_id,
    p_invoice_id,
    v_refund_uuid,
    v_number,
    p_refund_date,
    p_fiscal_year,
    p_seller_name,
    p_seller_address,
    p_seller_email,
    p_seller_phone,
    p_buyer_name,
    p_buyer_email,
    p_buyer_address,
    p_original_invoice_number,
    p_original_invoice_date,
    p_amount,
    coalesce(nullif(btrim(p_currency), ''), 'INR'),
    p_description,
    p_razorpay_payment_id,
    p_razorpay_order_id,
    v_refund_id,
    v_refund_id,
    p_tenant_id::text || '/' || v_number || '.pdf'
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;
