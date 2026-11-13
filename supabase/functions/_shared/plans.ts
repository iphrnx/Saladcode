// deno-lint-ignore-file no-explicit-any
import { admin } from "./db.ts";
import { limitCheckFailure } from "./billing.ts";

/**
 * Plans, trials and limits.
 *
 * Everything that decides what a restaurant may do is decided here, on the
 * server. The interface mirrors what the plan is sold with, but the
 * interface is never what decides — a restaurant that edits the browser
 * gets nothing, because every limit below is checked in the edge function
 * that does the write.
 *
 * The states a restaurant can be in:
 *
 *   trial       the free trial, running. It carries the trial plan.
 *   active      a paid subscription, in force.
 *   expired     the trial ran out and nothing was bought.
 *   cancelled   the subscription was cancelled. It stays active until the
 *               period it was paid for ends, and then it becomes expired.
 *   past_due    a renewal payment failed. Access is held for a grace
 *               period and then restricted.
 *   pending     the renewal charge failed and Razorpay is retrying it.
 *               Same grace as past_due — the money may still arrive.
 *   none        never had a trial and never subscribed.
 */

export type PlanId = string;

export type PlanLimits = {
  locations: number | null;
  staff: number | null;
  menuItems: number | null;
};

export type EffectivePlan = {
  /** The plan in force right now. */
  planId: PlanId;
  planName: string;
  status: string;
  /** True when a paid subscription is in force. */
  isPaid: boolean;
  /** True while the free trial is running. */
  isTrial: boolean;
  /** True when the trial has run out and there is no paid subscription. */
  isRestricted: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  /** How many days the trial period is configured to last. */
  trialDaysInPeriod: number;
  trialDaysRemaining: number | null;
  subscriptionPlan: PlanId | null;
  subscriptionStartedAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  razorpaySubscriptionId: string | null;
  razorpayPaymentId: string | null;
  limits: PlanLimits;
  features: string[];
  /** The gated entitlements this plan grants (see PRO_ONLY_FEATURES). */
  featureKeys: string[];
  priceMonthly: number;
  /** The annual price, 0 when the plan is not sold yearly. */
  priceYearly: number;
  /** Which interval this paid plan is on. */
  billingInterval: "monthly" | "annual";
  /** How the current period was bought: `pay_once` never renews itself. */
  paymentMode: "autopay" | "pay_once" | null;
  currency: string;
  /** The trial plan, used when the trial is running. */
  trialPlanId: PlanId;
  /** Recurring plans renew by themselves; one-time plans end when paid out. */
  billingMode: "onetime" | "recurring";
};

const DAY_MS = 86_400_000;

/** How long a failed renewal keeps access before it is restricted. */
export const PAST_DUE_GRACE_MS = 7 * DAY_MS;

/**
 * The gated features, and the keys a plan carries in
 * `subscription_plans.feature_keys` when it includes one.
 */
export const PRO_ONLY_FEATURES = ["advanced_analytics"] as const;

export type PlanFeature = (typeof PRO_ONLY_FEATURES)[number];

type PlanRow = {
  id: string;
  name: string;
  price_monthly: number;
  price_yearly: number | null;
  currency: string;
  trial_days: number;
  features: string[];
  is_active: boolean;
  max_locations: number | null;
  max_staff: number | null;
  max_menu_items: number | null;
  razorpay_plan_id: string | null;
  billing_mode: "recurring" | "onetime";
  /** Machine-readable entitlements. The authority for `hasFeature`. */
  feature_keys: string[] | null;
};

async function planRow(id: string): Promise<PlanRow | null> {
  const { data } = await admin()
    .from("subscription_plans")
    .select(
      "id, name, price_monthly, price_yearly, currency, trial_days, features, feature_keys, is_active, is_popular, max_locations, max_staff, max_menu_items, razorpay_plan_id, billing_mode",
    )
    .eq("id", id)
    .maybeSingle();
  return (data as PlanRow) ?? null;
}

async function activePlans(): Promise<PlanRow[]> {
  const { data } = await admin()
    .from("subscription_plans")
    .select(
      "id, name, price_monthly, price_yearly, currency, trial_days, features, feature_keys, is_active, max_locations, max_staff, max_menu_items, razorpay_plan_id, billing_mode",
    )
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  return (data as PlanRow[]) ?? [];
}

/**
 * The plan a new restaurant is put on. Pro, because the trial is a full
 * trial — the free fourteen days are the product, not a cut-down version of
 * it.
 */
export const DEFAULT_TRIAL_PLAN = "pro";

/**
 * The plan a restaurant falls back to when it has nothing paid for. The
 * cheapest one, so a lapsed restaurant keeps the essentials.
 */
