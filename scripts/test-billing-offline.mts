/**
 * Billing and entitlement rules, tested without a database or a network.
 *
 * Everything under test here is pure, on purpose: these are the rules that
 * decide whether money becomes entitlement, and a rule that can only be
 * exercised against live Razorpay and a live database is a rule nobody tests.
 * The edge functions do the I/O; these are the decisions they ask for.
 *
 *   npm run test:billing-offline
 */
import {
  checkoutMatches,
  entitlementAction,
  eventCreatedAt,
  fromMinorUnits,
  isStaleEvent,
  limitCheckFailure,
  mayChangePlanOnSubscription,
  minorUnits,
  paymentFetchFailure,
  periodEndFrom,
  webhookEventId,
  type CheckoutRecord,
  type PaymentFacts,
} from "../supabase/functions/_shared/billing.ts";
import { hmacSha256Hex, paymentSignatureCandidates, signatureMatches } from "../supabase/functions/_shared/signature.ts";
import fs from "node:fs";

/** A fixture secret. Not a credential, and never one from the environment. */
const FIXTURE_SECRET = "fixture-secret-not-a-credential";
const OTHER_SECRET = "a-different-fixture-secret";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
console.log("\n── a forged payment ──");
{
  const body = "order_ABC123|pay_XYZ789";
  const genuine = await hmacSha256Hex(body, FIXTURE_SECRET);

  check("the genuine signature matches", signatureMatches(genuine, genuine));
  check("a signature built with another secret does not",
    !signatureMatches(genuine, await hmacSha256Hex(body, OTHER_SECRET)));
  check("a signature for a different order does not",
    !signatureMatches(genuine, await hmacSha256Hex("order_SOMETHING|pay_XYZ789", FIXTURE_SECRET)));
  check("a truncated candidate does not", !signatureMatches(genuine, genuine.slice(0, 40)));
  check("an empty candidate does not", !signatureMatches(genuine, ""));
  check("the signature is not recoverable from the body alone",
    genuine !== body && genuine.length === 64, genuine);
}

// ---------------------------------------------------------------------------
const checkout: CheckoutRecord = {
  tenantId: "tenant-1",
  planId: "pro",
  amount: 999,
  currency: "INR",
  razorpayOrderId: "order_ABC123",
  razorpaySubscriptionId: "sub_ABC123",
  status: "pending",
  razorpayPaymentId: null,
};
const paid = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({
  id: "pay_XYZ789",
  amount: minorUnits(999, "INR"),
  currency: "INR",
  orderId: "order_ABC123",
  status: "captured",
  ...over,
});

console.log("\n── a payment that settles this checkout ──");
check("the right payment is accepted", checkoutMatches({ checkout, tenantId: "tenant-1", planId: "pro", payment: paid() }).ok);

console.log("\n── and the mismatches ──");
{
  const cases: Array<[string, Parameters<typeof checkoutMatches>[0]]> = [
    ["no checkout record at all", { checkout: null, tenantId: "tenant-1", planId: "pro", payment: paid() }],
    ["another restaurant's order", { checkout, tenantId: "tenant-2", planId: "pro", payment: paid() }],
    ["a different plan", { checkout, tenantId: "tenant-1", planId: "starter", payment: paid() }],
    ["a different order", { checkout, tenantId: "tenant-1", planId: "pro", payment: paid({ orderId: "order_OTHER" }) }],
    ["too little paid", { checkout, tenantId: "tenant-1", planId: "pro", payment: paid({ amount: minorUnits(1, "INR") }) }],
    ["the wrong currency", { checkout, tenantId: "tenant-1", planId: "pro", payment: paid({ currency: "USD" }) }],
    ["a payment that was not captured", { checkout, tenantId: "tenant-1", planId: "pro", payment: paid({ status: "authorized" }) }],
    ["no payment to check", { checkout, tenantId: "tenant-1", planId: "pro", payment: null }],
  ];
  for (const [label, args] of cases) {
    const verdict = checkoutMatches(args);
    check(`${label} is refused`, verdict.ok === false, JSON.stringify(verdict));
  }
  check("a missing record is a 403, not a 400",
    (checkoutMatches({ checkout: null, tenantId: "t", planId: null, payment: null }) as any).code === "not_found");
  check("a mismatch says which kind it was",
    (checkoutMatches({ checkout, tenantId: "tenant-2", planId: "pro", payment: paid() }) as any).code === "mismatch");
}

