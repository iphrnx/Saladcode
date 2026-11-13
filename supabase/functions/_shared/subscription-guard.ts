/**
 * The one-billable-plan rules, separated from the plumbing that carries them.
 *
 * The guarantee this module exists for:
 *
 *     One restaurant = one billable plan = one recurring charge.
 *
 * Everything here is pure — no database, no network, no environment — for the
 * same reason `_shared/billing.ts` is: the rules that decide when a mandate
 * may be created, reused, or cancelled are the rules that decide whether a
 * restaurant is ever charged twice, and rules that can only be exercised
 * against live Razorpay are rules nobody tests.
 *
 * The edge functions do the I/O and ask this module what to do.
 */

/**
 * What Razorpay says about a subscription, reduced to the fields the
 * decisions need. `paidCount` is Razorpay's own count of collected charges —
 * the only safe proof that a mandate has ever taken money.
 */
export type LiveSubscription = {
  /** Razorpay's status string: created, authenticated, active, paused,
      halted, cancelled, completed, expired. */
  status: string;
  paidCount: number;
};

/** A mandate that can still take money in the future. */
export function isBillableStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "authenticated" || s === "active" || s === "paused";
}

/**
 * A mandate that has never been authorised but whose authorisation link may
 * still be live. It cannot charge today — but anyone holding the link can
 * make it billable, so it is not safely ignored either.
 */
export function isAuthorisableStatus(status: string): boolean {
  return status.toLowerCase() === "created";
}

/** A mandate that will never charge again and needs no cancellation. */
export function isDeadStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "cancelled" || s === "completed" || s === "expired" || s === "halted";
}

/**
 * Can this mandate be cancelled without ever touching money that was
 * collected? Only a mandate that has never charged may be cancelled
 * automatically: cancelling a mandate that has collected payments is a real
 * billing action and goes through a human-approved path.
 */
export function canCancelWithoutPaymentImpact(live: LiveSubscription): boolean {
  return live.paidCount === 0 && (isBillableStatus(live.status) || isAuthorisableStatus(live.status));
}

/** A pending mandate checkout, as recorded in `subscription_checkouts`. */
export type PendingMandateCheckout = {
  id: string;
  planId: string;
  interval: "monthly" | "annual" | null;
  /** ISO timestamp the first charge is scheduled for, or null = immediate. */
  scheduledStartAt: string | null;
  razorpaySubscriptionId: string;
};

export type CheckoutAction =
  /** No pending mandate exists — create the subscription. */
  | { kind: "create" }
  /**
   * The pending mandate is exactly what was asked for and is still open —
   * hand its id back. A repeated click, a retried request, a second tab:
   * they all converge on the same mandate instead of minting new ones.
   */
  | { kind: "reuse"; checkout: PendingMandateCheckout }
  /**
   * The pending mandate is superseded — a different plan, a different
   * interval, or a start date computed from paid time that has since moved.
   * It has never charged, so it is cancelled at Razorpay and its row
   * expired, and a fresh subscription is created.
   */
  | { kind: "replace"; checkout: PendingMandateCheckout }
  /**
   * The pending mandate is already dead at Razorpay (cancelled, expired,
   * completed, halted) — no cancellation is needed, only its row is expired
   * and a fresh subscription is created.
   */
  | { kind: "expire"; checkout: PendingMandateCheckout }
  /**
   * Razorpay could not confirm the pending mandate's state. Creating a
   * second mandate while the first might be billable is exactly the bug
   * this module exists to prevent, so the answer is "try again", not a
   * guess.
   */
  | { kind: "unavailable" }
  /**
   * The pending mandate has already collected money — it is not a pending
   * anything, it is a live subscription for another plan. A new mandate is
   * the wrong tool; the plan-change path handles this.
   */
  | { kind: "blocked"; reason: string };

/**
 * Are two scheduled starts the same moment? Second-level tolerance: the
 * start is always derived from the tenant's period end, which does not move
 * between the click and the retry.
 */
export function sameScheduledStart(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const am = new Date(a).getTime();
  const bm = new Date(b).getTime();
  if (!Number.isFinite(am) || !Number.isFinite(bm)) return false;
  return Math.abs(am - bm) < 60_000;
}

/**
 * What a mandate checkout request should do about a mandate checkout that
 * is already pending for the restaurant.
 */
