-- ===========================================================================
-- 0031 — The owner's phone number has somewhere to live
--
-- The owner's "Personal Information" panel has always had a phone field, and
-- it has always been decorative: the form initialised it to an empty string
-- and there was no column to write it to. `profiles` had no phone at all —
-- the phone in the app is the *restaurant's* phone, on `tenants`.
--
-- The panel also had a "Save Profile" button that showed a success message
-- and saved nothing. Now that it saves, the phone needs a home.
-- ===========================================================================

alter table public.profiles add column if not exists phone text;

-- The owner's own details are readable by anyone in their restaurant, the
-- same as the name they already are.
comment on column public.profiles.phone is 'The owner''s own contact number';

