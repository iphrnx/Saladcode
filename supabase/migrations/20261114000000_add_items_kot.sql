-- Step 1: Add kot_number and idempotency_key to order_items for Takeaway/Delivery Add Items support
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS kot_number integer NOT NULL DEFAULT 1;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS idempotency_key uuid;

CREATE INDEX IF NOT EXISTS idx_order_items_kot ON public.order_items(order_id, kot_number);
CREATE INDEX IF NOT EXISTS idx_order_items_idempotency ON public.order_items(order_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