export function decideCheckoutAction(args: {
  existing: PendingMandateCheckout | null;
  /** Razorpay's report on the existing mandate, or null when the fetch failed. */
  live: LiveSubscription | null;
  requestPlanId: string;
  requestInterval: "monthly" | "annual";
  requestScheduledStart: string | null;
}): CheckoutAction {
  const { existing, live, requestPlanId, requestInterval, requestScheduledStart } = args;
  if (!existing) return { kind: "create" };

  if (!live) {
    // The state of a possibly-billable mandate is unknown. Reusing it is
    // safe when it is exactly what was requested (authorising the same
    // mandate twice is a no-op at Razorpay); anything else must wait.
    if (existing.planId === requestPlanId && existing.interval === requestInterval) {
      return { kind: "reuse", checkout: existing };
    }
    return { kind: "unavailable" };
  }

  // It has collected money — it is a live subscription, whatever our row
  // says. A second mandate on top would be the double-billing bug itself.
  if (live.paidCount > 0 && !isDeadStatus(live.status)) {
    return {
      kind: "blocked",
      reason:
        "This mandate has already started charging. Change the plan on it instead of starting a new one.",
    };
  }

  if (isDeadStatus(live.status)) {
    return { kind: "expire", checkout: existing };
  }

  const sameIntent = existing.planId === requestPlanId &&
    existing.interval === requestInterval &&
    sameScheduledStart(existing.scheduledStartAt, requestScheduledStart);
  if (sameIntent) {
    return { kind: "reuse", checkout: existing };
  }
  return { kind: "replace", checkout: existing };
}

export type SwitchAction =
  /** Nothing to do — there was no previous mandate, or it is the same one. */
  | { kind: "leave" }
  /**
   * The previously linked mandate is still billable at Razorpay. The
   * restaurant's billing has moved to a new mandate, so the old one is
   * cancelled immediately — access already paid for lives in the period
   * dates, not in the mandate.
   */
  | { kind: "cancel-previous" }
  /**
   * The previous mandate could not be checked. The switch still happens —
   * the new mandate has collected real money — but the unknown is recorded
   * for reconciliation instead of being assumed away.
   */
  | { kind: "unknown" };

/**
 * What linking the restaurant to a new subscription should do about the
 * subscription it was linked to before.
 */
export function decideSwitchAction(args: {
  previousSubscriptionId: string | null;
  newSubscriptionId: string | null;
  /** Razorpay's report on the previous subscription, or null when the fetch failed. */
  previousLive: LiveSubscription | null;
}): SwitchAction {
  const { previousSubscriptionId, newSubscriptionId, previousLive } = args;
  if (!previousSubscriptionId || previousSubscriptionId === newSubscriptionId) {
    return { kind: "leave" };
  }
  if (!previousLive) return { kind: "unknown" };
  if (isBillableStatus(previousLive.status)) return { kind: "cancel-previous" };
  return { kind: "leave" };
}

/**
 * Should a mandate scheduled to start at `scheduledStartAt` be superseded by
 * a purchase that just moved the paid boundary to `newPeriodEnd`?
 *
 * A scheduled mandate's start is computed from the paid time that existed
 * when it was created. A purchase that extends the paid time past the
 * mandate's start makes the mandate wrong: it would begin debiting while
 * the restaurant has already paid. A mandate whose start still sits at (or
 * after) the new boundary is exactly the future the customer arranged.
 */
