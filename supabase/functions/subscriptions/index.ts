// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { body, corsHeaders, json, preflight, subPath } from "../_shared/http.ts";
import { dispatchPending, queueForTenant } from "../_shared/email.ts";
import {
  planCatalogue,
  resolvePlan,
  type EffectivePlan,
} from "../_shared/plans.ts";
import {
  cancelSubscription,
  createOrder,
  createSubscription,
  fetchPayment,
  updateSubscriptionPlanAtCycleEnd,
  fetchSubscription,
  type RazorpayOrder,
  razorpayConfigured,
  razorpayConfig,
  verifyPaymentSignature,
} from "../_shared/razorpay.ts";
import {
  checkoutMatches,
  entitlementAction,
  fromMinorUnits,
  mayChangePlanOnSubscription,
  paymentFetchFailure,
  purchasedPeriodEnd,
  type PaymentFacts,
} from "../_shared/billing.ts";
import {
  buildRenewal,
  buildUpcoming,
  classifyMandate,
  directoryFrom,
  isCandidateScheduledCheckout,
  summariseTotals,
  type LiveMandate,
  type ManagePlan,
  type ScheduledChange,
} from "../_shared/billing-manage.ts";
import {
  issueInvoiceDocument,
  issueRefundDocument,
  invoiceFactsFromRow,
  readStoredPdf,
  sellerIdentity,
  refundFactsFromRow,
} from "../_shared/billing-documents.ts";
import { buildInvoicePdf, buildRefundPdf } from "../_shared/pdf.ts";
import {
  decideScheduledCancel,
  decideCheckoutAction,
  decideSwitchAction,
  mandateSupersededByPeriod,
  mandateVerdict,
  type LiveSubscription,
  type PendingMandateCheckout,
} from "../_shared/subscription-guard.ts";
import { cancelSupersededLink, retirePendingMandate } from "../_shared/mandate-switch.ts";

/**
 * /functions/v1/subscriptions
 *
 *   GET    state          the plan in force, the trial dates, the catalogue
 *   POST   checkout       create a Razorpay subscription and an order
 *   POST   verify         check the payment signature and activate the plan
 *   POST   upgrade        move to another plan
 *   POST   cancel         cancel the subscription at the end of the period
 *
 * Everything that changes a restaurant's plan happens here, on the server,
 * and only after a signature has been checked. The browser never tells the
 * server that a payment succeeded — it tells the server which payment to
 * check, and the server decides.
 */

/**
 * How many billing cycles a monthly mandate is authorised for.
 *
 * Only monthly is sold on a mandate now: a year is bought in one payment, so
 * there is nothing annual for Razorpay to authorise.
 */
const MONTHLY_CYCLES = 12;

/** A year, in seconds — the authorisation window for a mandate. */
const YEAR_SECONDS = 366 * 86_400;

export type PaymentMode = "autopay" | "pay_once";

/**
 * How a plan is being bought. The interval decides it, and the client does not.
 *
 * Monthly is the recurring product: a mandate for twelve monthly debits, as it
 * has always been. Annual is bought once — a year in a single Razorpay order,
 * no subscription, no mandate — so an annual request asking for `autopay` is
 * refused rather than quietly downgraded, because a client that still believes
 * it can create an annual mandate should hear that it cannot.
 */
function readPaymentMode(raw: unknown, interval: "monthly" | "annual"): PaymentMode | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (interval === "annual") {
    // Annual is pay-once. No mode, `pay_once`, or a legacy client sending
    // nothing at all are all fine; `autopay` is not a thing that exists.
    if (!value || value === "pay_once") return "pay_once";
    return null;
  }
  // Monthly: autopay unless the caller says something else.
  if (!value || value === "autopay") return "autopay";
  return null;
}

/** Which interval a checkout is buying. Unknown values are refused rather than
 * silently treated as monthly — a price the customer did not agree to is the
 * one mistake billing cannot make. */
