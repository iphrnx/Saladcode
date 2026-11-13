-- Staff sessions record the client they were created from, so the owner's
-- Security dashboard can show staff sessions with the same detail as owner
-- sessions (browser / OS / device / IP). Purely additive.
alter table public.staff_sessions
  add column if not exists user_agent text,
  add column if not exists ip text;
