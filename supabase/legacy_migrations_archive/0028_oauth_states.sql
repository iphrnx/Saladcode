-- ===========================================================================
-- 0028 — Single-use OAuth states
--
-- The sign-in state used to be an HMAC over the tenant id, signed with the
-- service role key. Two problems with that:
--
--   - it was replayable for the fifteen minutes it was valid;
--   - it was tied to whichever key the platform happened to inject, so a
--     rotation invalidated every sign-in in flight.
--
-- A state is now a row. It is created when a sign-in starts, it names the
-- restaurant it is for, and it is **spent** the moment it is used. The table
-- has no access policy, so only the service role can read or write it.
-- ===========================================================================

create table if not exists public.google_oauth_states (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create index if not exists google_oauth_states_expires_idx
  on public.google_oauth_states (expires_at);

alter table public.google_oauth_states enable row level security;
revoke all on public.google_oauth_states from anon, authenticated;
