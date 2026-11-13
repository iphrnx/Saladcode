/**
 * Put the super-admin account back.
 *
 * The cleanup emptied `super_admins` and removed the account itself, so this
 * recreates both: the auth user (email confirmed, no password — the panel signs
 * in with an emailed code, and a password can be set with "Forgot password"),
 * and the allowlist row that is the actual authority. Idempotent: run it twice
 * and the second run changes nothing.
 *
 *   npx tsx --env-file=.env.local scripts/restore-super-admin.mts [email]
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const EMAIL = process.argv[2] ?? process.env.EMAIL ?? "phrnx@icloud.com";
const LABEL = process.env.LABEL ?? "Owner";

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

/** Is this account allowed into the panel right now? */
const probe = async () => {
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  if (!link) return { status: null, error: "no such account" };
  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: session } = await c.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: "magiclink",
  });
  // A real route: the function answers 404 for the bare path, which says nothing
  // about authorization.
  const res = await fetch(`${SB}/functions/v1/super-admin/crm`, {
    headers: { apikey: ANON, authorization: `Bearer ${session?.session?.access_token}` },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

console.log(`── ${EMAIL} ──`);
const before = await probe();
console.log("  before:", before.status ?? before.error,
  before.status === 403 ? "(signed in, but not on the allowlist)" : "");

// 1. The account.
const { data: existing } = await admin.auth.admin.listUsers();
let user = existing?.users?.find((u) => u.email === EMAIL) ?? null;
if (!user) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    email_confirm: true, // confirmed, so the panel's emailed code works
  });
  if (error || !created?.user) throw new Error(`could not create the account: ${error?.message}`);
  user = created.user;
  console.log("  created the account:", user.id, "(no password — sign in with an emailed code)");
} else {
  console.log("  the account already existed:", user.id, "| confirmed:", Boolean(user.email_confirmed_at));
  if (!user.email_confirmed_at) {
    await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
    console.log("  confirmed the email address");
  }
}

// 2. The allowlist, which is what actually authorizes the panel.
const { data: row } = await admin.from("super_admins").select("id, label").eq("user_id", user.id).maybeSingle();
if (!row) {
  const { error } = await admin
    .from("super_admins")
    .insert({ user_id: user.id, email: EMAIL, label: LABEL });
  if (error) throw new Error(`could not add the allowlist row: ${error.message}`);
  console.log(`  added to the allowlist as "${LABEL}"`);
} else {
  console.log(`  already on the allowlist as "${row.label}"`);
}

const after = await probe();
console.log("  after:", after.status, after.status === 200 ? "(the panel answers)" : JSON.stringify(after.body).slice(0, 160));
const { data: rows } = await admin.from("super_admins").select("email, label, user_id, created_at");
console.log("  allowlist now:", JSON.stringify(rows));
process.exit(after.status === 200 ? 0 : 1);
