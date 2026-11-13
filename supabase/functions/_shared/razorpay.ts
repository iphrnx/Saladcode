// deno-lint-ignore-file no-explicit-any
import { admin } from "./db.ts";
import { hmacSha256Hex, paymentSignatureCandidates, signatureMatches } from "./signature.ts";

/**
 * Razorpay client.
 *
 * The key id and the key secret are read from the function's own environment
 * and never leave it. Nothing here returns a secret, and nothing here is
 * called from the browser — the browser asks the edge function to create a
 * subscription and receives an id, a plan and an amount.
 *
 * Two signatures matter:
 *
 *   - the payment signature, which proves the browser really was talking to
 *     Razorpay about this order and this payment. It is checked before a
 *     subscription is activated.
 *   - the webhook signature, which proves the event really came from
 *     Razorpay. It is checked against the raw body, because re-serialising
 *     the JSON would change the bytes and break the comparison.
 */

export const RAZORPAY_API = "https://api.razorpay.com/v1";

export type RazorpayConfig = {
  keyId: string | null;
  keySecret: string | null;
  /** The secret Razorpay signs webhooks with. Falls back to the key secret. */
  webhookSecret: string | null;
};

export function razorpayConfig(): RazorpayConfig {
  return {
    keyId: (Deno.env.get("RAZORPAY_KEY_ID") ?? "").trim() || null,
    keySecret: (Deno.env.get("RAZORPAY_KEY_SECRET") ?? "").trim() || null,
    webhookSecret: (Deno.env.get("RAZORPAY_WEBHOOK_SECRET") ?? "").trim() || null,
  };
}

export function razorpayConfigured(): boolean {
  const c = razorpayConfig();
  return Boolean(c.keyId && c.keySecret);
}

function authHeader(): string {
  const { keyId, keySecret } = razorpayConfig();
  if (!keyId || !keySecret) {
    throw new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as edge function secrets.",
    );
  }
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

// The signing and comparison live in _shared/signature.ts, which imports
// nothing: this module reaches a database and a network, and the code that
// decides whether a signature is valid should be testable without either.
export { hmacSha256Hex } from "./signature.ts";

/**
 * Check the signature Razorpay returns after the checkout.
 *
 * The signed string is the order id and the payment id, joined by a pipe.
 * This is what proves the payment really is for this order — without it, a
 * browser could post any payment id it liked and have a subscription
 * activated.
 */
export async function verifyPaymentSignature(opts: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  razorpaySubscriptionId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { keySecret } = razorpayConfig();
  if (!keySecret) {
    return { ok: false, error: "Razorpay is not configured on the server." };
  }
  if (!opts.razorpayPaymentId || !opts.razorpaySignature) {
    return { ok: false, error: "The payment details are incomplete." };
  }

  // One-time payments sign the order; subscription payments sign the
  // subscription. A checkout carrying both has to accept whichever Razorpay
  // used, or a genuine subscription payment is refused.
  const candidates = paymentSignatureCandidates({
    orderId: opts.razorpayOrderId || null,
    paymentId: opts.razorpayPaymentId,
    subscriptionId: opts.razorpaySubscriptionId || null,
  });
  if (candidates.length === 0) {
    return { ok: false, error: "The payment details are incomplete." };
  }
  let matched = false;
  for (const candidate of candidates) {
    if (signatureMatches(await hmacSha256Hex(candidate, keySecret), opts.razorpaySignature)) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    return { ok: false, error: "The payment signature did not match. The payment was not accepted." };
  }
  return { ok: true };
}

/**
 * Check the signature on a webhook event.
 *
 * The signature is over the raw body, so the body is read as text and
 * verified before it is parsed.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = razorpayConfig();
  const secret = config.webhookSecret ?? config.keySecret;
  if (!secret) {
    return { ok: false, error: "Razorpay is not configured on the server." };
  }
  if (!signature) {
    return { ok: false, error: "The webhook had no signature." };
  }

  const expected = await hmacSha256Hex(rawBody, secret);
  if (!signatureMatches(expected, signature)) {
    return { ok: false, error: "The webhook signature did not match." };
  }
  return { ok: true };
}

export type RazorpaySubscription = {
  id: string;
  status: string;
  plan_id: string;
  /** How many charges the subscription has collected. 0 until first payment. */
  paid_count?: number;
  total_count?: number;
  /** Charges still to come. 0 means the mandate is spent. */
  remaining_count?: number;
  current_start?: number;
  current_end?: number;
  /** The last moment the mandate can charge. Razorpay derives it from
   * `total_count`; it is the field to trust for "when does this end". */
  end_at?: number | null;
  /** Only the window in which the customer may AUTHORISE — not the mandate
   * end. Razorpay defaults it to 30 years, which is why it is always set
   * explicitly here. */
  expire_by?: number | null;
  charge_at?: number | null;
  auth_attempts?: number;
  customer_id?: string;
  notes?: Record<string, string>;
};

export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
  notes?: Record<string, string>;
};

