-- A scheduled checkout has no order.
--
-- When a restaurant buys a recurring plan while paid time is still on the
-- clock, the Razorpay subscription is created to START at the end of the
-- paid period and no order is made: nothing is charged today, the first
-- charge lands at the boundary. The checkout row is still recorded (it is
-- what `charged` later settles), but 0044's NOT NULL on razorpay_order_id
-- rejected that row, so every one-time to recurring switch answered 503
-- after the Razorpay subscription had already been created.
--
-- Nullable is the honest shape: an immediate checkout has an order, a
-- scheduled one does not. The unique index is unaffected; Postgres treats
-- NULLs as distinct, and `verify` only ever matches real order ids.

alter table public.subscription_checkouts
  alter column razorpay_order_id drop not null;

comment on column public.subscription_checkouts.razorpay_order_id is
  'The Razorpay order for an immediate checkout. NULL for a scheduled mandate, where nothing is charged until the paid period ends.';
