/**
 * Who did it — one answer, used by every surface that shows the audit trail.
 *
 * The Security page reads its log from /security, but the first paint and the
 * realtime refresh both come from /bootstrap, so the same event is rendered
 * from two payloads. Deriving the actor twice is how the two would drift apart.
 *
 * The rules, in order:
 *   * a row with `actor_staff_id` was a staff PIN action — name them from the
 *     staff record (deleted staff still get a truthful label);
 *   * a failed login is an *attempted* identity, never a person — naming the
 *     profile would blame its owner for someone else's attempt;
 *   * otherwise it was an owner/admin, named from the profile;
 *   * anything else is "System" — never a UUID, never an IP.
 */

export type Actor = {
  kind: "owner" | "staff" | "attempt" | "unknown";
  name: string;
  role: string | null;
};

export type ActorMaps = {
  staff: Map<string, { name: string; role: string | null }>;
  profiles: Map<string, { name: string; role: string | null }>;
};

/** The email a login attempt was made with, when the row recorded one. */
export function attemptedIdentity(meta: unknown): string {
  const match = String(meta ?? "").match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0] : "Unknown account";
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Remove database identifiers from text shown to a person.
 *
 * A session id is an internal handle: it identifies nothing an owner can act
 * on, and printing it puts a live identifier into a page that may be on a
 * shared screen. New rows are written without one; this covers the rows
 * already in the table, so history reads cleanly too.
 *
 * "Session <uuid> revoked" becomes "Session revoked", not "Session  revoked" —
 * the leftover gap is collapsed so the sentence still reads as English.
 */
export function scrubIds(value: unknown): string {
  return String(value ?? "")
    .replace(UUID_RE, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/** Build the id → person lookup from the rows both endpoints already fetch. */
export function actorMaps(
  staffRows: any[] | null | undefined,
  profileRows: any[] | null | undefined,
): ActorMaps {
  const staff = new Map<string, { name: string; role: string | null }>();
  for (const row of staffRows ?? []) {
    const rel = Array.isArray(row.role) ? row.role[0] : row.role;
    staff.set(String(row.id), { name: row.name ?? "Staff", role: rel?.name ?? null });
  }
  const profiles = new Map<string, { name: string; role: string | null }>();
  for (const row of profileRows ?? []) {
    // `roleRef` is bootstrap's join, `roleRow` is /security's; the plain `role`
    // column is the legacy text value most owner profiles still carry.
    const rel = [row.roleRef, row.roleRow].map((r) => (Array.isArray(r) ? r[0] : r)).find(Boolean);
    profiles.set(String(row.id), {
      name: row.name ?? "Owner",
      role: rel?.name ?? row.role ?? null,
    });
  }
  return { staff, profiles };
}

/** Resolve one audit row to the person who caused it. */
export function resolveActor(log: any, maps: ActorMaps): Actor {
  if (log.actor_staff_id) {
    const member = maps.staff.get(String(log.actor_staff_id));
    return member
      ? { kind: "staff", name: member.name, role: member.role }
      : { kind: "staff", name: "Former staff member", role: null };
  }
  if (log.action === "LOGIN_FAILED") {
    return { kind: "attempt", name: attemptedIdentity(log.meta), role: null };
  }
  const owner = log.user_id ? maps.profiles.get(String(log.user_id)) : null;
  if (owner) return { kind: "owner", name: owner.name, role: owner.role };
  return { kind: "unknown", name: "System", role: null };
}

/**
 * An audit row as the interface may show it.
 *
 * One place decides what a person sees: the actor, and a description with no
 * identifiers left in it. Both payloads go through this, so a row rendered
 * from /security and the same row rendered from /bootstrap are identical.
 */
export function presentLog(log: any, maps: ActorMaps) {
  return {
    ...log,
    meta: scrubIds(log.meta) || null,
    actor: resolveActor(log, maps),
  };
}
