-- ===========================================================================
-- 0081 — one signature for create_order_tx
--
-- Exactly the bug 0079 fixed for open_table_check, in the same shape, in the
-- function that takes orders. 0076 and 0077 left the four-argument version
-- beside the five-argument one; the edge function stopped sending `p_status`
-- when it is not PENDING_ACTIVATION (so an un-migrated database would still
-- work), and PostgREST then could not choose:
--
--   Could not choose the best candidate function between:
--     create_order_tx(p_order, p_items, p_promo_code_id, p_idempotency_key)
--     create_order_tx(p_order, p_items, p_promo_code_id, p_idempotency_key, p_status)
--
-- Every order placed from a diner's phone failed. The client's order queue kept
-- them ("Still no answer — kept the order pending"), which is why nothing was
-- lost — but nothing was reaching the kitchen either.
--
-- Fix: drop the four-argument version. The migration it was kept for has long
-- since been applied, so the compatibility it bought is gone and all it does
-- now is make calls ambiguous.
-- ===========================================================================

drop function if exists public.create_order_tx(jsonb, jsonb, uuid, uuid);

comment on function public.create_order_tx(jsonb, jsonb, uuid, uuid, text) is
  'Price and commit one order in a transaction (0056, 0076, 0078). 4-arg overload dropped in 0081.';

-- And a guard so this cannot recur silently: any future function in this
-- schema that exists in two arities is a call waiting to be ambiguous.
do $$
declare
  r record;
begin
  for r in
    select p.proname, array_agg(p.pronargs order by p.pronargs) as arities
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
     group by p.proname
    having count(*) > 1
  loop
    raise notice 'overloaded public function: % (arities %)', r.proname, r.arities;
  end loop;
end $$;
