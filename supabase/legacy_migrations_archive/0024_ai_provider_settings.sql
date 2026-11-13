-- ===========================================================================
-- 0024 — AI provider settings
--
-- The Gemini API key has to be settable from the Super Admin Dashboard, which
-- means it cannot live in a build-time environment variable alone — and it must
-- never reach a restaurant owner or a member of staff.
--
-- This table is read and written by the service role only. There is no policy
-- for `anon` or `authenticated`, so no signed-in user can read the key or
-- change it, whatever their role. The Super Admin manages it through the
-- `super-admin` edge function, which is behind the `super_admins` allowlist
-- check and which masks the key in every response it returns.
--
-- The edge function's own `GEMINI_API_KEY` secret is still honoured as a
-- fallback, so a deployment can work without touching this table at all.
-- ===========================================================================

create table if not exists public.ai_provider_settings (
  provider    text primary key,
  api_key     text,
  text_model  text not null default 'gemini-3.8-flash',
  image_model text not null default 'gemini-nano-banana-2.1',
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

alter table public.ai_provider_settings enable row level security;

-- No policies for anon or authenticated: the key is invisible to every
-- signed-in user, including restaurant owners and staff. Only the service
-- role — the edge functions — can read it.
revoke all on public.ai_provider_settings from anon, authenticated;

insert into public.ai_provider_settings (provider, text_model, image_model)
values ('gemini', 'gemini-3.8-flash', 'gemini-nano-banana-2.1')
on conflict (provider) do nothing;
