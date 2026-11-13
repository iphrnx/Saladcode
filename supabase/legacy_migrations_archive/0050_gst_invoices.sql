-- GST invoices (billing P1-6) and scheduled renewals (P1-5/P1-8).
--
-- platform_invoice_settings is one row describing the seller on every
-- invoice The Salad issues. Until the platform owner fills it in, the
-- invoice endpoint issues plain payment receipts with no GST breakup —
-- GST details are never invented.

create table if not exists platform_invoice_settings (
  id int primary key default 1 check (id = 1),
  legal_name text not null,
  gstin text,
  address text,
  gst_rate numeric not null default 18,
  updated_at timestamptz not null default now()
);

alter table platform_invoice_settings enable row level security;
-- No policies: anon and authenticated get nothing. Only the service role
-- (the edge functions) reads it.

-- One invoice per payment, snapshotted at issue time so later edits to the
-- tenant, the plan catalogue or the platform settings cannot rewrite a tax
-- document that was already issued.
create table if not exists billing_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  payment_id uuid not null references subscription_payments(id),
  invoice_number text not null unique,
  invoice_date timestamptz not null,
  fiscal_year text not null,
  seller_name text not null,
  seller_gstin text,
  seller_address text,
  buyer_name text not null,
  buyer_email text,
  buyer_gstin text,
  buyer_address text,
  place_of_supply text,
  gst_rate numeric,
  taxable_amount numeric not null,
  cgst_amount numeric,
  sgst_amount numeric,
  igst_amount numeric,
  total_amount numeric not null,
  currency text not null default 'INR',
  description text not null,
  razorpay_payment_id text,
  razorpay_order_id text,
  created_at timestamptz not null default now()
);

alter table billing_invoices enable row level security;
-- Only the service role issues or reads invoices.
create unique index if not exists billing_invoices_payment_id_key
  on billing_invoices(payment_id);

-- Invoice numbers restart each Indian fiscal year (Apr-Mar):
-- INV-2026-27-00001.
create table if not exists billing_invoice_counters (
  fiscal_year text primary key,
  last_number int not null default 0
);
alter table billing_invoice_counters enable row level security;

-- Atomically take the next invoice number for a fiscal year. The advisory
-- lock serialises concurrent invoices, so two owners downloading at the
-- same moment cannot take the same number.
create or replace function billing_next_invoice_number(p_fiscal_year text)
returns text
language plpgsql
as $$
declare
  v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('billing_invoice_counter'));
  insert into billing_invoice_counters (fiscal_year, last_number)
  values (p_fiscal_year, 1)
  on conflict (fiscal_year) do update
  set last_number = billing_invoice_counters.last_number + 1
  returning last_number into v_next;
  return 'INV-' || p_fiscal_year || '-' || lpad(v_next::text, 5, '0');
end;
$$;

-- The 0039 lesson: Postgres grants EXECUTE on new functions to PUBLIC
-- (which includes anon). Revoke so only the service role can call it.
revoke execute on function billing_next_invoice_number(text)
  from public, anon, authenticated;

-- A subscription bought to start at the end of the already-paid period
-- records when it will start, so the billing page can say so instead of
-- pretending a charge is pending.
alter table subscription_checkouts
  add column if not exists scheduled_start_at timestamptz;
