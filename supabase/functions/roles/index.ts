// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard, splitPermissions } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { toCamel } from "../_shared/case.ts";
import { escalationMessage } from "../_shared/grants.ts";
import { PERMISSION_GROUPS, PERMISSION_KEYS, RESERVED_ROLE_NAMES } from "../_shared/permissions.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/roles
 *   GET                 list roles + users + permission catalogue (roles.view)
 *   POST                create a role (roles.manage)
 *   PATCH  [?id=]       update a role (roles.manage)
 *   DELETE [?id=]       delete a role (roles.manage)
 *
 * Ported from src/app/api/roles/route.ts and src/app/api/roles/[id]/route.ts.
 * The Next.js version updated and deleted by `id` alone, letting one restaurant
 * mutate another's roles; every write here is scoped to the caller's tenant.
 */

/**
 * Names a built-in role cannot be given to a custom one.
 *
 * A custom role wearing "Manager" or "Owner" is a misread waiting to happen —
 * the owner-detection and the escalation rules key on the *system* Owner by
 * `is_system && name`, so a custom lookalike is inert, but nobody should have
 * to know that to read the role list.
 */
const RESERVED_SYSTEM_NAMES = RESERVED_ROLE_NAMES;

/** Whether an incoming name collides with a built-in role, case-insensitively. */
function isReservedName(name: unknown): string | null {
  const n = String(name ?? "").trim();
  if (!n) return null;
  return RESERVED_SYSTEM_NAMES.find((r) => r.toLowerCase() === n.toLowerCase()) ?? null;
}

/** Serialize permissions exactly as before: comma-separated string. */
function serializePermissions(permissions: unknown): string {
  return Array.isArray(permissions) ? permissions.join(",") : String(permissions ?? "");
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "roles");
  const idFromPath = segments[0];
  const url = new URL(req.url);
  const id = idFromPath ?? url.searchParams.get("id");

  try {
    switch (req.method) {
      case "GET":
        return await list(req);
      case "POST":
        return await create(req);
      case "PATCH":
      case "PUT":
        return await update(req, id);
      case "DELETE":
        return await remove(req, id);
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "roles.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const [rolesRes, usersRes] = await Promise.all([
    admin().from("roles").select("*").eq("tenant_id", tenantId).order("created_at", {
      ascending: true,
    }),
    admin()
      .from("profiles")
      .select("*, roleRef:roles(*)")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true }),
  ]);

  if (rolesRes.error) return json(req, { error: rolesRes.error.message }, 500);
  if (usersRes.error) return json(req, { error: usersRes.error.message }, 500);

  return json(req, {
    roles: toCamel(rolesRes.data ?? []),
    users: toCamel(usersRes.data ?? []),
    permissionKeys: PERMISSION_KEYS,
    permissionGroups: PERMISSION_GROUPS,
  });
}

async function create(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "roles.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const b = await body(req);

  const reserved = isReservedName(b.name);
  if (reserved) {
    return json(
      req,
      { error: `"${reserved}" is a built-in role name. Pick a different name for the custom role.` },
      400,
    );
  }

  // `roles.manage` is held by Owner, but a custom role can carry it too — and
  // whoever carries it must not be able to write a role stronger than
  // themselves. Otherwise `roles.manage` alone is a route to every permission
  // in the product: create a role with the keys you are missing, then assign it
  // to yourself through `staff.manage`.
  const escalation = escalationMessage(g.session.permissions, splitPermissions(b.permissions));
  if (escalation) return json(req, { error: escalation }, 403);

  const { data: role, error } = await admin()
    .from("roles")
    .insert({
      tenant_id: tenantId,
      name: b.name,
      description: b.description,
      permissions: serializePermissions(b.permissions),
      color: b.color || "#ff7e6b",
    })
    .select()
    .single();

  if (error) return json(req, { error: error.message }, 500);

  return json(req, toCamel(role), 201);
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "roles.manage" });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);
  const tenantId = g.session.tenantId;
  const b = await body(req);

  const { data: existing, error: findError } = await admin()
    .from("roles")
    .select("id, name, is_system, permissions")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (findError) return json(req, { error: findError.message }, 500);
  if (!existing) return json(req, { error: "Role not found" }, 404);

  // A built-in role is shared state: the Owner role's permission list is what
  // makes an owner an owner, so rewriting it — or renaming it, which is how the
  // Owner role is recognised — would lock the owner out of their own restaurant
  // and redefine what Manager, Cashier, Kitchen and Waiter can do. DELETE
  // already refuses system roles; this is the same refusal for the two fields
  // that matter. Description and colour stay editable, and a no-op PATCH that
  // sends the current values back is still accepted.
  if (existing.is_system) {
    const renamed = b.name !== undefined && String(b.name) !== existing.name;
    const regranted =
      b.permissions !== undefined &&
      serializePermissions(b.permissions) !== String(existing.permissions ?? "");
    if (renamed || regranted) {
      return json(req, { error: "System roles cannot be renamed or have their permissions changed" }, 400);
    }
  }

  // A custom role must not be renamed onto a built-in role's name.
  if (!existing.is_system && b.name !== undefined) {
    const reserved = isReservedName(b.name);
    if (reserved) {
      return json(
        req,
        { error: `"${reserved}" is a built-in role name. Pick a different name for the custom role.` },
        400,
      );
    }
  }

  if (b.permissions !== undefined) {
    const escalation = escalationMessage(g.session.permissions, splitPermissions(b.permissions));
    if (escalation) return json(req, { error: escalation }, 403);
  }

  const data: Record<string, unknown> = {};
  if (b.name) data.name = b.name;
  if (b.description !== undefined) data.description = b.description;
  if (b.permissions !== undefined) data.permissions = serializePermissions(b.permissions);
  if (b.color) data.color = b.color;

  const { data: role, error } = await admin()
    .from("roles")
    .update(data)
    .eq("id", id)
    .eq("tenant_id", tenantId) // tenant scoping — see header comment
    .select()
    .single();
  if (error) return json(req, { error: error.message }, 500);

  return json(req, toCamel(role));
}

async function remove(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "roles.manage" });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);
  const tenantId = g.session.tenantId;

  const { data: role, error: findError } = await admin()
    .from("roles")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (findError) return json(req, { error: findError.message }, 500);

  if (role?.is_system) return json(req, { error: "System roles cannot be deleted" }, 400);

  const { error } = await admin()
    .from("roles")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId);
  if (error) return json(req, { error: error.message }, 500);

  return json(req, { success: true });
}
