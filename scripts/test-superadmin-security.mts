/**
 * Security tests for the Super Admin panel.
 *
 * These are the checks that matter most in this codebase, because the whole
 * admin panel rests on one boolean column and one RLS policy. Both were
 * exploitable before migration 0020:
 *
 *   - `profiles_self_write` constrained only the row identity, not the
 *     columns, so any signed-in owner could set `is_super_admin = true` or
 *     clear `role_id` (which guard() reads as "every permission");
 *   - `/superadmin/login` sent a sign-in code to any address, so the panel
 *     doubled as an open signup.
 *
 * Run with the service role key in the environment:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/test-superadmin-security.mts
 *
 * The tests write to a real restaurant owner and put it back afterwards.
 */
import { createClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ADMIN_EMAIL = "phrnx@icloud.com";
const ADMIN_ID = "0d78085e-0f6a-4add-8e11-a1aab462f4f2";
// An ordinary restaurant owner, used as the attacker.
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
  return { client: c, userId: data!.user!.id, token: data!.session!.access_token };
}

async function callAdminApi(path: string, token?: string) {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    headers: { apikey: ANON, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return res.status;
}

console.log("\n── escalation attempts as an ordinary restaurant owner ──");
const o = await sessionFor(OWNER_EMAIL);
if ("error" in o) { console.log("  could not sign in:", o.error); process.exit(1); }
const attacker: any = o.client;
const uid: string = o.userId;

const { data: before } = await admin
  .from("profiles")
  .select("email, is_super_admin, role, role_id, tenant_id, active")
  .eq("id", uid)
  .single();

{
  const { error } = await attacker.from("profiles").update({ is_super_admin: true }).eq("id", uid);
  check("set own is_super_admin = true is refused", error ? "refused" : "ALLOWED", "refused");
}
{
  const { error } = await attacker.from("profiles").update({ role_id: null }).eq("id", uid);
  check("clear own role_id (grants every permission) is refused", error ? "refused" : "ALLOWED", "refused");
}
{
  const { data: other } = await admin.from("tenants").select("id").limit(1);
  const { error } = await attacker
    .from("profiles")
    .update({ tenant_id: (other as any)?.[0]?.id ?? null })
    .eq("id", uid);
  check("move own profile to another tenant is refused", error ? "refused" : "ALLOWED", "refused");
}
{
  const { error } = await attacker.from("profiles").update({ active: false }).eq("id", uid);
  check("deactivate own profile is refused", error ? "refused" : "ALLOWED", "refused");
}
{
  const { error } = await attacker.from("profiles").update({ role: "Owner" }).eq("id", uid);
  check("rename own role to Owner is refused", error ? "refused" : "ALLOWED", "refused");
}
{
  const { error } = await attacker.from("profiles").update({ name: "Bablu" }).eq("id", uid);
  check("updating own name still works", error ? `blocked: ${error.message}` : "allowed", "allowed");
}
{
  const { data: after } = await admin
    .from("profiles")
    .select("email, is_super_admin, role, role_id, tenant_id, active")
    .eq("id", uid)
    .single();
  check("the row is byte-for-byte unchanged by the attempts", after, before);
}

console.log("\n── the admin API ──");
const a = await sessionFor(ADMIN_EMAIL);
if ("error" in a) { console.log("  could not sign in as the admin:", a.error); process.exit(1); }
check("answers 200 for the designated admin", await callAdminApi("super-admin/overview", a.token), 200);
check("refuses an ordinary owner", await callAdminApi("super-admin/overview", o.token), 403);
check("refuses an anonymous caller", await callAdminApi("super-admin/overview"), 401);
check("refuses an anonymous caller on crm", await callAdminApi("super-admin/crm"), 401);
check("refuses an ordinary owner on payments", await callAdminApi("super-admin/payments", o.token), 403);

console.log("\n── the service role still writes profiles (the edge functions rely on it) ──");
{
  const { error } = await admin.from("profiles").update({ last_login: new Date().toISOString() }).eq("id", uid);
  check("service role can update a profile", error ? `blocked: ${error.message}` : "allowed", "allowed");
}
{
  const { error } = await admin.from("profiles").update({ is_super_admin: true }).eq("id", uid);
  check("service role can set is_super_admin (admin provisioning)", error ? `blocked: ${error.message}` : "allowed", "allowed");
  await admin.from("profiles").update({ is_super_admin: false }).eq("id", uid);
}

console.log("\n── the allowlist ──");
{
  const { data, error } = await admin.from("super_admins").select("email, label, user_id").order("email");
  check("holds exactly the designated admin", [error?.message ?? null, data], [null, [
    { email: ADMIN_EMAIL, label: "System Owner", user_id: ADMIN_ID },
  ]]);
}
{
  // RLS filters rather than errors, so an ordinary user sees no rows.
  const { data, error } = await attacker.from("super_admins").select("email");
  check("an ordinary user sees no allowlist rows", [error?.message ?? null, data], [null, []]);
}
{
  const { error } = await attacker.from("super_admins").insert({ email: "attacker@evil.com" }).select();
  check("an ordinary user cannot add themselves to the allowlist", error ? "refused" : "ALLOWED", "refused");
}
{
  // RLS filters the row out, so the update matches nothing rather than
  // erroring. Assert on the data, not on the absence of an error.
  const { error } = await attacker
    .from("super_admins")
    .update({ email: "attacker@evil.com" })
    .eq("email", ADMIN_EMAIL);
  const { data: list } = await admin.from("super_admins").select("email").order("email");
  check("an ordinary user cannot rewrite the allowlist", [error?.message ?? null, list], [null, [{ email: ADMIN_EMAIL }]]);
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
