/**
 * The Manage Billing rules, tested without a database or a network.
 *
 * These are the decisions that decide what an owner is told about their
 * money: when renewal is manual, what happens next, which mandates count as
 * verified, and what a payment history adds up to. A wrong answer here is
 * how a restaurant gets told to pay twice — so the rules are pure and every
 * path is exercised.
 *
 *   npm run test:billing-manage
 */
import {
  buildRenewal,
  buildUpcoming,
  classifyMandate,
  directoryFrom,
  intervalModeLabel,
  isCandidateScheduledCheckout,
  nextScheduled,
  summariseTotals,
  type LiveMandate,
  type ManagePlan,
  type ScheduledChange,
} from "../supabase/functions/_shared/billing-manage.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const plan = (over: Partial<ManagePlan>): ManagePlan => ({
  planId: "starter",
  planName: "Starter",
  status: "active",
  isPaid: true,
  isTrial: false,
  isRestricted: false,
  billingInterval: "annual",
  paymentMode: "pay_once",
  billingMode: "recurring",
  currentPeriodEnd: "2027-11-30T04:17:52.000Z",
  cancelAtPeriodEnd: false,
  priceMonthly: 999,
  priceYearly: 9990,
  currency: "INR",
  ...over,
});

const scheduled = (over: Partial<ScheduledChange>): ScheduledChange => ({
  checkoutId: "co-1",
  planId: "pro",
  planName: "Pro",
  interval: "monthly",
  paymentMode: "autopay",
  amount: 2499,
  currency: "INR",
  scheduledStartAt: "2027-11-30T04:17:52.000Z",
  mandateId: "sub_TEST",
  mandateState: "authorised",
  ...over,
});

const mandate = (over: Partial<LiveMandate>): LiveMandate => ({
  subscriptionId: "sub_LIVE",
  state: "active",
  status: "active",
  totalCycles: 12,
  chargesMade: 2,
  cyclesRemaining: 10,
  currentPeriodEnd: "2026-12-02T06:51:38.000Z",
  endAt: "2027-12-02T06:51:38.000Z",
  chargeable: true,
  ...over,
});

// ---------------------------------------------------------------------------
console.log("\n── mandate classification ──");
{
  check("active with cycles left is active", classifyMandate("active", 5) === "active");
  check("active with no cycles left has ended", classifyMandate("active", 0) === "ended");
  check("authenticated is authorised, never a payment", classifyMandate("authenticated", 12) === "authorised");
  check("authenticated with nothing left has ended", classifyMandate("authenticated", 0) === "ended");
  check("created is unverified — an abandoned checkout, not a mandate",
    classifyMandate("created", 12) === "unverified");
  check("cancelled is cancelled", classifyMandate("cancelled", 8) === "cancelled");
  check("completed is cancelled", classifyMandate("completed", 0) === "cancelled");
  check("expired is cancelled", classifyMandate("expired", 4) === "cancelled");
  check("halted is cancelled", classifyMandate("halted", 4) === "cancelled");
  check("an unknown status is unverified", classifyMandate("mystery", 4) === "unverified");
  check("no status at all is unverified", classifyMandate(null, null) === "unverified");
}

// ---------------------------------------------------------------------------
console.log("\n── renewal text: the 'manual renewal' lie ──");
{
  const annualPayOnce = plan({});
  check("annual pay-once with nothing scheduled renews manually",
    buildRenewal(annualPayOnce, [], null).label === "Manual renewal required");

  const withScheduled = buildRenewal(annualPayOnce, [scheduled({})], null);
  check("a verified scheduled change replaces 'manual renewal'",
    !withScheduled.label.includes("Manual"));
  check("…is tagged as a scheduled change", withScheduled.kind === "scheduled");
  check("…names the plan and its interval",
    withScheduled.label.includes("Pro") && withScheduled.label.includes("Monthly"));
  check("…and ships the start instant instead of formatting a date on the server",
    withScheduled.startsAt === scheduled({}).scheduledStartAt, String(withScheduled.startsAt));
  check("…so no UTC date can leak into the label",
    !/\d{2}\/\d{2}\/\d{4}/.test(withScheduled.label), withScheduled.label);
  check("…and promises nothing is charged before the start date",
    withScheduled.detail.includes("nothing") || withScheduled.detail.includes("Nothing"));

  const monthlyAutopay = buildRenewal(
    plan({ billingInterval: "monthly", paymentMode: "autopay" }), [], mandate({}),
  );
  check("a live monthly mandate renews automatically",
    monthlyAutopay.label.includes("automatically"));

  const cancelled = buildRenewal(plan({ cancelAtPeriodEnd: true }), [], null);
  check("a cancelled subscription says access continues to the period end",
    cancelled.label.includes("access continues"));
  check("…and is honest that Razorpay cannot resume it",
    cancelled.detail.includes("cannot resume"));

  check("past_due asks for payment, not renewal",
    buildRenewal(plan({ status: "past_due" }), [], null).label.includes("Payment failed"));
  check("a retry in flight says so",
    buildRenewal(plan({ status: "pending" }), [], null).label.includes("retried"));
  check("a trial has no billing",
    buildRenewal(plan({ isPaid: false, isTrial: true, status: "trial" }), [], null).label.includes("trial"));
  check("a restricted restaurant is told to pick a plan",
    buildRenewal(plan({ isPaid: false, isRestricted: true, status: "expired" }), [], null).label.includes("pick a plan"));
  check("a retired one-time plan simply ends",
    buildRenewal(plan({ billingMode: "onetime", paymentMode: null }), [], null).label.includes("One-time purchase"));
  check("an exhausted mandate asks for a new authorisation",
    buildRenewal(plan({ billingInterval: "monthly", paymentMode: "autopay" }), [], mandate({ state: "ended" })).label.includes("exhausted"));
}

