// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { toCamel } from "../_shared/case.ts";
import {
  listAuthSessions,
  listStaffSessions,
  revokeAllAuthSessions,
  revokeAllStaffSessions,
  revokeSessionDevice,
  revokeStaffSession,
} from "../_shared/sessions.ts";
import { body, json, preflight } from "../_shared/http.ts";

import { cleanIp, clientIp } from "../_shared/ip.ts";
import { auditStats } from "../_shared/audit.ts";

import { actorMaps, presentLog } from "../_shared/security-identity.ts";
/**
 * /functions/v1/security
 *   GET     { sessions, logs, users }  (security.view)
 *   DELETE  ?sessionId=  revoke one session (security.manage)
 *   PATCH   { action:'revoke_all' } | { userId, twoFactorEnabled } (security.manage)
 *
 * Sessions are the real Supabase Auth sessions (auth.sessions) via the
 * SECURITY DEFINER functions in migration 0036. The original implementation
 * read a `user_sessions` table that nothing ever wrote to, so "Active
 * Sessions" was always 0 and revocation deleted nothing while reporting
 * success. A revoke that matches no session now returns 404 so the UI can
 * never toast success over a no-op.
 *
 * Every write is scoped to the caller's tenant. The Next.js version this
 * replaces deleted a session by `id` alone and toggled 2FA by `id` alone,
 * which let a signed-in user of one restaurant terminate sessions or flip
 * two-factor on another restaurant's profiles.
 */

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const url = new URL(req.url);

  try {
    switch (req.method) {
      case "GET":
        return await list(req);
      case "DELETE":
        return await remove(req, url.searchParams.get("sessionId") ?? url.searchParams.get("id"));
      case "PATCH":
      case "PUT":
        return await patch(req);
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "security.view" });
  if (!g.ok) return g.response;
  const db = admin();

  // Users (profiles) for this tenant — the 2FA list.
  const { data: users, error: usersError } = await db
    .from("profiles")
    .select("id, name, email, two_factor_enabled, last_login, active, role, roleRow:roles!profiles_role_id_fkey(name)")
    .eq("tenant_id", g.session.tenantId);
  if (usersError) return json(req, { error: usersError.message }, 500);

  // Real auth sessions, scoped to this tenant's profiles — plus staff PIN
  // sessions, which live in staff_sessions and would otherwise be invisible
  // to the owner even though staff are signed into the restaurant all day.
  let sessions;
  try {
    const [authSessions, staffSessions] = await Promise.all([
      listAuthSessions(db, g.session.tenantId, g.session.sessionId),
      listStaffSessions(db, g.session.tenantId),
    ]);
    sessions = [...authSessions, ...staffSessions].sort((a, b) =>
      String(b.lastActive).localeCompare(String(a.lastActive))
    );
  } catch (err) {
    return json(req, { error: (err as Error).message }, 500);
  }

  const { data: logs, error: logsError } = await db
    .from("security_logs")
    .select("*, user:profiles(id, name, email)")
    .eq("tenant_id", g.session.tenantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (logsError) return json(req, { error: logsError.message }, 500);

  // Who did each thing. The same rules produce the bootstrap payload, so the
  // two views of one audit row cannot disagree — see _shared/security-identity.
  const { data: staffRows } = await db
    .from("staff")
    .select("id, name, role:roles(name)")
    .eq("tenant_id", g.session.tenantId);
  const maps = actorMaps(staffRows, users);
  const withActor = (logs ?? []).map((l: any) => presentLog(l, maps));

  // The same windowed counts bootstrap ships, so both surfaces agree.
  let stats;
  try {
    stats = await auditStats(db, g.session.tenantId);
  } catch (err) {
    return json(req, { error: (err as Error).message }, 500);
  }

  return json(req, {
    sessions,
    // Rows written before IPs were normalized still hold whole proxy
    // chains; clean on read so history displays like new rows do.
    logs: toCamel(withActor.map((l) => ({ ...l, ip: cleanIp(l.ip) }))),
    users: toCamel(users ?? []),
    stats,
  });
}

/**
 * Who a session belongs to, and whether it is an owner's or a staff member's.
 *
 * Needed before revoking anything: "don't show the button" is a suggestion to
 * a browser, and the rules below have to hold for a direct API call too.
 */
async function sessionOwner(
  db: ReturnType<typeof admin>,
  tenantId: string,
  sessionId: string,
): Promise<{ kind: "owner" | "staff"; id: string } | null> {
  // auth.sessions is not exposed through PostgREST, so the tenant's owner
  // sessions are read through the same definer function the list uses.
  const { data: sessions } = await db.rpc("security_list_sessions", { p_tenant_id: tenantId });
  const match = ((sessions ?? []) as any[]).find((s) => s.id === sessionId);
  if (match) return { kind: "owner", id: match.user_id };

  const { data: staffSession } = await db
    .from("staff_sessions")
    .select("id, staff:staff_id!inner(tenant_id)")
    .eq("id", sessionId)
    .eq("staff.tenant_id", tenantId)
    .maybeSingle();
  if (staffSession) return { kind: "staff", id: sessionId };
  return null;
}

/**
 * The name of the person a session belongs to, for the audit line.
 *
 * Only used to describe a revocation in words. Null when the session is gone
 * or belongs to nobody recognisable — the caller then writes a neutral line
 * rather than an identifier.
 */
