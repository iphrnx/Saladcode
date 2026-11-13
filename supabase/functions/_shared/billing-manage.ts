/**
 * The Manage Billing view's rules, kept pure so they can be tested without a
 * database or a network — the same discipline as `_shared/billing.ts`.
 *
 * The `subscriptions` function does the I/O (Postgres, Razorpay) and hands
 * the verified facts here; these functions decide what the owner is told.
 *
 * Invariants the whole file defends:
 *
 *   1. An authorised mandate is never a payment. Only a succeeded or
 *      refunded row in the payments ledger counts as money.
 *   2. A scheduled plan change is displayed only from records verified
 *      against Razorpay (a live fetch) or written by a signed webhook —
 *      never from a checkout row alone.
 *   3. Nothing here ever moves a date earlier: a scheduled start is the
 *      first moment a new plan may begin, and a period end is the last
 *      moment of access already paid for.
 */

/** How a mandate reads after a live Razorpay fetch. */
export type MandateState =
  /** The customer has authorised; charges are scheduled but none taken. */
  | "authorised"
  /** Authorised and at least one charge has been taken. */
  | "active"
  /** All cycles consumed, or Razorpay says it cannot charge again. */
  | "ended"
  /** Cancelled, completed, expired or halted — no charge will ever come. */
  | "cancelled"
  /** Razorpay could not confirm anything (fetch failed or status unknown). */
  | "unverified";

/**
 * Fold Razorpay's subscription status into the states the owner sees.
 * `created` is deliberately "unverified": a subscription that was created
 * but never authorised is an abandoned checkout, not a mandate, and showing
 * it as one is how phantom "upcoming debits" are born.
 */
export function classifyMandate(
  razorpayStatus: string | null | undefined,
  remainingCount: number | null | undefined,
): MandateState {
  const s = String(razorpayStatus ?? "").toLowerCase();
  if (s === "active") {
    return (remainingCount ?? 0) > 0 ? "active" : "ended";
  }
  if (s === "authenticated") {
    // Authorised, no charge yet — the scheduled-start case.
    return (remainingCount ?? 1) > 0 ? "authorised" : "ended";
  }
  if (s === "cancelled" || s === "completed" || s === "expired" || s === "halted" || s === "paused") {
    return "cancelled";
  }
  // "created", "pending", anything else: nothing verified to show.
  return "unverified";
}

/** A scheduled change after live verification against Razorpay. */
export interface ScheduledChange {
  checkoutId: string;
  planId: string;
  planName: string;
  interval: "monthly" | "annual";
  paymentMode: "autopay" | "pay_once";
  amount: number;
  currency: string;
  scheduledStartAt: string;
  mandateId: string | null;
  mandateState: MandateState;
}

/** The linked subscription's live mandate, as Razorpay reports it. */
export interface LiveMandate {
  subscriptionId: string;
  state: MandateState;
  status: string;
  totalCycles: number | null;
  chargesMade: number | null;
  cyclesRemaining: number | null;
  currentPeriodEnd: string | null;
  endAt: string | null;
  chargeable: boolean;
}

/** The plan in force, reduced to what the decisions below need. */
export interface ManagePlan {
  planId: string | null;
  planName: string;
  status: string;
  isPaid: boolean;
  isTrial: boolean;
  isRestricted: boolean;
  billingInterval: "monthly" | "annual";
  paymentMode: "autopay" | "pay_once" | null;
  billingMode: "recurring" | "onetime";
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
}

/** What the renewal answer is *about* — the view styles and dates it by this. */
export type RenewalKind =
  | "trial"
  | "restricted"
  | "past_due"
  | "retrying"
  | "cancelled"
  | "scheduled"
  | "onetime"
  | "pay_once"
  | "autopay"
  | "unverified"
  | "none";

export interface RenewalInfo {
  kind: RenewalKind;
  /** One short line, e.g. "Manual renewal required". Carries no date. */
  label: string;
  /** The sentence under it that carries the money and the terms. */
  detail: string;
  /**
   * When a scheduled change begins, as an instant. The view formats it in the
   * restaurant's timezone; the server deliberately ships no date text, because
   * slicing a UTC date here is what made the renewal line and the Upcoming
   * list below it disagree by a day.
   */
  startsAt?: string | null;
}

/** "Monthly · AutoPay" style text for one interval/mode pair. */
export function intervalModeLabel(
  interval: "monthly" | "annual",
  mode: "autopay" | "pay_once",
): string {
  if (interval === "annual") return "Annual · Pay once";
  return mode === "autopay" ? "Monthly · AutoPay" : "Monthly · Pay once";
}

