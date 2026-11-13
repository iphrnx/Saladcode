-- ===========================================================================
-- 0025 — Google Business Profile OAuth configuration
--
-- The Google client id and client secret are platform-wide, not per
-- restaurant. They were previously read only from the edge function's own
-- environment, which meant the Super Admin had no way to configure them and
-- no way to see whether the platform was configured at all.
--
-- This table holds them. It has row level security with **no policy** for
-- `anon` or `authenticated`, so no signed-in user — restaurant owner or
-- staff — can read or change the credentials. Only the service role (the
-- edge functions) can, and the `super-admin` edge function is the only thing
-- that writes it, behind the `super_admins` allowlist. It masks the secret
-- in every response it returns.
--
-- The edge function's own `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets
-- are still honoured as a fallback, so an existing deployment keeps working
-- without touching this table.
-- ===========================================================================

create table if not exists public.google_oauth_config (
  id            text primary key default 'google_business_profile',
  client_id     text,
  client_secret text,
  redirect_uri  text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null
);

alter table public.google_oauth_config enable row level security;

-- No policies for anon or authenticated: the credentials are invisible to
-- every signed-in user, owner or staff. Only the service role can read them.
revoke all on public.google_oauth_config from anon, authenticated;

insert into public.google_oauth_config (id)
values ('google_business_profile')
on conflict (id) do nothing;
