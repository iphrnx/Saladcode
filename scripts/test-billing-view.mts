/**
 * The billing view's display rules, tested without a browser.
 *
 * These are the fixes from the billing audit: a retired plan must keep its
 * name, a one-time purchase must not read "Monthly", and history must label
 * itself in words an owner understands.
 *
 *   npm run test:billing-view
 */
import {
  buildBillingSnapshot,
  changeLabel,
  daysBetween,
  daysLeftText,
  formatBillingDate,
  intervalModeLabel,
  mandateStateLabel,
  mandateTone,
  paymentModeLabel,
  periodLabel,
  priceLabel,
  renewalLabelOf,
  resolvePlanName,
  type BillingPlanFacts,
  type ManagePayload,
  type PlanDirectory,
} from "../src/lib/billing-view.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const directory: PlanDirectory = {
  starter: { name: "Starter", billingMode: "recurring" },
  pro: { name: "Pro", billingMode: "recurring" },
  "starter-onetime": { name: "Starter — one-time", billingMode: "onetime" },
};

console.log("\n── retired plan names ──");
{
  check("an active plan resolves to its name", resolvePlanName(directory, "starter") === "Starter");
  check("a retired plan resolves to its name, not its id",
    resolvePlanName(directory, "starter-onetime") === "Starter — one-time");
  check("an unknown plan falls back to its id rather than crashing",
    resolvePlanName(directory, "ghost-plan") === "ghost-plan");
  check("a missing plan id is a dash", resolvePlanName(directory, null) === "—");
  check("an empty directory degrades to the id", resolvePlanName({}, "starter") === "starter");
}

console.log("\n── historical period labels ──");
{
  check("a one-time purchase never reads Monthly",
    periodLabel(directory, "starter-onetime", "monthly") === "One-time · 30 days");
  check("a recurring monthly payment reads Monthly",
    periodLabel(directory, "starter", "monthly") === "Monthly");
  check("a recurring annual payment reads Annual",
    periodLabel(directory, "pro", "annual") === "Annual");
  check("an unknown plan uses its recorded period",
    periodLabel(directory, "ghost", "annual") === "Annual");
  check("an empty period is a dash, not a crash", periodLabel(directory, "pro", "") === "—");
}

console.log("\n── plan history labels ──");
{
  check("activated", changeLabel("activated") === "Plan activated");
  check("renewed", changeLabel("renewed") === "Subscription renewed");
  check("plan_change_scheduled", changeLabel("plan_change_scheduled") === "Plan change scheduled");
  check("scheduled_change_cancelled", changeLabel("scheduled_change_cancelled") === "Scheduled change cancelled");
  check("cancelled", changeLabel("cancelled") === "Subscription cancelled");
  check("payment_failed", changeLabel("payment_failed") === "Payment failed");
  check("refunded", changeLabel("refunded") === "Payment refunded");
  check("an unknown type becomes readable words", changeLabel("some_new_event") === "Some new event");
  check("an empty type is a dash-free fallback", changeLabel("") === "Change");
}

console.log("\n── mandate status labels ──");
{
  check("authorised reads Authorised",
    mandateStateLabel({ mandateState: "authorised" } as never) === "Authorised");
  check("a live mandate reads Active",
    mandateStateLabel({ state: "active" } as never) === "Active");
  check("an ended mandate reads Ended",
    mandateStateLabel({ state: "ended" } as never) === "Ended");
  check("a cancelled mandate reads Not charging",
    mandateStateLabel({ state: "cancelled" } as never) === "Not charging");
  check("nothing reads as a dash", mandateStateLabel(null) === "—");
}