function readInterval(raw: unknown): "monthly" | "annual" | null {
  const value = String(raw ?? "monthly").trim().toLowerCase();
  if (value === "monthly" || value === "annual") return value;
  return null;
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "subscriptions");
  const action = segments[0] ?? "state";

  try {
    // The webhook has its own function and its own signature check, so
    // everything here is an owner acting on their own restaurant.
    const g = await guard(req, { permission: "settings.manage" });
    if (!g.ok) return g.response;
    // Billing is the owner's business. A member of staff may have the
    // settings permission, but they do not get to buy the restaurant a plan
    // or read its payment history.
    if (g.session.kind !== "owner") {
      return json(req, { error: "Only the restaurant owner can manage billing." }, 403);
    }
    const tenantId = g.session.tenantId;

    switch (action) {
      case "state":
        if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
        return await state(req, tenantId);
      case "mandate":
        if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
        return await mandate(req, tenantId);
      case "manage":
        if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
        return await manage(req, tenantId);
      case "mandates-audit":
        if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
        return await mandatesAudit(req, tenantId);
      case "cancel-scheduled":
        if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
        return await cancelScheduled(req, tenantId);
      case "invoice":
        if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
        return await invoice(req, tenantId);
      case "checkout":
        if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
        return await checkout(req, tenantId);
      case "verify":
        if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
        return await verify(req, tenantId);
      case "upgrade":
        if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
        return await upgrade(req, tenantId);
      case "cancel":
        if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
        return await cancel(req, tenantId);
      default:
        return json(req, { error: "Not found" }, 404);
    }
  } catch (err) {
    console.error("subscriptions error:", err);
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

/**
 * The mandate as Razorpay knows it — the only authority on when it ends.
 *
 * `total_count` and `remaining_count` say how many charges the authorisation
 * covers and how many are left; `end_at` is the moment Razorpay itself refuses
 * further debits. Reading them live means the billing page cannot show a
 * mandate that ended, and a test can prove the one-year bound instead of
 * trusting the request we sent.
 */
async function mandate(req: Request, tenantId: string): Promise<Response> {
  const db = admin();
  const { data: tenant } = await db
    .from("tenants")
    .select("razorpay_subscription_id, payment_mode, billing_interval, subscription_status")
    .eq("id", tenantId)
    .maybeSingle();

  const subscriptionId = (tenant?.razorpay_subscription_id as string | null) ?? null;
  if (!subscriptionId) {
    return json(req, {
      mode: (tenant?.payment_mode as string | null) ?? "pay_once",
      subscriptionId: null,
      mandate: null,
      note: "No mandate on this restaurant — nothing can charge it again.",
    });
  }

  const live = await fetchSubscription(subscriptionId);
  if (!live.ok) {
    return json(
      req,
      { error: `Razorpay could not be asked about the mandate: ${live.error}`, subscriptionId },
      502,
    );
  }

  const s = live.data;
  return json(req, {
    mode: (tenant?.payment_mode as string | null) ?? "autopay",
    interval: (tenant?.billing_interval as string | null) ?? "monthly",
    subscriptionId,
    mandate: {
      status: s.status,
      /** Total charges the authorisation covers. 1 == a single yearly cycle. */
      totalCycles: s.total_count ?? null,
      chargesMade: s.paid_count ?? null,
      cyclesRemaining: s.remaining_count ?? null,
      currentPeriodEnd: s.current_end ? new Date(s.current_end * 1000).toISOString() : null,
      /** Razorpay refuses debits after this instant. */
      endAt: s.end_at ? new Date(s.end_at * 1000).toISOString() : null,
      authoriseBy: s.expire_by ? new Date(s.expire_by * 1000).toISOString() : null,
      /** True once Razorpay cannot take another charge on this mandate. */
      chargeable: s.status === "active" && (s.remaining_count ?? 0) > 0,
    },
  });
}

/** The live Razorpay subscription, folded into the shape the view trusts. */
function shapeLiveMandate(subscriptionId: string, s: {
  status: string;
  total_count?: number;
  paid_count?: number;
  remaining_count?: number;
  current_end?: number;
  end_at?: number | null;
}): LiveMandate {
  const state = classifyMandate(s.status, s.remaining_count);
  return {
    subscriptionId,
    state,
    status: s.status,
    totalCycles: s.total_count ?? null,
    chargesMade: s.paid_count ?? null,
    cyclesRemaining: s.remaining_count ?? null,
    currentPeriodEnd: s.current_end ? new Date(s.current_end * 1000).toISOString() : null,
    endAt: s.end_at ? new Date(s.end_at * 1000).toISOString() : null,
    chargeable: state === "active" && (s.remaining_count ?? 0) > 0,
  };
}

/**
 * The whole Manage Billing picture, verified.
 *
 *   GET /subscriptions/manage
 *
 * What it returns and where each part is verified:
 *
 *   - plan            resolvePlan — the same entitlement logic the rest of
 *                     the product enforces.
 *   - mandate         the LINKED subscription, fetched live from Razorpay in
 *                     this request. Never our row alone.
 *   - scheduledChanges  pending future-dated mandate checkouts, each fetched
 *                     live from Razorpay and kept only when Razorpay says the
 *                     mandate is authorised or active. An unverified checkout
 *                     is an abandoned checkout, not a schedule — it is
 *                     skipped and named in `warnings`.
 *   - history         the subscription audit log.
 *   - totals          summed from the payments ledger (succeeded/refunded
 *                     only — failed attempts are not money).
 *   - planDirectory   every plan including retired ones, for honest labels.
 *   - renewal/upcoming  derived from the above by the pure rules in
 *                     _shared/billing-manage.ts.
 *
 * The route writes nothing: verification happens on read so no checkout,
 * payment or mandate record is ever mutated by looking at the page.
 */
async function manage(req: Request, tenantId: string): Promise<Response> {
  const db = admin();
  const plan = await resolvePlan(tenantId);

  const { data: allPlans, error: allPlansError } = await db
    .from("subscription_plans")
    .select("id, name, billing_mode, price_monthly, price_yearly, currency")
    .order("sort_order", { ascending: true });
  if (allPlansError) {
    console.error("subscriptions manage: plan directory unreadable", allPlansError.message);
  }
  const directory = directoryFrom(allPlans ?? []);
  const planById = new Map((allPlans ?? []).map((row) => [row.id as string, row]));

  const { data: allPayments, error: allPaymentsError } = await db
    .from("subscription_payments")
    .select("amount, currency, status")
    .eq("tenant_id", tenantId);
  if (allPaymentsError) {
    console.error("subscriptions manage: totals unreadable", allPaymentsError.message);
  }
  const totals = summariseTotals(allPayments ?? []);

  const { data: auditRows, error: auditError } = await db
    .from("subscription_audit_logs")
    .select("id, change_type, old_plan, new_plan, detail, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (auditError) {
    console.error("subscriptions manage: history unreadable", auditError.message);
  }
  const history = (auditRows ?? []).map((row: any) => ({
    id: row.id,
    changeType: row.change_type,
    oldPlan: row.old_plan,
    newPlan: row.new_plan,
    oldPlanName: directory[row.old_plan]?.name ?? row.old_plan ?? null,
    newPlanName: directory[row.new_plan]?.name ?? row.new_plan ?? null,
    amountPaid: typeof row.detail?.amountPaid === "number" ? row.detail.amountPaid : null,
    createdAt: row.created_at,
  }));

  // Locations are counted, not hardcoded (a tenant is one location today).
  const { count: locationCount } = await db
    .from("tenants")
    .select("id", { count: "exact", head: true })
    .eq("id", tenantId);

  const warnings: string[] = [];

  // The linked mandate, live. The tenant row stores the id; Razorpay decides
  // what it is worth.
  const { data: tenantRow } = await db
    .from("tenants")
    .select("razorpay_subscription_id")
    .eq("id", tenantId)
    .maybeSingle();
  const linkedSubId = (tenantRow?.razorpay_subscription_id as string | null) ?? null;
  let linkedMandate: LiveMandate | null = null;
  if (linkedSubId) {
    const live = await fetchSubscription(linkedSubId);
    if (live.ok) {
      linkedMandate = shapeLiveMandate(linkedSubId, live.data);
    } else {
      warnings.push(`Razorpay could not confirm the linked mandate: ${live.error}`);
    }
  }

  // Scheduled changes. Candidates come from our checkout rows; only what
  // Razorpay confirms as authorised or active is ever shown.
  const { data: checkoutRows, error: checkoutError } = await db
    .from("subscription_checkouts")
    .select(
      "id, plan_id, amount, currency, billing_interval, payment_mode, razorpay_subscription_id, scheduled_start_at, status",
    )
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .not("razorpay_subscription_id", "is", null)
    .not("scheduled_start_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);
  if (checkoutError) {
    console.error("subscriptions manage: scheduled checkouts unreadable", checkoutError.message);
  }
  const nowMs = Date.now();
  const candidates = (checkoutRows ?? []).filter((row) => isCandidateScheduledCheckout(row, nowMs));
  const scheduled: ScheduledChange[] = [];
  for (const row of candidates) {
    const live = await fetchSubscription(row.razorpay_subscription_id as string);
    if (!live.ok) {
      warnings.push(
        `A scheduled change (${row.razorpay_subscription_id}) could not be confirmed with Razorpay: ${live.error}`,
      );
      continue;
    }
    const mandateState = classifyMandate(live.data.status, live.data.remaining_count);
    // "created" (never authorised), cancelled, completed, expired: nothing
    // verified to show, so nothing is shown.
    if (mandateState !== "authorised" && mandateState !== "active") continue;
    const planRow = planById.get(row.plan_id as string);
    scheduled.push({
      checkoutId: row.id,
      planId: row.plan_id,
      planName: (planRow?.name as string | undefined) ?? directory[row.plan_id]?.name ?? row.plan_id,
      interval: row.billing_interval === "annual" ? "annual" : "monthly",
      paymentMode: row.payment_mode === "pay_once" ? "pay_once" : "autopay",
      amount: Number(row.amount),
      currency: (row.currency as string | null) ?? "INR",
      scheduledStartAt: new Date(row.scheduled_start_at as string).toISOString(),
      mandateId: row.razorpay_subscription_id,
      mandateState,
    });
  }

  const managePlan: ManagePlan = {
    planId: plan.subscriptionPlan,
    planName: plan.planName,
    status: plan.status,
    isPaid: plan.isPaid,
    isTrial: plan.isTrial,
    isRestricted: plan.isRestricted,
    billingInterval: plan.billingInterval,
    paymentMode: plan.paymentMode,
    billingMode: plan.billingMode,
    currentPeriodEnd: plan.currentPeriodEnd,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
    priceMonthly: plan.priceMonthly,
    priceYearly: plan.priceYearly,
    currency: plan.currency,
  };

  return json(req, {
    plan: publicPlan(plan),
    renewal: buildRenewal(managePlan, scheduled, linkedMandate),
    upcoming: buildUpcoming(managePlan, scheduled, linkedMandate),
    scheduledChanges: scheduled,
    mandate: linkedMandate,
    history,
    totals,
    planDirectory: directory,
    locationCount: locationCount ?? 1,
    warnings,
  });
}

/**
 * Every mandate this restaurant has ever created, with what Razorpay says
 * about each RIGHT NOW.
 *
 *   GET /subscriptions/mandates-audit
 *
 * The audit this endpoint exists for: "exactly which subscriptions exist,
 * and which of them can still take money?" The database alone cannot answer
 * that — a checkout row says what was created, Razorpay says what is live.
 * Both are reported side by side, each mandate labelled:
 *
 *   billable      — can take money in the future (the invariant counts these)
 *   authorisable  — never authorised, but the link may still be live
 *   dead          — will never charge again
 *   unknown       — Razorpay did not answer; nothing is assumed
 *
 * Read-only: it fetches and reports, and never cancels, expires, or links
 * anything.
 */
async function mandatesAudit(req: Request, tenantId: string): Promise<Response> {
  const db = admin();

  const { data: tenant } = await db
    .from("tenants")
    .select("razorpay_subscription_id, subscription_plan, plan, subscription_status, current_period_end")
    .eq("id", tenantId)
    .maybeSingle();

  const { data: rows } = await db
    .from("subscription_checkouts")
    .select("id, plan_id, billing_interval, payment_mode, status, scheduled_start_at, razorpay_subscription_id, razorpay_payment_id, created_at")
    .eq("tenant_id", tenantId)
    .not("razorpay_subscription_id", "is", null)
    .order("created_at", { ascending: true });

  const linkedId = (tenant?.razorpay_subscription_id as string | null) ?? null;
  const seen = new Set<string>();
  const mandates = [];

  for (const row of rows ?? []) {
    const subId = String(row.razorpay_subscription_id);
    seen.add(subId);
    const fetched = await fetchSubscription(subId);
    const live = fetched.ok
      ? {
        status: String(fetched.data.status ?? ""),
        paidCount: Number(fetched.data.paid_count ?? 0),
        totalCount: fetched.data.total_count !== undefined ? Number(fetched.data.total_count) : null,
        currentStart: fetched.data.current_start ? new Date(Number(fetched.data.current_start) * 1000).toISOString() : null,
        currentEnd: fetched.data.current_end ? new Date(Number(fetched.data.current_end) * 1000).toISOString() : null,
        chargeAt: fetched.data.charge_at ? new Date(Number(fetched.data.charge_at) * 1000).toISOString() : null,
        startAt: fetched.data.start_at ? new Date(Number(fetched.data.start_at) * 1000).toISOString() : null,
        endAt: fetched.data.end_at ? new Date(Number(fetched.data.end_at) * 1000).toISOString() : null,
      }
      : null;
    mandates.push({
      checkoutId: row.id,
      dbStatus: row.status,
      planId: row.plan_id,
      interval: row.billing_interval ?? null,
      paymentMode: row.payment_mode ?? null,
      scheduledStartAt: row.scheduled_start_at ?? null,
      settledByPayment: row.razorpay_payment_id ?? null,
      createdAt: row.created_at,
      razorpaySubscriptionId: subId,
      isLinkedMandate: subId === linkedId,
      razorpay: live ?? { fetchError: fetched.ok ? null : fetched.error },
      verdict: mandateVerdict(live),
    });
  }

  // The linked mandate may have no checkout row at all (written directly, or
  // linked by a webhook for a subscription created elsewhere). It belongs in
  // the report all the same.
  let linked: unknown = null;
  if (linkedId && !seen.has(linkedId)) {
    const fetched = await fetchSubscription(linkedId);
    const live = fetched.ok
      ? {
        status: String(fetched.data.status ?? ""),
        paidCount: Number(fetched.data.paid_count ?? 0),
        chargeAt: fetched.data.charge_at ? new Date(Number(fetched.data.charge_at) * 1000).toISOString() : null,
        endAt: fetched.data.end_at ? new Date(Number(fetched.data.end_at) * 1000).toISOString() : null,
      }
      : null;
    linked = {
      razorpaySubscriptionId: linkedId,
      razorpay: live ?? { fetchError: fetched.ok ? null : fetched.error },
      verdict: mandateVerdict(live),
    };
  }

  const summary = {
    total: mandates.length,
    billable: mandates.filter((m) => m.verdict === "billable").length +
      (linked && (linked as any).verdict === "billable" ? 1 : 0),
    authorisable: mandates.filter((m) => m.verdict === "authorisable").length,
    dead: mandates.filter((m) => m.verdict === "dead").length,
    unknown: mandates.filter((m) => m.verdict === "unknown").length,
    pendingRowsInDb: (rows ?? []).filter((r) => r.status === "pending").length,
  };

  return json(req, {
    tenant: {
      plan: tenant?.subscription_plan ?? tenant?.plan ?? null,
      status: tenant?.subscription_status ?? null,
      currentPeriodEnd: tenant?.current_period_end ?? null,
      linkedSubscriptionId: linkedId,
    },
    summary,
    mandates,
    linked,
  });
}

/**
 * Cancel a scheduled change that has not started.
 *
 *   POST /subscriptions/cancel-scheduled   { checkoutId }
 *
 * This is the ONLY cancellation that is safe to offer for a future-dated
 * mandate: no charge has happened (guarded twice — the start date is in the
 * future AND Razorpay reports zero collected payments), so cancelling cannot
 * remove access anyone has paid for. A mandate that has already collected
 * money is a live subscription and belongs to the normal cancel flow, which
 * keeps access until the period ends.
 *
 * The checkout row is deliberately left untouched (the record of what the
 * customer did stays); the audit log records the cancellation, and the next
 * `manage` read confirms the outcome from Razorpay itself.
 */
async function cancelScheduled(req: Request, tenantId: string): Promise<Response> {
  const b = await body(req);
  const checkoutId = String(b.checkoutId ?? "").trim();
  if (!checkoutId) return json(req, { error: "checkoutId is required" }, 400);

  const db = admin();
  const { data: row } = await db
    .from("subscription_checkouts")
    .select("id, tenant_id, plan_id, status, razorpay_subscription_id, scheduled_start_at")
    .eq("id", checkoutId)
    .maybeSingle();
  if (!row || row.tenant_id !== tenantId) {
    return json(req, { error: "No such scheduled change for this restaurant." }, 404);
  }
  if (!row.razorpay_subscription_id) {
    return json(req, { error: "That checkout has no mandate to cancel." }, 409);
  }
  // A pending row is the normal case. An EXPIRED row is the orphan case: the
  // mandate still exists at Razorpay — created, never authorised, its
  // authorisation link still live — even though our row stopped counting it.
  // Cancelling it is exactly as safe as cancelling a pending one, because
  // the decision below is made from Razorpay's report, not from our row.
  if (row.status !== "pending" && row.status !== "expired") {
    return json(req, { error: "That checkout has already settled and cannot be cancelled here." }, 409);
  }

  // Verify with Razorpay before doing anything: never cancel on the strength
  // of our own row alone. The live report decides everything from here.
  const live = await fetchSubscription(row.razorpay_subscription_id as string);
  if (!live.ok) {
    return json(req, { error: `Razorpay could not confirm the mandate: ${live.error}` }, 502);
  }

  const decision = decideScheduledCancel({
    scheduledStartAt: (row.scheduled_start_at as string | null) ?? null,
    live: {
      status: String(live.data.status ?? ""),
      paidCount: Number(live.data.paid_count ?? 0),
    },
  });

  if (decision.kind === "already-dead") {
    // Nothing left that could charge — the outcome the caller wanted. The
    // row stops claiming the pending slot as well.
    await db
      .from("subscription_checkouts")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending");
    return json(req, { ok: true, already: true });
  }

  if (decision.kind === "refuse-charged") {
    // Money has moved on this mandate: it is a live subscription now, not a
    // scheduled change. Cancelling here could take away paid access.
    return json(
      req,
      { error: "This mandate has already collected a payment and can no longer be cancelled as a scheduled change." },
      409,
    );
  }

  if (decision.kind === "refuse-started") {
    return json(req, { error: "That change has already started and can no longer be cancelled here." }, 409);
  }

  if (decision.kind === "refuse-unknown") {
    return json(req, { error: `Razorpay reports this mandate as "${live.data.status}", which has no safe cancellation path.` }, 409);
  }

  // decision.kind is "cancel-scheduled" or "cancel-never-authorised".
  // Immediate cancel: no money has ever been collected on this mandate, so
  // there is no cycle end to wait for and no paid time to protect. For a
  // never-authorised mandate, cancelling also kills the authorisation link —
  // the only thing that could ever turn it into a charge.
  const result = await cancelSubscription(row.razorpay_subscription_id as string, false);
  if (!result.ok) {
    return json(req, { error: `Razorpay would not cancel the mandate: ${result.error}` }, 400);
  }
  // The cancel is not believed until Razorpay says it back.
  const after = await fetchSubscription(row.razorpay_subscription_id as string);

  // The mandate is dead at Razorpay, so the row stops claiming a pending
  // slot: one restaurant has at most one pending mandate checkout, and a
  // cancelled one is not it. The row is expired, never deleted — the record
  // of what the customer did stays.
  await db
    .from("subscription_checkouts")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("status", "pending");

  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: row.plan_id,
    new_plan: row.plan_id,
    change_type: "scheduled_change_cancelled",
    detail: {
      checkoutId: row.id,
      razorpaySubscriptionId: row.razorpay_subscription_id,
      scheduledStartAt: row.scheduled_start_at,
      reason: decision.kind,
      razorpayStatusBefore: String(live.data.status ?? ""),
      razorpayStatusAfter: after.ok ? String(after.data.status ?? "") : "unconfirmed",
    },
  });

  return json(req, { ok: true, neverAuthorised: decision.kind === "cancel-never-authorised" });
}

