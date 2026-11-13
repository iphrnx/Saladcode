/**
 * A new account always gets a real, full trial.
 *
 * The bug this guards: `tenants.subscription_status` defaults to 'trial' but
 * the two trial dates had no default, and the registration path did not write
 * them. A tenant created that way was a trial with no end date, which the
 * server read as a trial that was over — so a brand-new restaurant was told
 * "Your free trial has ended" before it had served an order.
 *
 * Three layers are checked, because any one of them alone would have hidden it:
 *
 *   1. the database, for an insert that names no trial dates at all
 *   2. registration, the path that was missing them — a real account is created
 *   3. the resolver, for a trial whose dates are missing (needs the current
 *      edge functions deployed; it is the layer that covers data written by
 *      anything else)
 *
 *   npm run test:trial
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const DAY = 86_400_000;
const stamp = Date.now();
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};
const daysBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / DAY;
const daysFromNow = (t: string) => (new Date(t).getTime() - Date.now()) / DAY;

/** Usage and billing tables reference tenants without a cascade. */
async function purgeTenant(id: string) {
  for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs"]) {
    await admin.from(t).delete().eq("tenant_id", id);
  }
  await admin.from("tenants").delete().eq("id", id);
}

console.log("\n── the database fills the trial clock in ──");
const dbTenantIds: string[] = [];
try {
  // Exactly the insert the registration path used to make: no trial fields.
  const { data: bare, error } = await admin
    .from("tenants")
    .insert({ name: `Trial Test ${stamp}`, slug: `trial-test-${stamp}` })
    .select("id, subscription_status, trial_started_at, trial_ends_at")
    .single();
  if (error) throw new Error(error.message);
  dbTenantIds.push(bare!.id);

  check("a tenant created without trial dates is on a trial", bare!.subscription_status === "trial", String(bare!.subscription_status));
  check("it has a trial start", Boolean(bare!.trial_started_at), "null");
  check("it has a trial end", Boolean(bare!.trial_ends_at), "null");
  if (bare!.trial_started_at && bare!.trial_ends_at) {
    const length = daysBetween(bare!.trial_started_at, bare!.trial_ends_at);
    check("the window is the configured 14 days", Math.round(length) === 14, `${length} days`);
    check("the window starts now, not in the past", Math.abs(daysFromNow(bare!.trial_started_at)) < 0.01, String(bare!.trial_started_at));
  }
} catch (e) {
  check("a tenant can be created", false, (e as Error).message);
}

