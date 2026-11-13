-- ============================================================================
-- 0011 — Table sessions end when the diner's menu closes
--
-- A session used to end on order completion, after six hours of age, or by hand
-- from the POS. Nothing detected the ordinary case: a diner scans the QR, reads
-- the menu and closes the tab. Closing a browser tab sends no request, so the
-- session stayed ACTIVE and showed up on the POS board as a table that was not
-- really in service.
--
-- The diner's menu already polls validate every 1.5 seconds while it is open,
-- so silence is a reliable signal that the menu is gone. Recording when we last
-- heard from a session turns that poll into a heartbeat, and a session that has
-- been silent for ten minutes ends itself. No manual clearing required.
--
-- The six-hour age cap stays: it is the backstop for a phone that never polls
-- at all.
-- ============================================================================

alter table public.table_sessions
  add column if not exists last_seen_at timestamptz;

-- Backfill from created_at, not now(), so genuinely old sessions age out
-- immediately rather than being given a fresh ten minutes.
update public.table_sessions
   set last_seen_at = created_at
 where last_seen_at is null;

alter table public.table_sessions alter column last_seen_at set default now();
alter table public.table_sessions alter column last_seen_at set not null;

create index if not exists table_sessions_active_seen_idx
  on public.table_sessions (last_seen_at)
  where status = 'ACTIVE';