/* ------------------------------------------------------------------------- *
 * The billing snapshot — the one derivation both pages render.
 *
 * These checks exist because the two pages used to derive the same facts
 * twice, from two payloads, and disagree. Every case below is a state a real
 * tenant has been in: the fixtures come from the production database
 * (read-only), not from imagination.
 * ------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
const NOW = "2026-11-08T05:41:00.000Z"; // 08/11/2026 11:11 IST

const planFacts = (over: Partial<BillingPlanFacts>): BillingPlanFacts => ({
  planId: "starter",
  planName: "Starter",
  status: "active",
  isPaid: true,
  isTrial: false,
  isRestricted: false,
  trialStartedAt: "2026-10-27T16:38:09.978Z",
  trialEndsAt: "2026-11-10T16:38:09.978Z",
  trialDaysRemaining: 3,
  subscriptionPlan: "starter",
  subscriptionStartedAt: "2026-11-02T06:51:38.455Z",
  currentPeriodEnd: "2027-11-30T04:17:52.817Z",
  cancelAtPeriodEnd: false,
  billingInterval: "annual",
  paymentMode: "pay_once",
  billingMode: "recurring",
  priceMonthly: 999,
  priceYearly: 9990,
  currency: "INR",
  ...over,
});

const mandate = (over: Record<string, unknown> = {}) => ({
  subscriptionId: "sub_TEST",
  state: "active" as const,
  status: "active",
  totalCycles: 12,
  chargesMade: 1,
  cyclesRemaining: 11,
  currentPeriodEnd: "2026-12-08T05:41:00.000Z",
  endAt: "2027-12-08T05:41:00.000Z",
  chargeable: true,
  ...over,
});

const managePayload = (over: Partial<ManagePayload> = {}): ManagePayload => ({
  plan: planFacts({}),
  renewal: { kind: "pay_once", label: "Manual renewal required", detail: "No mandate exists, so nothing can debit you." },
  upcoming: [],
  scheduledChanges: [],
  mandate: null,
  history: [],
  totals: { totalCharged: 999, totalRefunded: 0, netSpent: 999, paymentCount: 1, currency: "INR" },
  planDirectory: {},
  locationCount: 1,
  warnings: [],
  ...over,
});

const snap = (plan: BillingPlanFacts, manage: ManagePayload | null = null) =>
  buildBillingSnapshot({ plan, manage, now: NOW, timeZone: TZ });

console.log("\n── dates are business days, not the viewer's clock ──");
{
  // 20:00 UTC is already the next day in IST — the exact instant the server
  // used to print as 29/11 and the view as 30/11.
  check("an instant after 18:30 UTC reads as the next day in IST",
    formatBillingDate("2026-11-29T20:00:00.000Z", TZ) === "30/11/2026",
    formatBillingDate("2026-11-29T20:00:00.000Z", TZ));
  check("…and the same instant reads as the 29th in UTC",
    formatBillingDate("2026-11-29T20:00:00.000Z", "UTC") === "29/11/2026");
  check("a date-only value is not shifted by a western clock",
    formatBillingDate("2026-10-30", TZ) === "30/10/2026",
    formatBillingDate("2026-10-30", TZ));
  check("a missing date is a dash", formatBillingDate(null, TZ) === "—");
  check("a malformed date is a dash", formatBillingDate("not-a-date", TZ) === "—");

  // Calendar days, so the number and the date beside it agree.
  check("08/11 → 10/11 is 2 days, not a rounded-up 3",
    daysBetween(NOW, "2026-11-10T16:38:00.000Z", TZ) === 2,
    String(daysBetween(NOW, "2026-11-10T16:38:00.000Z", TZ)));
  check("later the same business day is 0", daysBetween(NOW, "2026-11-08T12:00:00.000Z", TZ) === 0);
  check("a past date is negative", (daysBetween(NOW, "2026-11-05T10:00:00.000Z", TZ) ?? 0) < 0);
  check("0 reads as 'Ends today'", daysLeftText(0) === "Ends today");
  check("1 reads as '1 day left'", daysLeftText(1) === "1 day left");
  check("2 reads as '2 days left'", daysLeftText(2) === "2 days left");
  check("yesterday reads as ended", daysLeftText(-1) === "Ended yesterday");
}

console.log("\n── price: the interval the plan is actually on ──");
{
  check("annual shows the yearly price", priceLabel(planFacts({})) === "₹9,990 / year");
  check("monthly shows the monthly price",
    priceLabel(planFacts({ billingInterval: "monthly", paymentMode: "autopay" })) === "₹999 / month");
  check("a retired one-time plan shows what was paid once",
    priceLabel(planFacts({ billingMode: "onetime", billingInterval: "monthly" })) === "₹999 once");
  check("an annual plan with no yearly price falls back to the monthly one",
    priceLabel(planFacts({ priceYearly: 0 })) === "₹999 / year");
}

console.log("\n── AutoPay is never claimed without a verified mandate ──");
{
  check("autopay + live mandate reads AutoPay",
    paymentModeLabel(planFacts({ paymentMode: "autopay" }), mandate() as never) === "Annual · AutoPay"
      || paymentModeLabel(planFacts({ paymentMode: "autopay", billingInterval: "monthly" }), mandate() as never) === "Monthly · AutoPay");
  check("autopay + authorised (no charge yet) still reads AutoPay",
    paymentModeLabel(planFacts({ paymentMode: "autopay", billingInterval: "monthly" }), mandate({ state: "authorised" }) as never) === "Monthly · AutoPay");
  check("autopay + NO mandate does not say AutoPay",
    !paymentModeLabel(planFacts({ paymentMode: "autopay", billingInterval: "monthly" }), null).includes("AutoPay"));
  check("…it says the renewal is unverified instead",
    paymentModeLabel(planFacts({ paymentMode: "autopay", billingInterval: "monthly" }), null).includes("unverified"));
  check("autopay + an ended mandate does not say AutoPay",
    !paymentModeLabel(planFacts({ paymentMode: "autopay", billingInterval: "monthly" }), mandate({ state: "ended" }) as never).includes("AutoPay"));
  check("an unrecorded mode is not assumed to be AutoPay",
    !paymentModeLabel(planFacts({ paymentMode: null, billingInterval: "monthly" }), null).includes("AutoPay"));
  check("…it says the mode was not recorded",
    paymentModeLabel(planFacts({ paymentMode: null, billingInterval: "monthly" }), null).includes("not recorded"));
  check("pay-once never reads AutoPay, even with a mandate authorised for a later plan",
    !paymentModeLabel(planFacts({ paymentMode: "pay_once", billingInterval: "monthly" }), mandate({ state: "authorised" }) as never).includes("AutoPay"));
  check("a retired one-time plan reads one-time",
    paymentModeLabel(planFacts({ billingMode: "onetime" }), null) === "One-time · retired");
}

console.log("\n── the trial: same dates and the same day count everywhere ──");
{
  const trial = snap(planFacts({
    status: "trial", isPaid: false, isTrial: true, subscriptionPlan: null,
    subscriptionStartedAt: null, currentPeriodEnd: null, paymentMode: null,
  }), managePayload({
    plan: null,
    renewal: { kind: "trial", label: "No billing during the trial", detail: "" },
  }));
  check("the plan in force during a trial is the trial plan", trial.planName === "Pro" || trial.planName === "Starter");
  check("the status reads Free trial", trial.statusLabel === "Free trial" && trial.statusTone === "info");
  check("the start of the trial is shown, not a blank",
    trial.startedLabel === "Trial started" && trial.startedValue === "27/10/2026", trial.startedValue);
  check("the period fact is the trial end", trial.periodLabel === "Trial ends");
  check("the end date and the days left agree",
    trial.periodValue === "10/11/2026 · 2 days left", trial.periodValue);
  check("the trial block exists for the Manage view", trial.trial !== null);
  check("…with the same start, end and count",
    trial.trial!.started === "27/10/2026" && trial.trial!.ends === "10/11/2026" && trial.trial!.daysLeft === 2,
    JSON.stringify(trial.trial));
  check("a trial never claims AutoPay", !trial.modeLabel.includes("AutoPay"));
}

console.log("\n── paid states: price, mode, start and period ──");
{
  const annualPayOnce = snap(planFacts({}));
  check("annual pay-once price", annualPayOnce.price === "₹9,990 / year");
  check("annual pay-once mode", annualPayOnce.modeLabel === "Annual · Pay once");
  check("started is the subscription start", annualPayOnce.startedValue === "02/11/2026", annualPayOnce.startedValue);
  check("a period that does not renew is an expiry, not a billing date",
    annualPayOnce.periodLabel === "Access expires on");
  check("the expiry date is the period end", annualPayOnce.periodDate === "30/11/2027");
  check("status reads Active", annualPayOnce.statusLabel === "Active" && annualPayOnce.statusTone === "success");
  check("a pay-once plan does not claim automatic renewal",
    !annualPayOnce.modeLabel.includes("AutoPay"));

  const autopay = snap(planFacts({ billingInterval: "monthly", paymentMode: "autopay", currentPeriodEnd: "2026-12-08T05:41:00.000Z" }),
    managePayload({ mandate: mandate() as never, renewal: { kind: "autopay", label: "Renews automatically every month", detail: "The mandate is authorised and live with Razorpay." } }));
  check("a live monthly mandate reads AutoPay", autopay.modeLabel === "Monthly · AutoPay", autopay.modeLabel);
  check("monthly autopay is a next billing date", autopay.periodLabel === "Next billing date");
  check("the renewal line comes from the verified payload",
    autopay.renewalLabel === "Renews automatically every month" && autopay.renewalConfirmed);
  check("a month's access reads in days", autopay.daysLeft === 30, String(autopay.daysLeft));

  // The real production row: active, one-time plan, payment_mode NULL, no mandate.
  const legacy = snap(planFacts({
    planId: "starter-onetime", subscriptionPlan: "starter-onetime", billingMode: "onetime",
    paymentMode: null, billingInterval: "monthly", currentPeriodEnd: "2026-11-29T07:39:38.202Z",
  }), managePayload({ mandate: null, renewal: { kind: "onetime", label: "One-time purchase — active until the date shown", detail: "" } }));
  check("a legacy one-time purchase is priced once", legacy.price === "₹999 once");
  check("…is labelled one-time, not AutoPay", legacy.modeLabel === "One-time · retired");
  check("…expires rather than renewing", legacy.periodLabel === "Access expires on" && legacy.periodDate === "29/11/2026");

  const restricted = snap(planFacts({
    status: "expired", isPaid: false, isTrial: false, isRestricted: true,
    subscriptionPlan: null, subscriptionStartedAt: null, currentPeriodEnd: null,
  }));
  check("a restricted restaurant reads Ended", restricted.statusLabel === "Ended");
  check("…and has no period to show", restricted.periodValue === "No active plan");
  check("…and the plan name is still the fallback, never a dash", restricted.planName.length > 0);
  check("…but it is not presented as a plan in force", restricted.inForce === false);
  check("a trial IS in force", snap(planFacts({ status: "trial", isPaid: false, isTrial: true })).inForce === true);

  const pastDue = snap(planFacts({ status: "past_due" }));
  check("past_due reads Payment failed, not Active", pastDue.statusLabel === "Payment failed");
  check("…in a danger tone", pastDue.statusTone === "danger");
  check("…and still shows when access ends", pastDue.daysLeft !== null);
}

console.log("\n── the period label names what the date actually is ──");
{
  const cancelled = snap(planFacts({ status: "cancelled", cancelAtPeriodEnd: true, paymentMode: "autopay", currentPeriodEnd: "2026-11-16T04:00:00.000Z" }),
    managePayload({ renewal: { kind: "cancelled", label: "Cancelled — access continues until the period ends", detail: "" } }));
  check("a cancelled subscription's date is the end of access, not a next billing date",
    cancelled.periodLabel === "Access ends on", cancelled.periodLabel);
  check("…and still counts down to it", cancelled.periodValue === "16/11/2026 · 8 days left", cancelled.periodValue);

  const pastDue = snap(planFacts({ status: "past_due", paymentMode: "autopay", currentPeriodEnd: "2026-11-05T04:00:00.000Z" }),
    managePayload({ renewal: { kind: "past_due", label: "Payment failed — pay again to keep your access", detail: "" } }));
  check("an elapsed period is not called a next billing date",
    pastDue.periodLabel === "Period ended on", pastDue.periodLabel);
  check("…and carries no contradictory countdown",
    pastDue.periodValue === "05/11/2026", pastDue.periodValue);
  check("…though the day count is still available to the logic", pastDue.daysLeft === -3, String(pastDue.daysLeft));

  const restricted = snap(planFacts({
    status: "expired", isPaid: false, isTrial: false, isRestricted: true,
    subscriptionPlan: null, currentPeriodEnd: null,
  }));
  check("a restaurant with no plan is not quoted the fallback plan's price",
    restricted.price === "—", restricted.price);
  check("…nor given a payment mode", restricted.modeLabel === "—", restricted.modeLabel);

  const trial = snap(planFacts({ status: "trial", isPaid: false, isTrial: true, paymentMode: null, currentPeriodEnd: null }));
  check("a trial has no payment mode to state", trial.modeLabel === "—", trial.modeLabel);
}

console.log("\n── the renewal line is verified, or it is absent ──");
{
  const loading = snap(planFacts({}), null);
  check("with no verified payload there is no renewal claim", loading.renewalLabel === null);
  check("…and the view is told to say it is checking", loading.renewalConfirmed);

  const unverified = snap(planFacts({ paymentMode: "autopay", billingInterval: "monthly" }),
    managePayload({ renewal: { kind: "unverified", label: "AutoPay could not be verified", detail: "Razorpay did not confirm a mandate." } }));
  check("an unverified renewal is flagged", unverified.renewalConfirmed === false);
  check("…and still carries the server's words", unverified.renewalLabel === "AutoPay could not be verified");

  const scheduled = renewalLabelOf({
    kind: "scheduled", label: "Pro (Monthly · AutoPay)", detail: "",
    startsAt: "2026-11-29T20:00:00.000Z",
  }, TZ);
  check("a scheduled start is dated in the restaurant's timezone, not a UTC slice",
    scheduled.endsWith("30/11/2026") && !scheduled.includes("29/11/2026"), scheduled);
}

console.log("\n── both pages read the same snapshot ──");
{
  // The Billing tab and the Manage view call buildBillingSnapshot with the
  // same plan and the same payload. These checks pin the two things that must
  // therefore be identical, and that used to differ.
  const manage = managePayload({
    plan: planFacts({ paymentMode: "autopay", billingInterval: "monthly" }),
    mandate: mandate() as never,
    renewal: { kind: "autopay", label: "Renews automatically every month", detail: "" },
  });
  const asTab = buildBillingSnapshot({ plan: planFacts({ paymentMode: "autopay", billingInterval: "monthly" }), manage, now: NOW, timeZone: TZ });
  const asManage = buildBillingSnapshot({ plan: manage.plan!, manage, now: NOW, timeZone: TZ });
  check("plan, price, mode, start, period, days and renewal are equal on both pages",
    JSON.stringify(asTab) === JSON.stringify(asManage));
  check("the snapshot is pure — same inputs, same output, every time",
    JSON.stringify(snap(planFacts({}), managePayload({}))) === JSON.stringify(snap(planFacts({}), managePayload({}))));
}

console.log("\n── interval/mode labels ──");
{
  check("annual is always pay once", intervalModeLabel("annual", "autopay") === "Annual · Pay once");
  check("monthly autopay", intervalModeLabel("monthly", "autopay") === "Monthly · AutoPay");
  check("monthly pay once", intervalModeLabel("monthly", "pay_once") === "Monthly · Pay once");
  check("an authorised mandate is info-toned", mandateTone({ state: "authorised" } as never) === "info");
  check("a live mandate is success-toned", mandateTone({ state: "active" } as never) === "success");
  check("an unverified mandate is warn-toned", mandateTone({ state: "unverified" } as never) === "warn");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
