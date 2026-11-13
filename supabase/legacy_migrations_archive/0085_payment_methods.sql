-- The ledger accepts the three ways money actually arrives.
--
-- `check_payments.method` was constrained to 'CASH' alone, while the payment
-- dialog offered Cash, UPI and Card and the endpoint recorded every one of them
-- as cash. A restaurant taking ₹1,200 by UPI had a bill that said cash, which is
-- a lie in the one place the books are kept.
--
-- Widening the allowed set is additive: every existing row is 'CASH' and stays
-- valid, and the endpoint still validates what it is given.

alter table public.check_payments
  drop constraint if exists check_payments_method_check;

alter table public.check_payments
  add constraint check_payments_method_check
  check (method in ('CASH', 'UPI', 'CARD'));

comment on column public.check_payments.method is
  'How the money arrived: CASH, UPI or CARD (0085).';
