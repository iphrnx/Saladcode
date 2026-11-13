-- ============================================================================
-- 0014 — Storage buckets for images
--
-- Four columns hold images: menu_items.image, tenants.logo, staff.avatar and
-- profiles.avatar. Nothing has ever written to a bucket, because the upload
-- component does not upload — it reads the file into a base64 data URL and
-- stores that string in the column.
--
-- That is worth stating plainly because it is the actual cost: a 500 KB photo
-- becomes ~670 KB of text in the row, and `bootstrap` returns menuItems, so
-- every dashboard load carries the images of the whole menu. Eighteen items at
-- half a megabyte each is roughly 12 MB per load, for data the browser could
-- fetch once and cache.
--
-- Three buckets, sized to what each actually stores:
--
--   menu-images  5 MB   dish photos, shown full width on the diner menu
--   brand        2 MB   the restaurant logo; SVG allowed as logos often are
--   avatars      1 MB   staff and owner pictures, small by nature
--
-- All three are public. That is deliberate and load-bearing: the diner browsing
-- a QR menu has no session at all, so the images have to be readable without
-- one. Verified that an unauthenticated GET of a public object returns 200.
--
-- No INSERT/UPDATE/DELETE policy is created, which means only the service role
-- can write. That is also deliberate: staff authenticate with a signed cookie
-- rather than a Supabase session, so `auth.uid()` is null for them and any
-- policy written against it would silently lock them out. Writes go through the
-- edge functions, which already authorise owners and staff through guard().
--
-- Paths are expected to be "<tenant_id>/<file>", so a function can scope a write
-- to the caller's own restaurant.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('menu-images', 'menu-images', true, 5242880,
   array['image/jpeg','image/png','image/webp']),
  ('brand', 'brand', true, 2097152,
   array['image/jpeg','image/png','image/webp','image/svg+xml']),
  ('avatars', 'avatars', true, 1048576,
   array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
