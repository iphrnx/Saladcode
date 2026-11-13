-- 0034: Portion pricing integrity, stable portion IDs, deduplication, and base price sync.
--
-- 1. Adds `order_items.portion_id` so orders record both the stable portion ID
--    and the display portion name snapshot.
-- 2. Adds `normalize_menu_item_portions()` BEFORE INSERT OR UPDATE trigger on
--    `menu_items` so the database itself guarantees:
--    - Every portion entry has a stable `id`, canonicalised `name` ("quarter"
--      -> "Quarter", "half" -> "Half", "full" -> "Full"), and non-negative price.
--    - Duplicate portion names (case-insensitive) are never stored.
--    - When a dish has portions, `menu_items.price` is automatically synced to
--      the lowest portion price so a dish never carries a conflicting standalone
--      base price alongside its portion prices.
-- 3. Normalises existing rows in-place without deleting any production data.

alter table order_items
  add column if not exists portion_id text default null;

create or replace function public.normalize_menu_item_portions()
returns trigger
language plpgsql
as $$
declare
  raw_elem jsonb;
  raw_name text;
  clean_name text;
  lower_name text;
  raw_id text;
  clean_id text;
  raw_price numeric;
  seen_names text[] := array[]::text[];
  cleaned jsonb := '[]'::jsonb;
  min_price double precision := null;
begin
  if new.portions is null or jsonb_typeof(new.portions) <> 'array' then
    new.portions := null;
    return new;
  end if;

  for raw_elem in select * from jsonb_array_elements(new.portions)
  loop
    if jsonb_typeof(raw_elem) = 'object' then
      raw_name := btrim(coalesce(raw_elem->>'name', ''));
      lower_name := lower(raw_name);

      if lower_name = 'quarter' then
        clean_name := 'Quarter';
      elsif lower_name = 'half' then
        clean_name := 'Half';
      elsif lower_name = 'full' then
        clean_name := 'Full';
      elsif lower_name = 'regular' then
        clean_name := 'Regular';
      elsif lower_name = 'small' then
        clean_name := 'Small';
      elsif lower_name = 'medium' then
        clean_name := 'Medium';
      elsif lower_name = 'large' then
        clean_name := 'Large';
      else
        clean_name := left(raw_name, 40);
      end if;

      begin
        raw_price := round((raw_elem->>'price')::numeric, 2);
      exception when others then
        raw_price := null;
      end;

      if clean_name <> '' and raw_price is not null and raw_price >= 0 and not (lower_name = any(seen_names)) then
        seen_names := array_append(seen_names, lower_name);
        raw_id := lower(btrim(coalesce(raw_elem->>'id', '')));
        if raw_id = '' then
          raw_id := lower_name;
        end if;
        clean_id := btrim(regexp_replace(raw_id, '[^a-z0-9]+', '-', 'g'), '-');
        if clean_id = '' then
          clean_id := 'portion-' || array_length(seen_names, 1)::text;
        end if;

        cleaned := cleaned || jsonb_build_array(
          jsonb_build_object(
            'id', clean_id,
            'name', clean_name,
            'price', raw_price::double precision
          )
        );

        if min_price is null or (raw_price::double precision) < min_price then
          min_price := raw_price::double precision;
        end if;

        if jsonb_array_length(cleaned) >= 8 then
          exit;
        end if;
      end if;
    end if;
  end loop;

  if jsonb_array_length(cleaned) = 0 then
    new.portions := null;
  else
    new.portions := cleaned;
    if min_price is not null then
      new.price := min_price;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_normalize_menu_item_portions on public.menu_items;
create trigger trg_normalize_menu_item_portions
  before insert or update on public.menu_items
  for each row
  execute function public.normalize_menu_item_portions();

-- Backfill existing portioned menu items in-place (preserves all dishes)
update public.menu_items
  set portions = portions
  where portions is not null;