export const FALLBACK_PLAN = "starter";

/**
 * How long a free trial runs when the catalogue does not say. Only a fallback:
 * the length of a trial is what the plan is sold with, and that lives in the
 * `subscription_plans` table (`trial_days`).
 */
export const DEFAULT_TRIAL_DAYS = 14;

/**
 * The trial window a new restaurant is given.
 *
 * Read from the catalogue rather than written into the signup code, so the
 * "configured trial period" is configured in one place.
 */
export async function trialWindow(
  planId: string = DEFAULT_TRIAL_PLAN,
): Promise<{ startedAt: string; endsAt: string; days: number }> {
  const plan = (await planRow(planId)) ?? (await planRow(FALLBACK_PLAN));
  const configured = Number(plan?.trial_days ?? 0);
  const days = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TRIAL_DAYS;
  const startedAt = new Date();
  return {
    startedAt: startedAt.toISOString(),
    endsAt: new Date(startedAt.getTime() + days * DAY_MS).toISOString(),
    days,
  };
}

/**
 * The columns every newly created tenant needs to be on a real trial.
 *
 * The column default for `subscription_status` is `'trial'`, but the two dates
 * had no default at all, so a tenant created without them was a trial that had
 * already ended. Anything that creates a tenant spreads these in.
 */
export async function trialFields(planId: string = DEFAULT_TRIAL_PLAN) {
  const window = await trialWindow(planId);
  return {
    subscription_status: "trial",
    subscription_plan: null,
    trial_started_at: window.startedAt,
    trial_ends_at: window.endsAt,
  };
}

/**
 * Resolve what a restaurant may do right now.
 *
 * The trial is the one state that needs a clock: it is in force until the
 * trial ends, and it stops being in force the moment it does — no job, no
 * cron, no flag. A restaurant whose trial has run out is restricted
 * immediately, whether or not anything noticed.
 */
