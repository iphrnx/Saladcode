-- One-time repair: complete the seller identity on billing documents
-- issued before Platform Business Details were saved.
--
-- INV-2026-27-00001 was issued at 06:43 UTC; the business details were
-- first saved at 07:26 UTC, so its seller snapshot froze as the bare
-- "The Salad" fallback. The platform owner asked that every The Salad
-- invoice carries the registered legal name and full business address.
-- This fills ONLY the empty seller identity fields — the document's
-- financial facts (number, dates, amounts, buyer, payment references)
-- are untouched — and only on rows whose seller block is entirely
-- empty, so no genuinely-snapshotted identity is ever rewritten.
--
-- The immutability trigger is disabled for exactly the two UPDATEs and
-- re-enabled immediately after; the address text is composed exactly
-- the way composeBusinessAddressLines() does for new issuances, so a
-- re-rendered PDF is indistinguishable from a freshly issued one.

alter table billing_invoices disable trigger billing_invoices_immutable;
alter table billing_refunds  disable trigger billing_refunds_immutable;

with d as (
  select
    nullif(trim(legal_name), '') as legal_name,
    nullif(trim(street), '') as street,
    nullif(concat_ws(', ', nullif(trim(city), ''), nullif(trim(state), '')), '')
      || case
           when nullif(concat_ws(', ', nullif(trim(city), ''), nullif(trim(state), '')), '') is not null
            and nullif(trim(pin_code), '') is not null
           then ' – ' || trim(pin_code)
           else ''
         end as region_line,
    nullif(trim(country), '') as country,
    nullif(trim(email), '') as email,
    nullif(trim(phone), '') as phone
  from platform_business_details
  where singleton
)
update billing_invoices i
set seller_name    = coalesce(d.legal_name, i.seller_name),
    seller_address = nullif(concat_ws(E'\n', d.street, d.region_line, d.country), ''),
    seller_email   = coalesce(d.email, ''),
    seller_phone   = coalesce(d.phone, '')
from d
where d.legal_name is not null
  and coalesce(i.seller_address, '') = ''
  and coalesce(i.seller_email, '') = ''
  and coalesce(i.seller_phone, '') = '';

with d as (
  select
    nullif(trim(legal_name), '') as legal_name,
    nullif(trim(street), '') as street,
    nullif(concat_ws(', ', nullif(trim(city), ''), nullif(trim(state), '')), '')
      || case
           when nullif(concat_ws(', ', nullif(trim(city), ''), nullif(trim(state), '')), '') is not null
            and nullif(trim(pin_code), '') is not null
           then ' – ' || trim(pin_code)
           else ''
         end as region_line,
    nullif(trim(country), '') as country,
    nullif(trim(email), '') as email,
    nullif(trim(phone), '') as phone
  from platform_business_details
  where singleton
)
update billing_refunds r
set seller_name    = coalesce(d.legal_name, r.seller_name),
    seller_address = nullif(concat_ws(E'\n', d.street, d.region_line, d.country), ''),
    seller_email   = coalesce(d.email, ''),
    seller_phone   = coalesce(d.phone, '')
from d
where d.legal_name is not null
  and coalesce(r.seller_address, '') = ''
  and coalesce(r.seller_email, '') = ''
  and coalesce(r.seller_phone, '') = '';

alter table billing_invoices enable trigger billing_invoices_immutable;
alter table billing_refunds  enable trigger billing_refunds_immutable;
