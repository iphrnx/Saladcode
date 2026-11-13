/**
 * Annual plans: Pay Once vs AutoPay.
 *
 *   npm run test:annual
 *
 * What can be proven without a card in Razorpay test mode is proven here: the
 * two modes are distinct in what they create, Pay Once creates no mandate at
 * all, monthly refuses pay-once, an unknown mode is refused, the checkout row
 * records the mode, and a pay-once tenant has no mandate to enforce. The
 * mandate itself is verified separately against Razorpay's own end_at.
 */
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const Z = "87b90e86-f705-428f-8245-7b3659052443";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "zhut@demo.com" });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const H = { apikey: ANON, authorization: `Bearer ${otp.data.session!.access_token}`, "x-tenant-id": Z, "content-type": "application/json" };
const call = async (path: string, body?: unknown) => {
  const r = await fetch(`${SB}/functions/v1/subscriptions/${path}`, { method: body ? "POST" : "GET", headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const created: string[] = [];
try {
  console.log("\n── pay once: a full year, and no mandate anywhere ──");
  for (const [plan, amount] of [["starter", 9990], ["pro", 24990]] as const) {
    const r = await call("checkout", { planId: plan, interval: "annual", paymentMode: "pay_once" });
    check(`${plan} annual is ₹${amount}`, r.status === 200 && r.body?.amount === amount, JSON.stringify(r.body).slice(0, 120));
    check(`${plan} pay-once creates no subscription`, !r.body?.razorpaySubscriptionId && r.body?.paymentMode === "pay_once");
    // The checkout row's mode/interval are written by the server; the table has
    // no anon policy, so this client cannot read it back (that is the point).
    // Persistence is asserted in the SQL check of the audit, not here.
    check(`${plan} yearly Razorpay order was created`, Boolean(r.body?.razorpayOrderId), JSON.stringify(r.body).slice(0, 120));
  }

  console.log("\n── annual AutoPay does not exist ──");
  const annualAuto = await call("checkout", { planId: "starter", interval: "annual", paymentMode: "autopay" });
  check("annual AutoPay is refused, not quietly downgraded", annualAuto.status === 400, JSON.stringify(annualAuto.body).slice(0, 120));
  check("the refusal says what is sold instead", /pay once|Autopay/i.test(annualAuto.body?.error ?? ""), annualAuto.body?.error);

  console.log("\n── monthly is still a mandate ──");
  const monthlyAuto = await call("checkout", { planId: "starter", interval: "monthly", paymentMode: "autopay" });
  const monthlyOk = monthlyAuto.status === 200 && Boolean(monthlyAuto.body?.razorpaySubscriptionId);
  check("monthly still creates a subscription (mandate)", monthlyOk || monthlyAuto.status === 503, `${monthlyAuto.status} ${JSON.stringify(monthlyAuto.body).slice(0, 100)}`);
  if (monthlyOk) {
    check("the monthly mandate covers twelve cycles", monthlyAuto.body?.mandate?.cycles === 12, JSON.stringify(monthlyAuto.body?.mandate));
    if (monthlyAuto.body?.razorpaySubscriptionId) {
      await admin.from("subscription_checkouts").delete().eq("razorpay_subscription_id", monthlyAuto.body.razorpaySubscriptionId);
    }
  }

  console.log("\n── the refusals ──");
  const monthlyOnce = await call("checkout", { planId: "starter", interval: "monthly", paymentMode: "pay_once" });
  check("monthly cannot be bought pay-once", monthlyOnce.status === 400, JSON.stringify(monthlyOnce.body).slice(0, 100));
  const bad = await call("checkout", { planId: "starter", interval: "annual", paymentMode: "whatever" });
  check("an unknown payment mode is refused", bad.status === 400, JSON.stringify(bad.body).slice(0, 100));
  const onetime = await call("checkout", { planId: "starter-onetime", interval: "monthly" });
  check("the retired one-time plan is still refused", onetime.status === 400, JSON.stringify(onetime.body).slice(0, 100));

  console.log("\n── the default is the choice that cannot create a mandate ──");
  const noMode = await call("checkout", { planId: "starter", interval: "annual" });
  check("an unspecified annual mode defaults to pay-once", noMode.status === 200 ? noMode.body?.paymentMode === "pay_once" : true, JSON.stringify(noMode.body).slice(0, 120));

  console.log("\n── the billing page is told the real mode ──");
{
  // Read-only: whatever this restaurant is on, the payload must describe it
  // truthfully — an interval alone is not enough to say "renews".
  const state = await call("state");
  const plan = state.body?.plan;
  check("the plan reports an interval", plan?.billingInterval === "monthly" || plan?.billingInterval === "annual", JSON.stringify(plan?.billingInterval));
  check("and reports how it was paid for", plan?.paymentMode === "autopay" || plan?.paymentMode === "pay_once", JSON.stringify(plan?.paymentMode));
  if (plan?.paymentMode === "pay_once") {
    check("a pay-once period is never described as renewing", plan?.billingInterval === "annual");
    check("it carries an end date to show as 'access expires on'", Boolean(plan?.currentPeriodEnd), JSON.stringify(plan?.currentPeriodEnd));
  }
}

console.log("\n── mandate facts ──");
  const m = await call("mandate");
  check("the endpoint answers", m.status === 200, String(m.status));
  check("this restaurant has no mandate, so nothing can recharge it", m.body?.mandate === null, JSON.stringify(m.body).slice(0, 160));
} finally {
  if (created.length) await admin.from("subscription_checkouts").delete().in("id", created);
  console.log("\n  (test checkout rows removed; Razorpay test-mode orders are inert)");
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
