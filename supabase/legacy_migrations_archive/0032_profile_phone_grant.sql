-- ===========================================================================
-- 0032 — Let the owner save their own phone number
--
-- Migration 0020 took the table-wide UPDATE on `profiles` away from the
-- browser and granted three columns by name instead, so that an owner could
-- not rewrite their own role or tenant. That left a rule that is easy to
-- forget: a new column on `profiles` is not writable by a browser until it
-- is granted by name too.
--
-- `phone` was added in 0031 and is not in the list, so saving the owner's
-- own phone was refused outright.
-- ===========================================================================

grant update (name, avatar, updated_at, phone) on public.profiles to authenticated;
