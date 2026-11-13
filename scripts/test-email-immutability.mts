/**
 * The owner's login email is not editable; the restaurant's contact email is.
 *
 *   npm run test:email-immutability
 *
 * Uses Z Hut (a real account with a real Supabase Auth user) and changes
 * business details only, restoring everything afterwards. The login email and
 * the auth user are never touched.
 */
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const Z = "87b90e86-f705-428f-8245-7b3659052443";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "zhut@demo.com" });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const token = otp.data.session!.access_token;
const H = { apikey: ANON, authorization: `Bearer ${token}`, "x-tenant-id": Z, "content-type": "application/json" };
const call = async (path: string, body: unknown, method = "PATCH") => {
  const r = await fetch(`${SB}/functions/v1/${path}`, { method, headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const before = {
  tenant: (await admin.from("tenants").select("name, email, phone, address").eq("id", Z).single()).data!,
  profile: (await admin.from("profiles").select("id, name, email, phone").eq("tenant_id", Z).single()).data!,
  authUser: (await admin.auth.admin.getUserById((await admin.from("profiles").select("id").eq("tenant_id", Z).single()).data!.id)).data.user!,
};

try {
  console.log("\n── the login email is immutable ──");
  check("the profile email is the auth email", before.profile.email === before.authUser.email, `${before.profile.email} vs ${before.authUser.email}`);

  const attempt = await call("auth/profile", { email: "attacker@example.com" });
  check("the profile API refuses an email change", attempt.status === 400, `${attempt.status} ${JSON.stringify(attempt.body).slice(0, 120)}`);
  check("and says why", /verified|sign-in|cannot be changed/i.test(attempt.body?.error ?? ""), attempt.body?.error);

  const afterAttempt = (await admin.from("profiles").select("email").eq("id", before.profile.id).single()).data!;
  check("the stored profile email is unchanged", afterAttempt.email === before.profile.email, afterAttempt.email);

  // Business email via the allowed path, unchanged by the attempt above.
  const tenantEmailAfter = (await admin.from("tenants").select("email").eq("id", Z).single()).data!;
  check("the restaurant email is untouched by it too", tenantEmailAfter.email === before.tenant.email);

  console.log("\n── the database refuses it too, not just the API ──");
  {
    // Straight at PostgREST, with the owner's own token: the column grant and
    // the trigger must both hold when the edge function is out of the way.
    const direct = await fetch(`${SB}/rest/v1/profiles?id=eq.${before.profile.id}`, {
      method: "PATCH",
      headers: { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ email: "attacker@example.com" }),
    });
    check("a direct profile update cannot change email", direct.status === 403 || direct.status === 401, String(direct.status));
    const still = (await admin.from("profiles").select("email").eq("id", before.profile.id).single()).data!;
    check("the email is still the verified one", still.email === before.profile.email, still.email);
  }

  console.log("\n── name and phone remain editable ──");
  const rename = await call("auth/profile", { name: `${before.profile.name}`.trim(), phone: before.profile.phone ?? "9876543210" });
  check("the profile API accepts name and phone", rename.status === 200, JSON.stringify(rename.body).slice(0, 120));
  check("and returns the unchanged login email", rename.body?.profile?.email === before.profile.email, rename.body?.profile?.email);

  console.log("\n── the business email is independent and editable ──");
  const marker = `billing-${Date.now()}@zhut.test`;
  const biz = await call("settings", { tenant: { ...before.tenant, email: marker } }, "PUT");
  check("the restaurant email can be changed", biz.status === 200, JSON.stringify(biz.body).slice(0, 120));
  const tenantNow = (await admin.from("tenants").select("email").eq("id", Z).single()).data!;
  const profileNow = (await admin.from("profiles").select("email").eq("id", before.profile.id).single()).data!;
  check("it changed on the restaurant", tenantNow.email === marker, tenantNow.email);
  check("it did NOT change the owner's login email", profileNow.email === before.profile.email, profileNow.email);

  const userNow = (await admin.auth.admin.getUserById(before.profile.id)).data.user!;
  check("the Supabase Auth address is unchanged", userNow.email === before.authUser.email, userNow.email);

  console.log("\n── authentication still works afterwards ──");
  const relog: any = await admin.auth.admin.generateLink({ type: "magiclink", email: before.authUser.email! });
  // The SDK nests the link under `data`; accept either shape.
  const hashed = relog?.data?.properties?.hashed_token ?? relog?.properties?.hashed_token;
  check("the original address still resolves a sign-in", Boolean(hashed) && !relog?.error, JSON.stringify(relog?.error ?? ""));

  console.log("\n── the identity used for ownership is the UUID ──");
  const boot = await fetch(`${SB}/functions/v1/bootstrap`, { headers: H });
  const bootBody = await boot.json();
  check("bootstrap still answers for this owner", boot.status === 200, String(boot.status));
  check("the account is identified by its id, not its email", Boolean(bootBody?.currentUser?.id), JSON.stringify(bootBody?.currentUser)?.slice(0, 120));
} finally {
  await admin.from("tenants").update({ name: before.tenant.name, email: before.tenant.email, phone: before.tenant.phone, address: before.tenant.address }).eq("id", Z);
  await admin.from("profiles").update({ name: before.profile.name, phone: before.profile.phone }).eq("id", before.profile.id);
  console.log("\n  restaurant and profile restored");
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
