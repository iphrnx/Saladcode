-- Security dashboard: a person, not an address.
--
-- Three things were wrong underneath the display:
--   * an audit event started by a staff PIN had nowhere to name that staff
--     member — `security_logs.user_id` only ever pointed at `profiles`, so a
--     staff action resolved to "System";
--   * owner sessions carried no role, so the owner row had no role label;
--   * "Revoke All" had no way to spare the session doing the revoking, so an
--     owner clicking it signed themselves out too.
--
-- All additive except the two function bodies, which only gain behaviour.

alter table public.security_logs
  add column if not exists actor_staff_id uuid references public.staff(id) on delete set null;

create index if not exists security_logs_actor_staff_idx
  on public.security_logs (actor_staff_id)
  where actor_staff_id is not null;

-- Owner sessions now say which role they are on, the way staff sessions do.
-- The return type gains a column, and Postgres cannot replace a function whose
-- OUT columns changed — so it is dropped and recreated.
drop function if exists public.security_list_sessions(uuid);

create or replace function public.security_list_sessions(p_tenant_id uuid)
returns table(id uuid, user_id uuid, name text, email text, role text, created_at timestamp with time zone, updated_at timestamp with time zone, not_after timestamp with time zone, user_agent text, ip text, aal text)
language sql
stable
security definer
set search_path to ''
as $function$
  select s.id, s.user_id, p.name, p.email,
         coalesce(r.name, p.role, 'Owner') as role,
         s.created_at, s.updated_at, s.not_after, s.user_agent, s.ip, s.aal
  from auth.sessions s
  join public.profiles p on p.id = s.user_id
  left join public.roles r on r.id = p.role_id
  where p.tenant_id = p_tenant_id
    and (s.not_after is null or s.not_after > now())
  order by s.updated_at desc
$function$;

-- Revoke every session of the tenant EXCEPT one. The caller passes its own
-- session id: an owner emptying the list should not lock themselves out of
-- the page they are standing on. Default null keeps the old behaviour for any
-- caller that has no session of its own to spare.
drop function if exists public.security_revoke_all_sessions(uuid);

create or replace function public.security_revoke_all_sessions(
  p_tenant_id uuid,
  p_exclude_session_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_count integer := 0;
begin
  -- auth.refresh_tokens.user_id is varchar, so profiles.id is cast to text.
  -- The excluded session keeps its refresh token, or it would be signed out
  -- at the next refresh while still appearing in the list.
  update auth.refresh_tokens r
     set revoked = true, updated_at = now()
    from public.profiles p, auth.sessions s
   where r.user_id = p.id::text
     and p.tenant_id = p_tenant_id
     and s.id = r.session_id
     and (p_exclude_session_id is null or s.id <> p_exclude_session_id)
     and not r.revoked;

  delete from auth.sessions s
   using public.profiles p
   where s.user_id = p.id
     and p.tenant_id = p_tenant_id
     and (p_exclude_session_id is null or s.id <> p_exclude_session_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Realtime: the dashboard listens to these two tables. Auth sessions live in
-- the `auth` schema and cannot be published, so login/logout reach the page
-- through the audit rows they write.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'security_logs'
  ) then
    alter publication supabase_realtime add table public.security_logs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'staff_sessions'
  ) then
    alter publication supabase_realtime add table public.staff_sessions;
  end if;
end $$;

-- Realtime authorises every subscription through RLS, so the owner needs to be
-- able to read their own restaurant's staff sessions. Tenant-scoped exactly
-- like the security_logs policy next door.
drop policy if exists staff_sessions_owner_read on public.staff_sessions;
create policy staff_sessions_owner_read on public.staff_sessions
  for select to authenticated
  using (
    exists (
      select 1 from public.staff s
       where s.id = staff_sessions.staff_id
         and public.is_owner_of(s.tenant_id)
    )
  );