console.log("\n── registering creates an account on a full trial ──");
const email = `trial-check-${stamp}@example.com`;
const password = "trial-check-123456";
let registeredTenantId: string | null = null;
let accessToken: string | null = null;
try {
  const res = await fetch(`${SB}/functions/v1/auth/register`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ name: "Trial Check", email, password, restaurantName: `Trial Resto ${stamp}` }),
  });
  const payload = await res.json().catch(() => ({}));
  check("registration succeeds", res.ok, `${res.status} ${JSON.stringify(payload).slice(0, 200)}`);
  accessToken = payload?.token ?? payload?.accessToken ?? payload?.session?.access_token ?? null;

  const { data: profile } = await admin.from("profiles").select("tenant_id").eq("email", email).maybeSingle();
  registeredTenantId = profile?.tenant_id ?? null;
  check("it created a tenant", Boolean(registeredTenantId), "no profile for the new account");

  if (registeredTenantId) {
    const { data: tenant } = await admin
      .from("tenants")
      .select("subscription_status, trial_started_at, trial_ends_at")
      .eq("id", registeredTenantId)
      .maybeSingle();
    check("the new account is on a trial", tenant?.subscription_status === "trial", String(tenant?.subscription_status));
    check("its trial start is written", Boolean(tenant?.trial_started_at), "null");
    check("its trial end is written", Boolean(tenant?.trial_ends_at), "null");
    if (tenant?.trial_ends_at) {
      const left = daysFromNow(tenant.trial_ends_at);
      check("it has the full configured period left", left > 13.9 && left <= 14, `${left.toFixed(2)} days`);
    }
  }

  // What the dashboard actually shows, through the API it reads.
  if (registeredTenantId) {
    const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const c = createClient(SB, ANON, { auth: { persistSession: false } });
    const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
    accessToken = session?.session?.access_token ?? accessToken;
  }
  if (accessToken) {
    const res = await fetch(`${SB}/functions/v1/subscriptions/state`, {
      headers: { apikey: ANON, Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json().catch(() => ({}));
    const plan = body?.plan ?? {};
    check("the API says the trial is running", plan.isTrial === true, JSON.stringify(plan).slice(0, 200));
    check("the API does not restrict a new account", plan.isRestricted === false, JSON.stringify(plan).slice(0, 200));
    check("the API reports days remaining", typeof plan.trialDaysRemaining === "number" && plan.trialDaysRemaining >= 13, String(plan.trialDaysRemaining));
    check("the API reports the trial end date", Boolean(plan.trialEndsAt), "null");
  }
} catch (e) {
  check("registration path runs", false, (e as Error).message);
}

console.log("\n── a trial with no dates is not read as ended ──");
// The layer that covers data written by anything else: strip the dates from a
// tenant and ask the API what it thinks. It must fill the clock in from the
// plan's configured days, not declare the trial over.
let strippedId: string | null = null;
try {
  const { data: scratch, error } = await admin
    .from("tenants")
    .insert({ name: `No Clock ${stamp}`, slug: `no-clock-${stamp}`, subscription_status: "trial" })
    .select("id, created_at")
    .single();
  if (error) throw new Error(error.message);
  strippedId = scratch!.id;
  await admin.from("tenants").update({ trial_started_at: null, trial_ends_at: null }).eq("id", strippedId);

  // Ask the server through a session for this tenant, using the account that
  // owns it — created here so the request carries a real owner token.
  const strippedEmail = `no-clock-${stamp}@example.com`;
  await admin.auth.admin.createUser({ email: strippedEmail, password, email_confirm: true });
  const { data: ownerRole } = await admin.from("roles").select("id").eq("tenant_id", strippedId).eq("name", "Owner").maybeSingle();
  const { data: createdRole } = ownerRole
    ? { data: ownerRole }
    : await admin
        .from("roles")
        .insert({
          tenant_id: strippedId,
          name: "Owner",
          description: "Full access",
          permissions: "dashboard.view,settings.view,settings.manage",
          is_system: true,
        })
        .select("id")
        .single();
  const { data: user } = await admin.auth.admin.listUsers();
  const authUser = user?.users?.find((u) => u.email === strippedEmail);
  await admin.from("profiles").insert({
    id: authUser!.id,
    tenant_id: strippedId,
    name: "No Clock",
    email: strippedEmail,
    role_id: createdRole?.id ?? null,
  });

  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: strippedEmail });
  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashtoken ?? link!.properties.hashed_token, type: "magiclink" });
  const res = await fetch(`${SB}/functions/v1/subscriptions/state`, {
    headers: { apikey: ANON, Authorization: `Bearer ${session?.session?.access_token}` },
  });
  const body = await res.json().catch(() => ({}));
  const plan = body?.plan ?? {};
  check(
    "a trial with no end date is not restricted",
    plan.isRestricted === false,
    `isRestricted=${plan.isRestricted} isTrial=${plan.isTrial} — needs the current edge functions deployed`,
  );
  check("it is read as the full configured trial", plan.isTrial === true && plan.trialDaysRemaining >= 13, JSON.stringify(plan).slice(0, 200));
  check("the resolved end date is reported", Boolean(plan.trialEndsAt), "null");
} catch (e) {
  check("the no-dates case runs", false, (e as Error).message);
}

// Clean up everything this run created.
for (const id of [...dbTenantIds, ...(registeredTenantId ? [registeredTenantId] : []), ...(strippedId ? [strippedId] : [])]) {
  await purgeTenant(id);
}
for (const e of [email, `no-clock-${stamp}@example.com`]) {
  const { data: list } = await admin.auth.admin.listUsers();
  const u = list?.users?.find((x) => x.email === e);
  if (u) await admin.auth.admin.deleteUser(u.id).catch(() => {});
}
const { data: left } = await admin.from("tenants").select("id").like("slug", `%${stamp}%`);
check("scratch data cleaned up", (left ?? []).length === 0, JSON.stringify(left));

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