/** The restaurant as the billing page sees it. */
async function state(req: Request, tenantId: string): Promise<Response> {
  const plan = await resolvePlan(tenantId);
  const catalogue = await planCatalogue();
  const { data: tenant } = await admin()
    .from("tenants")
    .select("name, email")
    .eq("id", tenantId)
    .maybeSingle();

  const { data: payments } = await admin()
    .from("subscription_payments")
    .select(
      "id, amount, currency, status, payment_method, transaction_id, plan_id, billing_period, created_at, razorpay_payment_id, razorpay_order_id, failure_reason",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(24);

  // The issued financial documents, so the printed receipt is the same
  // document the download endpoint replays: number, period and seller
  // identity come from the immutable issued record, never recomputed in
  // the browser. Best-effort — a read problem here must not blank the
  // billing page; the print falls back to the payment row itself.
  const { data: invoices, error: invoicesError } = await admin()
    .from("billing_invoices")
    .select(
      "razorpay_payment_id, invoice_number, invoice_date, period_start, period_end, description, seller_name, seller_address, seller_email, seller_phone, buyer_name, buyer_email, buyer_address",
    )
    .eq("tenant_id", tenantId);
  if (invoicesError) {
    console.error("subscriptions state: invoices unreadable", invoicesError.message);
  }
  const { data: refunds, error: refundsError } = await admin()
    .from("billing_refunds")
    .select(
      "razorpay_payment_id, refund_number, refund_date, original_invoice_number, original_invoice_date, razorpay_refund_id",
    )
    .eq("tenant_id", tenantId);
  if (refundsError) {
    console.error("subscriptions state: refunds unreadable", refundsError.message);
  }
  const invoiceByPayment = new Map(
    (invoices ?? []).map((row) => [row.razorpay_payment_id, row]),
  );
  const refundByPayment = new Map(
    (refunds ?? []).map((row) => [row.razorpay_payment_id, row]),
  );

  // Every plan's display facts — retired ones included. The catalogue the
  // grid is built from is active-only, so without this a retired plan's
  // historical payments fall back to their raw id ("starter-onetime") and a
  // wrong period label ("Monthly" for a 30-day one-time purchase).
  const { data: allPlans, error: allPlansError } = await admin()
    .from("subscription_plans")
    .select("id, name, billing_mode");
  if (allPlansError) {
    console.error("subscriptions state: plan directory unreadable", allPlansError.message);
  }

  // Lifetime totals, from the ledger only — lean columns, no 24-row cap, and
  // failed attempts never counted as money.
  const { data: allPayments, error: allPaymentsError } = await admin()
    .from("subscription_payments")
    .select("amount, currency, status")
    .eq("tenant_id", tenantId);
  if (allPaymentsError) {
    console.error("subscriptions state: totals unreadable", allPaymentsError.message);
  }

  // A tenant is exactly one restaurant location in today's schema — but the
  // number is counted from the database rather than hardcoded, so the day
  // locations become rows this follows without a client change.
  const { count: locationCount } = await admin()
    .from("tenants")
    .select("id", { count: "exact", head: true })
    .eq("id", tenantId);

  return json(req, {
    plan: publicPlan(plan),
    plans: catalogue,
    restaurant: { name: tenant?.name ?? null, email: tenant?.email ?? null },
    razorpayConfigured: razorpayConfigured(),
    planDirectory: directoryFrom(allPlans ?? []),
    totals: summariseTotals(allPayments ?? []),
    locationCount: locationCount ?? 1,
    payments: (payments ?? []).map((row) => {
      const key = row.razorpay_payment_id ?? row.transaction_id;
      return {
        ...row,
        document: invoiceByPayment.get(key) ?? null,
        refundDocument: refundByPayment.get(key) ?? null,
      };
    }),
  });
}

/** The part of the plan the browser is allowed to see. */
function publicPlan(plan: EffectivePlan) {
  return {
    planId: plan.planId,
    planName: plan.planName,
    status: plan.status,
    isPaid: plan.isPaid,
    isTrial: plan.isTrial,
    isRestricted: plan.isRestricted,
    trialStartedAt: plan.trialStartedAt,
    trialEndsAt: plan.trialEndsAt,
    trialDaysRemaining: plan.trialDaysRemaining,
    subscriptionPlan: plan.subscriptionPlan,
    subscriptionStartedAt: plan.subscriptionStartedAt,
    currentPeriodEnd: plan.currentPeriodEnd,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
    limits: plan.limits,
    features: plan.features,
    priceMonthly: plan.priceMonthly,
    priceYearly: plan.priceYearly,
    billingInterval: plan.billingInterval,
    paymentMode: plan.paymentMode,
    currency: plan.currency,
    billingMode: plan.billingMode,
  };
}

/**
 * Create a subscription and an order for the checkout.
 *
 * The plan id is Razorpay's own, which comes from the plan catalogue and is
 * set by the Super Admin. If it is not set, the answer says exactly what is
 * missing rather than failing somewhere inside Razorpay.
 *
 * `upgrade` delegates a first purchase here, and it has already read the
 * body by then — a request body can only be read once, so the parsed body is
 * passed through rather than read again (a second read answers {} and every
 * first purchase used to fail with "planId is required").
 */

/** The pending mandate checkouts of a restaurant, newest first. */
async function pendingMandateCheckouts(
  db: any,
  tenantId: string,
): Promise<Array<PendingMandateCheckout & { amount: number | null; razorpayOrderId: string | null }>> {
  const { data } = await db
    .from("subscription_checkouts")
    .select("id, plan_id, billing_interval, scheduled_start_at, razorpay_subscription_id, razorpay_order_id, amount, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .not("razorpay_subscription_id", "is", null)
    .order("created_at", { ascending: false });
  return (data ?? []).map((r: any) => ({
    id: r.id as string,
    planId: String(r.plan_id ?? ""),
    interval: (r.billing_interval === "annual" ? "annual" : r.billing_interval === "monthly" ? "monthly" : null),
    scheduledStartAt: (r.scheduled_start_at as string | null) ?? null,
    razorpaySubscriptionId: String(r.razorpay_subscription_id),
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    razorpayOrderId: (r.razorpay_order_id as string | null) ?? null,
  }));
}

/** Razorpay's report on a subscription, reduced to what the guard needs. */
async function liveSubscription(subscriptionId: string): Promise<LiveSubscription | null> {
  const fetched = await fetchSubscription(subscriptionId);
  if (!fetched.ok) return null;
  return {
    status: String(fetched.data.status ?? ""),
    paidCount: Number(fetched.data.paid_count ?? 0),
  };
}

/** A unique-constraint violation from Postgres (the one-pending-mandate backstop). */
function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "23505" || String(error.message ?? "").includes("duplicate key");
}

async function checkout(
  req: Request,
  tenantId: string,
  parsedBody?: Record<string, unknown>,
): Promise<Response> {
  const b = parsedBody ?? await body(req);
  const planId = String(b.planId ?? "").trim();
  if (!planId) return json(req, { error: "planId is required" }, 400);

  const interval = readInterval(b.interval);
  if (!interval) {
    return json(req, { error: "interval must be monthly or annual." }, 400);
  }
  const paymentMode = readPaymentMode(b.paymentMode, interval);
  if (!paymentMode) {
    return json(
      req,
      {
        error:
          "Monthly plans are AutoPay only, and annual plans are paid once. " +
          "Annual AutoPay is not offered.",
      },
      400,
    );
  }

  if (!razorpayConfigured()) {
    return json(
      req,
      {
        error:
          "Payments are not set up on the server yet. The Super Admin has to add the Razorpay keys first.",
      },
      503,
    );
  }

  const db = admin();
  const { data: planRow } = await db
    .from("subscription_plans")
    .select("id, name, price_monthly, price_yearly, currency, razorpay_plan_id, is_active, billing_mode")
    .eq("id", planId)
    .maybeSingle();

  if (!planRow) return json(req, { error: "That plan does not exist." }, 404);
  const onetime = planRow.billing_mode === "onetime";
  // The one-time plan is retired. Its historical purchases are untouched, but
  // it is not something anyone can buy any more.
  if (onetime) {
    return json(
      req,
      { error: "One-time plans are no longer offered. Choose a monthly or annual subscription instead." },
      400,
    );
  }
  if (!planRow.is_active) return json(req, { error: "That plan is not available." }, 400);

  const price = interval === "annual" ? Number(planRow.price_yearly ?? 0) : Number(planRow.price_monthly);
  // Only a monthly mandate needs a Razorpay plan; a year is an order.
  const razorpayPlanId = planRow.razorpay_plan_id;
  if (!price) {
    return json(
      req,
      { error: `The ${interval} price for ${planRow.name} is not set.` },
      503,
    );
  }
  if (paymentMode === "autopay" && !razorpayPlanId) {
    return json(
      req,
      {
        error: `AutoPay for ${planRow.name} is not set up yet.`,
      },
      503,
    );
  }

  const { data: tenant } = await db
    .from("tenants")
    .select("name, email, current_period_end")
    .eq("id", tenantId)
    .maybeSingle();
  const { data: profile } = await db
    .from("profiles")
    .select("email, full_name")
    .eq("tenant_id", tenantId)
    .limit(1)
    .maybeSingle();

  const notes = {
    tenant_id: tenantId,
    plan_id: planId,
    interval,
    payment_mode: paymentMode,
    restaurant: tenant?.name ?? "Restaurant",
  };

  /**
   * Pay once: a bare Razorpay order for the whole year.
   *
   * No subscription is created, so there is no mandate anywhere in the chain
   * that could ever charge again — the absence of a subscription id is what
   * makes "never renew" true rather than a promise. The checkout row records
   * the mode so `verify` grants exactly one period and the billing page can
   * say so.
   */
  if (paymentMode === "pay_once") {
    /**
     * A repeated click, a retried request, a second tab: they must all land
     * on ONE payable order, not mint one per attempt. An open order for the
     * same plan and interval is handed back; only a genuinely different
     * purchase creates a new one. The unique index is the backstop when two
     * requests race — the loser reads the winner's row and reuses it.
     */
    const { data: pendingOrder } = await db
      .from("subscription_checkouts")
      .select("id, razorpay_order_id, amount")
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .eq("plan_id", planRow.id)
      .eq("billing_interval", interval)
      .is("razorpay_subscription_id", null)
      .not("razorpay_order_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendingOrder?.razorpay_order_id) {
      return json(req, {
        keyId: razorpayConfig().keyId,
        razorpayOrderId: pendingOrder.razorpay_order_id,
        amount: Number(pendingOrder.amount ?? price),
        currency: planRow.currency ?? "INR",
        interval,
        paymentMode: "pay_once",
        planId: planRow.id,
        planName: planRow.name,
        billingMode: "recurring",
        resumed: true,
      });
    }

    const order = await createOrder({
      amount: price,
      currency: planRow.currency ?? "INR",
      receipt: `payonce_${tenantId.replace(/-/g, "").slice(0, 12)}_${Date.now()}`.slice(0, 40),
      notes,
    });
    if (!order.ok) {
      return json(req, { error: `Razorpay would not create the order: ${order.error}` }, 400);
    }

    const { error: insertError } = await db.from("subscription_checkouts").insert({
      tenant_id: tenantId,
      plan_id: planRow.id,
      amount: price,
      currency: planRow.currency ?? "INR",
      billing_interval: interval,
      payment_mode: "pay_once",
      razorpay_order_id: order.data.id,
      razorpay_subscription_id: null,
      status: "pending",
    });
    if (insertError) {
      if (isUniqueViolation(insertError)) {
        // Lost the race to a concurrent request — its order is the one.
        const { data: winner } = await db
          .from("subscription_checkouts")
          .select("razorpay_order_id, amount")
          .eq("tenant_id", tenantId)
          .eq("status", "pending")
          .eq("plan_id", planRow.id)
          .eq("billing_interval", interval)
          .is("razorpay_subscription_id", null)
          .not("razorpay_order_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (winner?.razorpay_order_id) {
          return json(req, {
            keyId: razorpayConfig().keyId,
            razorpayOrderId: winner.razorpay_order_id,
            amount: Number(winner.amount ?? price),
            currency: planRow.currency ?? "INR",
            interval,
            paymentMode: "pay_once",
            planId: planRow.id,
            planName: planRow.name,
            billingMode: "recurring",
            resumed: true,
          });
        }
      }
      console.error("subscriptions: could not record the pay-once checkout", insertError.message);
      return json(req, { error: "Could not start the checkout. Please try again." }, 503);
    }

    return json(req, {
      keyId: razorpayConfig().keyId,
      razorpayOrderId: order.data.id,
      amount: price,
      currency: planRow.currency ?? "INR",
      interval,
      paymentMode: "pay_once",
      planId: planRow.id,
      planName: planRow.name,
      billingMode: "recurring",
    });
  }

  /**
   * A restaurant that still has paid time left must not be charged again
   * today: paying for the same 30 days twice is the one-time → recurring
   * double-sell. The subscription is created to START at the end of the
   * period already paid for — the customer authorises the mandate in the
   * Razorpay checkout now, and the first charge lands exactly at the
   * boundary. No order is created because nothing is collected today.
   */
  const remainingMs =
    tenant?.current_period_end ? new Date(tenant.current_period_end).getTime() - Date.now() : 0;
  const scheduledStart = remainingMs > 60_000 ? new Date(tenant!.current_period_end as string) : null;

  /**
   * One restaurant, one pending mandate.
   *
   * This is the fix for the duplicate-subscription bug: until now every call
   * created a fresh Razorpay subscription, so a double-click, a retry, or a
   * second browser tab minted a fresh billable mandate each time (one test
   * restaurant accumulated seven). The rule now:
   *
   *   - the same purchase again (same plan, interval and start) REUSES the
   *     pending mandate — the customer resumes authorising it;
   *   - a different purchase REPLACES it — the old mandate, which has never
   *     charged, is cancelled at Razorpay and its row retired;
   *   - anything Razorpay cannot confirm blocks the creation rather than
   *     guessing, because guessing is how a restaurant gets two mandates.
   *
   * The partial unique index in migration 0069 is the hard backstop: two
   * concurrent requests cannot both insert, and the loser reuses the
   * winner's mandate.
   */
  const pendingMandates = await pendingMandateCheckouts(db, tenantId);
  if (pendingMandates.length > 0) {
    const [existing, ...older] = pendingMandates;
    const live = await liveSubscription(existing.razorpaySubscriptionId);
    const action = decideCheckoutAction({
      existing,
      live,
      requestPlanId: planRow.id,
      requestInterval: interval,
      requestScheduledStart: scheduledStart ? scheduledStart.toISOString() : null,
    });

    if (action.kind === "reuse") {
      const liveEnd = await fetchSubscription(existing.razorpaySubscriptionId);
      return json(req, {
        keyId: razorpayConfig().keyId,
        razorpaySubscriptionId: existing.razorpaySubscriptionId,
        // An immediate-start mandate carries the order its first payment
        // settles; a scheduled one never had an order to begin with.
        ...(existing.razorpayOrderId ? { razorpayOrderId: existing.razorpayOrderId } : {}),
        ...(existing.scheduledStartAt
          ? { scheduled: true, startsAt: existing.scheduledStartAt }
          : {}),
        amount: existing.amount ?? price,
        currency: planRow.currency ?? "INR",
        interval,
        paymentMode: "autopay",
        mandate: {
          id: existing.razorpaySubscriptionId,
          cycles: MONTHLY_CYCLES,
          expiresAt: liveEnd.ok && liveEnd.data.end_at
            ? new Date(Number(liveEnd.data.end_at) * 1000).toISOString()
            : null,
        },
        planId: planRow.id,
        planName: planRow.name,
        billingMode: "recurring",
        resumed: true,
      });
    }

    if (action.kind === "unavailable") {
      return json(
        req,
        {
          error:
            "Your existing AutoPay mandate could not be confirmed with Razorpay just now, " +
            "so nothing new was started. Please try again in a moment.",
          retryable: true,
        },
        503,
      );
    }

    if (action.kind === "blocked") {
      return json(req, { error: action.reason }, 409);
    }

    // replace or expire: the pending mandate is retired before a fresh one
    // is created. Both paths go through the helper, which cancels only a
    // mandate that has never charged and records what it did.
    const retired = await retirePendingMandate(db, {
      tenantId,
      checkoutId: existing.id,
      razorpaySubscriptionId: existing.razorpaySubscriptionId,
      reason: action.kind === "replace" ? "replaced" : "dead",
      live,
    });
    if (retired.kind === "unknown") {
      return json(
        req,
        {
          error:
            "Your existing AutoPay mandate could not be retired with Razorpay just now, " +
            "so nothing new was started. Please try again in a moment.",
          retryable: true,
        },
        503,
      );
    }
    if (retired.kind === "kept") {
      return json(
        req,
        {
          error:
            "Your existing AutoPay mandate has already started charging, so a new one " +
            "was not created. Change the plan on it from the billing page instead.",
        },
        409,
      );
    }

    // Any older pending mandates (from before this guard existed) are
    // superseded by the same purchase. Best-effort: each is checked with
    // Razorpay and retired only if it has never charged.
    for (const stale of older) {
      try {
        const staleLive = await liveSubscription(stale.razorpaySubscriptionId);
        await retirePendingMandate(db, {
          tenantId,
          checkoutId: stale.id,
          razorpaySubscriptionId: stale.razorpaySubscriptionId,
          reason: "superseded",
          live: staleLive,
        });
      } catch (e) {
        console.error("subscriptions: stale mandate would not retire", stale.razorpaySubscriptionId, (e as Error)?.message);
      }
    }
  }

  // A monthly mandate is bounded by its twelve cycles. `expire_by` only limits
  // when the customer may authorise, so it is set to the same year rather than
  // left at Razorpay's thirty-year default.
  const totalCount = MONTHLY_CYCLES;
  const authoriseWindowEnd = Math.floor(
    (scheduledStart ? scheduledStart.getTime() : Date.now()) / 1000,
  ) + YEAR_SECONDS;

  const subscription = await createSubscription({
    razorpayPlanId,
    totalCount,
    customer: {
      name: tenant?.name ?? profile?.full_name ?? "Restaurant",
      email: profile?.email ?? tenant?.email ?? "",
    },
    notes,
    expireBy: authoriseWindowEnd,
    ...(scheduledStart
      ? { startAt: Math.floor(scheduledStart.getTime() / 1000) }
      : {}),
  });
  if (!subscription.ok) {
    return json(req, { error: `Razorpay would not create the subscription: ${subscription.error}` }, 400);
  }

  let order: { ok: true; data: RazorpayOrder } | { ok: false; error: string } | null = null;
  if (!scheduledStart) {
    order = await createOrder({
      amount: price,
      currency: planRow.currency ?? "INR",
      receipt: `sub_${subscription.data.id}`.slice(0, 40),
      notes: { ...notes, subscription_id: subscription.data.id },
    });
    if (!order.ok) {
      return json(req, { error: `Razorpay would not create the order: ${order.error}` }, 400);
    }
  }

  // The subscription is NOT linked to the tenant yet. The webhook finds the
  // restaurant through the subscription's notes (tenant_id is in them), and
  // the linkage is only written once a payment is proven — in verify, or by
  // a webhook event for a subscription that has collected money. Writing it
  // here, before the payment, is how an abandoned checkout used to leave a
  // tenant that had already paid pointing at a subscription that never did.

  /**
   * And record what was bought.
   *
   * `verify` has to answer "is this order ours, for this plan, for this amount",
   * and until now there was nothing to answer it from: the order id was returned
   * to the browser and never written down, which is why the ownership check
   * could be satisfied by any subscription id the caller supplied.
   *
   * If this cannot be recorded the checkout does not proceed: a payment we could
   * not later check is worse than no payment.
   */
  const { error: checkoutError } = await db.from("subscription_checkouts").insert({
    tenant_id: tenantId,
    plan_id: planRow.id,
    amount: price,
    currency: planRow.currency ?? "INR",
    billing_interval: interval,
    payment_mode: "autopay",
    // For a Razorpay subscription the mandate IS the subscription; `end_at` is
    // what Razorpay derives from total_count and refuses charges past.
    mandate_id: subscription.data.id,
    mandate_expires_at: subscription.data.end_at
      ? new Date(subscription.data.end_at * 1000).toISOString()
      : null,
    razorpay_order_id: order?.ok ? order.data.id : null,
    razorpay_subscription_id: subscription.data.id,
    ...(scheduledStart ? { scheduled_start_at: scheduledStart.toISOString() } : {}),
    status: "pending",
  });
  if (checkoutError) {
    if (isUniqueViolation(checkoutError)) {
      /**
       * Lost the race: a concurrent request inserted the restaurant's one
       * pending mandate first. The subscription created moments ago is the
       * duplicate — it has never been shown to a customer, so cancelling it
       * is safe — and the winner's mandate is the one handed back.
       */
      try {
        await cancelSubscription(subscription.data.id, false);
      } catch (e) {
        console.error("subscriptions: losing-race subscription would not cancel", (e as Error)?.message);
      }
      const { data: winner } = await db
        .from("subscription_checkouts")
        .select("plan_id, billing_interval, scheduled_start_at, razorpay_subscription_id, razorpay_order_id, amount")
        .eq("tenant_id", tenantId)
        .eq("status", "pending")
        .not("razorpay_subscription_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (winner?.razorpay_subscription_id) {
        return json(req, {
          keyId: razorpayConfig().keyId,
          razorpaySubscriptionId: winner.razorpay_subscription_id,
          ...(winner.razorpay_order_id ? { razorpayOrderId: winner.razorpay_order_id } : {}),
          ...(winner.scheduled_start_at
            ? { scheduled: true, startsAt: winner.scheduled_start_at }
            : {}),
          amount: Number(winner.amount ?? price),
          currency: planRow.currency ?? "INR",
          interval,
          paymentMode: "autopay",
          mandate: {
            id: winner.razorpay_subscription_id,
            cycles: MONTHLY_CYCLES,
            expiresAt: null,
          },
          planId: planRow.id,
          planName: planRow.name,
          billingMode: "recurring",
          resumed: true,
        });
      }
    }
    console.error("subscriptions: could not record the checkout", checkoutError.message);
    // The Razorpay subscription already exists at this point, and once the
    // customer authorises it, it debits on schedule — recorded or not. A
    // checkout we failed to write down must not stay live, so the mandate
    // is cancelled immediately, best-effort: the customer still gets the
    // error and can retry, which creates a fresh pair.
    try {
      await cancelSubscription(subscription.data.id, false);
    } catch (e) {
      console.error("subscriptions: orphan subscription would not cancel", (e as Error)?.message);
    }
    return json(req, { error: "Could not start the checkout. Please try again." }, 503);
  }

  return json(req, {
    keyId: razorpayConfig().keyId,
    razorpaySubscriptionId: subscription.data.id,
    razorpayOrderId: order?.ok ? order.data.id : undefined,
    ...(scheduledStart ? { scheduled: true, startsAt: scheduledStart.toISOString() } : {}),
    amount: price,
    currency: planRow.currency ?? "INR",
    interval,
    paymentMode: "autopay",
    // What the mandate covers, in the customer's terms — the UI shows these so
    // "Enable AutoPay" is a decision with facts attached, not a label.
    mandate: {
      id: subscription.data.id,
      cycles: totalCount,
      expiresAt: subscription.data.end_at ? new Date(subscription.data.end_at * 1000).toISOString() : null,
    },
    planId: planRow.id,
    planName: planRow.name,
    billingMode: "recurring",
  });
}

/**
 * Check the payment and activate the plan.
 *
 * The browser sends what Razorpay gave it. The signature is recomputed here with
 * the server's own secret, and if it does not match nothing changes — a
 * restaurant cannot activate a plan by saying it paid.
 *
 * The signature covers the order id and the payment id and nothing else, so on
 * its own it says neither how much was paid nor which plan it was for. Those come
 * from the checkout this server recorded when the order was created, and from the
 * payment as Razorpay itself reports it. A client-supplied subscription id is
 * ignored on purpose: the recorded checkout is the only source for it.
 */
async function verify(req: Request, tenantId: string): Promise<Response> {
  const b = await body(req);
  const razorpayOrderId = String(b.razorpayOrderId ?? "");
  const razorpayPaymentId = String(b.razorpayPaymentId ?? "");
  const razorpaySignature = String(b.razorpaySignature ?? "");
  const razorpaySubscriptionId = String(b.razorpaySubscriptionId ?? "");

  const check = await verifyPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature,
    razorpaySubscriptionId,
  });
  if (!check.ok) {
    return json(req, { error: check.error, activated: false }, 400);
  }

  const db = admin();

  // 1. The checkout this order belongs to. This is what makes "the order is
  //    ours" answerable — an order we never recorded cannot be verified, and
  //    neither can one belonging to another restaurant.
  let { data: checkoutRow, error: checkoutError } = await db
    .from("subscription_checkouts")
    .select(
      "tenant_id, plan_id, amount, currency, billing_interval, payment_mode, mandate_id, mandate_expires_at, razorpay_order_id, razorpay_subscription_id, status, razorpay_payment_id",
    )
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  // A subscription's payment can come back without the order id; the
  // subscription the checkout recorded identifies it just as well.
  if (!checkoutRow && !checkoutError && razorpaySubscriptionId) {
    const bySubscription = await db
      .from("subscription_checkouts")
      .select(
        "tenant_id, plan_id, amount, currency, billing_interval, payment_mode, mandate_id, mandate_expires_at, razorpay_order_id, razorpay_subscription_id, status, razorpay_payment_id",
      )
      .eq("razorpay_subscription_id", razorpaySubscriptionId)
      .eq("status", "pending")
      .maybeSingle();
    checkoutRow = bySubscription.data;
    checkoutError = bySubscription.error;
  }

  if (checkoutError) {
    console.error("subscriptions verify: could not read the checkout", checkoutError.message);
    return json(req, { error: "Could not check the order just now. Please try again.", activated: false, retryable: true }, 503);
  }

  const checkout = checkoutRow
    ? {
      tenantId: checkoutRow.tenant_id as string,
      planId: checkoutRow.plan_id as string,
      amount: Number(checkoutRow.amount),
      currency: checkoutRow.currency as string,
      billingInterval: (checkoutRow.billing_interval === "annual" ? "annual" : "monthly") as "monthly" | "annual",
      paymentMode: (checkoutRow.payment_mode === "autopay" ? "autopay" : "pay_once") as PaymentMode,
      mandateId: (checkoutRow.mandate_id as string | null) ?? null,
      mandateExpiresAt: (checkoutRow.mandate_expires_at as string | null) ?? null,
      razorpayOrderId: checkoutRow.razorpay_order_id as string,
      razorpaySubscriptionId: (checkoutRow.razorpay_subscription_id as string | null) ?? null,
      status: checkoutRow.status as "pending" | "paid" | "failed" | "expired",
      razorpayPaymentId: (checkoutRow.razorpay_payment_id as string | null) ?? null,
    }
    : null;

  if (!checkout || checkout.tenantId !== tenantId) {
    const verdict = checkoutMatches({ checkout, tenantId, planId: null, payment: null });
    return json(req, { error: verdict.ok ? "That order is not one of yours." : verdict.reason, activated: false }, 403);
  }

  // 2. The payment, as Razorpay reports it. A payment that cannot be fetched is
  //    neither accepted nor called a failure: the money may well have moved, so
  //    the answer is "pending, try again".
  const fetched = await fetchPayment(razorpayPaymentId);
  if (!fetched.ok) {
    const failure = paymentFetchFailure({ status: fetched.status, error: fetched.error });
    if (failure.retryable) {
      console.error("subscriptions verify: payment not confirmed", fetched.status, fetched.error);
    }
    return json(
      req,
      { error: failure.reason, activated: false, retryable: failure.retryable },
      failure.retryable ? 503 : 400,
    );
  }

  const payment: PaymentFacts = {
    id: fetched.data.id,
    amount: Number(fetched.data.amount ?? 0),
    currency: String(fetched.data.currency ?? checkout.currency),
    orderId: fetched.data.order_id ?? null,
    status: String(fetched.data.status ?? ""),
  };

  // 3. Does it settle this checkout — right restaurant, right plan, right
  //    amount, right currency, and captured?
  const verdict = checkoutMatches({
    checkout,
    tenantId,
    planId: checkout.planId,
    payment,
  });
  if (!verdict.ok) {
    console.error("subscriptions verify: refused", verdict.code, verdict.reason);
    return json(req, { error: verdict.reason, activated: false }, verdict.code === "not_found" ? 403 : 400);
  }

  // 4. Once per payment. A browser that reloads and verifies again is told it is
  //    already active rather than having its period moved forward another month.
  if (entitlementAction({ checkout, paymentId: payment.id }) === "already") {
    const plan = await resolvePlan(tenantId);
    return json(req, { ok: true, activated: true, alreadyVerified: true, plan: publicPlan(plan) });
  }

  const now = new Date();
  /**
   * The period starts at the later of now and the end of what the
   * restaurant has already paid for. A one-time month bought with days
   * still on the clock extends from the boundary, not from today —
   * otherwise every early renewal quietly re-sold the remaining days.
   */
  const { data: tRow } = await db
    .from("tenants")
    .select("current_period_end, razorpay_subscription_id, plan, subscription_plan")
    .eq("id", tenantId)
    .maybeSingle();
  const paidUntil = tRow?.current_period_end ? new Date(tRow.current_period_end) : null;
  const periodBase = paidUntil && paidUntil > now ? paidUntil : now;
  const interval = checkout.billingInterval ?? "monthly";
  const periodEnd = purchasedPeriodEnd(periodBase, interval);
  const amountPaid = fromMinorUnits(payment.amount, payment.currency);
  const subscriptionId = checkout.razorpaySubscriptionId;
  const paymentMode = checkout.paymentMode ?? "pay_once";
  const mandateId = paymentMode === "autopay" ? (checkout.mandateId ?? subscriptionId) : null;
  const mandateExpiresAt = paymentMode === "autopay" ? checkout.mandateExpiresAt : null;

  // The ledger write comes first and is not optional. A payment that cannot be
  // recorded is a payment the history, the receipts and the refunds all
  // silently lose — this exact failure is why the first real checkout
  // verified, activated and left an empty payment history behind. So the
  // upsert is checked, and on failure nothing is activated: the checkout is
  // still pending, the browser can safely retry, and the money has not been
  // spent twice.
  const { error: ledgerError } = await db
    .from("subscription_payments")
    .upsert(
      {
        tenant_id: tenantId,
        // What was actually paid, not the plan's list price: the two are the
        // same in the ordinary case, and recording the list price when they are
        // not is how a ledger stops describing reality.
        amount: amountPaid,
        currency: payment.currency,
        status: "succeeded",
        // How the customer actually paid — card, upi, netbanking, wallet —
        // from Razorpay's own record of the payment.
        payment_method: (payment as any).method ?? "razorpay",
        transaction_id: payment.id,
        plan_id: checkout.planId,
        billing_period: interval,
        payment_mode: paymentMode,
        mandate_id: mandateId,
        mandate_expires_at: mandateExpiresAt,
        // A pay-once year ends by itself; nothing may renew it. An autopay
        // year renews only when Razorpay reports a charge that succeeded.
        renewal_status: paymentMode === "pay_once" ? "not_applicable" : "scheduled",
        razorpay_payment_id: payment.id,
        razorpay_order_id: checkout.razorpayOrderId,
        razorpay_subscription_id: subscriptionId,
        razorpay_signature: razorpaySignature,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: "razorpay_payment_id" },
    );
  if (ledgerError) {
    console.error("subscriptions verify: could not record the payment", ledgerError.message);
    return json(
      req,
      {
        error: "The payment was verified but could not be recorded. Nothing was activated — please try again in a moment.",
        activated: false,
        retryable: true,
      },
      503,
    );
  }

  await db
    .from("tenants")
    .update({
      plan: checkout.planId,
      subscription_plan: checkout.planId,
      subscription_status: "active",
      subscription_started_at: now.toISOString(),
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      razorpay_subscription_id: subscriptionId,
      subscription_razorpay_payment_id: payment.id,
      billing_interval: interval,
      payment_mode: paymentMode,
    })
    .eq("id", tenantId);

  /**
   * One restaurant, one billable mandate — enforced at the moment money
   * lands. Two things are cleaned up here, both best-effort: the activation
   * has already happened and must not be rolled back by bookkeeping.
   *
   *   1. If the restaurant was linked to a different subscription before,
   *      that mandate is cancelled at Razorpay (verified), or the miss is
   *      audited — the double-billing window never stays open silently.
   *   2. Pending mandates whose scheduled start is now inside the paid
   *      period just bought are retired: they were computed from a boundary
   *      that has moved, and would otherwise debit during paid time.
   */
  try {
    const switched = await cancelSupersededLink(db, {
      tenantId,
      previousSubscriptionId: (tRow?.razorpay_subscription_id as string | null) ?? null,
      newSubscriptionId: subscriptionId,
      source: "verify",
      oldPlan: (tRow?.subscription_plan ?? tRow?.plan ?? null) as string | null,
      newPlan: checkout.planId,
    });
    if (switched.kind === "cancelled" || switched.kind === "unknown") {
      console.log("subscriptions verify: previous mandate", switched.kind, switched);
    }
  } catch (e) {
    console.error("subscriptions verify: mandate switch check failed", (e as Error)?.message);
  }

  try {
    const stranded = await pendingMandateCheckouts(db, tenantId);
    for (const m of stranded) {
      if (subscriptionId && m.razorpaySubscriptionId === subscriptionId) continue;
      if (!mandateSupersededByPeriod(m.scheduledStartAt, periodEnd.toISOString())) continue;
      const live = await liveSubscription(m.razorpaySubscriptionId);
      await retirePendingMandate(db, {
        tenantId,
        checkoutId: m.id,
        razorpaySubscriptionId: m.razorpaySubscriptionId,
        reason: "superseded-by-purchase",
        live,
      });
    }
  } catch (e) {
    console.error("subscriptions verify: stranded mandate sweep failed", (e as Error)?.message);
  }

  // One settled purchase retires every other open order: a payable link to
  // a plan the restaurant just replaced must not stay payable.
  try {
    await db
      .from("subscription_checkouts")
      .update({ status: "expired", updated_at: now.toISOString() })
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .is("razorpay_subscription_id", null)
      .neq("razorpay_order_id", checkout.razorpayOrderId);
  } catch (e) {
    console.error("subscriptions verify: stale order sweep failed", (e as Error)?.message);
  }

  // Confirmation of the thing that actually happened. Queued from the row that
  // was just written, so the email cannot describe a state the database is not
  // in; sent immediately because a "you're on Pro" that arrives tomorrow is
  // worse than useless.
  try {
    await queueForTenant(db, tenantId, {
      eventKey: `subscription_activated:${tenantId}:${payment.id}`,
      eventType: "subscription_activated",
      planName: checkout.planId,
      amount: amountPaid,
      currency: payment.currency,
      billingInterval: interval,
      payload: { periodEnd, paymentRef: payment.id, mode: paymentMode },
    });
    await dispatchPending(db, 5);
  } catch (e) {
    // A confirmation email must never fail an activation that already happened.
    console.error("subscriptions: activation email failed", (e as Error)?.message);
  }

  // The checkout now names the payment that settled it. This is the record the
  // next call reads to know it has already been applied.
  await db
    .from("subscription_checkouts")
    .update({
      status: "paid",
      razorpay_payment_id: payment.id,
      verified_amount: amountPaid,
      verified_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("razorpay_order_id", checkout.razorpayOrderId);

  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: null,
    new_plan: checkout.planId,
    change_type: "activated",
    razorpay_event_id: payment.id,
    detail: {
      razorpayPaymentId: payment.id,
      razorpayOrderId,
      razorpaySubscriptionId: subscriptionId,
      amountPaid,
      currency: payment.currency,
    },
  });

  // The invoice is issued from the verified payment, eagerly, so the
  // document exists before the owner ever asks for it. Best-effort: the
  // money already moved and the entitlement is granted — a filing
  // problem never blocks either; the download endpoint replays or
  // retries issuance later.
  try {
    const { data: ledgerRow } = await db
      .from("subscription_payments")
      .select(
        "id, amount, currency, status, payment_method, plan_id, billing_period, created_at, razorpay_payment_id, razorpay_order_id",
      )
      .eq("razorpay_payment_id", payment.id)
      .maybeSingle();
    if (ledgerRow) {
      await issueInvoiceDocument(db, tenantId, ledgerRow, { periodStart: periodBase, periodEnd });
    }
  } catch (e) {
    console.error("subscriptions verify: invoice issuance failed", (e as Error)?.message);
  }

  const plan = await resolvePlan(tenantId);
  return json(req, { ok: true, activated: true, plan: publicPlan(plan) });
}

