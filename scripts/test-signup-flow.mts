/**
 * E2E: the new-tenant signup flow with Supabase email confirmation ON.
 *
 * Part A (this script): signup → DB records → unconfirmed login →
 * confirmation link (exactly what the email carries) → follow it.
 *
 * Run: SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
 *      npx tsx --env-file=.env.local scripts/test-signup-flow.mts
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const anon = createClient(SB, ANON, { auth: { persistSession: false } });

const STAMP = Date.now();
const EMAIL = `signup-e2e-${STAMP}@thesalad.in`;
const PASSWORD = "e2e-Flow-2026!";
const NAME = "E2E Tester";
const RESTAURANT = `Signup Flow Test Cafe ${STAMP % 10000}`;

let pass = 0, fail = 0;
const ok = (name: string, cond: any, detail?: any) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); }
};

console.log("— 1. Signup (fresh test tenant) —");
const regRes = await fetch(`${SB}/functions/v1/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json", apikey: ANON, origin: "http://localhost:3000" },
  body: JSON.stringify({ name: NAME, email: EMAIL, password: PASSWORD, restaurantName: RESTAURANT }),
});
const reg = await regRes.json();
ok("register answers 200", regRes.status === 200, { status: regRes.status, body: reg });
ok("no session while confirmation is on", reg.session === null || reg.session === undefined, reg.session);
ok("user returned", Boolean(reg.user?.id));
ok("tenant returned", Boolean(reg.tenant?.id));
const authUserId = reg.user?.id as string;
const tenantId = reg.tenant?.id as string;
console.log(`  tenant: ${tenantId}  auth user: ${authUserId}`);

console.log("— 2. Database records —");
const { data: tenant } = await admin.from("tenants").select("*").eq("id", tenantId).maybeSingle();
ok("tenant row exists", Boolean(tenant));
ok("tenant name", tenant?.name === RESTAURANT, tenant?.name);
ok("plan is pro", tenant?.plan === "pro", tenant?.plan);
ok("trial status", tenant?.subscription_status === "trial" || tenant?.status === "trial" || tenant?.trial_ends_at != null, { s: tenant?.subscription_status, trialEnds: tenant?.trial_ends_at });
ok("trial ends in the future", tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) > new Date() : false, tenant?.trial_ends_at);
ok("currency INR/₹", tenant?.currency === "INR" && tenant?.currency_symbol === "₹");
ok("onboarding not done yet", tenant?.onboarding_done === false);

const { data: profile } = await admin.from("profiles").select("*").eq("id", authUserId).maybeSingle();
ok("owner profile exists", Boolean(profile));
ok("profile keyed to the tenant", profile?.tenant_id === tenantId);
ok("profile role OWNER", profile?.role === "OWNER", profile?.role);
ok("profile has the Owner role id", Boolean(profile?.role_id));

const { count: roleCount } = await admin.from("roles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
ok("default roles seeded", roleCount === 5, roleCount);

const { data: secLog } = await admin.from("security_logs").select("*").eq("tenant_id", tenantId).eq("action", "REGISTER").maybeSingle();
ok("REGISTER security log written", Boolean(secLog));

const { data: mail } = await admin.from("email_events").select("id, status, recipient, subject").eq("tenant_id", tenantId).eq("event_type", "trial_started").maybeSingle();
ok("trial_started welcome email queued", Boolean(mail), mail?.status);

console.log("— 3. Login before confirmation —");
const earlyLogin = await fetch(`${SB}/functions/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", apikey: ANON },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const earlyBody = await earlyLogin.json();
ok("unconfirmed login refused", earlyLogin.status !== 200, { status: earlyLogin.status });
console.log(`  (current deploy says ${earlyLogin.status}: "${earlyBody.error}" — after deploy this becomes 403 email_not_confirmed)`);

console.log("— 4. The confirmation link (what the email carries) —");
// The same link the confirmation email carries — generateLink builds it
// through the same GoTrue machinery without consuming the emailed token.
const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
  type: "signup",
  email: EMAIL,
  password: PASSWORD,
  options: { redirectTo: "http://localhost:3000/?view=confirm-email" },
});
ok("confirmation link generated", Boolean(linkData?.properties?.action_link), linkError?.message);
if (linkData?.properties?.action_link) {
  const verifyRes = await fetch(linkData.properties.action_link, { redirect: "manual" });
  const location = verifyRes.headers.get("location") ?? "";
  ok("verify redirects (303)", verifyRes.status === 303, verifyRes.status);
  ok("lands on the confirm view", location.startsWith("http://localhost:3000/?view=confirm-email#"), location.slice(0, 80));
  ok("carries an access token", location.includes("access_token="));
  ok("typed as signup", location.includes("type=signup"));
  writeFileSync("/tmp/confirm-url.txt", location);
  console.log("  confirm URL saved to /tmp/confirm-url.txt");
}

console.log("— 5. Server draft route (graceful against the not-yet-deployed backend) —");
const draftPut = await fetch(`${SB}/functions/v1/onboarding`, {
  method: "PUT",
  headers: { "content-type": "application/json", apikey: ANON },
  body: JSON.stringify({ draft: { step: 2 } }),
});
ok("PUT draft answers (405 until deploy, not a crash)", draftPut.status === 405 || draftPut.status === 401 || draftPut.status === 409, draftPut.status);
console.log(`  (draft GET/PUT need the deploy: current status ${draftPut.status})`);

console.log(`\nPART A: ${pass} passed, ${fail} failed`);
writeFileSync("/tmp/signup-e2e-state.json", JSON.stringify({ EMAIL, PASSWORD, authUserId, tenantId }, null, 2));
process.exit(fail > 0 ? 1 : 0);
