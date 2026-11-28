-- ============================================================================
-- Migration: 20261127000006_atomic_claim_refund_document.sql
-- Purpose:
--   Atomically claim one billing_refunds row and reserve one RFND document
--   number per refund (under an advisory lock keyed by razorpay_refund_id or
--   payment_id) before uploading the PDF, so concurrent deliveries produce
--   one row, consume one number, and retries resume with the same path.
-- ============================================================================

alter table public.billing_refunds
  add column if not exists linked_razorpay_refund_id text;

create unique index if not exists billing_refunds_linked_razorpay_refund_id_key
  on public.billing_refunds (linked_razorpay_refund_id)
  where linked_razorpay_refund_id is not null;

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
  v_payment_ref         text := nullif(btrim(p_razorpay_payment_id), '');
  v_currency            text := upper(coalesce(nullif(btrim(p_currency), ''), 'INR'));
  v_processed_count     int := 0;
  v_legacy_count        int := 0;
  v_total_receipt_count int := 0;
  v_processed_refund_id text;
  v_processed_amount    numeric;
  v_processed_currency  text;
  v_processed_at        timestamptz;
  v_payment_amount      numeric;
begin
  v_lock_key := 'billing_refund:' || p_payment_id::text;
  perform pg_advisory_xact_lock(hashtext(v_lock_key));

  select sp.amount
    into v_payment_amount
    from public.subscription_payments sp
   where sp.id = p_payment_id
     and sp.tenant_id = p_tenant_id
   limit 1;

  select count(*)::int
    into v_processed_count
    from public.subscription_refunds
   where payment_id = p_payment_id
     and status = 'processed';

  select count(*)::int,
         count(*) filter (where razorpay_refund_id is null and linked_razorpay_refund_id is null)::int
    into v_total_receipt_count, v_legacy_count
    from public.billing_refunds
   where payment_id = p_payment_id
     and tenant_id = p_tenant_id;

  if v_refund_id is not null then
    select *
      into v_existing
      from public.billing_refunds
     where razorpay_refund_id = v_refund_id
        or linked_razorpay_refund_id = v_refund_id
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

    if v_processed_count = 1 then
      select nullif(btrim(sr.razorpay_refund_id), ''),
             sr.amount,
             upper(coalesce(nullif(btrim(sr.currency), ''), 'INR')),
             sr.processed_at
        into v_processed_refund_id, v_processed_amount, v_processed_currency, v_processed_at
        from public.subscription_refunds sr
       where sr.payment_id = p_payment_id
         and sr.status = 'processed'
       limit 1;
    end if;

    -- Reconcile an unambiguous legacy ID-less receipt only with reliable
    -- event identity evidence (full-payment refund OR matching refund event
    -- timestamp) in addition to payment, tenant, amount, currency, and
    -- available refund identifiers. Persist linked_razorpay_refund_id
    -- atomically while keeping razorpay_refund_id immutable.
    if v_processed_count <= 1 and v_total_receipt_count = 1 and v_legacy_count = 1 then
      if v_processed_count = 0
         or (
           (v_processed_refund_id is null or v_processed_refund_id = v_refund_id)
           and (v_processed_amount is null or p_amount is null or v_processed_amount = p_amount)
           and (v_processed_currency = v_currency)
         )
      then
        select *
          into v_existing
          from public.billing_refunds br
         where br.payment_id = p_payment_id
           and br.tenant_id = p_tenant_id
           and br.razorpay_refund_id is null
           and br.linked_razorpay_refund_id is null
           and br.amount is not null
           and p_amount is not null
           and br.amount = p_amount
           and upper(coalesce(nullif(btrim(br.currency), ''), 'INR')) = v_currency
           and (
             v_payment_ref is null
             or nullif(btrim(br.razorpay_payment_id), '') is null
             or br.razorpay_payment_id = v_payment_ref
           )
           and (
             (v_payment_amount is not null and br.amount = v_payment_amount and p_amount = v_payment_amount)
             or (
               coalesce(v_processed_at, p_refund_date) is not null
               and br.refund_date is not null
               and abs(extract(epoch from (br.refund_date - coalesce(v_processed_at, p_refund_date)))) <= 2
             )
           )
         limit 1;
        if found then
          update public.billing_refunds
             set linked_razorpay_refund_id = v_refund_id,
                 pdf_path = coalesce(nullif(btrim(pdf_path), ''), tenant_id::text || '/' || refund_number || '.pdf')
           where id = v_existing.id
             and razorpay_refund_id is null
             and linked_razorpay_refund_id is null
          returning * into v_existing;
          return v_existing;
        end if;
      end if;
    end if;

    -- Ambiguous legacy guard: if any unlinked ID-less receipt on this payment
    -- could already be documenting this refund (matching amount/currency or
    -- null amount), leave it unresolved without allocating a second receipt.
    if v_legacy_count > 0 and exists (
      select 1
        from public.billing_refunds br
       where br.payment_id = p_payment_id
         and br.tenant_id = p_tenant_id
         and br.razorpay_refund_id is null
         and br.linked_razorpay_refund_id is null
         and (br.amount is null or (p_amount is not null and br.amount = p_amount))
         and upper(coalesce(nullif(btrim(br.currency), ''), 'INR')) = v_currency
    ) then
      return null;
    end if;
  else
    select *
      into v_existing
      from public.billing_refunds br
     where br.payment_id = p_payment_id
       and br.tenant_id = p_tenant_id
       and br.razorpay_refund_id is null
       and br.linked_razorpay_refund_id is null
       and (br.amount is null or p_amount is null or br.amount = p_amount)
       and upper(coalesce(nullif(btrim(br.currency), ''), 'INR')) = v_currency
       and (
         v_payment_ref is null
         or nullif(btrim(br.razorpay_payment_id), '') is null
         or br.razorpay_payment_id = v_payment_ref
       )
       and (
         (v_processed_count = 0 and v_total_receipt_count = 1)
         or (v_payment_amount is not null and br.amount = v_payment_amount and p_amount = v_payment_amount)
         or (
           p_refund_date is not null
           and br.refund_date is not null
           and abs(extract(epoch from (br.refund_date - p_refund_date))) <= 2
         )
       )
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

    -- Reverse delivery order: if a provider-keyed receipt already exists as
    -- the sole receipt on a single-refund payment with reliable event identity
    -- match, reuse it rather than minting a duplicate ID-less receipt.
    if v_processed_count <= 1 and v_total_receipt_count = 1 then
      select sr.processed_at
        into v_processed_at
        from public.subscription_refunds sr
       where sr.payment_id = p_payment_id
         and sr.status = 'processed'
       limit 1;

      select *
        into v_existing
        from public.billing_refunds br
       where br.payment_id = p_payment_id
         and br.tenant_id = p_tenant_id
         and br.amount is not null
         and p_amount is not null
         and br.amount = p_amount
         and upper(coalesce(nullif(btrim(br.currency), ''), 'INR')) = v_currency
         and (
           v_payment_ref is null
           or nullif(btrim(br.razorpay_payment_id), '') is null
           or br.razorpay_payment_id = v_payment_ref
         )
         and (
           (v_payment_amount is not null and br.amount = v_payment_amount and p_amount = v_payment_amount)
           or (
             coalesce(v_processed_at, p_refund_date) is not null
             and br.refund_date is not null
             and abs(extract(epoch from (br.refund_date - coalesce(v_processed_at, p_refund_date)))) <= 2
           )
         )
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

    -- Ambiguous guard for ID-less call when an existing receipt matches amount/currency
    if exists (
      select 1
        from public.billing_refunds br
       where br.payment_id = p_payment_id
         and br.tenant_id = p_tenant_id
         and (br.amount is null or (p_amount is not null and br.amount = p_amount))
         and upper(coalesce(nullif(btrim(br.currency), ''), 'INR')) = v_currency
    ) then
      return null;
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
    linked_razorpay_refund_id,
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