export async function resolvePlan(tenantId: string): Promise<EffectivePlan> {
  const db = admin();

  const { data: tenant } = await db
    .from("tenants")
    .select(
      "id, plan, subscription_status, trial_started_at, trial_ends_at, created_at, subscription_plan, subscription_started_at, razorpay_subscription_id, subscription_razorpay_payment_id, current_period_end, cancel_at_period_end, billing_interval, payment_mode",
    )
    .eq("id", tenantId)
    .maybeSingle();

  const t = tenant as any;
  const status = String(t?.subscription_status ?? "none");
  const now = Date.now();

  const trialPlanId = DEFAULT_TRIAL_PLAN;
  const trialPlan = (await planRow(trialPlanId)) ?? (await planRow("pro"));
  const paidPlan = t?.subscription_plan ? await planRow(t.subscription_plan) : null;
  const fallback = await planRow(FALLBACK_PLAN);

  // The trial window. A trial with no end date is one that was never written
  // down — the signup path created tenants without one for a while, and reading
  // that as "over" told a brand-new restaurant its free trial had ended before
  // it had begun. So a missing end date falls back to the full period the
  // catalogue allows, measured from the start of the trial or, failing that,
  // from when the account was made. A window that has genuinely passed still
  // ends: this fills in a clock, it does not remove one.
  const configuredTrialDays =
    Number(trialPlan?.trial_days ?? 0) > 0
      ? Number(trialPlan!.trial_days)
      : DEFAULT_TRIAL_DAYS;
  const trialStartMs = t?.trial_started_at
    ? new Date(t.trial_started_at).getTime()
    : t?.created_at
      ? new Date(t.created_at).getTime()
      : null;
  const trialEndsMs = t?.trial_ends_at
    ? new Date(t.trial_ends_at).getTime()
    : trialStartMs !== null
      ? trialStartMs + configuredTrialDays * DAY_MS
      : null;

  const trialActive = status === "trial" && trialEndsMs !== null && trialEndsMs > now;

  const trialDaysRemaining =
    trialActive && trialEndsMs !== null
      ? Math.max(0, Math.ceil((trialEndsMs - now) / DAY_MS))
      : null;

  // A paid subscription is in force while its period lasts. A cancellation
  // takes effect at the end of the period, not the moment it is pressed, so
  // the period end is the real deadline.
  const periodEnd = t?.current_period_end ? new Date(t.current_period_end).getTime() : null;
  const paidActive =
    status === "active" &&
    paidPlan !== null &&
    (periodEnd === null || periodEnd > now);

  // A cancelled subscription still gives access until the period ends.
  const cancelledActive =
    status === "cancelled" &&
    paidPlan !== null &&
    (periodEnd === null || periodEnd > now);

  // A renewal that failed keeps access for a grace period, and then it is
  // restricted.
  const pastDueActive =
    status === "past_due" &&
    paidPlan !== null &&
    (periodEnd === null || periodEnd + PAST_DUE_GRACE_MS > now);

  // A renewal whose charge failed and is being retried is "pending" on
  // Razorpay's side. The money may still arrive on its own, so the same
  // grace applies — cutting access the day the period ends, while the
  // retry that would fix it is still scheduled, punishes the restaurant
  // for a bank's bad day.
  const pendingActive =
    status === "pending" &&
    paidPlan !== null &&
    (periodEnd === null || periodEnd + PAST_DUE_GRACE_MS > now);

  const chosen =
    trialActive && trialPlan
      ? trialPlan
      : (paidActive || cancelledActive || pastDueActive || pendingActive) && paidPlan
        ? paidPlan
        : (fallback ?? trialPlan);

  const isPaid =
    (paidActive || cancelledActive || pastDueActive || pendingActive) && paidPlan !== null;
  const isTrial = trialActive;

  return {
    planId: chosen?.id ?? FALLBACK_PLAN,
    planName: chosen?.name ?? "Starter",
    status,
    isPaid,
    isTrial,
    // Restricted means: the trial is over and there is no paid subscription.
    // The restaurant keeps everything it has; it just cannot do the paid
    // things any more.
    isRestricted: !isPaid && !isTrial,
    // The dates the decision was made from — including a window derived from
    // the catalogue — so the interface shows the same clock the server used.
    trialStartedAt: trialStartMs !== null ? new Date(trialStartMs).toISOString() : null,
    trialEndsAt: trialEndsMs !== null ? new Date(trialEndsMs).toISOString() : null,
    trialDaysInPeriod: configuredTrialDays,
    trialDaysRemaining,
    subscriptionPlan: t?.subscription_plan ?? null,
    subscriptionStartedAt: t?.subscription_started_at ?? null,
    currentPeriodEnd: t?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(t?.cancel_at_period_end),
    razorpaySubscriptionId: t?.razorpay_subscription_id ?? null,
    razorpayPaymentId: t?.subscription_razorpay_payment_id ?? null,
    limits: {
      locations: chosen?.max_locations ?? null,
      staff: chosen?.max_staff ?? null,
      menuItems: chosen?.max_menu_items ?? null,
    },
    features: Array.isArray(chosen?.features) ? chosen!.features : [],
    featureKeys: Array.isArray(chosen?.feature_keys) ? chosen!.feature_keys : [],
    priceMonthly: Number(chosen?.price_monthly ?? 0),
    priceYearly: Number(chosen?.price_yearly ?? 0),
    billingInterval: (t?.billing_interval === "annual" ? "annual" : "monthly"),
    paymentMode: (t?.payment_mode === "pay_once" ? "pay_once" : t?.payment_mode === "autopay" ? "autopay" : null),
    currency: chosen?.currency ?? "INR",
    trialPlanId,
    billingMode: chosen?.billing_mode === "onetime" ? "onetime" : "recurring",
  };
}

/** The plans an owner can be shown, with their prices and features. */
export async function planCatalogue() {
  const plans = await activePlans();
  return plans.map((p) => ({
    id: p.id,
    name: p.name,
    description: (p as any).description ?? null,
    priceMonthly: Number(p.price_monthly),
    priceYearly: Number(p.price_yearly ?? 0),
    currency: p.currency,
    trialDays: p.trial_days,
    features: Array.isArray(p.features) ? p.features : [],
    limits: {
      locations: p.max_locations,
      staff: p.max_staff,
      menuItems: p.max_menu_items,
    },
    popular: Boolean(p.is_popular),
    razorpayPlanId: p.razorpay_plan_id,
    billingMode: p.billing_mode === "onetime" ? "onetime" : "recurring",
  }));
}

/**
 * Check a limit before a write.
 *
 * The count is passed in rather than counted here, so the caller counts
 * exactly the rows it is about to add to and the check is on the same
 * transaction's view of the world.
 */
export function checkLimit(
  plan: EffectivePlan,
  kind: "locations" | "staff" | "menuItems",
  currentCount: number,
): { ok: true } | { ok: false; error: string; limit: number } {
  const limit = plan.limits[kind];
  if (limit === null || limit === undefined) return { ok: true };
  if (currentCount < limit) return { ok: true };

  const noun = kind === "staff" ? "staff members" : kind === "menuItems" ? "menu items" : "locations";
  return {
    ok: false,
    limit,
    error:
      `Your ${plan.planName} plan includes up to ${limit} ${noun}. ` +
      `Upgrade your plan to add more.`,
  };
}

