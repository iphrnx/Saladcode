/**
 * The decisions billing makes, separated from the plumbing that carries them.
 *
 * Everything here is pure: no database, no network, no environment. That is
 * deliberate — these are the rules that decide whether money becomes
 * entitlement, and rules that can only be exercised against live Razorpay and a
 * live database are rules nobody tests. The edge functions do the I/O and ask
 * this module what to do.
 */

/** What a checkout recorded when it was created. */
export type CheckoutRecord = {
  tenantId: string;
  planId: string;
  /** In the plan's own units — rupees, as the catalogue prices it. */
  amount: number;
  currency: string;
  razorpayOrderId: string;
  razorpaySubscriptionId: string | null;
  status: "pending" | "paid" | "failed" | "expired";
  razorpayPaymentId: string | null;
};

/** The parts of a Razorpay payment this module reasons about. */
export type PaymentFacts = {
  id: string;
  /** Minor units, as Razorpay reports it (paise). */
  amount: number;
  currency: string;
  orderId: string | null;
  status: string;
};

export type Verdict =
  | { ok: true }
  | { ok: false; reason: string; code: "not_found" | "mismatch" | "unverified" };

/** Razorpay reports amounts in minor units. Rupees to paise, and back. */
export function minorUnits(amount: number, currency: string): number {
  // The currencies this product sells in have two decimals. A currency with a
  // different exponent would need its own row here rather than a guess.
  const exponent = ["JPY", "KRW"].includes(currency.toUpperCase()) ? 0 : 2;
  return Math.round(amount * 10 ** exponent);
}

export function fromMinorUnits(amount: number, currency: string): number {
  const exponent = ["JPY", "KRW"].includes(currency.toUpperCase()) ? 0 : 2;
  return Number((amount / 10 ** exponent).toFixed(exponent));
}

/**
 * The identity of a webhook delivery.
 *
 * Razorpay sends a per-delivery id in the `x-razorpay-event-id` header. That is
 * the identity — *not* `event.event`, which is the event *type*. Using the type
 * as the key means the first `subscription.charged` is recorded and every later
 * renewal, for every restaurant, is rejected as a duplicate.
 *
 * When the header is absent, the fallback has to be unique per delivery and
 * stable across retries of the same delivery: the type, the id of the entity it
 * is about, and the moment Razorpay created it. Two renewals on the same
 * subscription differ by `created_at`; two entities differ by id.
 */
export function webhookEventId(
  headerId: string | null | undefined,
  event: { event?: unknown; created_at?: unknown; payload?: Record<string, any> },
): string | null {
  const fromHeader = String(headerId ?? "").trim();
  if (fromHeader) return fromHeader;

  const type = String(event?.event ?? "").trim();
  const entityId = String(
    event?.payload?.subscription?.entity?.id ??
      event?.payload?.payment?.entity?.id ??
      event?.payload?.order?.entity?.id ??
      "",
  ).trim();
  const createdAt = String(event?.created_at ?? "").trim();

  if (!type || !entityId || !createdAt) return null;
  return `${type}:${entityId}:${createdAt}`;
}

