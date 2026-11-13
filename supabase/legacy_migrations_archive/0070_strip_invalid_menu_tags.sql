-- Strip menu-item tags that Menu Management does not know.
--
-- The AI menu scanner saved tags it invented — "healthy" (rendered as "FIT"
-- on cards) and "signature" — that the owner can neither see nor edit in the
-- Menu Management picker. Only the eight preset tags may exist on a dish.
--
-- Deliberately conservative:
--   * rows whose tags are ALL valid are untouched, byte for byte;
--   * rows with a mix keep their valid tokens verbatim (case and spacing
--     preserved) with only the invalid ones removed;
--   * rows whose every tag was invalid end up with NULL, not an empty
--     string, matching how "no tags" is stored everywhere else.

update public.menu_items mi
set tags = kept.cleaned
from (
  select mi2.id, nullif(string_agg(x.tok, ', '), '') as cleaned
  from public.menu_items mi2
  cross join lateral unnest(string_to_array(mi2.tags, ',')) as raw_tok
  cross join lateral (select trim(raw_tok) as tok) as x
  where mi2.tags is not null
    and lower(x.tok) in ('veg','non-veg','vegan','spicy','jain','bestseller','new','gluten-free')
  group by mi2.id
) kept
where mi.id = kept.id
  and exists (
    select 1
    from unnest(string_to_array(mi.tags, ',')) as t
    where trim(t) <> ''
      and lower(trim(t)) not in ('veg','non-veg','vegan','spicy','jain','bestseller','new','gluten-free')
  );

update public.menu_items
set tags = null
where tags is not null
  and not exists (
    select 1
    from unnest(string_to_array(tags, ',')) as t
    where lower(trim(t)) in ('veg','non-veg','vegan','spicy','jain','bestseller','new','gluten-free')
  );
