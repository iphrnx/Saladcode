-- ============================================================================
-- Migration: 20261127000006_atomic_claim_refund_document.sql
-- Purpose:
--   Atomically claim one billing_refunds row and reserve one RFND document
--   number per refund (under an advisory lock keyed by razorpay_refund_id or
--   payment_id) before uploading the PDF, so concurrent deliveries produce
--   one row, consume one number, and retries resume with the same path.
-- ============================================================================

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
  v_processed_count     int := 0;
  v_legacy_count        int := 0;
  v_total_receipt_count int := 0;
begin
  v_lock_key := 'billing_refund:' || p_payment_id::text;
  perform pg_advisory_xact_lock(hashtext(v_lock_key));

  if nullif(btrim(p_razorpay_refund_id), '') is not null then
    select *
      into v_existing
      from public.billing_refunds
     where razorpay_refund_id = p_razorpay_refund_id
     limit 1;

    if found then
      return v_existing;
    end if;

    -- Reconcile an unambiguous legacy ID-less receipt when the payment has
    -- at most one processed refund and exactly one legacy receipt (and no
    -- other refund receipts). Multi-refund payments stay unresolved.
    select count(*)::int
      into v_processed_count
      from public.subscription_refunds
     where payment_id = p_payment_id
       and status = 'processed';

    select count(*)::int,
           count(*) filter (where razorpay_refund_id is null)::int
      into v_total_receipt_count, v_legacy_count
      from public.billing_refunds
     where payment_id = p_payment_id;

    if v_processed_count <= 1 and v_total_receipt_count = 1 and v_legacy_count = 1 then
      select *
        into v_existing
        from public.billing_refunds
       where payment_id = p_payment_id
         and razorpay_refund_id is null
       limit 1;
      if found then
        return v_existing;
      end if;
    end if;
  else
    select *
      into v_existing
      from public.billing_refunds
     where payment_id = p_payment_id
       and razorpay_refund_id is null
     limit 1;

    if found then
      return v_existing;
    end if;
  end if;

  v_number := public.billing_next_document_number('RFND', p_fiscal_year);

  insert into public.billing_refunds (
    tenant_id,
    payment_id,
    invoice_id,
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
    pdf_path
  ) values (
    p_tenant_id,
    p_payment_id,
    p_invoice_id,
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
    nullif(btrim(p_razorpay_refund_id), ''),
    p_tenant_id::text || '/' || v_number || '.pdf'
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

revoke all on function public.claim_billing_refund_document(
  uuid, uuid, uuid, timestamptz, text, text, text, text, text,
  text, text, text, text, timestamptz, numeric, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.claim_billing_refund_document(
  uuid, uuid, uuid, timestamptz, text, text, text, text, text,
  text, text, text, text, timestamptz, numeric, text, text, text, text, text
) to service_role;
