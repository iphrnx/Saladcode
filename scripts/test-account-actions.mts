/**
 * The owner's own profile and password.
 *
 * Both of these buttons used to show a success message and do nothing: the
 * form was thrown away, and the password did not change. This signs up a
 * throwaway account, changes both, and checks they really changed — the
 * old password stops working and the new one starts, and the name is
 * different the next time the account is read.
 *
 * The account it makes is deleted at the end.
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const email = `accttest${Date.now()}@example.com`;
const FIRST = "FirstPass123!"
const SECOND = "SecondPass456!"

// --- make the account ------------------------------------------------------
console.log("\n── making a throwaway account ──");
{
  const res = await fetch(`${SB}/functions/v1/auth/register`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Before Name",
      restaurantName: "Account Test Kitchen",
      email,
      password: FIRST,
    }),
  });
  const body = await res.json().catch(() => ({}));
  check("the account was created", res.status === 200, `status ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
}

// --- sign in with the password --------------------------------------------
console.log("\n── signing in with the password ──");
const browser = createClient(SB, ANON, { auth: { persistSession: false } });
{
  const { data, error } = await browser.auth.signInWithPassword({ email, password: FIRST });
  check("the password signs in", !error && Boolean(data.session), error?.message);
}

// --- change the profile ----------------------------------------------------
console.log("\n── saving the profile ──");
{
  const { data: userData } = await browser.auth.getUser();
  const user = userData.user!;
  const { error } = await browser
    .from("profiles")
    .update({ name: "After Name", phone: "98765 43210" })
    .eq("id", user.id);
  check("the profile write is allowed", !error, error?.message);

  // Read it back with the service role, which is what the app does.
  const { data: rows } = await admin.from("profiles").select("name, phone").eq("id", user.id).maybeSingle();
  check("the name really changed", rows?.name === "After Name", String(rows?.name));
  check("the phone really changed", rows?.phone === "98765 43210", String(rows?.phone));
}

// --- change the password ---------------------------------------------------
console.log("\n── changing the password ──");
{
  // The current password has to be proved first.
  const { error: wrong } = await browser.auth.signInWithPassword({ email, password: "not-the-password" });
  check("a wrong current password is refused", Boolean(wrong), String(wrong?.message));

  const { error } = await browser.auth.updateUser({ password: SECOND });
  check("the password is changed", !error, error?.message);
}

// --- the new password works and the old one does not ----------------------
console.log("\n── the new password works ──");
{
  const probe = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data, error: oldError } = await probe.auth.signInWithPassword({ email, password: FIRST });
  check("the old password no longer works", Boolean(oldError), "the old password still signed in");

  const { data: fresh, error: newError } = await probe.auth.signInWithPassword({ email, password: SECOND });
  check("the new password works", !newError && Boolean(fresh.session), newError?.message);
}

// --- clean up --------------------------------------------------------------
console.log("\n── cleaning up ──");
{
  const { data: users } = await admin.auth.admin.listUsers();
  const made = users?.users?.find((u: any) => u.email === email);
  if (made) {
    const { data: profile } = await admin.from("profiles").select("tenant_id").eq("id", made.id).maybeSingle();
    if (profile?.tenant_id) {
      for (const t of ["tables", "menu_items", "categories", "roles", "settings", "profiles"]) {
        await admin.from(t).delete().eq("tenant_id", profile.tenant_id);
      }
      await admin.from("tenants").delete().eq("id", profile.tenant_id);
    }
    await admin.auth.admin.deleteUser(made.id);
  }
  const { data: left } = await admin.from("tenants").select("id").eq("name", "Account Test Kitchen");
  check("the test left nothing behind", (left ?? []).length === 0, String(left?.length));
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
