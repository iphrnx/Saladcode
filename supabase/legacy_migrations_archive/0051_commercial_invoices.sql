-- Commercial invoices without any tax layer, plus storage, immutability
-- and refund documents.
--
-- 0050 was applied with a GST design that was redirected before any of it
-- deployed: the tables are empty and no code ever read them, so the tax
-- columns are dropped here rather than left to rot. Commercial invoices
-- show what was bought and what was paid — no tax computation, no GSTIN,
-- no rates.

-- ---- the invoice table: drop the tax columns, add period/status/pdf ----
drop table if exists platform_invoice_settings;

alter table billing_invoices
  drop column if exists seller_gstin,
  drop column if exists buyer_gstin,
  drop column if exists place_of_supply,
  drop column if exists gst_rate,
  drop column if exists taxable_amount,
  drop column if exists cgst_amount,
  drop column if exists sgst_amount,
  drop column if exists igst_amount;

alter table billing_invoices
  add column if not exists period_start timestamptz,
  add column if not exists period_end timestamptz,
  add column if not exists payment_status text not null default 'paid',
  add column if not exists payment_method text,
  add column if not exists pdf_path text;

-- ---- numbering: one counter table, one series per document kind ----
drop function if exists billing_next_invoice_number(text);

alter table billing_invoice_counters
  add column if not exists series text not null default 'INV';
alter table billing_invoice_counters
  drop constraint if exists billing_invoice_counters_pkey;
alter table billing_invoice_counters
  add primary key (series, fiscal_year);

-- Atomically take the next number in a series for a fiscal year:
-- INV-2026-27-00001 for invoices, RFND-2026-27-00001 for refunds. The
-- advisory lock serialises concurrent issues.
create or replace function billing_next_document_number(
  p_series text, p_fiscal_year text
) returns text
language plpgsql
as $$
declare
  v_next int;
begin
  perform pg_advisory_xact_lock(hashtext('billing_document_counter'));
  insert into billing_invoice_counters (series, fiscal_year, last_number)
  values (p_series, p_fiscal_year, 1)
  on conflict (series, fiscal_year) do update
  set last_number = billing_invoice_counters.last_number + 1
  returning last_number into v_next;
  return p_series || '-' || p_fiscal_year || '-' || lpad(v_next::text, 5, '0');
end;
$$;
revoke execute on function billing_next_document_number(text, text)
  from public, anon, authenticated;

-- ---- refund documents, each linked to the invoice it reverses ----
create table if not exists billing_refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  payment_id uuid not null references subscription_payments(id),
  invoice_id uuid references billing_invoices(id),
  refund_number text not null unique,
  refund_date timestamptz not null,
  fiscal_year text not null,
  seller_name text not null,
  seller_address text,
  buyer_name text not null,
  buyer_email text,
  buyer_address text,
  original_invoice_number text,
  original_invoice_date timestamptz,
  amount numeric not null,
  currency text not null default 'INR',
  description text not null,
  razorpay_payment_id text,
  razorpay_order_id text,
  razorpay_refund_id text,
  pdf_path text,
  created_at timestamptz not null default now()
);
alter table billing_refunds enable row level security;
-- Only the service role issues or reads refund documents.
create unique index if not exists billing_refunds_payment_id_key
  on billing_refunds(payment_id);

-- ---- immutability ----
-- A financial document that can be edited is not a document. Nothing —
-- not even the service role — may change or remove a row once issued;
-- a correction is a new document, never an edit.
create or replace function billing_document_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'issued billing documents are immutable';
end;
$$;

drop trigger if exists billing_invoices_immutable on billing_invoices;
create trigger billing_invoices_immutable
  before update or delete on billing_invoices
  for each row execute function billing_document_immutable();

drop trigger if exists billing_refunds_immutable on billing_refunds;
create trigger billing_refunds_immutable
  before update or delete on billing_refunds
  for each row execute function billing_document_immutable();

-- ---- the private bucket the PDFs live in ----
insert into storage.buckets (id, name, public)
values ('billing-documents', 'billing-documents', false)
on conflict (id) do nothing;