/**
 * The earliest scheduled change — the one that happens *next*.
 *
 * Candidates arrive newest-created first, which is not the same thing: a plan
 * change scheduled for March can be created after one scheduled for January.
 */
export function nextScheduled(scheduled: ScheduledChange[]): ScheduledChange | null {
  if (scheduled.length === 0) return null;
  return [...scheduled].sort(
    (a, b) => new Date(a.scheduledStartAt).getTime() - new Date(b.scheduledStartAt).getTime(),
  )[0];
}

export interface UpcomingItem {
  /** debit = money will be taken; start = a plan begins; end = access ends;
      renewal-due = nothing happens unless the owner pays again. */
  kind: "debit" | "start" | "end" | "renewal-due";
  label: string;
  date: string | null;
  amount: number | null;
  currency: string;
}

/**
 * The RENEWAL field and the renewal information block, from verified facts
 * only. The old text said "Manual renewal required" for every pay-once plan —
 * true only when nothing else is scheduled. An authorised AutoPay mandate or
 * a verified scheduled upgrade means renewal is already arranged, and saying
 * "manual" sends the owner to pay twice.
 */
export function buildRenewal(plan: ManagePlan, scheduled: ScheduledChange[], mandate: LiveMandate | null): RenewalInfo {
  if (plan.isTrial) {
    return { kind: "trial", label: "No billing during the trial", detail: "Pick a plan before the trial ends to keep the paid features on." };
  }
  if (plan.isRestricted) {
    return { kind: "restricted", label: "Ended — pick a plan to restore access", detail: "Nothing renews until you subscribe again." };
  }
  if (plan.isPaid && plan.status === "past_due") {
    return { kind: "past_due", label: "Payment failed — pay again to keep your access", detail: "The last renewal debit was declined." };
  }
  if (plan.isPaid && plan.status === "pending") {
    return { kind: "retrying", label: "A renewal payment is being retried", detail: "Razorpay retries the debit; access continues while it does." };
  }
  if (plan.isPaid && plan.cancelAtPeriodEnd) {
    return {
      kind: "cancelled",
      label: "Cancelled — access continues until the period ends",
      detail: "No further debits. Razorpay cannot resume a cancelled mandate — you can subscribe again any time.",
    };
  }
  // A verified scheduled change outranks the mode text: it IS the renewal.
  const next = nextScheduled(scheduled);
  if (plan.isPaid && next) {
    return {
      kind: "scheduled",
      label: `${next.planName} (${intervalModeLabel(next.interval, next.paymentMode)})`,
      detail: next.paymentMode === "autopay"
        ? `The mandate is authorised. The first debit happens on the start date — nothing before it.`
        : `Confirmed at checkout. The payment is taken on the start date — nothing before it.`,
      startsAt: next.scheduledStartAt,
    };
  }
  if (plan.isPaid && plan.billingMode === "onetime") {
    return { kind: "onetime", label: "One-time purchase — active until the date shown", detail: "The retired plan simply ends; subscribe to any current plan to continue." };
  }
  if (plan.isPaid && plan.paymentMode === "pay_once") {
    return {
      kind: "pay_once",
      label: "Manual renewal required",
      detail: "No mandate exists, so nothing can debit you. Renew before the access end date to keep the paid features on.",
    };
  }
  if (plan.isPaid && mandate) {
    if (mandate.state === "active") {
      return {
        kind: "autopay",
        label: plan.billingInterval === "annual" ? "Renews automatically every year" : "Renews automatically every month",
        detail: "The mandate is authorised and live with Razorpay.",
      };
    }
    if (mandate.state === "ended") {
      return { kind: "unverified", label: "Mandate exhausted — renewal needs a new authorisation", detail: "All cycles on the mandate are used up." };
    }
  }
  // The old code answered "Renews automatically every month — AutoPay is on
  // for this subscription" here for ANY paid plan it had run out of rules for,
  // including one whose payment_mode column is empty and whose mandate does
  // not exist. That is an AutoPay claim with nothing behind it, and it is the
  // one line an owner acts on. Without a verified mandate there is no
  // automatic renewal to promise — only an unconfirmed one to report.
  if (plan.isPaid && plan.paymentMode === "autopay") {
    return {
      kind: "unverified",
      label: "AutoPay could not be verified",
      detail: "Razorpay did not confirm a mandate for this subscription, so no automatic renewal is assumed. Renew from the plans below if access is due to end.",
    };
  }
  if (plan.isPaid) {
    return {
      kind: "unverified",
      label: "Renewal not confirmed",
      detail: "No mandate is on record for this subscription. Check the access end date and renew from the plans below.",
    };
  }
  return { kind: "none", label: "—", detail: "" };
}

