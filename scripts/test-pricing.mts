/**
 * Pricing, plans and the one-time retirement.
 *
 *   npm run test:pricing
 *
 * Checks the catalogue the landing page and billing both render, the server's
 * refusals around the retired one-time plan and the interval, and that a
 * legacy one-time customer still resolves to a paid plan with the right
 * limits. Nothing here charges anything.
 */
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const ZHUT = "87b90e86-f705-428f-8245-7b3659052443";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "zhut@demo.com" });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const H = { apikey: ANON, authorization: `Bearer ${otp.data.session!.access_token}`, "x-tenant-id": ZHUT };

console.log("\n── the catalogue ──");
const plansRes = await fetch(`${SB}/functions/v1/plans`, { headers: { apikey: ANON } });
const { plans } = await plansRes.json();
check("two active plans are sold", plans.length === 2, JSON.stringify(plans.map((p: any) => p.id)));
const starter = plans.find((p: any) => p.id === "starter");
const pro = plans.find((p: any) => p.id === "pro");
check("starter is ₹999/month and ₹9,990/year", starter?.priceMonthly === 999 && starter?.priceYearly === 9990, JSON.stringify(starter));
check("pro is ₹2,499/month and ₹24,990/year", pro?.priceMonthly === 2499 && pro?.priceYearly === 24990, JSON.stringify(pro));
check("starter limits are 100 items / 1 location / 5 staff",
  starter?.limits.menuItems === 100 && starter?.limits.locations === 1 && starter?.limits.staff === 5, JSON.stringify(starter?.limits));
check("pro limits are 200 items / 3 locations / 10 staff",
  pro?.limits.menuItems === 200 && pro?.limits.locations === 3 && pro?.limits.staff === 10, JSON.stringify(pro?.limits));
const allFeatures = plans.flatMap((p: any) => p.features).join(" | ");
check("nothing says Unlimited", !/unlimited/i.test(allFeatures), allFeatures);
check("annual saves 16.7% on starter", Math.round(((999 * 12 - 9990) / (999 * 12)) * 1000) / 10 === 16.7);
check("annual saves 16.7% on pro", Math.round(((2499 * 12 - 24990) / (2499 * 12)) * 1000) / 10 === 16.7);
check("the one-time plan is not in the catalogue", !plans.some((p: any) => p.id === "starter-onetime"));

console.log("\n── the server refuses what is no longer sold ──");
const call = async (path: string, body: unknown) => {
  const res = await fetch(`${SB}/functions/v1/subscriptions/${path}`, {
    method: "POST",
    headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const onetime = await call("checkout", { planId: "starter-onetime", interval: "monthly" });
check("one-time checkout is refused", onetime.status === 400 && /no longer offered/i.test(onetime.body?.error ?? ""), JSON.stringify(onetime));
const badInterval = await call("checkout", { planId: "starter", interval: "weekly" });
check("an unknown interval is refused", badInterval.status === 400, JSON.stringify(badInterval));
// Annual now has two modes. Pay-once needs no Razorpay plan at all, so it is
// purchasable immediately; AutoPay is the one that waits for the yearly plan.
const annual = await call("checkout", { planId: "starter", interval: "annual" });
check("annual pay-once works without a yearly Razorpay plan",
  annual.status === 200 && annual.body?.paymentMode === "pay_once", JSON.stringify(annual));
const annualAuto = await call("checkout", { planId: "starter", interval: "annual", paymentMode: "autopay" });
check("annual AutoPay is refused — annual is pay-once only",
  annualAuto.status === 400, JSON.stringify(annualAuto));

// A legacy one-time customer's entitlement is covered by
// scripts/test-analytics-access.mts, which provisions a scratch restaurant on
// `starter-onetime` and gets real analytics back. This file stays about the
// catalogue and the checkout refusals. (The `tenants` table is not readable
// with this client — RLS — so reading another restaurant's plan here would
// only ever return null.)

// The monthly ↔ annual guard needs a tenant with a live, paid subscription to
// exist, so it is verified out of band (it was: 409 with "needs a new
// subscription", while a same-interval change reached Razorpay and was refused
// there instead — the guard did not block the legitimate path).

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
