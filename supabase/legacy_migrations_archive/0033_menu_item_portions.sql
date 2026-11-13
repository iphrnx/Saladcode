-- 0033: Portion-wise menu pricing.
--
-- A dish can be sold in portions (Quarter / Half / Full / custom) with a price
-- each. `menu_items.portions` is a jsonb array of {name, price} rows:
--   portions: [{"name":"Quarter","price":60},{"name":"Half","price":110},{"name":"Full","price":200}]
-- NULL or empty = a single-price dish, exactly as before. The base `price`
-- column stays NOT NULL: it is the fallback when no portion is chosen and what
-- analytics reads.
--
-- `order_items.portion` records which portion was ordered, and `price` keeps
-- the portion price at order time (the same snapshot rule as the item name),
-- so recalcOrderTotals keeps working with no change: it multiplies the row's
-- own price by quantity.

alter table menu_items
  add column if not exists portions jsonb default null;

alter table order_items
  add column if not exists portion text default null;

-- Cheap shape guard: portions is either absent or a json array. The per-entry
-- validation (name string, price number, no duplicates, max length) lives in
-- the menu edge function, which is the only writer.
alter table menu_items
  add constraint menu_items_portions_is_array
  check (portions is null or jsonb_typeof(portions) = 'array')
  not valid;

comment on column menu_items.portions is
  'Portion options: jsonb array of {name, price}. Null/empty = single-price item.';
comment on column order_items.portion is
  'Portion name chosen by the customer/staff, null for single-price items. The row price is the portion price snapshot.';
