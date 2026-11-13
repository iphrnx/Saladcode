import { admin, asUser } from "./db.ts";
import { json } from "./http.ts";
import { expandPermissions, hasEffectivePermission, PERMISSION_KEYS } from "./permissions.ts";

/**
 * Session resolution for edge functions. Mirrors src/lib/session.ts so both
 * halves of the migration behave identically.
 *
 *   * owners — `Authorization: Bearer <supabase access token>`
 *   * staff  — `x-staff-session` header, or the `the-salad-staff-session` cookie
 *
 * `guard()` fails closed: no session, a deactivated account, a cross-tenant
 * `x-tenant-id`, or a missing permission all produce 401/403 rather than data.
 */

export type SessionKind = "owner" | "staff";

export interface Session {
  kind: SessionKind;
  tenantId: string;
  /** `profiles.id` for owners, `staff.id` for staff. */
  subjectId: string;
  /** The caller's own auth session (`session_id` JWT claim), owners only. */
  sessionId: string | null;
  name: string;
  email: string | null;
  roleName: string;
  permissions: string[];
}

export type GuardResult =
  | { ok: true; session: Session }
  | { ok: false; response: Response };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `session_id` claim of a Supabase access token, without verifying it —
 * `ownerSession()` only calls this after `auth.getUser()` has verified the
 * token itself. Used to badge the caller's own session on the Security page. */