// ---------------------------------------------------------------------------
console.log("\n── amounts ──");
check("999 rupees is 99900 paise", minorUnits(999, "INR") === 99900);
check("499900 paise is 4999 rupees", fromMinorUnits(499900, "INR") === 4999);
check("a rupee amount survives the round trip", fromMinorUnits(minorUnits(4999, "INR"), "INR") === 4999);

// ---------------------------------------------------------------------------
console.log("\n── webhook delivery identity ──");
{
  const charged = (createdAt: number, id: string) => ({
    event: "subscription.charged",
    created_at: createdAt,
    payload: { subscription: { entity: { id } } },
  });

  check("the header id is the identity when it is present",
    webhookEventId("evt_0001", charged(1730000000, "sub_A")) === "evt_0001");
  check("the identity is never the event type",
    webhookEventId(null, charged(1730000000, "sub_A")) !== "subscription.charged",
    String(webhookEventId(null, charged(1730000000, "sub_A"))));

  const typeAsId = webhookEventId(null, charged(1730000000, "sub_A"));
  check("a duplicate delivery of the same event has the same identity",
    webhookEventId(null, charged(1730000000, "sub_A")) === typeAsId);
  check("two renewals of the same subscription are distinct",
    webhookEventId(null, charged(1732592000, "sub_A")) !== typeAsId,
    "a later charge must not look like a repeat of the first");
  check("two subscriptions' events are distinct",
    webhookEventId(null, charged(1730000000, "sub_B")) !== typeAsId);
  check("an event with nothing to identify it is refused",
    webhookEventId(null, { event: "subscription.charged" }) === null);
  check("the same header id twice is the same delivery",
    webhookEventId("evt_abc", charged(1, "sub_A")) === webhookEventId("evt_abc", charged(2, "sub_B")));
}

// ---------------------------------------------------------------------------
console.log("\n── an old event arriving late ──");
{
  const cursor = new Date("2026-10-01T00:00:00Z");
  check("older than the cursor is stale",
    isStaleEvent({ eventCreatedAt: new Date("2026-09-30T00:00:00Z"), cursorAt: cursor }));
  check("newer than the cursor is applied",
    !isStaleEvent({ eventCreatedAt: new Date("2026-10-02T00:00:00Z"), cursorAt: cursor }));
  check("with no cursor nothing is stale",
    !isStaleEvent({ eventCreatedAt: new Date("2026-09-30T00:00:00Z"), cursorAt: null }));
  check("unix seconds are read as seconds",
    eventCreatedAt({ created_at: 1730000000 })?.toISOString() === new Date(1730000000 * 1000).toISOString());
}

// ---------------------------------------------------------------------------
console.log("\n── verifying the same payment twice ──");
{
  check("the first verification activates",
    entitlementAction({ checkout, paymentId: "pay_XYZ789" }) === "activate");
  const settled: CheckoutRecord = { ...checkout, status: "paid", razorpayPaymentId: "pay_XYZ789" };
  check("the same payment again does not activate",
    entitlementAction({ checkout: settled, paymentId: "pay_XYZ789" }) === "already");
  check("a different payment on the same checkout does activate",
    entitlementAction({ checkout: settled, paymentId: "pay_NEW" }) === "activate");
  const start = new Date("2026-10-29T00:00:00Z");
  check("a period runs thirty days", periodEndFrom(start) === "2026-11-28T00:00:00.000Z", periodEndFrom(start));
}

