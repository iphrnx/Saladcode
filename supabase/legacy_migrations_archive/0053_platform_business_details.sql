-- The platform's own legal identity, editable from Super Admin →
-- Settings → Billing & Invoices. A single row (the singleton CHECK),
-- readable and writable only through the service role — no policies
-- means no anon or authenticated access at all; the super-admin edge
-- function is the only door, behind its allowlist guard.
--
-- Also completes the seller snapshot on the financial documents:
-- seller_name/seller_address existed, seller_email/seller_phone are
-- added so every issued document freezes the identity it was issued
-- with. Editing the business details afterwards can never change an
-- issued invoice — the immutability triggers see to that.

create table if not exists public.platform_business_details (
  singleton     boolean primary key default true check (singleton),
  legal_name    text not null default '',
  street        text not null default '',
  city          text not null default '',
  state         text not null default '',
  pin_code      text not null default '',
  country       text not null default 'India',
  email         text not null default '',
  phone         text not null default '',
  gstin         text not null default '',  -- stored for future use; not rendered on documents
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

alter table public.platform_business_details enable row level security;
-- No policies on purpose: only the service role reaches this table.

alter table public.billing_invoices add column if not exists seller_email text not null default '';
alter table public.billing_invoices add column if not exists seller_phone text not null default '';
alter table public.billing_refunds  add column if not exists seller_email text not null default '';
alter table public.billing_refunds  add column if not exists seller_phone text not null default '';
