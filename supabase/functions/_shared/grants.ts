import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { splitPermissions } from "./auth.ts";

/**
 * Who may hand out what.
 *
 * `staff.manage` is held by Manager and `roles.manage` by Owner, but holding a
 * key to the door is not the same as being allowed to widen it. Two rules close
 * the gap, and they are the same rule stated twice:
 *
 *   1. The built-in Owner role is never assignable to staff. A staff row
 *      holding it satisfies the owner test in `staffSession()`, so a four-digit
 *      PIN would buy the whole restaurant.
 *
 *   2. Nobody may give away a permission they do not hold. Without this a
 *      Manager — who legitimately manages staff — could mint a role carrying
 *      `settings.manage` and `security.manage`, assign it to themselves, and be
 *      the owner in everything but name. The same rule covers acting *on* an
 *      account that already outranks you: resetting its PIN is the same
 *      escalation one step longer.
 *
 * The Owner holds all nineteen keys, so both rules are inert for them, and the
 * seeded roles (Manager, Cashier, Kitchen, Waiter) are subsets of Manager's set
 * — so the roles a Manager could already hand out, they still can.
 */

export const OWNER_ROLE_MESSAGE =
  "The Owner role cannot be assigned to staff. Create a separate role instead.";

export interface RoleGrants {
  name: string;
  isSystem: boolean;
  permissions: string[];
}

/** The permission set a role carries, or null when it is not this tenant's. */
export async function roleGrants(
  db: SupabaseClient,
  tenantId: string,
  roleId: string,
): Promise<RoleGrants | null> {
  const { data } = await db
    .from("roles")
    .select("name, is_system, permissions")
    .eq("id", roleId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  return {
    name: String(data.name ?? ""),
    isSystem: data.is_system === true,
    permissions: splitPermissions(data.permissions),
  };
}

/** The built-in Owner role — the one role that must never be assignable. */
export function isOwnerRole(role: { name: string; isSystem: boolean }): boolean {
  return role.isSystem && role.name === "Owner";
}

/** The permissions in `target` that `actor` does not hold. */
export function unheld(actor: string[], target: string[]): string[] {
  return target.filter((p) => !actor.includes(p));
}

/**
 * A refusal naming the keys that would be gained, or null when the grant is
 * within what the caller already holds.
 */
export function escalationMessage(actor: string[], target: string[]): string | null {
  const extra = unheld(actor, target);
  if (extra.length === 0) return null;
  return `You cannot grant permissions you do not hold: ${extra.join(", ")}.`;
}
