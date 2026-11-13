-- ===========================================================================
-- 0042 — correct the built-in roles' permissions
--
-- Every tenant created so far has the old defaults, and three of them were
-- wrong: Cashier, Kitchen and Waiter had no `dashboard.view` at all, so those
-- roles could not load the dashboard, and Manager had no `staff.manage`, so it
-- could not manage the team it is supposed to run.
--
-- Two things this deliberately does not do:
--
--   * **Custom roles are untouched.** Only `is_system = true` rows are
--     considered; anything an owner built themselves keeps exactly the
--     permissions it has.
--   * **An edited system role is left alone.** The update only matches rows
--     whose permissions are still exactly one of the old defaults. If an owner
--     has configured a built-in role for their restaurant, that is their
--     decision and this migration does not overrule it.
--
-- The values here must match DEFAULT_ROLES in supabase/functions/_shared/
-- permissions.ts, which is what new restaurants get.
-- ===========================================================================

update public.roles
   set permissions = 'dashboard.view,orders.view,orders.manage,menu.view,menu.manage,tables.view,tables.manage,promos.view,promos.manage,analytics.view,qr.manage,staff.view,staff.manage'
 where is_system = true
   and name = 'Manager'
   and permissions = 'dashboard.view,orders.view,orders.manage,menu.view,menu.manage,tables.view,tables.manage,promos.view,promos.manage,analytics.view,qr.manage,staff.view';

update public.roles
   set permissions = 'dashboard.view,orders.view,orders.manage,tables.view,tables.manage'
 where is_system = true
   and name = 'Cashier'
   and permissions = 'orders.view,orders.manage,menu.view,tables.view';

update public.roles
   set permissions = 'dashboard.view,orders.view,orders.manage'
 where is_system = true
   and name = 'Kitchen'
   and permissions = 'orders.view,orders.manage,menu.view';

update public.roles
   set permissions = 'dashboard.view,orders.view,orders.manage,tables.view,tables.manage'
 where is_system = true
   and name = 'Waiter'
   and permissions = 'orders.view,orders.manage,menu.view,tables.view';

-- The Owner role is every key, and was already correct; this is the safety net
-- for a tenant whose Owner row somehow lacks one.
update public.roles
   set permissions = 'dashboard.view,orders.view,orders.manage,menu.view,menu.manage,tables.view,tables.manage,promos.view,promos.manage,analytics.view,qr.manage,settings.view,settings.manage,security.view,security.manage,roles.view,roles.manage,staff.view,staff.manage'
 where is_system = true
   and name = 'Owner'
   and permissions <> 'dashboard.view,orders.view,orders.manage,menu.view,menu.manage,tables.view,tables.manage,promos.view,promos.manage,analytics.view,qr.manage,settings.view,settings.manage,security.view,security.manage,roles.view,roles.manage,staff.view,staff.manage';
