import type { ViewKey } from '@/lib/store'
import { expandPermissions, RESERVED_ROLE_NAMES } from '@/lib/constants'

/**
 * What each dashboard module needs.
 *
 * `dashboard.view` is the gate for using the dashboard at all — every role has
 * it — and it grants nothing else. Each screen names the permission for what it
 * shows, so a role with the dashboard and nothing else sees an empty set of
 * modules rather than every module.
 *
 * `dashboard` is the POS: the table and order screen, where an order is rung up
 * and paid for. It needs `tables.view` rather than `dashboard.view`, which is
 * what keeps a Kitchen login out of the till — the kitchen has the order queue
 * and no tables, so it lands on Orders. If that ever needs to be its own key
 * rather than borrowing tables, add one to PERMISSION_KEYS and change this line.
 */
export const VIEW_PERMISSIONS: Record<ViewKey, string[]> = {
  // The dashboard is the POS, and opening it needs the dashboard permission
  // *and* the tables permission that feeds it. `dashboard.view` alone checks
  // nothing on its own and grants nothing on its own — keeping it in the
  // matrix as if it did is how a "Server" role ended up showing
  // "Dashboard 1/1" while its rail had no dashboard at all.
  dashboard: ['dashboard.view', 'tables.view'],
  orders: ['orders.view'],
  menu: ['menu.view'],
  qr: ['qr.manage'],
  promos: ['promos.view'],
  analytics: ['analytics.view'],
  roles: ['roles.view'],
  security: ['security.view'],
  settings: ['settings.view'],
  // Billing is the subscription — the owner's alone, and the `subscriptions`
  // function already guards on the same key, so the menu and the API agree.
  billing: ['settings.manage'],
  'location-onboarding': ['settings.manage'],
}

/**
 * The order modules are listed in, which is also the order of preference when
 * the app has to choose a landing view for a restricted role.
 */
export const VIEW_ORDER: ViewKey[] = [
  'dashboard', 'orders', 'analytics', 'menu', 'qr', 'promos',
  'roles', 'security', 'settings', 'billing',
]

/** Whether a set of permissions opens a module. */
export function canView(permissions: string[] | undefined, view: ViewKey): boolean {
  return VIEW_PERMISSIONS[view].every((p) => hasPermission(permissions, p))
}

/**
 * Whether a set of permissions holds one key.
 *
 * The same rule `canView` uses, for the write keys — so a screen can ask about
 * `menu.manage` in exactly the way it asks about `menu.view`, and the two
 * answers cannot drift apart.
 *
 * No permission list means an owner: bootstrap sends every key for an owner,
 * and anything older that sends none is not a restricted staff member.
 */
export function hasPermission(
  permissions: string[] | undefined,
  permission: string | undefined,
): boolean {
  if (!permissions || permissions.length === 0) return true
  if (!permission) return false
  return permissions.includes(permission)
}

/** The first module this role may open — where a restricted login should land. */
export function firstAllowedView(permissions: string[] | undefined): ViewKey {
  return VIEW_ORDER.find((v) => canView(permissions, v)) ?? 'orders'
}

/**
 * Read a role's `permissions` column into a list.
 *
 * Roles store permissions as a comma string, but some legacy rows are JSON. The
 * server reads it this way and the client has to read it the same way, or the
 * two disagree about what a role holds — which is how a permission guard ends up
 * refusing an edit with a permission name that is not real.
 *
 * It lives here rather than in `session.ts` because `session.ts` reaches for the
 * server Supabase client, and importing it from a client component drags
 * server-only code into the browser bundle.
 */
export function splitPermissions(raw: unknown): string[] {
  const value = String(raw ?? '').trim()
  if (!value) return []
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {
      /* not JSON — fall through to the comma path */
    }
  }
  return value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * Whether the caller may grant every permission of a role.
 *
 * The assignment dropdowns and the role matrix use this so a `staff.manage`
 * holder (or a `roles.manage` holder) is never offered a role — or a key —
 * the server would refuse as an escalation. An absent/empty caller list is
 * the owner, who grants everything.
 */
export function canGrantRole(
  rolePermissions: string[] | undefined,
  callerPermissions: string[] | undefined,
): boolean {
  if (!callerPermissions || callerPermissions.length === 0) return true
  // The caller's own list may be raw (a `settings.manage` holder can still
  // grant `settings.view` — the manage key implies it).
  const caller = expandPermissions(callerPermissions)
  const effective = expandPermissions(rolePermissions ?? [])
  return effective.every((p) => caller.includes(p))
}

/**
 * The built-in role name an input collides with, case-insensitively, or null.
 *
 * Mirrors the server's refusal so the page can say "that name is taken" before
 * the request round-trips — and so a custom role never wears a system name.
 */
export function reservedRoleName(name: string): string | null {
  const n = name.trim()
  if (!n) return null
  return RESERVED_ROLE_NAMES.find((r) => r.toLowerCase() === n.toLowerCase()) ?? null
}

/** The same resolved-permission rule the server's guard uses (legacy aliases
 * included), so a button and the endpoint it calls can never disagree. */
export { hasEffectivePermission } from '@/lib/constants'