async function sessionHolderName(
  db: ReturnType<typeof admin>,
  tenantId: string,
  target: { kind: "owner" | "staff"; id: string } | null,
): Promise<string | null> {
  if (!target) return null;
  if (target.kind === "owner") {
    const { data } = await db
      .from("profiles")
      .select("name")
      .eq("id", target.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    return (data as any)?.name ?? null;
  }
  // Staff sessions are keyed by session id; the staff row carries the name.
  const { data }: any = await db
    .from("staff_sessions")
    .select("staff:staff_id!inner(name, tenant_id)")
    .eq("id", target.id)
    .eq("staff.tenant_id", tenantId)
    .maybeSingle();
  const rel = Array.isArray(data?.staff) ? data?.staff[0] : data?.staff;
  return rel?.name ?? null;
}

async function remove(req: Request, sessionId: string | null): Promise<Response> {
  const g = await guard(req, { permission: "security.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const db = admin();

  const payload = await body(req).catch(() => ({}) as any);
  const id = sessionId ?? (payload.sessionId as string | undefined);
  if (!id) return json(req, { error: "sessionId required" }, 400);
  /**
   * A row on the page can be several sessions — the same browser signed in
   * more than once. Revoking it has to end all of them, or the row returns
   * with a smaller count and the owner has to click again. Every id is
   * verified tenant-scoped by the SQL function, so a stray id is a no-op.
   */
  const extraIds = Array.isArray(payload.sessionIds)
    ? (payload.sessionIds as unknown[]).filter((v): v is string => typeof v === "string" && v !== id)
    : [];

  /**
   * The owner's session is not a revocable object on this page.
   *
   * Two rules, both enforced here rather than by hiding a button:
   *   * nobody revokes the session they are using — that would be a log-out
   *     disguised as an administrative action;
   *   * a staff PIN session never ends an owner's session, whatever its
   *     permission set says.
   * An owner who really wants to leave uses sign-out.
   */
  const target = await sessionOwner(db, tenantId, id);
  if (target?.kind === "owner") {
    if (g.session.kind !== "owner") {
      return json(req, { error: "Only the restaurant owner can end an owner session." }, 403);
    }
    if (g.session.sessionId && g.session.sessionId === id) {
      return json(req, { error: "That is your current session. Use sign out to end it." }, 400);
    }
  }

  /**
   * Whose session it is, read while the row still exists.
   *
   * A staff session is deleted by the revocation, so the name has to be looked
   * up first. The audit line says what happened to whom; the session id is an
   * internal handle a reader can do nothing with, and it never reaches the page.
   */
  const targetName = await sessionHolderName(db, tenantId, target);

  let revoked: number;
  try {
    // One row on the page is one browser. Revoking it has to end every session
    // that browser created, or the row would come back with its siblings.
    revoked = await revokeSessionDevice(db, tenantId, id);
    for (const extra of extraIds) {
      revoked += await revokeSessionDevice(db, tenantId, extra);
    }
    // Not an auth session of this tenant — it may be a staff PIN session.
    if (revoked < 1) revoked = await revokeStaffSession(db, tenantId, id);
  } catch (err) {
    return json(req, { error: (err as Error).message }, 500);
  }
  if (revoked < 1) return json(req, { error: "Session not found" }, 404);

  // The revocation has already happened, so the audit log is best-effort: a
  // failed insert must not turn a successful revoke into an error response.
  await db.from("security_logs").insert({
    tenant_id: tenantId,
    // A staff PIN keeps the actor on staff_id; `user_id` stays for owners.
    user_id: g.session.kind === "owner" ? g.session.subjectId : null,
    actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
    action: "SESSION_REVOKED",
    ip: clientIp(req),
    user_agent: req.headers.get("user-agent") || "unknown",
    meta: targetName ? `Session ended for ${targetName}` : "Session ended",
  });

  return json(req, { success: true, revoked });
}

async function patch(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "security.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const b = await body(req);
  const db = admin();

  if (b.action === "revoke_all") {
    let revoked: number;
    try {
      /**
       * Owner auth sessions and staff PIN sessions alike — "Revoke All" must
       * empty the list the owner is looking at, not half of it.
       *
       * Except the caller's own: the session doing the revoking survives, so
       * the owner is not signed out of the page they just used. A staff caller
       * never touches owner sessions at all, and keeps their own PIN session.
       */
      revoked = g.session.kind === "owner"
        ? await revokeAllAuthSessions(db, tenantId, g.session.sessionId)
        : 0;
      revoked += await revokeAllStaffSessions(
        db,
        tenantId,
        g.session.kind === "staff" ? g.session.subjectId : null,
      );
    } catch (err) {
      return json(req, { error: (err as Error).message }, 500);
    }

    // Best-effort audit log — see remove() for why this cannot fail the request.
    await db.from("security_logs").insert({
      tenant_id: tenantId,
      user_id: g.session.kind === "owner" ? g.session.subjectId : null,
      actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
      action: "SESSION_REVOKED",
      ip: clientIp(req),
      user_agent: req.headers.get("user-agent") || "unknown",
      meta: `All sessions revoked (${revoked})`,
    });

    return json(req, { success: true, revoked });
  }

  if (b.userId && b.twoFactorEnabled !== undefined) {
    const { error } = await db
      .from("profiles")
      .update({ two_factor_enabled: b.twoFactorEnabled })
      .eq("id", b.userId)
      .eq("tenant_id", tenantId); // tenant scoping — see header comment
    if (error) return json(req, { error: error.message }, 500);
    return json(req, { success: true });
  }

  return json(req, { error: "invalid action" }, 400);
}
