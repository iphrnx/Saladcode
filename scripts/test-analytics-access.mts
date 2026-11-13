/**
 * Who gets Advanced Analytics.
 *
 *   npm run test:analytics
 *
 * Proves the gate is the plan's entitlement, not its name: Starter monthly and
 * annual both get the advanced half, a legacy one-time Starter keeps it while
 * paid, a plan with the entitlement removed loses it, and an expired trial
 * gets nothing. Scratch restaurants are created and removed by the run.
 */
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};

const stamp = Date.now();
const tenant = (await admin.from("tenants").insert({
  name: `Analytics ${stamp}`, slug: `analytics-${stamp}`, plan: "starter",
  currency: "INR", currency_symbol: "₹", active: true, subscription_status: "active",
}).select("id").single()).data!;
const email = `analytics-${stamp}@example.com`;
const user = (await admin.auth.admin.createUser({ email, email_confirm: true })).data.user!;
await admin.from("profiles").insert({ id: user.id, tenant_id: tenant.id, name: "Analytics Owner", email, role: "Owner", active: true });

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const token = otp.data.session!.access_token;

const analytics = async () => {
  const r = await fetch(`${SB}/functions/v1/analytics`, { headers: { apikey: ANON, authorization: `Bearer ${token}`, "x-tenant-id": tenant.id } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const setTenant = (patch: Record<string, unknown>) => admin.from("tenants").update(patch).eq("id", tenant.id);
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

try {
  console.log("\n── Starter monthly ──");
  await setTenant({ plan: "starter", subscription_plan: "starter", subscription_status: "active", billing_interval: "monthly", payment_mode: "autopay", current_period_end: future(30) });
  let a = await analytics();
  check("advanced is on", a.body?.advanced === true, String(a.body?.advanced));
  check("Sales by Hour is populated (24 buckets)", Array.isArray(a.body?.hourly) && a.body.hourly.length === 24, JSON.stringify(a.body?.hourly)?.slice(0, 40));
  check("Order Types is populated", Array.isArray(a.body?.typeBreakdown));
  check("Today's Revenue is served", typeof a.body?.todaysRevenue === "number");
  check("Top Tables is served", Array.isArray(a.body?.topTables));

  console.log("\n── Starter annual (pay once) ──");
  await setTenant({ plan: "starter", subscription_plan: "starter", subscription_status: "active", billing_interval: "annual", payment_mode: "pay_once", current_period_end: future(365) });
  a = await analytics();
  check("advanced is on", a.body?.advanced === true, String(a.body?.advanced));
  check("Sales by Hour is populated", Array.isArray(a.body?.hourly) && a.body.hourly.length === 24);
  check("Order Types is populated", Array.isArray(a.body?.typeBreakdown));

  console.log("\n── legacy one-time Starter, still paid ──");
  await setTenant({ plan: "starter-onetime", subscription_plan: "starter-onetime", subscription_status: "active", current_period_end: future(10) });
  a = await analytics();
  check("keeps the advanced half while active", a.body?.advanced === true, String(a.body?.advanced));

  console.log("\n── Pro is unchanged ──");
  await setTenant({ plan: "pro", subscription_plan: "pro", subscription_status: "active" });
  a = await analytics();
  check("Pro still gets it", a.body?.advanced === true, String(a.body?.advanced));

  console.log("\n── the gate itself still works ──");
  // `enterprise` is a real catalogue row with no entitlements. If the gate were
  // still "pro is always allowed" this would come back true — and it also
  // proves a plan is judged by its own keys, not by its name.
  await setTenant({ plan: "enterprise", subscription_plan: "enterprise", subscription_status: "active", current_period_end: future(30) });
  a = await analytics();
  check("a plan without the entitlement is denied", a.body?.advanced === false, String(a.body?.advanced));
  check("and the advanced arrays are empty, not missing", Array.isArray(a.body?.hourly) && a.body.hourly.length === 0);
  check("while the basic half still works", typeof a.body?.totalRevenue === "number");

  console.log("\n── expired trial gets nothing advanced ──");
  await setTenant({ plan: "pro", subscription_plan: null, subscription_status: "trial", trial_started_at: new Date(Date.now() - 20 * 86_400_000).toISOString(), trial_ends_at: new Date(Date.now() - 6 * 86_400_000).toISOString(), current_period_end: null });
  a = await analytics();
  check("an expired trial is restricted", a.body?.advanced === false, String(a.body?.advanced));
  check("its advanced arrays are empty", Array.isArray(a.body?.hourly) && a.body.hourly.length === 0);
} finally {
  await admin.from("profiles").delete().eq("id", user.id);
  await admin.from("tenants").delete().eq("id", tenant.id);
  await admin.auth.admin.deleteUser(user.id);
  console.log("\n  scratch restaurant removed");
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