/** Razorpay's `created_at` is unix seconds. */
export function eventCreatedAt(event: { created_at?: unknown; payload?: Record<string, any> }): Date | null {
  const raw =
    event?.created_at ??
    event?.payload?.subscription?.entity?.created_at ??
    event?.payload?.payment?.entity?.created_at ??
    null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * Does this payment settle this checkout?
 *
 * The signature proves the payment is genuine and is for this order. It does
 * *not* say how much was paid — the signed string is the order id and the
 * payment id — so the amount, the currency and the order have to be checked
 * against what was recorded when the checkout was created, and the payment has
 * to be captured rather than merely authorised.
 */
export function checkoutMatches(args: {
  checkout: CheckoutRecord | null;
  tenantId: string;
  planId: string | null;
  payment: PaymentFacts | null;
}): Verdict {
  const { checkout, tenantId, planId, payment } = args;

  if (!checkout) {
    return {
      ok: false,
      code: "not_found",
      reason: "That order is not one of ours. Start the checkout again from this restaurant's billing page.",
    };
  }
  if (checkout.tenantId !== tenantId) {
    return { ok: false, code: "mismatch", reason: "That order belongs to another restaurant." };
  }
  if (planId && checkout.planId !== planId) {
    return { ok: false, code: "mismatch", reason: "That order is for a different plan." };
  }
  if (!payment) {
    return { ok: false, code: "unverified", reason: "The payment could not be confirmed with Razorpay." };
  }
  if (payment.orderId && payment.orderId !== checkout.razorpayOrderId) {
    return { ok: false, code: "mismatch", reason: "That payment is for a different order." };
  }
  if (payment.currency && payment.currency.toUpperCase() !== checkout.currency.toUpperCase()) {
    return { ok: false, code: "mismatch", reason: "That payment is in a different currency." };
  }
  if (payment.amount !== minorUnits(checkout.amount, checkout.currency)) {
    return {
      ok: false,
      code: "mismatch",
      reason: `The amount paid does not match this plan. ${fromMinorUnits(payment.amount, checkout.currency)} was paid.`,
    };
  }
  if (payment.status !== "captured") {
    return {
      ok: false,
      code: "unverified",
      reason: `The payment is ${payment.status}, not captured.`,
    };
  }
  return { ok: true };
}

/**
 * Is this delivery older than the state the subscription has already reached?
 *
 * Razorpay retries, and deliveries can arrive out of order. An event that is
 * older than the newest one already applied is recorded (so a retry is not
 * re-processed) but not acted on, or a `subscription.cancelled` from before a
 * renewal could cancel a subscription that has since been paid for.
 *
 * The database applies this rule as well, in `apply_subscription_event`, where
 * the cursor read and the delivery insert happen in one transaction — this is
 * the same rule, kept here so it can be exercised without a database.
 */
export function isStaleEvent(args: {
  eventCreatedAt: Date | null;
  cursorAt: Date | null;
}): boolean {
  const { eventCreatedAt, cursorAt } = args;
  if (!eventCreatedAt || !cursorAt) return false;
  return eventCreatedAt.getTime() < cursorAt.getTime();
}

/**
 * What to do with the payment a checkout row already names.
 *
 * Activation happens once per payment. Calling verify again with the same
 * payment is a legitimate thing a browser does after a refresh, and it must
 * answer "already active" — not move the period forward another month.
 */
export function entitlementAction(args: {
  checkout: CheckoutRecord;
  paymentId: string;
}): "activate" | "already" {
  const { checkout, paymentId } = args;
  if (checkout.status === "paid" && checkout.razorpayPaymentId === paymentId) {
    return "already";
  }
  return "activate";
}

/** Where a settled checkout's period should end. */
export function periodEndFrom(from: Date, days = 30): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

/**
 * The end of the period a checkout bought.
 *
 * A monthly subscription is thirty days from the boundary it starts at; an
 * annual one is a year. Razorpay owns the real renewal date and the webhook
 * moves it on every charge — this is only the date the licence is granted for
 * when a payment is first verified, and getting the interval wrong here would
 * grant a year of access for a month's money (or the reverse).
 */
export function purchasedPeriodEnd(from: Date, interval: "monthly" | "annual"): string {
  return interval === "annual"
    ? new Date(from.getTime() + 366 * 86_400_000).toISOString()
    : periodEndFrom(from);
}

/**
 * Reading a failed Razorpay call.
 *
 * A payment we could not fetch is not a payment that failed. Razorpay being
 * unreachable, rate-limiting or timing out says nothing about whether the money
 * moved, so it is answered as pending and retryable. Only an answer that
 * positively says the payment does not exist, or is not captured, is a refusal.
 */
export function paymentFetchFailure(args: {
  status: number;
  error?: string;
}): { retryable: boolean; code: "unverified" | "not_found"; reason: string } {
  const { status, error } = args;
  if (status === 0) {
    return {
      retryable: true,
      code: "unverified",
      reason: "We could not reach the payment provider to confirm the payment. Please try again in a moment.",
    };
  }
  if (status === 404) {
    return { retryable: false, code: "not_found", reason: "That payment does not exist." };
  }
  if (status === 429 || status >= 500) {
    return {
      retryable: true,
      code: "unverified",
      reason: "The payment provider is busy confirming the payment. Please try again in a moment.",
    };
  }
  return {
    retryable: false,
    code: "unverified",
    reason: error || "The payment could not be confirmed with the provider.",
  };
}

/**
 * How a limit check that could not be completed is answered.
 *
 * A count that cannot be read is not evidence that there is room. The write is
 * refused and the caller is told to retry; letting it through would make the
 * limit advisory whenever the database is having a bad minute.
 */
export function limitCheckFailure(args: { error?: string }): {
  ok: false;
  retryable: true;
  status: 503;
  error: string;
} {
  return {
    ok: false,
    retryable: true,
    status: 503,
    error:
      args.error ??
      "We could not check your plan's limit just now, so nothing was saved. Please try again.",
  };
}

/**
 * What a failed payment does to the restaurant's status.
 *
 * A failed *renewal* moves a paying subscriber to past_due — they had a paid
 * period and the money stopped. A failed *first purchase* changes nothing:
 * the restaurant never had a paid period, so a declined card must not tear
 * down a running trial or turn a trial-expired state into something
 * stranger. The failed attempt is still recorded in the payment history;
 * only the status is left alone.
 */
/**
 * May a plan change run against the subscription this tenant is linked to?
 *
 * A linked subscription id is not evidence of a paid subscription: the old
 * checkout wrote the linkage before the payment, so an abandoned checkout
 * could leave a tenant that had already paid (a one-time purchase, say)
 * pointing at a subscription that never collected anything. The status field
 * alone is not evidence either — the same scenario reads as "active". So a
 * plan change requires proof that money was collected for THIS subscription:
 * a checkout that was paid, or a succeeded payment recorded against it.
 * Anything less is a first purchase, and first purchases go through
 * checkout, not through a plan change on a subscription that owes us
 * nothing and has never been paid for.
 */
export function mayChangePlanOnSubscription(args: {
  linkedSubscriptionId: string | null | undefined;
  subscriptionStatus: string;
  /** A paid checkout row or a succeeded payment row for that exact subscription, or null. */
  paidEvidence: unknown;
}): boolean {
  if (!args.linkedSubscriptionId) return false;
  // past_due is absent on purpose: the tenant only reaches past_due when
  // Razorpay has halted the subscription after its retries — a halted
  // mandate cannot carry a plan change, so recovery is a fresh checkout,
  // not a PATCH on a dead subscription.
  if (!["active", "cancelled"].includes(String(args.subscriptionStatus))) return false;
  return Boolean(args.paidEvidence);
}