async function razorpayRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${RAZORPAY_API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Razorpay: ${(e as Error).message}`, status: 0 };
  }

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }

  if (!res.ok) {
    // A throttled account is not the customer's fault and not a validation
    // error: say so, so the person retries in a minute instead of deciding
    // the plan is broken.
    const message = res.status === 429
      ? "Razorpay is temporarily limiting requests for this account. Please try again in a minute."
      : (body?.error?.description || body?.message || `Razorpay answered ${res.status}`);
    return { ok: false, error: message, status: res.status };
  }
  return { ok: true, data: body as T };
}

/**
 * Create a subscription for a plan.
 *
 * The plan id is the one Razorpay knows, which comes from the plan
 * catalogue and is set by the Super Admin — it cannot be invented here.
 */
export async function createSubscription(opts: {
  razorpayPlanId: string;
  totalCount: number;
  customer: { name: string; email: string };
  notes: Record<string, string>;
  /**
   * When the first charge should happen, as Unix seconds. A subscription
   * for a restaurant that still has paid time left starts at the end of
   * that period: the customer authorises the mandate now, and the first
   * (and only) charge lands at the boundary — so the remaining days they
   * already paid for are never re-sold to them.
   */
  startAt?: number;
  /**
   * The window in which the customer may AUTHORISE the mandate — not when the
   * mandate ends. Razorpay defaults it to thirty years, so it is always passed
   * explicitly: an authorisation link that stays payable for thirty years is a
   * subscription id anyone could settle long after the conversation ended.
   * The mandate's real end comes from `total_count` (Razorpay derives
   * `end_at` from it), never from this field.
   */
  expireBy?: number;
}): Promise<{ ok: true; data: RazorpaySubscription } | { ok: false; error: string }> {
  const res = await razorpayRequest<RazorpaySubscription>("/subscriptions", {
    method: "POST",
    body: {
      plan_id: opts.razorpayPlanId,
      total_count: opts.totalCount,
      quantity: 1,
      customer_notify: 1,
      notes: opts.notes,
      ...(opts.startAt ? { start_at: opts.startAt } : {}),
      ...(opts.expireBy ? { expire_by: opts.expireBy } : {}),
    },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

/** Create the order the checkout is started against. */
export async function createOrder(opts: {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}): Promise<{ ok: true; data: RazorpayOrder } | { ok: false; error: string }> {
  const res = await razorpayRequest<RazorpayOrder>("/orders", {
    method: "POST",
    body: {
      amount: Math.round(opts.amount * 100), // Razorpay works in paise
      currency: opts.currency,
      receipt: opts.receipt,
      notes: opts.notes,
    },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

export async function fetchSubscription(
  id: string,
): Promise<{ ok: true; data: RazorpaySubscription } | { ok: false; error: string }> {
  const res = await razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(id)}`);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: res.data };
}

/**
 * Change the plan on a live subscription, effective at the end of the
 * current billing cycle.
 *
 * The plan the tenant is entitled to changes exactly when the new plan's
 * money is collected — at the next charge — never before. With
 * `schedule_change_at: "cycle_end"` Razorpay takes no payment now: the
 * next `subscription.charged` event carries the new plan id and the
 * webhook applies it then. (The old code called a non-existent
 * `POST /subscriptions/:id/update` with `prorate: true`, which Razorpay
 * would have refused — the documented endpoint is PATCH with
 * `schedule_change_at`.)
 */
export async function updateSubscriptionPlanAtCycleEnd(
  subscriptionId: string,
  razorpayPlanId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await razorpayRequest<RazorpaySubscription>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    {
      method: "PATCH",
      body: {
        plan_id: razorpayPlanId,
        schedule_change_at: "cycle_end",
      },
    },
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

export async function cancelSubscription(
  id: string,
  cancelAtCycleEnd: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await razorpayRequest<unknown>(`/subscriptions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: { cancel_at_cycle_end: cancelAtCycleEnd },
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/**
 * The restaurant a Razorpay subscription belongs to.
 *
 * The tenant id travels in the subscription's notes, which Razorpay echoes
 * back on every webhook. The webhook itself is signed, so the notes cannot
 * be forged by anyone else.
 */
export async function tenantFromNotes(
  notes: Record<string, string> | undefined | null,
): Promise<string | null> {
  const tenantId = notes?.tenant_id ?? notes?.tenantId ?? null;
  if (!tenantId) return null;
  const { data } = await admin()
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .maybeSingle();
  return data?.id ?? null;
}

export type RazorpayPayment = {
  id: string;
  /** Minor units. */
  amount: number;
  currency: string;
  order_id?: string;
  status: string;
  method?: string;
  error_description?: string;
};

/**
 * Fetch a payment from Razorpay.
 *
 * The signature a browser sends covers the order id and the payment id, and
 * nothing else — not the amount, not the currency, not whether the payment was
 * captured. So the amount a subscription is activated for cannot come from the
 * browser or from the plan's list price: it comes from here.
 *
 * The failure shape matters as much as the success one. `status: 0` means
 * Razorpay could not be reached, which is not evidence that a payment failed.
 */
export async function fetchPayment(
  paymentId: string,
): Promise<
  { ok: true; data: RazorpayPayment } | { ok: false; error: string; status: number }
> {
  return await razorpayRequest<RazorpayPayment>(
    `/payments/${encodeURIComponent(paymentId)}`,
    {},
  );
}
