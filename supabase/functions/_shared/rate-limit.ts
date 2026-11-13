/**
 * Rate limiting for the anonymous routes.
 *
 * The counter lives in Postgres because an edge function has no shared memory:
 * a Map in module scope is per-isolate, and there are many isolates. A limiter
 * that only counts a fraction of the traffic is worse than none, because it
 * looks like protection.
 *
 * Fails OPEN. If the limiter itself is unavailable, the request is allowed:
 * refusing every diner in the restaurant because a counter table is slow is a
 * bigger outage than the abuse it defends against, and the ordering path is
 * already bounded by the session check and the idempotency key.
 */
import { admin } from "./db.ts";

export interface RateLimitVerdict {
  allowed: boolean;
  /** Present when refused — the caller turns this into a 429. */
  retryAfterSeconds?: number;
}

/**
 * Count one hit. `bucket` must already be unguessable or scoped — the limiter
 * only counts, it does not identify.
 */
export async function rateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitVerdict> {
  try {
    const { data, error } = await admin().rpc("rate_limit_hit", {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return { allowed: true };
    if (data === true) return { allowed: true };
    return { allowed: false, retryAfterSeconds: windowSeconds };
  } catch {
    return { allowed: true };
  }
}

/** A short, non-reversible key for an IP or a token, so limits are not a log. */
export async function bucketKey(prefix: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${prefix}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex}`;
}
