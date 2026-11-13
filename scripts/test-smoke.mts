/**
 * A smoke test for the whole platform.
 *
 * It signs in as a real restaurant owner and calls every edge function the
 * owner dashboard uses, so a change to the admin panel or to the database
 * cannot quietly break the restaurant app. Run it after anything that
 * touches a migration, a policy or a shared edge function.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/test-smoke.mts
 */
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";

let bad = 0;
let checks = 0;

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function sessionFor(email: string) {
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data } = await c.auth.verifyOtp({
    token_hash: link!.properties.hashed_token,
    type: "magiclink",
  });
  return data!.session!.access_token;
}

async function check(name: string, actual: unknown, expected: unknown) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    bad++;
    console.log(`  FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

async function status(path: string, token?: string, init: RequestInit = {}) {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return res.status;
}

console.log("\n── the owner dashboard's edge functions ──");
const owner = await sessionFor("swizofoods@gmail.com");
for (const path of [
  "bootstrap",
  "orders",
  "menu",
  "promos",
  "settings",
  "analytics",
  "tables",
  "categories",
  "reservations",
  "security",
  "roles",
  "tenants",
  "health",
]) {
  check(`${path} answers 200 for the owner`, await status(path, owner), 200);
}

console.log("\n── the routes that need a subpath ──");
// The router matches the path before it authenticates, so a bare /staff or
// /table-session is a 404 with no data, and the guarded routes are the ones
// with a head segment.
check("staff list", await status("staff/manage", owner), 200);
check("table-session list", await status("table-session/end", owner), 200);
check("table-session active", await status("table-session/active", owner), 200);

console.log("\n── the routes that need an argument ──");
{
  const { data: orders } = await admin
    .from("orders")
    .select("id")
    .eq("tenant_id", (await admin.from("profiles").select("tenant_id").eq("email", "swizofoods@gmail.com").single()).data!.tenant_id)
    .limit(1);
  if (orders?.length) {
    check("bill for a real order", await status(`bill/${orders[0].id}`, owner), 200);
  } else {
    console.log("  --  no order to bill");
  }
  // The table has to belong to the owner's own tenant — asking for another
  // restaurant's table is a cross-tenant request, and a 404 is the right
  // answer to that.
  const { data: ownerProfile } = await admin
    .from("profiles")
    .select("tenant_id")
    .eq("email", "swizofoods@gmail.com")
    .single();
  const { data: tables } = await admin
    .from("tables")
    .select("id")
    .eq("tenant_id", ownerProfile?.tenant_id ?? null)
    .limit(1);
  if (tables?.length) {
    check("qr for a real table", await status(`qr/${tables[0].id}`, owner), 200);
  } else {
    console.log("  --  no table to read a qr for");
  }
}

console.log("\n── the boundaries still hold ──");
check("an anonymous caller is refused the bootstrap", await status("bootstrap"), 401);
check("an anonymous caller is refused the orders", await status("orders"), 401);
check("an anonymous caller is refused the staff", await status("staff/manage"), 401);
check("a bare /staff is a 404, not a leak", await status("staff"), 404);
check("the super-admin API is refused without a session", await status("super-admin/overview"), 401);

console.log("\n── the diner path is untouched ──");
{
  const { data: sessRow } = await admin
    .from("table_sessions")
    .select("token")
    .eq("status", "ACTIVE")
    .limit(1);
  if (sessRow?.length) {
    const res = await fetch(`${URL}/functions/v1/orders`, {
      method: "POST",
      headers: { apikey: ANON, "content-type": "application/json" },
      body: JSON.stringify({ tableSessionToken: sessRow[0].token, items: [] }),
    });
    const text = await res.text();
    check("an empty diner order is refused with a clear message", [res.status, text.includes("No valid items")], [400, true]);
  } else {
    console.log("  --  no active table session to test with");
  }
}

console.log("\n── the promo rules, against the tenant that owns the code ──");
{
  const jaegar = await sessionFor("demo2@jaegarresto.in");
  const res = await fetch(`${URL}/functions/v1/promos/validate`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${jaegar}`, "content-type": "application/json" },
    body: JSON.stringify({ code: "FLAT50", total: 1000 }),
  });
  const body = await res.json();
  check("FLAT50 applies for its own tenant", [res.status, body.applied, body.discount], [200, true, 50]);

  const res2 = await fetch(`${URL}/functions/v1/promos/validate`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${jaegar}`, "content-type": "application/json" },
    body: JSON.stringify({ code: "FLAT50", total: 100 }),
  });
  const body2 = await res2.json();
  check("FLAT50 below the minimum is declined with a reason", [res2.status, body2.applied, !!body2.reason], [200, false, true]);

  const res3 = await fetch(`${URL}/functions/v1/promos/validate`, {
    method: "POST",
    headers: { apikey: ANON, authorization: `Bearer ${owner}`, "content-type": "application/json" },
    body: JSON.stringify({ code: "FLAT50", total: 1000 }),
  });
  const body3 = await res3.json();
  check("FLAT50 is not visible from another tenant", body3.applied, false);
}

console.log("\n── the customer-facing site ──");
for (const p of ["/", "/superadmin/login"]) {
  const res = await fetch(`${SITE}${p}`, { redirect: "manual" });
  check(`${p} answers 200`, res.status, 200);
}

console.log(`\n${checks - bad}/${checks} passed`);
if (bad > 0) process.exit(1);