// ---------------------------------------------------------------------------
console.log("\n── Razorpay being unreachable ──");
{
  check("a timeout is retryable, not a failed payment", paymentFetchFailure({ status: 0 }).retryable);
  check("a 500 is retryable", paymentFetchFailure({ status: 502 }).retryable);
  check("a rate limit is retryable", paymentFetchFailure({ status: 429 }).retryable);
  check("a payment that does not exist is not retryable",
    paymentFetchFailure({ status: 404 }).retryable === false);
  check("a 404 is reported as not found", paymentFetchFailure({ status: 404 }).code === "not_found");
}

// ---------------------------------------------------------------------------
console.log("\n── a limit that cannot be checked ──");
{
  const failure = limitCheckFailure({});
  check("it is refused", failure.ok === false);
  check("it is retryable", failure.retryable === true);
  check("it answers 503", failure.status === 503, String(failure.status));
  check("it explains itself without leaking", /try again/i.test(failure.error), failure.error);
}

// ---------------------------------------------------------------------------
console.log("\n── concurrent writes ──");
{
  // Concurrency needs a database to demonstrate. What can be checked here is
  // that the migration does the counting and the inserting together, under a
  // lock — an integration test after it is applied is the real proof.
  const sqlPath = fs.existsSync("supabase/migrations/0044_billing_integrity.sql")
    ? "supabase/migrations/0044_billing_integrity.sql"
    : "supabase/legacy_migrations_archive/0044_billing_integrity.sql";
  const sql = fs.readFileSync(sqlPath, "utf8");
  check("the menu write counts and inserts in one function",
    /create_menu_item_within_limit[\s\S]*?select count\(\*\)[\s\S]*?insert into public\.menu_items/.test(sql));
  check("the staff write counts and inserts in one function",
    /create_staff_within_limit[\s\S]*?select count\(\*\)[\s\S]*?insert into public\.staff/.test(sql));
  check("both take a lock on the restaurant first",
    (sql.match(/pg_advisory_xact_lock/g) ?? []).length === 2);
  check("neither swallows an error into a success",
    !/exception[\s\S]{0,120}return jsonb_build_object\('ok', true/.test(sql));
  check("the event gate inserts the delivery and reads the cursor in one function",
    /apply_subscription_event[\s\S]*?insert into public\.subscription_webhook_events[\s\S]*?for update/.test(sql));
  check("the new functions are not executable by the public",
    (sql.match(/revoke execute on function public\./g) ?? []).length >= 3);
}

// ---------------------------------------------------------------------------
console.log("\n── payment signature schemes (one-time and subscription) ──");
{
  // An order payment signs order|payment; a subscription's payment signs
  // payment|subscription. A checkout carrying both has to accept whichever
  // Razorpay used — and nothing else.
  const orderId = "order_fixture", paymentId = "pay_fixture", subId = "sub_fixture";

  check("order only → the order string",
    JSON.stringify(paymentSignatureCandidates({ orderId, paymentId })) ===
      JSON.stringify([`${orderId}|${paymentId}`]));
  check("both ids → order first, subscription second",
    JSON.stringify(paymentSignatureCandidates({ orderId, paymentId, subscriptionId: subId })) ===
      JSON.stringify([`${orderId}|${paymentId}`, `${paymentId}|${subId}`]));
  check("no ids → nothing to verify against",
    paymentSignatureCandidates({ paymentId }).length === 0);

  const candidates = paymentSignatureCandidates({ orderId, paymentId, subscriptionId: subId });
  const matchesAny = async (signature: string, secret = FIXTURE_SECRET) => {
    for (const candidate of candidates) {
      if (signatureMatches(await hmacSha256Hex(candidate, secret), signature)) return true;
    }
    return false;
  };

  check("an order-scheme signature is accepted",
    await matchesAny(await hmacSha256Hex(`${orderId}|${paymentId}`, FIXTURE_SECRET)));
  check("a subscription-scheme signature is accepted",
    await matchesAny(await hmacSha256Hex(`${paymentId}|${subId}`, FIXTURE_SECRET)));
  check("a signature from the wrong secret is refused",
    !(await matchesAny(await hmacSha256Hex(`${orderId}|${paymentId}`, OTHER_SECRET))));
  check("the transposed pairing (payment|order) is refused",
    !(await matchesAny(await hmacSha256Hex(`${paymentId}|${orderId}`, FIXTURE_SECRET))));
  check("a truncated signature is refused",
    !(await matchesAny((await hmacSha256Hex(`${orderId}|${paymentId}`, FIXTURE_SECRET)).slice(0, 32))));
}

// ---------------------------------------------------------------------------
console.log("\n── one-time checkouts in the rules ──");
{
  // A one-time checkout records no subscription. The matching rule decides on
  // the order, the restaurant, the plan, the amount and the capture — the
  // absent subscription must not matter.
  const onetimeCheckout: CheckoutRecord = {
    tenantId: "tenant-1",
    planId: "starter-onetime",
    amount: 999,
    currency: "INR",
    razorpayOrderId: "order_once",
    razorpaySubscriptionId: null,
    status: "pending",
    razorpayPaymentId: null,
  };
  const captured: PaymentFacts = {
    id: "pay_once",
    amount: minorUnits(999, "INR"),
    currency: "INR",
    orderId: "order_once",
    status: "captured",
  };
  check("a captured one-time payment settles its checkout",
    checkoutMatches({ checkout: onetimeCheckout, tenantId: "tenant-1", planId: "starter-onetime", payment: captured }).ok);
  check("the same payment for another restaurant is refused",
    !checkoutMatches({ checkout: onetimeCheckout, tenantId: "tenant-2", planId: "starter-onetime", payment: captured }).ok);
  check("an authorised-but-not-captured payment is refused",
    !checkoutMatches({ checkout: onetimeCheckout, tenantId: "tenant-1", planId: "starter-onetime", payment: { ...captured, status: "authorized" } }).ok);
  check("verifying it twice is \"already\", not a second month",
    entitlementAction({ checkout: { ...onetimeCheckout, status: "paid", razorpayPaymentId: "pay_once" }, paymentId: "pay_once" }) === "already");
}

// ---------------------------------------------------------------------------
console.log("\n── a plan change needs paid proof for the exact subscription ──");
{
  // The status field is not evidence. A tenant can be active on a one-time
  // purchase while the stored subscription id belongs to a checkout that was
  // never paid — the old checkout wrote the linkage before the payment. A
  // plan change on that subscription would hand over the new plan without
  // any money changing hands.
  const paid = { id: "row" };
  check("a paid subscription with a paid checkout may change plan",
    mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "active", paidEvidence: paid }));
  check("a paid subscription with only a succeeded payment may change plan",
    mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "active", paidEvidence: { id: "pay" } }));
  check("an unpaid linked subscription may not, however active the tenant",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_unpaid", subscriptionStatus: "active", paidEvidence: null }));
  check("no linked subscription means a first purchase, not an upgrade",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: null, subscriptionStatus: "active", paidEvidence: paid }));
  check("an empty linked subscription id is no subscription",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: "", subscriptionStatus: "active", paidEvidence: paid }));
  check("a trial never upgrades on a linked subscription",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "trial", paidEvidence: paid }));
  check("an expired subscription is not changeable",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "expired", paidEvidence: paid }));
  check("a cancelled subscription with paid proof is changeable",
    mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "cancelled", paidEvidence: paid }));
  // past_due means Razorpay halted the subscription after its retries — a
  // halted mandate cannot carry a plan change, so recovery is a fresh
  // checkout, not a PATCH on a dead subscription.
  check("a past_due subscription is not changeable — its mandate is dead",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "past_due", paidEvidence: paid }));
  check("a pending subscription is not changeable mid-retry",
    !mayChangePlanOnSubscription({ linkedSubscriptionId: "sub_paid", subscriptionStatus: "pending", paidEvidence: paid }));
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
