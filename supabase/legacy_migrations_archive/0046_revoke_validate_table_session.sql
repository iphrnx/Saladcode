-- ===========================================================================
-- 0046 — take the retired session validator off the public API
--
-- `public.validate_table_session(p_session_token)` was the original diner
-- session check, superseded when the `table-session` edge function began
-- validating inline and calling `session_is_abandoned` by RPC instead. Nothing
-- in the codebase has called it since — but migration 0039 listed it as one of
-- the deliberately-public diner RPCs, so its EXECUTE grant to PUBLIC, anon and
-- authenticated is still live. Anyone holding the anon key can invoke it today.
--
-- It ends table sessions with the semantics of the era it was written in
-- (before the 0040/0041 lifecycle rules), so leaving it open keeps a stale
-- session-ending path reachable by anyone. This mirrors what 0043 did for the
-- legacy `place_order` RPC: the function stays in place, executable by the
-- service role only, so nothing that depends on it breaks and its history
-- stays readable.
-- ===========================================================================

revoke execute on function public.validate_table_session(text) from public, anon, authenticated;
