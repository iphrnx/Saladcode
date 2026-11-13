// Client IP resolution — the single place every function gets the caller's
// IP from. Used by auth (login, failed login, register), settings (audit),
// security (revocation audit), and the session/activity readers.
//
// Why not "first entry of x-forwarded-for" blindly: XFF is a client-
// controllable header on the open internet, and on generic infrastructure
// the leftmost entry is the spoofable one. What makes resolution safe HERE
// is measured behaviour of the Supabase edge gateway, probed on 2026-10-31
// (security v28, three request shapes):
//
//   clean request:    xff = "<client>, <client>, <supabase-egress>"
//                     cf-connecting-ip = <client>
//   spoofed XFF sent: xff = "<client>, <client>, <supabase-egress>"  (unchanged)
//                     cf-connecting-ip = <client>                    (unchanged)
//
// The gateway DISCARDS any client-supplied chain and rebuilds the header
// itself: the real connecting peer on the left, its own egress pool
// (rotating AWS addresses) on the right. So on this infrastructure:
//
//   - `cf-connecting-ip`, when present, is the authoritative client address.
//   - otherwise the FIRST x-forwarded-for entry is the client.
//   - everything further right is Supabase infrastructure and must never be
//     reported as the client — the egress pool is exactly the "internal
//     proxy IP" a naive rightmost-entry implementation would leak.
//
// If Supabase's gateway behaviour ever changes, the spoof tests in
// scripts/test-security-offline.mts pin the rule this module implements.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Loose but strict-enough v6: hex groups, colons, optional "::", optional
// embedded IPv4 tail (the mapped form "::ffff:1.2.3.4" carries dots).
// Rejects hostnames, ports, and injection garbage.
const IPV6 = /^[0-9a-fA-F:.]+$/;

/**
 * Validate and normalize one IP literal. Returns null for anything that is
 * not a plausible IPv4/IPv6 address — the caller decides the fallback, so no
 * garbage string ever reaches an audit row or the UI.
 *
 * Normalization: IPv4 octet range-checked; IPv6 lowercased with zone ids
 * removed; IPv4-mapped IPv6 ("::ffff:1.2.3.4") unwrapped to IPv4; CIDR masks
 * ("/32") stripped — Postgres `inet` renders auth.sessions.ip with one.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  // Strip a CIDR mask (Postgres inet presentation) and v6 zone ids.
  s = s.replace(/\/\d{1,3}$/, "").replace(/%[A-Za-z0-9_.-]+$/, "");
  // Strip brackets some proxies add around v6 literals.
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);

  const v4 = IPV4.exec(s);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    return octets.join(".");
  }

  if (s.includes(":") && IPV6.test(s)) {
    const lower = s.toLowerCase();
    // Unwrap IPv4-mapped ("::ffff:1.2.3.4") and compatible ("::1.2.3.4") so
    // the same client does not appear in two spellings across rows.
    const mapped = /^(::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped) return normalizeIp(mapped[2]);
    // Canonical text (RFC 5952): lowercase, no leading zeros in any group.
    const strip = (half: string) =>
      half.split(":").map((g) => g.replace(/^0+(?=[0-9a-f])/, "")).join(":");
    const halves = lower.split("::");
    return halves.length === 2
      ? `${strip(halves[0])}::${strip(halves[1])}`
      : strip(lower);
  }
  return null;
}

/**
 * Resolve the client IP of an incoming request using the trusted sources in
 * order: cf-connecting-ip (gateway-written), then the leftmost
 * x-forwarded-for entry. Everything further right in the chain is Supabase
 * egress infrastructure by measurement — deliberately never consulted.
 * Returns "unknown" when nothing valid is present (local dev, service-to-
 * service calls), never an internal proxy address.
 */
export function resolveClientIp(req: Request): string {
  const cf = normalizeIp(req.headers.get("cf-connecting-ip"));
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = normalizeIp(xff.split(",")[0]);
    if (first) return first;
  }
  return "unknown";
}

/** The IP to persist for an incoming request — never the raw header. */
export const clientIp = resolveClientIp;

/**
 * Normalize a STORED ip value for display. Rows written before resolution
 * was centralized may still hold a whole proxy chain or an inet mask; this
 * cleans them at read time so history needs no migration.
 */
export function cleanIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normalizeIp(raw.split(",")[0]);
}