/**
 * Move to another plan.
 *
 * A restaurant that has no subscription yet just starts a checkout. One that
 * has a subscription has Razorpay change the plan on it, so the renewal
 * continues on the new plan and the difference is prorated.
 */
async function upgrade(req: Request, tenantId: string): Promise<Response> {
  const b = await body(req);
  const planId = String(b.planId ?? "").trim();
  if (!planId) return json(req, { error: "planId is required" }, 400);
  const interval = readInterval(b.interval);
  if (!interval) {
    return json(req, { error: "interval must be monthly or annual." }, 400);
  }

  const db = admin();
  const { data: tenant } = await db
    .from("tenants")
    .select("razorpay_subscription_id, subscription_plan, plan, subscription_status, cancel_at_period_end, current_period_end, billing_interval")
    .eq("id", tenantId)
    .maybeSingle();

  // A linked subscription is only an upgrade target when money has actually
  // been collected for THAT subscription. The status field alone is not
  // evidence: a tenant can be active on a one-time purchase while the stored
  // subscription id belongs to a checkout that was never paid (the old
  // checkout wrote the linkage before the payment). Changing the plan on an
  // unpaid subscription would hand over the new plan without any money
  // changing hands, so the proof is read, not assumed: a checkout that was
  // paid, or a succeeded payment Razorpay recorded against this exact
  // subscription id.
  const linkedSubId = String(tenant?.razorpay_subscription_id ?? "") || null;
  let paidEvidence: unknown = null;
  if (linkedSubId) {
    const { data: paidCheckout } = await db
      .from("subscription_checkouts")
      .select("id")
      .eq("razorpay_subscription_id", linkedSubId)
      .eq("status", "paid")
      .limit(1)
      .maybeSingle();
    if (paidCheckout) {
      paidEvidence = paidCheckout;
    } else {
      const { data: paidPayment } = await db
        .from("subscription_payments")
        .select("id")
        .eq("razorpay_subscription_id", linkedSubId)
        .eq("status", "succeeded")
        .limit(1)
        .maybeSingle();
      paidEvidence = paidPayment ?? null;
    }
  }
  if (
    !mayChangePlanOnSubscription({
      linkedSubscriptionId: linkedSubId,
      subscriptionStatus: String(tenant?.subscription_status ?? ""),
      paidEvidence,
    }) ||
    // A subscription cancelled at the period end is on its way out:
    // changing the plan on it would arrange billing for a subscription
    // that completes at the boundary. The purchase instead becomes a new
    // subscription scheduled to start when the paid time ends — via
    // checkout, which already knows how to start at the boundary.
    tenant?.cancel_at_period_end
  ) {
    // No subscription, or no proof this one was ever paid — a first
    // purchase, not an upgrade, whatever the status field says.
    return checkout(req, tenantId, b);
  }

  const { data: planRow } = await db
    .from("subscription_plans")
    .select("id, name, price_monthly, price_yearly, currency, razorpay_plan_id, is_active, billing_mode")
    .eq("id", planId)
    .maybeSingle();
  if (!planRow) return json(req, { error: "That plan does not exist." }, 404);
  if (planRow.billing_mode === "onetime") {
    return json(
      req,
      { error: "One-time plans are no longer offered. Choose a monthly or annual subscription instead." },
      400,
    );
  }
  if (!planRow.is_active) return json(req, { error: "That plan is not available." }, 400);

  // Razorpay cannot change the billing interval of a live subscription — the
  // plan's period defines the cycle. Switching monthly ↔ annual therefore has
  // to be a new mandate at the boundary, not a PATCH; saying so plainly is
  // better than a change that quietly never applies.
  const currentInterval = tenant?.billing_interval === "annual" ? "annual" : "monthly";
  if (interval !== currentInterval) {
    return json(
      req,
      {
        error:
          "Changing between monthly and annual billing needs a new subscription. " +
          "Cancel this one — you keep access until the period ends — then subscribe on the new interval.",
      },
      409,
    );
  }

  // AutoPay only exists for monthly, so only the monthly plan id is used.
  const razorpayPlanId = planRow.razorpay_plan_id;
  if (!razorpayPlanId) {
    return json(
      req,
      { error: `The Razorpay plan for ${planRow.name} has not been set yet.` },
      503,
    );
  }

  /**
   * Asking for the plan the restaurant is already on is the way a scheduled
   * change gets REVERTED: Razorpay treats every update as the new desired
   * end-state, so setting the plan to the current one cancels whatever was
   * scheduled — on the same mandate, never a second one. With nothing
   * scheduled it is a harmless no-op. Repeated upgrades and downgrades
   * therefore always converge: last write wins, one mandate throughout.
   */
  const currentPlanId = String(tenant?.subscription_plan ?? tenant?.plan ?? "");
  const reverting = currentPlanId === planRow.id;

  const result = await updateSubscriptionPlanAtCycleEnd(
    tenant.razorpay_subscription_id,
    razorpayPlanId,
  );
  if (!result.ok) {
    return json(req, { error: `Razorpay would not change the plan: ${result.error}` }, 400);
  }

  if (reverting) {
    await db.from("subscription_audit_logs").insert({
      tenant_id: tenantId,
      old_plan: currentPlanId,
      new_plan: planRow.id,
      change_type: "scheduled_change_cancelled",
      detail: {
        razorpaySubscriptionId: tenant.razorpay_subscription_id,
        reason: "reverted to the current plan",
      },
    });
    return json(req, {
      ok: true,
      scheduled: true,
      reverted: true,
      effectiveAt: tenant.current_period_end,
      planId: planRow.id,
      planName: planRow.name,
    });
  }

  /**
   * The plan in force is NOT changed here. Razorpay applies the new plan
   * at the end of the current cycle and charges for it then; the
   * `subscription.charged` event that follows carries the new plan id and
   * the webhook switches the entitlement at that moment. Writing
   * `subscription_plan` immediately would hand over the new plan while
   * the old one's money is all that has been collected — an upgrade
   * granted before it is paid for, or a downgrade restricting early.
   */

  try {
    await queueForTenant(db, tenantId, {
      eventKey: `plan_changed:${tenantId}:${tenant.subscription_plan ?? tenant.plan}:${planId}:${tenant.current_period_end ?? ""}`,
      eventType: "plan_changed",
      planName: planId,
      amount: interval === "annual" ? Number((planRow as any).price_yearly ?? 0) : Number(planRow.price_monthly ?? 0),
      currency: "INR",
      billingInterval: interval,
      payload: { effectiveAt: tenant.current_period_end },
    });
    await dispatchPending(db, 5);
  } catch (e) {
    console.error("subscriptions: plan-change email failed", (e as Error)?.message);
  }

  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: tenant.subscription_plan ?? tenant.plan,
    new_plan: planId,
    change_type: "plan_change_scheduled",
    detail: {
      razorpaySubscriptionId: tenant.razorpay_subscription_id,
      effectiveAt: tenant.current_period_end,
    },
  });

  return json(req, {
    ok: true,
    scheduled: true,
    effectiveAt: tenant.current_period_end,
    planId,
    planName: planRow.name,
  });
}

