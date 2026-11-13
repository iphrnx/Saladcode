-- ===========================================================================
-- 0039 — take the default EXECUTE grant off the SECURITY DEFINER functions
--
-- Postgres grants EXECUTE on a new function to PUBLIC, which in Supabase means
-- `anon` and `authenticated` as well. For a SECURITY DEFINER function in the
-- exposed `public` schema that is a hole: it runs with the owner's rights and
-- is reachable at POST /rest/v1/rpc/<name> with no login at all.
--
-- Migration 0036 added three such functions and left the default grant in
-- place, so this was live: with only the public anon key,
--
--   security_list_sessions(<any tenant id>)   returned that restaurant's
--       users' names, emails, IP addresses, user agents and session ids;
--   security_revoke_all_sessions(<tenant>)    revoked every session for that
--       restaurant, and security_revoke_session(<tenant>, <session>) one.
--
-- Verified by probe: all three answered 200 to an anonymous request before this
-- migration. Every caller in the codebase reaches them through the service role
-- (`_shared/sessions.ts`, called by the security/bootstrap/auth edge functions),
-- so revoking the public grant breaks nothing — it only removes the route that
-- was never meant to exist.
--
-- The same default applies to the session-cleanup and metrics triggers, which
-- are called with the service role from the edge functions. `track_*` are
-- trigger functions and are invoked as the table owner, not through EXECUTE.
--
-- Deliberately NOT revoked here: the policy helpers (`is_owner_of`,
-- `is_super_admin`, `current_tenant_id`, `tenant_timezone`) — RLS policies call
-- them as the invoking user, so `anon` and `authenticated` must keep EXECUTE —
-- and the diner RPCs (`start_table_session`, `validate_table_session`,
-- `place_order`), which are the QR flow's intended public surface.
-- ===========================================================================

revoke execute on function public.security_list_sessions(uuid) from public, anon, authenticated;
revoke execute on function public.security_revoke_session(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.security_revoke_all_sessions(uuid) from public, anon, authenticated;
revoke execute on function public.expire_stale_table_sessions() from public, anon, authenticated;
revoke execute on function public.track_order_metrics() from public, anon, authenticated;
revoke execute on function public.track_feature_usage() from public, anon, authenticated;

-- These bodies are fully schema-qualified (`auth.sessions`, `public.profiles`,
-- `public.tenant_sessions`), so they cannot be redirected by a caller-controlled
-- search_path.
alter function public.security_list_sessions(uuid) set search_path = '';
alter function public.security_revoke_session(uuid, uuid) set search_path = '';
alter function public.security_revoke_all_sessions(uuid) set search_path = '';