// ---------------------------------------------------------------------------
console.log("\n── AutoPay is never claimed without a verified mandate ──");
{
  const autopayNoMandate = buildRenewal(
    plan({ billingInterval: "monthly", paymentMode: "autopay" }), [], null,
  );
  check("autopay with no mandate is not called an automatic renewal",
    !autopayNoMandate.label.toLowerCase().includes("automatically"), autopayNoMandate.label);
  check("…and says so plainly", autopayNoMandate.label.includes("could not be verified"));
  check("…with the unverified kind, so the view can warn",
    autopayNoMandate.kind === "unverified");
  check("…and never claims AutoPay is on", !autopayNoMandate.detail.includes("AutoPay is on"));

  const unrecordedMode = buildRenewal(
    plan({ billingInterval: "monthly", paymentMode: null }), [], null,
  );
  check("an unrecorded payment mode is not assumed to renew",
    !unrecordedMode.label.toLowerCase().includes("automatically"), unrecordedMode.label);
  check("…it asks for confirmation instead", unrecordedMode.kind === "unverified");

  const noModeButLiveMandate = buildRenewal(
    plan({ billingInterval: "monthly", paymentMode: null }), [], mandate({}),
  );
  check("a live mandate does justify automatic renewal",
    noModeButLiveMandate.kind === "autopay" && noModeButLiveMandate.label.includes("automatically"));

  const annualLive = buildRenewal(
    plan({ billingInterval: "annual", paymentMode: "autopay" }), [], mandate({}),
  );
  check("an annual mandate renews yearly, not monthly",
    annualLive.label.includes("year"), annualLive.label);

  const payOnceWithMandate = buildRenewal(
    plan({ billingInterval: "monthly", paymentMode: "pay_once" }), [], mandate({}),
  );
  check("a pay-once period stays manual even if a mandate exists for later",
    payOnceWithMandate.kind === "pay_once", payOnceWithMandate.kind);
}

// ---------------------------------------------------------------------------
console.log("\n── the next scheduled change is the earliest one, not the newest one ──");
{
  const january = scheduled({ checkoutId: "co-jan", scheduledStartAt: "2027-01-15T00:00:00.000Z" });
  const march = scheduled({ checkoutId: "co-mar", scheduledStartAt: "2027-03-15T00:00:00.000Z" });
  check("the earliest start is selected whichever order they arrive in",
    nextScheduled([march, january])?.checkoutId === "co-jan");
  check("no candidates is not a crash", nextScheduled([]) === null);
  check("the renewal names the earliest change",
    buildRenewal(plan({}), [march, january], null).startsAt === january.scheduledStartAt);
}

