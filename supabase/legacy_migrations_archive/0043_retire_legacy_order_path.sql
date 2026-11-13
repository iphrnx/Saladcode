-- ===========================================================================
-- 0043 — take the legacy order function off the public API
--
-- `public.place_order(p_session_token, p_items, …)` was the original diner
-- order path, written before portion pricing existed. It prices every line from
-- the dish's base price and has no notion of a portion at all — which is how a
-- diner who chose Half was billed the base price and had no portion recorded.
--
-- The `orders` edge function no longer calls it: both the till and the QR page
-- now go through one pricing path that resolves portions (see
-- `priceAndCreateOrder`). Nothing else in the codebase calls it either, and it
-- is still callable with the public anon key (migration 0039 listed it as one of
-- the deliberately-public diner RPCs, when it was the live path). Leaving it
-- open now would keep a bypass that writes orders at the wrong prices.
--
-- The function itself is left in place, executable by the service role only, so
-- nothing that already depends on it breaks and its history stays readable.
-- ===========================================================================

revoke execute on function public.place_order(text, jsonb, text, text, text, text, text) from public, anon, authenticated;