/**
 * Whether a feature is available on the plan in force.
 *
 * Decided by the plan's own entitlements, never by its name. The previous
 * version compared plan ids (`pro` or `enterprise`), which meant the
 * catalogue could advertise a feature on Starter while the server refused it —
 * changing what a plan includes was a code change nobody could see from the
 * plan row. `feature_keys` is that row's answer.
 *
 * A plan with no entitlement list grants nothing gated, which is the safe
 * direction for an unknown or half-written row.
 */
export function hasFeature(plan: EffectivePlan, feature: PlanFeature): boolean {
  if (!PRO_ONLY_FEATURES.includes(feature)) return true;
  // Nothing gated is granted to a restaurant that is not on anything: an
  // expired trial or a lapsed subscription falls back to the Starter row, and
  // Starter now includes this feature — so without this check a lapsed
  // restaurant would keep the paid features for ever.
  if (!plan.isPaid && !plan.isTrial) return false;
  return (plan.featureKeys ?? []).includes(feature);
}

/**
 * Whether a Pro-only feature may be used, and why not when it may not.
 */
export function checkFeature(
  plan: EffectivePlan,
  feature: PlanFeature,
): { ok: true } | { ok: false; error: string } {
  if (hasFeature(plan, feature)) return { ok: true };
  return {
    ok: false,
    error:
      feature === "advanced_analytics"
        ? "Advanced analytics is a Pro feature. Upgrade your plan to see it."
        : "That feature is not on your plan.",
  };
}

/**
 * Check the plan's limit and write the row, in one transaction.
 *
 * Counting in the edge function and inserting afterwards leaves a window: two
 * requests for the last slot both count one below the limit and both write. The
 * count and the insert happen inside `create_*_within_limit` instead, under a
 * lock taken on the restaurant, so the second request sees the first's row.
 *
 * The row is prepared by the caller — validated, priced, hashed — because that
 * work belongs in JavaScript; this only decides whether it may be written.
 *
 * A failure that is not a limit is answered as retryable and **nothing is
 * written**. A count that cannot be read is not evidence that there is room,
 * which is what the helper this replaced got wrong: it logged the failure and
 * returned `{ ok: true }`.
 */
function limitForPlan(plan: EffectivePlan, kind: "staff" | "menuItems"): number {
  // `null` in the catalogue means no limit. The database still does the
  // counting, so "no limit" is a ceiling it will never reach rather than a
  // second code path that skips the check: one writer, one rule.
  const limit = plan.limits[kind];
  return limit === null || limit === undefined ? 2_147_483_647 : limit;
}

export async function enforceWriteLimit(
  tenantId: string,
  kind: "staff" | "menuItems",
  row: Record<string, unknown>,
): Promise<
  | { ok: true; row: any; limit: number }
  | { ok: false; reason: "limit"; error: string; limit: number }
  | { ok: false; reason: "unavailable"; retryable: true; status: 503; error: string }
  | { ok: false; reason: "write"; error: string; status: 500 }
> {
  const plan = await resolvePlan(tenantId);
  const limit = limitForPlan(plan, kind);

  const fn = kind === "staff" ? "create_staff_within_limit" : "create_menu_item_within_limit";
  const args: Record<string, unknown> = { p_tenant_id: tenantId, p_limit: limit };
  args[kind === "staff" ? "p_staff" : "p_item"] = row;

  const { data, error } = await admin().rpc(fn, args);

  if (error) {
    // A row that breaks a constraint is the caller's problem, reported the way
    // this endpoint has always reported it. Anything else is infrastructure,
    // and the write did not happen.
    const message = String(error.message ?? "");
    if (/duplicate key|violates|invalid input|null value/i.test(message)) {
      return { ok: false, reason: "write", error: message, status: 500 };
    }
    console.error("plans: could not enforce the limit", kind, message);
    return limitCheckFailure({ error: undefined });
  }

  const result = data as any;
  if (result && result.ok === false && result.reason === "limit") {
    const cap = Number(result.limit ?? limit);
    const noun = kind === "staff" ? "staff members" : "menu items";
    return {
      ok: false,
      reason: "limit",
      limit: cap,
      error: `Your ${plan.planName} plan includes up to ${cap} ${noun}. Upgrade your plan to add more.`,
    };
  }

  const written = kind === "staff" ? result?.staff : result?.item;
  if (!result?.ok || !written?.id) {
    console.error("plans: the write returned nothing usable", kind, String(JSON.stringify(result)).slice(0, 200));
    return limitCheckFailure({ error: undefined });
  }

  return { ok: true, row: written, limit: Number(result.limit ?? limit) };
}
