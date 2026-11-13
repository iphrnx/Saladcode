/**
 * End-to-end production check of the Super Admin panel.
 *
 * Mints a real administrator session, puts it in the HttpOnly cookie the
 * @supabase/ssr server client reads, and calls the production proxy. This is
 * the whole chain: cookie -> server session -> allowlist -> edge function ->
 * data. If any link is broken, this fails.
 */
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const REF = "ygibmdkrslquamwflshb";

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

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

const { data: link, error: linkError } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email: "phrnx@icloud.com",
});
if (linkError) { console.log("link error:", linkError.message); process.exit(1); }

const c = createClient(URL, ANON, { auth: { persistSession: false } });
const { data: session, error: otpError } = await c.auth.verifyOtp({
  token_hash: link!.properties.hashed_token,
  type: "magiclink",
});
if (otpError) { console.log("otp error:", otpError.message); process.exit(1); }

const s = session!.session!;
// The shape @supabase/ssr stores in the cookie: the "base64-" prefix
// followed by base64url of the session JSON.
const cookieValue =
  "base64-" +
  Buffer.from(
    JSON.stringify({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at,
      expires_in: s.expires_in,
      token_type: s.token_type,
      user: s.user,
    }),
  ).toString("base64url");

const cookie = `sb-${REF}-auth-token=${cookieValue}`;

console.log("\n── production, with a real administrator session ──");
for (const path of ["overview", "crm", "conversion", "payments", "usage", "retention", "audit"]) {
  const res = await fetch(`${SITE}/api/superadmin/${path}`, {
    headers: { cookie },
  });
  const body = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  check(`GET /api/superadmin/${path}`, res.status, 200);
  if (res.status !== 200) console.log(`        body: ${body.slice(0, 200)}`);
}

console.log("\n── the panel pages are guarded ──");
for (const path of ["/superadmin", "/superadmin/crm", "/superadmin/payments"]) {
  const res = await fetch(`${SITE}${path}`, { redirect: "manual", headers: { cookie } });
  check(`${path} renders for the administrator`, res.status, 200);
}
for (const path of ["/superadmin", "/superadmin/crm"]) {
  const res = await fetch(`${SITE}${path}`, { redirect: "manual" });
  check(`${path} redirects an anonymous visitor`, res.status, 307);
}

console.log("\n── the numbers are real ──");
{
  const res = await fetch(`${SITE}/api/superadmin/overview`, { headers: { cookie } });
  const body = await res.json();
  check("the overview has a restaurant count", typeof body?.kpis?.totalRestaurants === "number", true);
  check("the overview has a 30-day trend", Array.isArray(body?.trend) && body.trend.length === 30, true);
  check("the trend has revenue in it", typeof body?.trend?.[0]?.revenue === "number", true);
  console.log(`        ${body.kpis.totalRestaurants} restaurants · ${body.kpis.trials} on trial · MRR ${body.kpis.mrr} · ${body.kpis.totalOrders} orders`);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
