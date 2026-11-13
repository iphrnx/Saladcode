/**
 * Signature helpers, with no imports at all.
 *
 * These live apart from the Razorpay client so they can be exercised without a
 * database or a network — the two things the client module pulls in — and so the
 * comparison exists once. The secrets never appear here: callers pass one in.
 */

/** HMAC-SHA256 of a message, hex encoded — the form Razorpay uses. */
export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two hex signatures without leaking where they differ, and without
 * being fooled by a longer or shorter candidate.
 */
export function signatureMatches(expected: string, provided: string): boolean {
  if (!expected || !provided) return false;
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/**
 * The strings Razorpay may have signed for a payment.
 *
 * An ordinary order payment signs `order_id|payment_id`; a subscription's
 * payment signs `payment_id|subscription_id`. A checkout can carry both an
 * order and a subscription (the first payment of a subscription does), and
 * which string Razorpay chose is its business — so the caller tries every
 * candidate the payment could plausibly have. Accepting either is not a
 * loosening: producing any one of them still requires the secret.
 */
export function paymentSignatureCandidates(args: {
  orderId?: string | null;
  paymentId: string;
  subscriptionId?: string | null;
}): string[] {
  const candidates: string[] = [];
  if (args.orderId) candidates.push(`${args.orderId}|${args.paymentId}`);
  if (args.subscriptionId) candidates.push(`${args.paymentId}|${args.subscriptionId}`);
  return candidates;
}