/** Cancel at the end of the period. The restaurant keeps what it paid for. */
async function cancel(req: Request, tenantId: string): Promise<Response> {
  const db = admin();
  const { data: tenant } = await db
    .from("tenants")
    .select("razorpay_subscription_id, subscription_plan, plan, current_period_end")
    .eq("id", tenantId)
    .maybeSingle();

  if (!tenant?.razorpay_subscription_id) {
    return json(req, { error: "There is no subscription to cancel." }, 400);
  }

  const result = await cancelSubscription(tenant.razorpay_subscription_id, true);
  if (!result.ok) {
    return json(req, { error: `Razorpay would not cancel the subscription: ${result.error}` }, 400);
  }

  await db
    .from("tenants")
    .update({ cancel_at_period_end: true, subscription_status: "cancelled" })
    .eq("id", tenantId);

  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: tenant.subscription_plan ?? tenant.plan,
    new_plan: tenant.subscription_plan ?? tenant.plan,
    change_type: "cancelled",
    detail: { razorpaySubscriptionId: tenant.razorpay_subscription_id },
  });

  // "You won't be charged again, and you keep access until X" is the one thing
  // a customer wants in writing after pressing cancel.
  try {
    await queueForTenant(db, tenantId, {
      eventKey: `subscription_cancelled:${tenantId}:${tenant.current_period_end ?? ""}`,
      eventType: "subscription_cancelled",
      planName: tenant.subscription_plan ?? tenant.plan,
      currency: "INR",
      payload: { periodEnd: tenant.current_period_end },
    });
    await dispatchPending(db, 5);
  } catch (e) {
    console.error("subscriptions: cancellation email failed", (e as Error)?.message);
  }

  return json(req, { ok: true, cancelAtPeriodEnd: true });
}

