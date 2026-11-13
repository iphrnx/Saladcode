// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { cleanIp } from "./ip.ts";
import { parseUserAgent } from "./user-agent.ts";

/**
 * Real owner sessions, read from Supabase Auth (auth.sessions) through the
 * SECURITY DEFINER functions in migration 0036.
 *
 * The dashboard used to read a `user_sessions` table that nothing ever wrote
 * to, so "Active Sessions" was always 0 and revocation reported success while
 * deleting nothing. These helpers are the single source of truth for the wire
 * shape both `bootstrap` and `security` return, so the two endpoints can never
 * drift apart again.
 */

export interface WireSession {
  id: string;
  userId: string;
  device: string | null;
  browser: string | null;
  os: string | null;
  ip: string | null;
  location: null; // no geo data in auth.sessions; kept for UI compatibility
  /** "owner" = Supabase Auth session; "staff" = PIN login (staff_sessions). */
  kind: "owner" | "staff";
  /** Staff role name (Waiter, Cashier, …); null for owner sessions. */
  role: string | null;
  current: boolean;
  /** auth.sessions.updated_at — refreshed on token use; NOT the sign-in time. */
  lastActive: string;
  /** auth.sessions.created_at — when this session was signed in. */
  createdAt: string;
  user: { id: string; name: string; email: string };
  /**
   * How many real sessions this row stands for. The dashboard shows one row
   * per browser — a device that signed in five times is still one device —
   * and `ids` is what a revoke acts on, so it cannot leave the others behind.
   */
  count: number;
  ids: string[];
  /** Oldest sign-in among the grouped sessions (createdAt is the newest). */
  firstSeen: string;
}

/**
 * Row → wire mapping, extracted so the offline suite can pin it without a
 * database: the sign-in time (created_at) and the last-activity time
 * (updated_at) must survive as two distinct fields — the UI showing one
 * ambiguous timestamp was the bug this separation fixes.
 */
export function wireSessionFromRow(
  row: any,
  currentSessionId: string | null,
): WireSession {
  const agent = parseUserAgent(row.user_agent);
  return {
    id: row.id,
    userId: row.user_id,
    device: agent.device,
    browser: agent.browser,
    os: agent.os,
    ip: cleanIp(row.ip),
    location: null,
    kind: "owner",
    // The owner's role label, resolved in SQL from roles.name → profiles.role.
    role: row.role ?? null,
    current: currentSessionId ? row.id === currentSessionId : false,
    lastActive: row.last_active ?? row.updated_at,
    createdAt: row.created_at,
    user: { id: row.user_id, name: row.name, email: row.email },
    count: Number(row.session_count ?? 1),
    ids: Array.isArray(row.session_ids) ? row.session_ids : [row.id],
    firstSeen: row.first_seen ?? row.created_at,
  };
}

/**
 * List the tenant's live auth sessions, newest activity first.
 * `currentSessionId` is the caller's own session (the `session_id` JWT claim)
 * so the UI can badge it; pass null when it is not known.
 */
export async function listAuthSessions(
  db: SupabaseClient,
  tenantId: string,
  currentSessionId: string | null,
): Promise<WireSession[]> {
  /**
   * One row per browser, and only sessions that can still be used.
   *
   * `security_list_session_devices` (migration 0072) drops sessions whose
   * access has expired or whose refresh tokens are all revoked, then groups
   * what is left by the browser that created it. Without the grouping a
   * laptop that signed in a dozen times filled the page with a dozen
   * identical "active" rows.
   */
  const { data, error } = await db.rpc("security_list_session_devices", {
    p_tenant_id: tenantId,
  });
  if (error) throw new Error(error.message);

  return mergeSameDevice((data ?? []).map((row: any) => wireSessionFromRow(row, currentSessionId)));
}

/**
 * Fold together rows that would read as the same device on screen.
 *
 * The SQL groups by the browser's own identity string, which is the right key
 * for "this client" — but two different clients can parse to the same three
 * display words (a script and a CLI both come out as "Browser · Device"), and
 * two identical-looking rows is exactly the complaint the grouping was meant
 * to answer. So the last fold is on what the reader sees.
 */