/**
 * What happens next with money and dates attached, most urgent first.
 * Built from the same verified facts as `buildRenewal`.
 */
export function buildUpcoming(
  plan: ManagePlan,
  scheduled: ScheduledChange[],
  mandate: LiveMandate | null,
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  if (!plan.isPaid) return items;

  for (const change of scheduled) {
    // One row per scheduled change. It used to emit two — "begins" and "first
    // debit" — for the same plan, the same date and the same amount, which
    // read as two separate events. The kind still tells the view whether
    // money moves (autopay) or the owner pays at checkout.
    items.push({
      kind: change.paymentMode === "autopay" ? "debit" : "start",
      label: `${change.planName} (${intervalModeLabel(change.interval, change.paymentMode)}) starts`,
      date: change.scheduledStartAt,
      amount: change.amount,
      currency: change.currency,
    });
  }

  if (plan.cancelAtPeriodEnd) {
    items.push({
      kind: "end",
      label: "Access ends (subscription cancelled)",
      date: plan.currentPeriodEnd,
      amount: null,
      currency: plan.currency,
    });
    return items;
  }

  const hasScheduledCover = scheduled.length > 0;
  if (plan.paymentMode === "autopay" && mandate?.state === "active" && mandate.currentPeriodEnd) {
    items.push({
      kind: "debit",
      label: `Next AutoPay debit (${plan.planName})`,
      date: mandate.currentPeriodEnd,
      amount: plan.priceMonthly,
      currency: plan.currency,
    });
  } else if (plan.paymentMode === "pay_once" && !hasScheduledCover && plan.currentPeriodEnd) {
    items.push({
      kind: "renewal-due",
      label: "Renewal due — nothing is charged automatically",
      date: plan.currentPeriodEnd,
      amount: plan.billingInterval === "annual" ? (plan.priceYearly ?? plan.priceMonthly) : plan.priceMonthly,
      currency: plan.currency,
    });
    items.push({
      kind: "end",
      label: "Access ends unless renewed",
      date: plan.currentPeriodEnd,
      amount: null,
      currency: plan.currency,
    });
  }

  // Soonest first. Creation order is not date order, and a list of "what
  // happens next" that is not in time order is a list that hides the next
  // thing behind a later one.
  return items.sort((a, b) => {
    const at = a.date ? new Date(a.date).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.date ? new Date(b.date).getTime() : Number.POSITIVE_INFINITY;
    return at - bt;
  });
}

/** Money in, money back, and what stayed — from the payments ledger only. */
export interface Totals {
  totalCharged: number;
  totalRefunded: number;
  netSpent: number;
  paymentCount: number;
  currency: string;
}

export function summariseTotals(
  payments: Array<{ amount: number | string; currency?: string | null; status: string }>,
): Totals {
  let charged = 0;
  let refunded = 0;
  let count = 0;
  let currency = "INR";
  for (const p of payments) {
    if (p.currency) currency = p.currency;
    if (p.status === "succeeded") {
      charged += Number(p.amount) || 0;
      count += 1;
    } else if (p.status === "refunded") {
      const a = Number(p.amount) || 0;
      charged += a;
      refunded += a;
      count += 1;
    }
    // "failed" and "pending" rows are attempts, not money — never counted.
  }
  return { totalCharged: charged, totalRefunded: refunded, netSpent: charged - refunded, paymentCount: count, currency };
}

/**
 * A checkout row is a candidate scheduled change only while it is pending,
 * carries a Razorpay subscription (the mandate), and starts in the future.
 * Candidates are verified live before display — this predicate only decides
 * what is worth asking Razorpay about.
 */
export function isCandidateScheduledCheckout(
  row: {
    status: string;
    razorpay_subscription_id: string | null;
    scheduled_start_at: string | null;
  },
  nowMs: number,
): boolean {
  if (row.status !== "pending") return false;
  if (!row.razorpay_subscription_id) return false;
  if (!row.scheduled_start_at) return false;
  return new Date(row.scheduled_start_at).getTime() > nowMs;
}

/** Every plan's display facts, including retired ones, keyed by id. */
export function directoryFrom(
  plans: Array<{ id: string; name: string; billing_mode?: string | null }>,
): Record<string, { name: string; billingMode: "onetime" | "recurring" }> {
  const out: Record<string, { name: string; billingMode: "onetime" | "recurring" }> = {};
  for (const p of plans) {
    out[p.id] = { name: p.name, billingMode: p.billing_mode === "onetime" ? "onetime" : "recurring" };
  }
  return out;
}