function jwtSessionId(jwt: string): string | null {
  try {
    const payload = JSON.parse(
      atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/** The `sub` claim, unverified — used only to start the profile lookup in
 * parallel with `getUser`, never as a decision on its own. */
function jwtSubject(jwt: string): string | null {
  try {
    const payload = JSON.parse(
      atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function splitPermissions(raw: unknown): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* not JSON — fall through to the comma path */
    }
  }
  return value.split(",").map((p) => p.trim()).filter(Boolean);
}

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function staffToken(req: Request): string | null {
  const header = req.headers.get("x-staff-session");
  if (header?.trim()) return header.trim();
  const cookie = req.headers.get("cookie") ?? "";
  // The current name first, then the ones it has had — a staff session issued
  // before the rename is still a staff session.
  for (const name of ["the-salad-staff-session", "toastly-staff-session", "tablo-staff-session"]) {
    const match = cookie.match(new RegExp(`${name}=([^;]+)`));
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function claimedTenant(req: Request): string | null {
  const url = new URL(req.url);
  return req.headers.get("x-tenant-id") || url.searchParams.get("tenant");
}

async function ownerSession(req: Request): Promise<Session | null> {
  const jwt = bearer(req);
  if (!jwt) return null;

  try {
    // Verify the token against Supabase Auth and read the caller's profile at
    // the same time. The profile row needs the token's `sub`, which is readable
    // from the payload without verifying it — and an unverified id only ever
    // costs a wasted lookup, because the result is discarded unless `getUser`
    // accepts the token. Serialised, these two round trips were ~590 ms of
    // every guarded request; in parallel they cost the slower one.
    const sub = jwtSubject(jwt);
    const [authResult, profileResult] = await Promise.all([
      asUser(jwt).auth.getUser(jwt),
      sub
        ? admin()
            .from("profiles")
            .select(
              "id, tenant_id, name, email, role, role_id, active, role_row:roles!profiles_role_id_fkey (name, permissions, is_system)",
            )
            .eq("id", sub)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as { data: null; error: null }),
    ]);

    const { data: authData, error } = authResult;
    if (error || !authData?.user) return null;
    const profile = (profileResult.data ?? null) as Record<string, any> | null;

    if (!profile?.tenant_id || profile.active === false) return null;

    const rel: unknown = (profile as Record<string, unknown>).role_row;
    const role = (Array.isArray(rel) ? rel[0] : rel) as
      | { name?: string; permissions?: string; is_system?: boolean }
      | null
      | undefined;

    // A profile with no role row predates roles (or is the tenant creator);
    // give it the full set so the account cannot lock itself out.
    const permissions = expandPermissions(
      profile.role_id
      ? splitPermissions(role?.permissions)
      : [...PERMISSION_KEYS]
    );

    return {
      kind: "owner",
      tenantId: profile.tenant_id,
      subjectId: profile.id,
      sessionId: jwtSessionId(jwt),
      name: profile.name,
      email: profile.email,
      roleName: role?.name ?? profile.role ?? "Owner",
      permissions,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a staff session from a request's `x-staff-session` header or the
 * staff cookie — the same resolution `guard()` uses for a staff caller.
 *
 * Exported so `/auth/me` can make the shell decision the same way the rest of
 * the server does: a request carrying a valid staff session is a staff member,
 * and the client must never render the owner shell for one.
 */
export async function staffSession(req: Request): Promise<Session | null> {
  const token = staffToken(req);
  if (!token) return null;

  const db = admin();
  const { data: session } = await db
    .from("staff_sessions")
    .select("*, staff:staff_id(*, role:roles(*))")
    .eq("token", token)
    .maybeSingle();

  if (!session) return null;

  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  if (new Date(session.created_at).getTime() < twelveHoursAgo) {
    await db.from("staff_sessions").delete().eq("id", session.id);
    return null;
  }

  const staff = (session as Record<string, any>).staff;
  if (!staff?.active) return null;

  await db
    .from("staff_sessions")
    .update({ last_active: new Date().toISOString() })
    .eq("id", session.id);

  // `is_system` marks a built-in role, NOT the owner: the seeded Owner,
  // Manager, Waiter, Cashier and Kitchen roles are all `is_system: true`.
  // Treating it as "owner" escalated every PIN login to full tenant access.
  const isOwner = staff.role?.is_system === true && staff.role?.name === "Owner";
  let permissions = expandPermissions(splitPermissions(staff.role?.permissions));
  if (isOwner) permissions = Array.from(new Set([...permissions, ...PERMISSION_KEYS]));

  return {
    kind: "staff",
    tenantId: staff.tenant_id,
    subjectId: staff.id,
    sessionId: null,
    name: staff.name,
    email: null,
    roleName: staff.role?.name ?? "Staff",
    permissions,
  };
}

/**
 *   const g = await guard(req, { permission: "menu.manage" })
 *   if (!g.ok) return g.response
 *   const { tenantId } = g.session
 */
export async function guard(
  req: Request,
  opts: { permission?: string; anyOf?: string[] } = {},
): Promise<GuardResult> {
  const session = (await ownerSession(req)) ?? (await staffSession(req));
  if (!session) {
    return { ok: false, response: json(req, { error: "Unauthorized" }, 401) };
  }

  // A signed-in session may not address another restaurant.
  const claimed = claimedTenant(req);
  if (claimed && claimed !== session.tenantId) {
    return { ok: false, response: json(req, { error: "Forbidden" }, 403) };
  }

  if (opts.permission && !hasEffectivePermission(session.permissions, opts.permission)) {
    return {
      ok: false,
      response: json(req, { error: "Forbidden", required: opts.permission }, 403),
    };
  }

  if (
    opts.anyOf &&
    !opts.anyOf.some((p) => hasEffectivePermission(session.permissions, p))
  ) {
    return {
      ok: false,
      response: json(req, { error: "Forbidden", required: opts.anyOf }, 403),
    };
  }

  return { ok: true, session };
}

/**
 * Resolve a tenant for a genuinely public route from an explicit
 * `?tenant=` / `x-tenant-id` value only — never a "pick one for me" fallback.
 */
export async function publicTenantId(req: Request): Promise<string | null> {
  const key = claimedTenant(req);
  if (!key) return null;
  const db = admin();
  if (UUID_RE.test(key)) {
    const { data } = await db.from("tenants").select("id").eq("id", key).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data } = await db.from("tenants").select("id").eq("slug", key).maybeSingle();
  return data?.id ?? null;
}

/** Validate a diner's table-session token. Public route helper. */
export async function tableSession(token: string): Promise<{
  id: string;
  tenantId: string;
  tableId: string;
  status: string;
} | null> {
  if (!token) return null;
  const { data } = await admin()
    .from("table_sessions")
    .select("id, tenant_id, table_id, status")
    .eq("token", token)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    tenantId: data.tenant_id,
    tableId: data.table_id,
    status: data.status,
  };
}