export function mandateSupersededByPeriod(
  scheduledStartAt: string | null,
  newPeriodEnd: string,
): boolean {
  if (!scheduledStartAt) {
    // An immediate-start mandate that is still pending while new paid time
    // exists is stale by definition.
    return true;
  }
  const start = new Date(scheduledStartAt).getTime();
  const end = new Date(newPeriodEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  // An hour of slack for clock and rounding differences — the mandate's
  // start is the boundary it was computed from, give or take nothing.
  return start < end - 3_600_000;
}

export type MandateVerdict =
  /** Can take money in the future — the thing the invariant counts. */
  | "billable"
  /** Never authorised, but the link may still be live — authorisable. */
  | "authorisable"
  /** Will never charge again. */
  | "dead";

/** One word for what a mandate is, for the audit report. */
export function mandateVerdict(live: LiveSubscription | null): MandateVerdict | "unknown" {
  if (!live) return "unknown";
  if (isBillableStatus(live.status)) return "billable";
  if (isAuthorisableStatus(live.status)) return "authorisable";
  return "dead";
}

export type ChargeLinkAction =
  /**
   * Take the link: a renewal on the mandate already linked, a first link,
   * or a new billing source where the previous one cannot charge any more.
   */
  | { kind: "apply" }
  /**
   * The charging mandate is itself dead at Razorpay (cancelled after the
   * charge was emitted, or a long-late delivery). The money is recorded in
   * the ledger either way, but a dead mandate never takes over the link —
   * this is how an old webhook cannot cancel a valid subscription by
   * re-pointing the tenant at it.
   */
  | { kind: "reject-dead-incoming" }
  /**
   * A different mandate already holds the link and can still charge. The
   * incoming charge is from a duplicate: the money is recorded and flagged
   * for review, the link stays put, and the duplicate is cancelled so it
   * cannot charge again. First-linked wins — deterministically, so two
   * mandates can never flap the link back and forth.
   */
  | { kind: "reject-linked-billable" };

/**
 * Should a charge (or first-payment activation) from `incomingId` move the
 * tenant's link?
 *
 * The naive answer — always link the subscription that charged — breaks the
 * moment two billable mandates exist: each one's charge re-links the tenant
 * and cancels the other, forever. The decision has to be stable:
 *
 *   - a renewal on the linked mandate always applies;
 *   - a dead mandate never takes the link, however real its charge is;
 *   - a live incoming mandate takes the link only when nothing billable
 *     holds it already.
 */
export function decideChargeLink(args: {
  linkedId: string | null;
  incomingId: string;
  /** Live read of the linked mandate; null when the fetch failed. */
  linkedLive: LiveSubscription | null;
  /** Live read of the incoming mandate; null when the fetch failed. */
  incomingLive: LiveSubscription | null;
}): ChargeLinkAction {
  const { linkedId, incomingId, linkedLive, incomingLive } = args;

  if (linkedId === incomingId) return { kind: "apply" };

  // A dead mandate never takes over. When the incoming status is unknown we
  // do not guess "dead" — the charge is real money that deserves the link
  // review below, not silence.
  if (incomingLive && isDeadStatus(incomingLive.status)) {
    return { kind: "reject-dead-incoming" };
  }

  if (!linkedId) return { kind: "apply" };

  // The linked mandate's state is unknown: the incoming charge has real
  // money behind it, so the link follows the money and the sweep logs what
  // it could not verify about the previous one.
  if (!linkedLive) return { kind: "apply" };

  if (isBillableStatus(linkedLive.status)) return { kind: "reject-linked-billable" };

  return { kind: "apply" };
}

export type ScheduledCancelAction =
  /** Razorpay already says this mandate can never charge — nothing to do. */
  | { kind: "already-dead" }
  /**
   * Money has moved on this mandate. Cancelling it is a human decision with
   * refund implications, not an automatic one — the normal cancel flow owns
   * it (access runs to the period that was paid for).
   */
  | { kind: "refuse-charged" }
  /**
   * Never authorised, never charged: a 'created' mandate whose
   * authorisation link is still live. Cancelling kills the link — the one
   * thing that can turn a test mandate into a real charge — and touches no
   * money, no access, no future start.
   */
  | { kind: "cancel-never-authorised" }
  /**
   * Authorised and its start has come (or it never had one): it is a live
   * subscription now. Not cancellable as a "scheduled change".
   */
  | { kind: "refuse-started" }
  /**
   * Authorised, uncharged, and the start is still in the future: the
   * classic scheduled change. Cancelling is immediate and safe — there is
   * no paid time on THIS mandate to protect.
   */
  | { kind: "cancel-scheduled" }
  /** A status Razorpay did not document when this was written. Refused. */
  | { kind: "refuse-unknown" };

/**
 * May this mandate be cancelled as a not-yet-billing change, and why?
 *
 * The order of the questions is the safety argument:
 *
 *   1. dead → done, nothing can charge;
 *   2. charged → never automatic — money needs a human;
 *   3. never authorised → safe: no money, no access, only a live link;
 *   4. authorised → only while its start is still in the future.
 *
 * Every answer is derived from Razorpay's own report, never from our row.
 */
export function decideScheduledCancel(args: {
  scheduledStartAt: string | null;
  live: LiveSubscription;
}): ScheduledCancelAction {
  const { scheduledStartAt, live } = args;

  if (isDeadStatus(live.status)) return { kind: "already-dead" };

  if (live.paidCount > 0) return { kind: "refuse-charged" };

  if (isAuthorisableStatus(live.status)) return { kind: "cancel-never-authorised" };

  if (isBillableStatus(live.status)) {
    if (!scheduledStartAt) return { kind: "refuse-started" };
    const start = new Date(scheduledStartAt).getTime();
    if (!Number.isFinite(start) || start <= Date.now()) return { kind: "refuse-started" };
    return { kind: "cancel-scheduled" };
  }

  return { kind: "refuse-unknown" };
}