export function mergeSameDevice(rows: WireSession[]): WireSession[] {
  const byDevice = new Map<string, WireSession>();
  for (const row of rows) {
    const key = `${row.userId}|${row.kind}|${row.browser}|${row.os}|${row.device}`;
    const seen = byDevice.get(key);
    if (!seen) {
      byDevice.set(key, row);
      continue;
    }
    const newest = row.lastActive > seen.lastActive ? row : seen;
    byDevice.set(key, {
      ...newest,
      // The badge has to say "current" if any session behind it is this one.
      current: seen.current || row.current,
      count: seen.count + row.count,
      ids: [...seen.ids, ...row.ids],
      firstSeen: seen.firstSeen < row.firstSeen ? seen.firstSeen : row.firstSeen,
      lastActive: newest.lastActive,
      createdAt: newest.createdAt,
    });
  }
  return [...byDevice.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

/**
 * Staff sessions live in a separate table (`staff_sessions`) from owner
 * sessions — a PIN login never touches Supabase Auth, so without this the
 * Security dashboard showed only the owner and every PIN session was
 * invisible. UA/IP are recorded at login (migration 0055); sessions created
 * before then show "Unknown client".
 *
 * Expiry mirrors the guard's 12-hour rule: sessions older than 12h are dead
 * (the guard deletes them lazily on use) and are not shown.
 */
export function wireStaffSessionFromRow(row: any): WireSession {
  const agent = parseUserAgent(row.user_agent);
  const staff = row.staff ?? {};
  const roleRel = Array.isArray(staff.role) ? staff.role[0] : staff.role;
  return {
    id: row.id,
    userId: staff.id ?? row.staff_id,
    device: agent.device,
    browser: agent.browser,
    os: agent.os,
    ip: cleanIp(row.ip),
    location: null,
    kind: "staff",
    role: roleRel?.name ?? null,
    current: false,
    lastActive: row.last_active,
    createdAt: row.created_at,
    user: {
      id: staff.id ?? row.staff_id,
      name: staff.name ?? "Staff",
      // Staff have no email; the employee id is their login identifier.
      email: staff.employee_id ?? "",
    },
    // A PIN session is one row by definition — there is nothing to group.
    count: 1,
    ids: [row.id],
    firstSeen: row.created_at,
  };
}

export async function listStaffSessions(
  db: SupabaseClient,
  tenantId: string,
): Promise<WireSession[]> {
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("staff_sessions")
    .select(
      "id, staff_id, created_at, last_active, user_agent, ip, " +
        "staff:staff_id!inner(id, name, employee_id, active, tenant_id, role:roles(name))",
    )
    .eq("staff.tenant_id", tenantId)
    .eq("staff.active", true)
    .gte("created_at", twelveHoursAgo)
    .order("last_active", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);

  return (data ?? []).map(wireStaffSessionFromRow);
}

/**
 * Revoke one staff PIN session, tenant-scoped. Returns 1 when a session was
 * removed, 0 when the id did not match a staff session of this tenant — the
 * caller must treat 0 as a failure, same as revokeAuthSession.
 */
export async function revokeStaffSession(
  db: SupabaseClient,
  tenantId: string,
  sessionId: string,
): Promise<number> {
  const { data: match, error: matchError } = await db
    .from("staff_sessions")
    .select("id, staff:staff_id!inner(tenant_id)")
    .eq("id", sessionId)
    .eq("staff.tenant_id", tenantId)
    .maybeSingle();
  if (matchError) throw new Error(matchError.message);
  if (!match) return 0;

  const { error } = await db.from("staff_sessions").delete().eq("id", sessionId);
  if (error) throw new Error(error.message);
  return 1;
}

/**
 * End every staff PIN session in the tenant. Returns sessions removed.
 *
 * `keepStaffId` spares one staff member's session — the one doing the
 * revoking — so an admin emptying the list is not logged out of it.
 */
export async function revokeAllStaffSessions(
  db: SupabaseClient,
  tenantId: string,
  keepStaffId: string | null = null,
): Promise<number> {
  const { data: staffRows, error: staffError } = await db
    .from("staff")
    .select("id")
    .eq("tenant_id", tenantId)
    .neq("id", keepStaffId ?? "00000000-0000-0000-0000-000000000000");
  if (staffError) throw new Error(staffError.message);
  const ids = (staffRows ?? []).map((s: any) => s.id);
  if (ids.length === 0) return 0;

  const { error, count } = await db
    .from("staff_sessions")
    .delete({ count: "exact" })
    .in("staff_id", ids);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Revoke one session. Returns the number of sessions removed — 0 means the
 * session did not belong to this tenant or was already gone, which the caller
 * must treat as a failure so the UI can never toast success over a no-op.
 */
export async function revokeAuthSession(
  db: SupabaseClient,
  tenantId: string,
  sessionId: string,
): Promise<number> {
  const { data, error } = await db.rpc("security_revoke_session", {
    p_tenant_id: tenantId,
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * Revoke every session behind one displayed row — the same browser, signed in
 * more than once. Returns sessions removed; 0 means the id matched nothing in
 * this tenant, which the caller must treat as a failure.
 */
export async function revokeSessionDevice(
  db: SupabaseClient,
  tenantId: string,
  sessionId: string,
): Promise<number> {
  const { data, error } = await db.rpc("security_revoke_session_device", {
    p_tenant_id: tenantId,
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * Retire the previous sessions from this browser, keeping the one just
 * created. Called after a successful sign-in so repeated logins do not pile
 * up — the page was showing fifteen "active sessions" for one laptop.
 * Best effort: a failure here must never fail a login.
 */
export async function pruneSessionsForDevice(
  db: SupabaseClient,
  userId: string,
  keepSessionId: string | null,
  userAgent: string | null = null,
): Promise<number> {
  if (!keepSessionId) return 0;
  const { data, error } = await db.rpc("security_prune_sessions", {
    p_user_id: userId,
    p_keep_session_id: keepSessionId,
    // The browser's own agent, from the request. The stored one is the edge
    // runtime's until stampSession() replaces it.
    p_user_agent: userAgent,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * Write the requesting browser's agent (and address) onto the session GoTrue
 * just created. Without this every owner sign-in is stamped with the edge
 * runtime's user agent, so the dashboard cannot tell a phone from a laptop.
 */
export async function stampSession(
  db: SupabaseClient,
  sessionId: string | null,
  userAgent: string | null,
  ip: string | null,
): Promise<void> {
  if (!sessionId) return;
  const { error } = await db.rpc("security_stamp_session", {
    p_session_id: sessionId,
    p_user_agent: userAgent,
    p_ip: ip,
  });
  if (error) throw new Error(error.message);
}

/**
 * Revoke every session of every profile in the tenant, except one.
 *
 * `excludeSessionId` is the caller's own session: revoking the list must not
 * sign out the person doing it. The exclusion is enforced in SQL, so a caller
 * that never passes it cannot lock itself out by accident.
 */
export async function revokeAllAuthSessions(
  db: SupabaseClient,
  tenantId: string,
  excludeSessionId: string | null = null,
): Promise<number> {
  const { data, error } = await db.rpc("security_revoke_all_sessions", {
    p_tenant_id: tenantId,
    p_exclude_session_id: excludeSessionId,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