// ---------------------------------------------------------------------------
console.log("\n── upcoming billing ──");
{
  const annualPayOnce = plan({});
  const nothingScheduled = buildUpcoming(annualPayOnce, [], null);
  check("annual pay-once shows a renewal due at the period end",
    nothingScheduled.some((i) => i.kind === "renewal-due" && i.amount === 9990 && i.date === annualPayOnce.currentPeriodEnd));
  check("…and warns access ends without it",
    nothingScheduled.some((i) => i.kind === "end"));

  const withScheduled = buildUpcoming(annualPayOnce, [scheduled({})], null);
  check("a scheduled AutoPay change is one row, not two",
    withScheduled.filter((i) => i.date === scheduled({}).scheduledStartAt && i.label.includes("Pro")).length === 1,
    JSON.stringify(withScheduled.map((i) => i.kind)));
  check("…with the start date and the amount it will take",
    withScheduled.some((i) => i.date === scheduled({}).scheduledStartAt && i.amount === 2499));
  check("…marked as money moving, because the mandate debits it",
    withScheduled.some((i) => i.date === scheduled({}).scheduledStartAt && i.kind === "debit"));
  check("…and no manual renewal nag once the future is arranged",
    !withScheduled.some((i) => i.kind === "renewal-due"));

  const monthly = buildUpcoming(
    plan({ billingInterval: "monthly", paymentMode: "autopay" }), [], mandate({}),
  );
  check("a live monthly mandate shows the next debit with amount and date",
    monthly.some((i) => i.kind === "debit" && i.amount === 999 && i.date === mandate({}).currentPeriodEnd));

  const cancelled = buildUpcoming(plan({ cancelAtPeriodEnd: true }), [], null);
  check("a cancelled subscription shows only the end of access",
    cancelled.length === 1 && cancelled[0].kind === "end");
  check("…and never a debit", !cancelled.some((i) => i.kind === "debit"));

  check("a trial shows nothing", buildUpcoming(plan({ isPaid: false, isTrial: true, status: "trial" }), [], null).length === 0);

  const twoSchedules = buildUpcoming(annualPayOnce, [scheduled({}), scheduled({ checkoutId: "co-2" })], null);
  check("two distinct schedules are both shown — hiding a real mandate is how double-debits surprise people",
    twoSchedules.filter((i) => i.label.includes("Pro")).length === 2);

  const ordered = buildUpcoming(annualPayOnce, [
    scheduled({ checkoutId: "co-late", scheduledStartAt: "2027-12-01T00:00:00.000Z" }),
    scheduled({ checkoutId: "co-early", scheduledStartAt: "2027-06-01T00:00:00.000Z" }),
  ], null);
  check("upcoming items are in date order, soonest first",
    ordered[0].date === "2027-06-01T00:00:00.000Z", String(ordered[0]?.date));
  check("…every item carries a date",
    ordered.every((i) => typeof i.date === "string"));
}

// ---------------------------------------------------------------------------
console.log("\n── totals: only money that moved counts ──");
{
  const totals = summariseTotals([
    { amount: 9990, currency: "INR", status: "succeeded" },
    { amount: 999, currency: "INR", status: "succeeded" },
    { amount: 2499, currency: "INR", status: "failed" },
    { amount: 999, currency: "INR", status: "refunded" },
  ]);
  check("failed attempts are not money", totals.totalCharged === 9990 + 999 + 999, String(totals.totalCharged));
  check("refunds are counted separately", totals.totalRefunded === 999);
  check("net is charged minus refunded", totals.netSpent === 9990 + 999, String(totals.netSpent));
  check("refunded payments still count as payments", totals.paymentCount === 3);
  check("an empty ledger is zero, not an error",
    summariseTotals([]).netSpent === 0 && summariseTotals([]).paymentCount === 0);
  check("string amounts from the database still sum",
    summariseTotals([{ amount: "9990.00", currency: "INR", status: "succeeded" }]).netSpent === 9990);
}

// ---------------------------------------------------------------------------
console.log("\n── scheduled-change candidates ──");
{
  const future = Date.now() + 86_400_000;
  const row = (over: object) => ({
    status: "pending",
    razorpay_subscription_id: "sub_X",
    scheduled_start_at: new Date(future).toISOString(),
    ...over,
  });
  check("a pending future mandate checkout is a candidate", isCandidateScheduledCheckout(row({}), Date.now()));
  check("a paid checkout is not — it is a purchase", !isCandidateScheduledCheckout(row({ status: "paid" }), Date.now()));
  check("a checkout without a mandate is not", !isCandidateScheduledCheckout(row({ razorpay_subscription_id: null }), Date.now()));
  check("a checkout without a start date is not", !isCandidateScheduledCheckout(row({ scheduled_start_at: null }), Date.now()));
  check("a start date in the past is not — it has started",
    !isCandidateScheduledCheckout(row({ scheduled_start_at: new Date(Date.now() - 1000).toISOString() }), Date.now()));
}

// ---------------------------------------------------------------------------
console.log("\n── the plan directory covers retired plans ──");
{
  const dir = directoryFrom([
    { id: "starter", name: "Starter", billing_mode: "recurring" },
    { id: "starter-onetime", name: "Starter — one-time", billing_mode: "onetime" },
  ]);
  check("a retired plan keeps its name", dir["starter-onetime"].name === "Starter — one-time");
  check("…and its one-time mode", dir["starter-onetime"].billingMode === "onetime");
  check("a recurring plan reads as recurring", dir["starter"].billingMode === "recurring");
  check("a missing mode is recurring, not onetime", directoryFrom([{ id: "x", name: "X" }])["x"].billingMode === "recurring");
}


console.log("\n── interval/mode text ──");
{
  check("annual is always pay once", intervalModeLabel("annual", "autopay") === "Annual · Pay once");
  check("monthly autopay", intervalModeLabel("monthly", "autopay") === "Monthly · AutoPay");
  check("monthly pay once", intervalModeLabel("monthly", "pay_once") === "Monthly · Pay once");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
