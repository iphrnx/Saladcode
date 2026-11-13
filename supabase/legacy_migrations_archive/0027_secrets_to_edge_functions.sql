-- ===========================================================================
-- 0027 — Secrets belong in Edge Function Secrets, not in the database
--
-- The audit found three places where a secret was somewhere it should not
-- have been.
--
-- 1. The Gemini API key was stored in `ai_provider_settings.api_key` and was
--    written from the Super Admin dashboard. A key in a table is a key in the
--    database, in every backup of it, and in the hands of anyone who can read
--    the table. It moves to the `GEMINI_API_KEY` edge function secret, and
--    the column goes.
--
-- 2. The Google OAuth client id and secret were in
--    `google_oauth_config`. They move to the `GOOGLE_CLIENT_ID` and
--    `GOOGLE_CLIENT_SECRET` edge function secrets.
--
-- 3. The worst one: `google_connections` held the restaurant's Google access
--    token and refresh token, and its row level security policy was
--    `FOR ALL TO authenticated` — so a restaurant owner could read their own
--    refresh token straight out of the table with PostgREST and their own
--    session. A refresh token is a credential for their Google account.
--
--    The tokens move to their own table with no access policy at all, so the
--    only thing that can read them is the service role. What is left in
--    `google_connections` is the connection's settings, which are the
--    restaurant's own business and nothing secret.
--
-- What stays in the database is the configuration that is not secret: which
-- model to use, which redirect URI, which features are on.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The Gemini key leaves the database
-- ---------------------------------------------------------------------------

alter table public.ai_provider_settings drop column if exists api_key;

-- ---------------------------------------------------------------------------
-- 2. The Google client credentials leave the database
-- ---------------------------------------------------------------------------

alter table public.google_oauth_config drop column if exists client_id;
alter table public.google_oauth_config drop column if exists client_secret;

-- ---------------------------------------------------------------------------
-- 3. The restaurant's own Google tokens get their own table
-- ---------------------------------------------------------------------------

create table if not exists public.google_oauth_tokens (
  connection_id   uuid primary key references public.google_connections(id) on delete cascade,
  access_token    text not null,
  refresh_token   text,
  token_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- No policy for anon or authenticated, and the grants are revoked: only the
-- service role — the edge functions — can read a token. The table is not
-- reachable from the browser at all.
alter table public.google_oauth_tokens enable row level security;
revoke all on public.google_oauth_tokens from anon, authenticated;

-- Move what is already there.
insert into public.google_oauth_tokens (connection_id, access_token, refresh_token, token_expires_at)
select id, access_token, refresh_token, token_expires_at
from public.google_connections
where access_token is not null
on conflict (connection_id) do update
set access_token = excluded.access_token,
    refresh_token = excluded.refresh_token,
    token_expires_at = excluded.token_expires_at;

alter table public.google_connections drop column if exists access_token;
alter table public.google_connections drop column if exists refresh_token;
alter table public.google_connections drop column if exists token_expires_at;

-- The connection's own policy becomes read-only, and the columns a restaurant
-- must not choose for itself are protected. The account and the location are
-- chosen by the owner through the edge function, which checks the choice
-- against their own Google token; a direct UPDATE would bypass that check.
drop policy if exists google_connections_owner_all on public.google_connections;

create policy "google_connections_owner_read"
  on public.google_connections
  for select
  to authenticated
  using (is_owner_of(tenant_id));

-- The public reviews policy looks the connection up, so anon has to be able
-- to read the connection row. There is nothing secret left in it.
create policy "google_connections_public_read"
  on public.google_connections
  for select
  to anon
  using (enabled and show_public);

-- ---------------------------------------------------------------------------
-- 4. The webhook events were readable by anyone with the public key
-- ---------------------------------------------------------------------------

alter table public.subscription_webhook_events enable row level security;
revoke all on public.subscription_webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The payments policy was granted to `public`
-- ---------------------------------------------------------------------------

drop policy if exists "Super admins can manage all payments" on public.subscription_payments;

create policy "Super admins can manage all payments"
  on public.subscription_payments
  for all
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_super_admin = true
    )
  );

-- ---------------------------------------------------------------------------
-- 6. The AI request log
-- ---------------------------------------------------------------------------

-- What the AI features have been asked to do, and what came back. It holds
-- no prompt text and no response text — only the shape of the call — so it
-- is safe to keep.
create table if not exists public.ai_request_logs (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  model         text,
  action        text not null,
  tenant_id     uuid references public.tenants(id) on delete set null,
  status        text not null,
  duration_ms   integer,
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists ai_request_logs_created_idx
  on public.ai_request_logs (created_at desc);

create index if not exists ai_request_logs_tenant_idx
  on public.ai_request_logs (tenant_id);

alter table public.ai_request_logs enable row level security;

-- Only the service role reads it. The Super Admin reaches it through the
-- `super-admin` edge function, which checks the allowlist.
revoke all on public.ai_request_logs from anon, authenticated;
