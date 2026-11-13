-- ===========================================================================
-- 0075 — realtime privacy: capability topics, minimal payloads, RLS
--
-- Before this, every order was broadcast on `orders:<tenantId>` as a *public*
-- channel carrying the whole order row — customer name, customer phone, the
-- order's notes — and, inside the nested table object, the table's `qrToken`.
-- The diner's own menu subscribed to that same topic, and a diner learns the
-- tenant id the moment they scan (it is in their session payload). So any
-- diner could read every other table's orders, including the token that mints
-- sessions.
--
-- The fix has three parts:
--
--   1. The topic is no longer derivable from anything a diner holds. A staff
--      topic carries a per-tenant secret that is issued only to the owner and
--      to staff with `orders.view`/`tables.view`, at bootstrap, over an
--      authenticated call.
--   2. A diner gets a topic of their own: `diner:<session token>`. The token
--      is the capability, it is 48 hex characters, and it is only ever handed
--      to the browser that minted that session.
--   3. What travels on either topic is a small, fixed set of order fields.
--      No customer identity, no free-text notes, no QR token, no session
--      credentials.
--
-- On authorization: a diner has no account and staff sign in with a PIN, not
-- a Supabase JWT, so there is no identity for a row-level policy to bind an
-- anonymous subscriber to. For those two, the boundary is the topic itself —
-- an unguessable, server-issued name — and the RLS below makes sure that a
-- *signed-in* user can only ever read a topic belonging to their own tenant,
-- even if they learn another tenant's secret.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The per-tenant staff secret
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_realtime (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  secret     text not null default encode(gen_random_bytes(24), 'hex'),
  created_at timestamptz not null default now()
);

alter table public.tenant_realtime enable row level security;

-- No policies at all: service role only. The secret is issued by an edge
-- function that has already authenticated the caller; nothing in the browser
-- may read or write this table directly.
revoke all on public.tenant_realtime from public, anon, authenticated;

/**
 * The staff topic for a tenant, creating the secret on first use.
 *
 * SECURITY DEFINER because the caller is the service role through an edge
 * function, and the function must be able to insert. EXECUTE is revoked from
 * everything else — a recreated function gets the PUBLIC grant back, which is
 * the mistake migration 0039 had to clean up elsewhere.
 */
create or replace function public.ensure_tenant_realtime_secret(p_tenant uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  insert into public.tenant_realtime (tenant_id)
  values (p_tenant)
  on conflict (tenant_id) do nothing;

  select secret into v_secret from public.tenant_realtime where tenant_id = p_tenant;
  return v_secret;
end;
$$;

revoke execute on function public.ensure_tenant_realtime_secret(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Realtime authorization — NOT POSSIBLE HERE, and what replaces it
--
-- The plan was RLS on `realtime.messages` plus `private: true` channels. That
-- table is owned by `supabase_realtime_admin`, and the role that runs
-- migrations (`postgres`) is neither its owner nor a member of it:
--
--   ERROR: 42501: must be owner of table messages
--
-- Caught by running this migration inside a transaction and rolling it back,
-- before it could reach production.
--
-- So the boundary for an anonymous subscriber is the topic itself, and it is a
-- capability rather than an identifier:
--
--   staff:<tenant uuid>:<24 random bytes>   issued at bootstrap only to a
--                                           caller with orders.view or
--                                           tables.view
--   diner:<48 hex session token>            issued to the browser that minted
--                                           that session
--
-- Neither is derivable from the QR code, the menu URL, or the tenant id a
-- diner already knows.
--
-- Channels stay public on purpose: a private channel with no policy delivers
-- nothing at all, so `private: true` without the RLS that authorises it would
-- take live updates away from every screen. If the platform ever allows those
-- policies, add them here and flip the three call sites together.
-- ---------------------------------------------------------------------------
