import { json } from "./http.ts";
import { admin } from "./db.ts";

/**
 * superGuard
 *
 * Authorization for the global administrative endpoints. Unlike the standard
 * guard(), this does not check tenant membership — it checks the one thing
 * that matters here: is the caller on the super-admin allowlist?
 *
 * The allowlist (`public.super_admins`) is the authority, not the
 * `profiles.is_super_admin` column. A column on a row a user can update is
 * not an authorization mechanism: before migration 0020 any signed-in owner
 * could set that column on their own profile and the admin API answered 200.
 * The table has RLS that stops anyone but an admin from reading or writing
 * it, and this guard reads it with the service role.
 */
export async function superGuard(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) {
    return {
      ok: false,
      response: json(req, { error: "Missing authentication token" }, 401),
    };
  }

  const jwt = authHeader.replace("Bearer ", "").trim();
  if (!jwt) {
    return {
      ok: false,
      response: json(req, { error: "Missing authentication token" }, 401),
    };
  }

  const db = admin();

  // Verify the token before trusting anything it claims.
  const { data: userData, error: userError } = await db.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return {
      ok: false,
      response: json(req, { error: "Invalid or expired session" }, 401),
    };
  }
  const user = userData.user;

  const { data: allowed, error: allowedError } = await db
    .from("super_admins")
    .select("id, email, label, last_seen_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (allowedError) {
    console.error("superGuard: allowlist lookup failed", allowedError);
    return {
      ok: false,
      response: json(req, { error: "Authorization check failed" }, 500),
    };
  }

  if (!allowed) {
    return {
      ok: false,
      response: json(req, { error: "Forbidden: Super Admin access required" }, 403),
    };
  }

  // Record the admin's presence. Best effort — a failure here must not deny
  // access to someone who is otherwise authorised.
  try {
    await db
      .from("super_admins")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", allowed.id);
  } catch (e) {
    console.error("superGuard: could not record last_seen_at", e);
  }

  return {
    ok: true,
    admin: {
      id: allowed.id,
      userId: user.id,
      email: allowed.email ?? user.email ?? "",
      label: allowed.label ?? "Super Admin",
    },
  };
}

/**
 * logAdminAction
 *
 * Inserts a record into the super_admin_audit_logs table. Every mutating
 * administrative action goes through here, so there is a trail of who did
 * what to which restaurant and when.
 */
export async function logAdminAction(
  adminId: string,
  action: string,
  details: unknown,
  targetTenantId?: string,
) {
  const { error } = await admin()
    .from("super_admin_audit_logs")
    .insert({
      admin_id: adminId,
      action,
      target_tenant_id: targetTenantId ?? null,
      details: (details ?? {}) as any,
    });
  if (error) {
    // The action already happened; failing the request would be misleading.
    console.error("logAdminAction failed", action, error);
  }
}
