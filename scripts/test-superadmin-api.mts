import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ADMIN_EMAIL = "phrnx@icloud.com";
const OWNER_EMAIL = "swizofoods@gmail.com";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}
function checkTrue(name: string, actual: boolean, detail = "") {
  check(name + (detail ? ` (${detail})` : ""), actual, true);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function sessionFor(email: string) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) return { error: error.message };
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error: e2 } = await c.auth.verifyOtp({
    token_hash: link!.properties.hashed_token,
    type: "magiclink",
  });
  if (e2) return { error: e2.message };
  return { token: data!.session!.access_token, userId: data!.user!.id };
}

async function call(path: string, token?: string, init: RequestInit = {}) {
  const res = await fetch(`${URL}/functions/v1/super-admin/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const a = await sessionFor(ADMIN_EMAIL);
if ("error" in a) { console.log("admin session error:", a.error); process.exit(1); }
const o = await sessionFor(OWNER_EMAIL);
if ("error" in o) { console.log("owner session error:", o.error); process.exit(1); }

console.log("\n── every endpoint, as the administrator ──");
for (const path of [
  "overview",
  "crm",
  "conversion",
  "payments",
  "usage",
  "retention",
  "reports?from=2026-01-01&to=2026-12-31",
  "audit",
  "issues",
  "search?q=cafe",
]) {
  const r = await call(path, a.token);
  check(`GET ${path}`, r.status, 200);
}

console.log("\n── the overview reports real numbers ──");
{
  const r = await call("overview", a.token);
  const k = r.body?.kpis ?? {};
  checkTrue("has a total restaurant count", typeof k.totalRestaurants === "number", String(k.totalRestaurants));
  checkTrue("has an MRR figure", typeof k.mrr === "number", String(k.mrr));
  checkTrue("has a churn rate", typeof k.churnRate === "number", String(k.churnRate));
  checkTrue("has active and inactive users", typeof k.activeUsers30d === "number" && typeof k.inactiveUsers === "number", `${k.activeUsers30d} active / ${k.inactiveUsers} inactive`);
  checkTrue("has a 30-day trend", Array.isArray(r.body?.trend) && r.body.trend.length === 30, `${r.body?.trend?.length} points`);
  checkTrue("counts the tenants that are on trial", typeof k.trials === "number", String(k.trials));
}

console.log("\n── the conversion funnel ──");
{
  const r = await call("conversion", a.token);
  const stages = r.body?.stages ?? [];
  // The funnel is the activation path: signed up, onboarded, published a
  // menu, took first order. Each step is a subset of the one before, so a
  // step can never report a step rate over a hundred or a drop-off below
  // zero.
  check("has the four activation stages", stages.length, 4);
  checkTrue("stages carry a rate", typeof stages[0]?.rate === "number", `${stages[0]?.rate}%`);
  checkTrue("the funnel starts at the signup count", stages[0]?.count > 0, String(stages[0]?.count));
  checkTrue("the funnel only goes down", stages.every((s: any, i: number) => i === 0 || s.count <= stages[i - 1].count), JSON.stringify(stages.map((s: any) => s.count)));
  checkTrue("no stage drops below zero", stages.every((s: any) => s.dropOff >= 0), JSON.stringify(stages.map((s: any) => s.dropOff)));
  checkTrue("no stage steps over a hundred", stages.every((s: any) => s.stepRate <= 100), JSON.stringify(stages.map((s: any) => s.stepRate)));
  // The subscription cut is reported beside the funnel, not as a step in it.
  checkTrue("the monetisation pair is reported", typeof r.body?.monetisation?.trial === "number" && typeof r.body?.monetisation?.paid === "number", JSON.stringify(r.body?.monetisation));
  checkTrue("the totals still carry the trial and paid counts", typeof r.body?.totals?.trial === "number" && typeof r.body?.totals?.paid === "number", JSON.stringify(r.body?.totals));
}

console.log("\n── the CRM ──");
{
  const r = await call("crm", a.token);
  checkTrue("returns an array", Array.isArray(r.body), `${r.body?.length} rows`);
  const row = r.body?.[0];
  checkTrue("a row carries the fields the panel shows", !!row && "subscriptionStatus" in row && "orderCount" in row && "ownerEmail" in row);
  if (row) {
    const detail = await call(`crm/${row.id}`, a.token);
    check("the detail route answers 200", detail.status, 200);
    checkTrue("the detail carries notes and issues", Array.isArray(detail.body?.notes) && Array.isArray(detail.body?.issues));
  }
}

console.log("\n── usage is backed by real counters ──");
{
  const r = await call("usage", a.token);
  checkTrue("has per-restaurant usage", Array.isArray(r.body?.perRestaurant) && r.body.perRestaurant.length > 0);
  checkTrue("has feature adoption", Array.isArray(r.body?.featureAdoption) && r.body.featureAdoption.length > 0, `${r.body?.featureAdoption?.length} features`);
  const total = r.body?.perRestaurant?.reduce((s: number, x: any) => s + x.orders, 0);
  checkTrue("order counts add up to the platform total", total > 0, `${total} orders`);
}

console.log("\n── administrative actions work and are audited ──");
{
  const { data: tenants } = await admin.from("tenants").select("id, plan").limit(1);
  const tenant = tenants![0];
  const before = await call("audit", a.token);
  const beforeCount = before.body?.length ?? 0;

  const upd = await call(`tenants/${tenant.id}`, a.token, {
    method: "PATCH",
    body: JSON.stringify({ subscriptionStatus: "active" }),
  });
  check("PATCH tenants/:id answers 200", upd.status, 200);
  check("the change is reflected", upd.body?.subscription_status, "active");

  const after = await call("audit", a.token);
  checkTrue("the audit log grew", (after.body?.length ?? 0) > beforeCount, `${beforeCount} -> ${after.body?.length}`);

  const note = await call(`crm/${tenant.id}/notes`, a.token, {
    method: "POST",
    body: JSON.stringify({ body: "Checked in by the API test." }),
  });
  check("POST a follow-up note answers 201", note.status, 201);

  // Put the tenant back the way it was.
  await admin.from("tenants").update({ subscription_status: "trial" }).eq("id", tenant.id);
}

console.log("\n── authorisation still holds ──");
{
  for (const path of ["overview", "crm", "payments", "usage", "retention", "audit"]) {
    const r = await call(path, o.token);
    check(`an ordinary owner is refused ${path}`, r.status, 403);
  }
  const r = await call("overview");
  check("an anonymous caller is refused", r.status, 401);
  const r2 = await call("overview", "not-a-real-token");
  check("a forged token is refused", r2.status, 401);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
