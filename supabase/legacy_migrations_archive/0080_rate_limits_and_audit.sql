-- ===========================================================================
-- 0080 — rate limits on the anonymous paths, and an audit trail for money
--
-- Two gaps against the production-hardening list.
--
-- 1. The diner endpoints had no rate limit at all. `POST /table-session` mints
--    a session for anyone holding a table's QR token, and the ordering path
--    accepts work from an anonymous caller. Edge functions are stateless and
--    run in many isolates, so an in-memory counter is decoration — the limiter
--    has to live in the database, which is the only shared state there is.
--
-- 2. Payments, refunds and invoice finalisation were not audited. Accepting a
--    table and closing one were; taking money was not. Those are exactly the
--    records that answer "who settled this, and when".
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The limiter
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket        text primary key,
  window_start  timestamptz not null default now(),
  hits          integer not null default 0
);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

/**
 * Count one hit against a bucket. True means "you may proceed".
 *
 * Fixed window, deliberately: a sliding window needs a row per hit, and this
 * runs on the ordering path of every diner. The window is short enough that
 * the boundary burst does not matter for the thing it defends against.
 */
create or replace function public.rate_limit_hit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hits integer;
begin
  insert into public.rate_limits as rl (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update
     set hits = case
                  when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1
                  else rl.hits + 1
                end,
         window_start = case
                  when rl.window_start < now() - make_interval(secs => p_window_seconds) then now()
                  else rl.window_start
                end
  returning hits into v_hits;

  return v_hits <= p_limit;
end $$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Old buckets are useless once their window has long passed. Kept small on
-- purpose; this is the only cleanup the limiter needs.
create or replace function public.prune_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.rate_limits where window_start < now() - interval '1 day' returning 1
  )
  select count(*) into v_count from gone;
  return v_count;
end $$;

revoke execute on function public.prune_rate_limits() from public, anon, authenticated;
grant execute on function public.prune_rate_limits() to service_role;