/**
 * A billing document for one payment, as a PDF.
 *
 *   GET /subscriptions/invoice?paymentId=<uuid>&kind=invoice|refund&download=1
 *
 * An invoice is only ever issued from a payment that already exists in
 * the ledger — i.e. after server-side verification (verify issues them
 * eagerly) or a signed webhook (charged issues; refunded issues the
 * refund document). This endpoint replays what is stored, and lazily
 * issues if eager issuance ever failed: the unique payment_id index
 * makes a duplicate impossible, the immutability trigger makes an edit
 * impossible, and the PDF streams from the private billing-documents
 * bucket, falling back to a re-render from the immutable row if the
 * stored object was ever lost.
 */
async function invoice(req: Request, tenantId: string): Promise<Response> {
  const url = new URL(req.url);
  const paymentId = String(url.searchParams.get("paymentId") ?? "").trim();
  const kind = url.searchParams.get("kind") === "refund" ? "refund" : "invoice";
  const download = url.searchParams.get("download") === "1";
  if (!paymentId) return json(req, { error: "paymentId is required" }, 400);

  const db = admin();

  const { data: payment, error: paymentError } = await db
    .from("subscription_payments")
    .select(
      "id, tenant_id, amount, currency, status, payment_method, plan_id, billing_period, created_at, razorpay_payment_id, razorpay_order_id",
    )
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) {
    console.error("subscriptions invoice: could not read the payment", paymentError.message);
    return json(req, { error: "Could not read the payment just now." }, 503);
  }
  if (!payment || payment.tenant_id !== tenantId) {
    return json(req, { error: "No such payment for this restaurant." }, 404);
  }

  if (kind === "refund") {
    if (payment.status !== "refunded") {
      return json(req, { error: "No refund has been recorded for this payment." }, 404);
    }
    const { data: existing } = await db
      .from("billing_refunds")
      .select("*")
      .eq("payment_id", paymentId)
      .maybeSingle();
    const row = existing ?? await issueRefundDocument(db, tenantId, payment, {});
    if (!row) {
      return json(req, { error: "The refund document is not available just now. Please try again." }, 503);
    }
    // The re-render fallback reconstructs from the immutable row; the
    // snapshot on it keeps even a re-render faithful to the original.
    const bytes = await readStoredPdf(db, row.pdf_path)
      ?? buildRefundPdf(refundFactsFromRow(row, await sellerIdentity(db)));
    return pdfResponse(req, bytes, `Refund-${row.refund_number}.pdf`, download);
  }

  // kind === "invoice". A refunded payment keeps its original invoice —
  // the refund document reverses it, never erases it.
  if (payment.status !== "succeeded" && payment.status !== "refunded") {
    return json(
      req,
      { error: `Invoices are issued for completed payments only (this one is ${payment.status}).` },
      400,
    );
  }
  const { data: existing, error: existingError } = await db
    .from("billing_invoices")
    .select("*")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (existingError) {
    console.error("subscriptions invoice: could not read the invoice", existingError.message);
    return json(req, { error: "Could not read the invoice just now." }, 503);
  }
  const row = existing ?? await issueInvoiceDocument(db, tenantId, payment);
  if (!row) {
    return json(req, { error: "Could not issue the invoice just now. Please try again." }, 503);
  }
  const bytes = await readStoredPdf(db, row.pdf_path)
    ?? buildInvoicePdf(invoiceFactsFromRow(row, await sellerIdentity(db)));
  return pdfResponse(req, bytes, `Invoice-${row.invoice_number}.pdf`, download);
}

function pdfResponse(req: Request, bytes: Uint8Array, filename: string, download: boolean): Response {
  // CORS headers are not optional decoration: the dashboard calls this
  // cross-origin (thesalad.in -> supabase.co), and without them the browser
  // withholds a perfectly good 200 from the fetch - the server logs success
  // while the owner sees "Could not download the invoice".
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
