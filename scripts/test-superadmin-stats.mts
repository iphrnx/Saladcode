/**
 * Every Super Admin number, checked against the database.
 *
 * The dashboard used to report figures that were not real: a query whose
 * error was ignored became a confident zero, and a stat that read a field
 * nothing writes counted nothing at all. This calls every endpoint and
 * checks the headline figures against the database directly, so a stat that
 * has drifted away from its source is caught rather than displayed.
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

async function sessionFor(email: string) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(error.message);
  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data, error: e2 } = await c.auth.verifyOtp({
    token_hash: link!.properties.hashed_token,
    type: "magiclink",
  });
  if (e2) throw new Error(e2.message);
  return data!.session!.access_token;
}

async function call(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/functions/v1/super-admin/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const token = await sessionFor("phrnx@icloud.com");

// ---- the database, for comparison ----------------------------------------
const { data: tenants } = await admin.from("tenants").select("*");
const { data: profiles } = await admin.from("profiles").select("id, last_login, tenant_id");
const { data: plans } = await admin.from("subscription_plans").select("*");
const { data: payments } = await admin.from("subscription_payments").select("*");
const { data: orders } = await admin.from("orders").select("id, tenant_id, total, status, created_at");
const { data: menuItems } = await admin.from("menu_items").select("id, tenant_id");
const { data: staff } = await admin.from("staff").select("id, tenant_id");
const { data: issues } = await admin.from("support_issues").select("id");
const { data: auditLogs } = await admin.from("super_admin_audit_logs").select("id");

console.log("\n── every endpoint answers ──");
const ENDPOINTS = [
  "overview",
  "crm",
  "conversion",
  "payments",
  "usage",
  "retention",
  "reports?from=2026-01-01&to=2026-12-31",
  "reports/csv?type=revenue&from=2026-01-01&to=2026-12-31",
  "audit",
  "search?q=a",
  "issues",
  "ai-provider",
];
const responses: Record<string, any> = {};
for (const ep of ENDPOINTS) {
  const res = await call(ep, token);
  responses[ep.split("?")[0]] = res.body;
  check(`${ep} answers`, res.status === 200, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  check(`${ep} is not an error`, !res.body?.error, String(res.body?.error).slice(0, 120));
}
{
  const { data: one } = await admin.from("tenants").select("id").limit(1);
  const res = await call(`crm/${one![0].id}`, token);
  check("crm/:id answers", res.status === 200, `status ${res.status}`);
  check("crm/:id has the restaurant", Boolean(res.body?.tenant?.id), JSON.stringify(res.body).slice(0, 120));
}

console.log("\n── the overview's headline figures ──");
{
  const o = responses["overview"];
  const k = o?.kpis ?? {};

  check("the restaurant count is the real one", k.totalRestaurants === tenants.length, `${k.totalRestaurants} vs ${tenants.length}`);
  check("the owner count is the real one", k.totalUsers === profiles.length, `${k.totalUsers} vs ${profiles.length}`);
  check("the on-trial count is the real one", k.trials === tenants.filter((t: any) => t.subscription_status === "trial").length, `${k.trials}`);
  check("the paid count is the real one", k.paid === tenants.filter((t: any) => t.subscription_status === "active").length, `${k.paid}`);

  const d30 = Date.now() - 30 * 86_400_000;
  check(
    "the new-restaurants count is the real one",
    k.newRestaurants30d === tenants.filter((t: any) => new Date(t.created_at).getTime() >= d30).length,
    `${k.newRestaurants30d}`,
  );
  check(
    "the completed-onboarding count is the real one",
    k.completedOnboarding === tenants.filter((t: any) => t.onboarding_done).length,
    `${k.completedOnboarding}`,
  );

  const loggedIn = profiles.filter((p: any) => p.last_login);
  const d7 = Date.now() - 7 * 86_400_000;
  check(
    "the active-in-7-days count is the real one",
    k.activeUsers7d === loggedIn.filter((p: any) => new Date(p.last_login).getTime() >= d7).length,
    `${k.activeUsers7d}`,
  );
  check(
    "the never-logged-in count is the real one",
    k.neverLoggedIn === profiles.filter((p: any) => !p.last_login).length,
    `${k.neverLoggedIn}`,
  );
  check(
    "the total-orders count is the real one",
    k.totalOrders === orders.length,
    `${k.totalOrders} vs ${orders.length}`,
  );

  // The plan distribution has to add up to the number of restaurants.
  const dist = (o?.planDistribution ?? []).reduce((s: number, p: any) => s + p.count, 0);
  check("the plan distribution adds up", dist === tenants.length, `${dist} vs ${tenants.length}`);

  // The trend has to have one point per day.
  check("the trend has thirty days", (o?.trend ?? []).length === 30, String((o?.trend ?? []).length));
}

console.log("\n── the CRM directory ──");
{
  const rows = responses["crm"];
  check("the directory has a row per restaurant", rows.length === tenants.length, `${rows.length} vs ${tenants.length}`);

  // The counts on each row have to be the real ones.
  const menuByTenant = new Map<string, number>();
  for (const m of menuItems) menuByTenant.set(m.tenant_id, (menuByTenant.get(m.tenant_id) ?? 0) + 1);
  const staffByTenant = new Map<string, number>();
  for (const s of staff) staffByTenant.set(s.tenant_id, (staffByTenant.get(s.tenant_id) ?? 0) + 1);
  const orderByTenant = new Map<string, { n: number; v: number }>();
  for (const o of orders) {
    const cur = orderByTenant.get(o.tenant_id) ?? { n: 0, v: 0 };
    cur.n++; cur.v += Number(o.total) || 0;
    orderByTenant.set(o.tenant_id, cur);
  }

  let menuOk = true, staffOk = true, ordersOk = true, revenueOk = true;
  for (const row of rows) {
    if ((row.menuItemCount ?? 0) !== (menuByTenant.get(row.id) ?? 0)) menuOk = false;
    if ((row.staffCount ?? 0) !== (staffByTenant.get(row.id) ?? 0)) staffOk = false;
    const roll = orderByTenant.get(row.id) ?? { n: 0, v: 0 };
    if ((row.orderCount ?? 0) !== roll.n) ordersOk = false;
    if (Math.abs(Number(row.orderValue ?? 0) - roll.v) > 0.01) revenueOk = false;
  }
  check("every row's menu item count is the real one", menuOk);
  check("every row's staff count is the real one", staffOk);
  check("every row's order count is the real one", ordersOk);
  check("every row's order value is the real one", revenueOk);
}

console.log("\n── the conversion funnel ──");
{
  const c = responses["conversion"];
  const stages = c?.stages ?? [];
  const signup = stages.find((s: any) => s.key === "signup");
  check("the funnel starts with every restaurant", signup?.count === tenants.length, `${signup?.count} vs ${tenants.length}`);

  const withMenu = tenants.filter((t: any) => menuItems.some((m: any) => m.tenant_id === t.id)).length;
  const published = stages.find((s: any) => s.key === "published" || s.key === "menu");
  check("the published-a-menu stage is the real one", published?.count === withMenu, `${published?.count} vs ${withMenu}`);
  check("the funnel is a descending funnel", stages.every((s: any, i: number) => i === 0 || s.count <= stages[i - 1].count), JSON.stringify(stages.map((s: any) => s.count)));
  check("no step reports a drop-off below zero", stages.every((s: any) => s.dropOff >= 0), JSON.stringify(stages.map((s: any) => s.dropOff)));
  check("no step reports a step rate over a hundred", stages.every((s: any) => s.stepRate <= 100), JSON.stringify(stages.map((s: any) => s.stepRate)));
  check("the monetisation pair is reported", typeof responses["conversion"]?.monetisation?.trial === "number" && typeof responses["conversion"]?.monetisation?.paid === "number", JSON.stringify(responses["conversion"]?.monetisation));
}

console.log("\n── the reports ──");
{
  const r = responses["reports"];
  check("the report has rows", Array.isArray(r?.rows ?? r), JSON.stringify(r).slice(0, 120));
  const csv = await call("reports/csv?type=revenue&from=2026-01-01&to=2026-12-31", token);
  check("the CSV export answers", csv.status === 200, `status ${csv.status}`);
  check("the CSV export has a header", String(csv.body).split("\n")[0]?.includes("Restaurant"), String(csv.body).split("\n")[0]);
}

console.log("\n── the activity and issue logs ──");
{
  const a = responses["audit"];
  const rows = a?.logs ?? a?.rows ?? a;
  check("the audit log is a list", Array.isArray(rows), JSON.stringify(a).slice(0, 100));

  const i = responses["issues"];
  const list = i?.issues ?? i;
  check("the issue list is a list", Array.isArray(list), JSON.stringify(i).slice(0, 100));
  check("the issue count is the real one", Array.isArray(list) && list.length === issues.length, `${Array.isArray(list) ? list.length : "?"} vs ${issues.length}`);
}

console.log("\n── the usage and retention pages ──");
{
  const u = responses["usage"];
  check("the usage page lists every restaurant", (u?.perRestaurant ?? []).length === tenants.length, `${(u?.perRestaurant ?? []).length} vs ${tenants.length}`);
  check("the usage page has a feature adoption list", (u?.featureAdoption ?? []).length > 0, String((u?.featureAdoption ?? []).length));
  check("the usage page has a trend", (u?.trend ?? []).length > 0, String((u?.trend ?? []).length));

  // The usage page's order counts have to be the real ones.
  const orderByTenant = new Map<string, number>();
  for (const o of orders) orderByTenant.set(o.tenant_id, (orderByTenant.get(o.tenant_id) ?? 0) + 1);
  const rows = u?.perRestaurant ?? [];
  const ok = rows.every((r: any) => (r.orders ?? 0) === (orderByTenant.get(r.id) ?? 0));
  check("every usage row's order count is the real one", ok);

  // The retention lists are four different cuts of the same restaurants, so a
  // restaurant can be in more than one of them. What has to be true is that
  // each list holds the restaurants its own definition says it should, and
  // that the summary counts match the lists.
  const r = responses["retention"];
  const now = Date.now();
  const DAY = 86_400_000;

  const inactiveOk = (r?.inactive ?? []).every(
    (t: any) => t.orderCount === 0 || t.daysSinceActivity >= 14,
  );
  check("every inactive restaurant matches the definition", inactiveOk);

  const expiringOk = (r?.expiringTrials ?? []).every(
    (t: any) =>
      t.subscriptionStatus === "trial" &&
      t.trialEndsAt &&
      new Date(t.trialEndsAt).getTime() <= now + 7 * DAY &&
      new Date(t.trialEndsAt).getTime() >= now,
  );
  check("every expiring trial matches the definition", expiringOk);

  const expiredOk = (r?.expiredTrials ?? []).every(
    (t: any) => t.subscriptionStatus === "trial" && t.trialEndsAt && new Date(t.trialEndsAt).getTime() < now,
  );
  check("every expired trial matches the definition", expiredOk);

  const prospectOk = (r?.prospects ?? []).every(
    (t: any) => t.subscriptionStatus !== "active" && (t.orderCount > 0 || t.daysSinceActivity < 14),
  );
  check("every prospect matches the definition", prospectOk);

  const summary = r?.summary ?? {};
  check("the inactive count matches the list", summary.inactiveCount === (r?.inactive ?? []).length);
  check("the expiring count matches the list", summary.expiringTrialCount === (r?.expiringTrials ?? []).length);
  check("the expired count matches the list", summary.expiredTrialCount === (r?.expiredTrials ?? []).length);
  check("the prospect count matches the list", summary.prospectCount === (r?.prospects ?? []).length);
}

console.log("\n── the order counter comes back down ──");
{
  // The counter behind the dashboard's order count and revenue used to fire
  // on INSERT only, so a deleted order left its number behind for ever and
  // the dashboard drifted away from the truth.
  const { data: tenant } = await admin.from("tenants").select("id").limit(1).maybeSingle();
  const tenantId = tenant!.id;

  const countFor = async (rows: any[] | null) =>
    (rows ?? []).reduce((n, r: any) => n + Number(r.order_count ?? 0), 0);

  const before = await admin
    .from("daily_tenant_metrics")
    .select("order_count, order_value")
    .eq("tenant_id", tenantId);
  const beforeCount = await countFor(before?.data);

  const { data: order, error: insertError } = await admin
    .from("orders")
    .insert({
      tenant_id: tenantId,
      total: 123.45,
      status: "COMPLETED",
      order_type: "DINE_IN",
      payment_method: "CASH",
    })
    .select("id")
    .single();
  check("an order can be written", !insertError, insertError?.message);

  const during = await admin
    .from("daily_tenant_metrics")
    .select("order_count, order_value")
    .eq("tenant_id", tenantId);
  const duringCount = await countFor(during?.data);
  check("the counter went up by one", duringCount === beforeCount + 1, `${beforeCount} -> ${duringCount}`);

  if (order?.id) await admin.from("orders").delete().eq("id", order.id);

  const after = await admin
    .from("daily_tenant_metrics")
    .select("order_count, order_value")
    .eq("tenant_id", tenantId);
  const afterCount = await countFor(after?.data);
  check("the counter came back down", afterCount === beforeCount, `${duringCount} -> ${afterCount}`);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
