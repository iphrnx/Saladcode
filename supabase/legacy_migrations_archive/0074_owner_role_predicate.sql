-- `is_owner_of` has never checked for an owner.
--
-- Its whole body is a membership test:
--
--   select exists (
--     select 1 from public.profiles
--     where id = auth.uid() and tenant_id = p_tenant and active
--   );
--
-- Fifteen policies call it, and they are the tenant's own tables — orders,
-- order_items, menu_items, categories, tables, table_sessions, staff,
-- staff_sessions, staff_activities, roles, settings, promo_codes, reservations,
-- customer_reviews and security_logs. So in all fifteen, "owner" has meant
-- "anyone on the staff list with a login in this restaurant". The edge
-- functions do not go through these policies (they use the service role and
-- gate on permissions themselves), but PostgREST does, and so does realtime —
-- a profile holding a limited role can reach all fifteen tables directly with
-- its own JWT.
--
-- The fix is two names for two questions. The membership test keeps its
-- behaviour under the name it always described, and `is_owner_of` becomes the
-- test its name promises.
--
-- `ALTER FUNCTION ... RENAME` carries the policies with it: a policy references
-- the function by OID, not by name, so all fifteen follow and none can be
-- missed. Verified before applying — fifteen distinct policies depend on this
-- function by OID, and no policy anywhere mentions `is_member_of`.
--
-- Today this changes no answer: all eighteen profiles in the database hold
-- either the Owner role (fifteen) or no role row with `role = 'OWNER'` (three),
-- so every one of them satisfies both the old test and the new one. It is the
-- difference between a rule that happens to hold and a rule that holds because
-- it is written down.

alter function public.is_owner_of(uuid) rename to is_member_of;

create or replace function public.is_owner_of(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.roles r on r.id = p.role_id
    where p.id = auth.uid()
      and p.tenant_id = p_tenant
      and p.active
      and (
        -- The built-in Owner role, which is how `ownerSession()` recognises an
        -- owner on the edge functions too.
        (r.is_system and r.name = 'Owner')
        -- A profile predating the roles table: no role row, but the text column
        -- still says OWNER. `profiles.role` is stored uppercase.
        or (p.role_id is null and upper(p.role) = 'OWNER')
      )
  );
$$;

-- The ACL does not survive a `create or replace` on a *new* function, so it is
-- set explicitly. `anon` has to be named in the revoke: this project carries
-- `alter default privileges ... grant execute on functions to anon,
-- authenticated, service_role`, so a freshly created function starts with an
-- explicit `anon` grant that `revoke ... from public` does not touch. Revoking
-- only from `public` leaves `anon=X` on the new function while the function it
-- replaces has none — a silent widening, and the reason this is written out
-- rather than assumed. A policy that consults `auth.uid()` has nothing to say to
-- a caller who has not signed in.
revoke all on function public.is_owner_of(uuid) from public, anon;
grant execute on function public.is_owner_of(uuid) to authenticated, service_role;
