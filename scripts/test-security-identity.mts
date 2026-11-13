/**
 * Security dashboard: identity, failed-login attribution, and the rules that
 * protect an owner's session.
 *
 *   npm run test:security-identity
 *
 * Provisions a scratch restaurant with an owner and a PIN staff member, then
 * exercises the real endpoints. The owner's session must be named, its role
 * shown, un-revokable by itself and un-revokable by staff, and "revoke all"
 * must leave it standing.
 */
import { createClient } from "@supabase/supabase-js";
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};

const stamp = Date.now();
const tenant = (await admin.from("tenants").insert({
  name: `Identity ${stamp}`, slug: `identity-${stamp}`, plan: "starter", currency: "INR",
  currency_symbol: "₹", active: true, subscription_status: "active", subscription_plan: "starter",
  billing_interval: "monthly", payment_mode: "autopay",
  current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
}).select("id").single()).data!;
const email = `identity-${stamp}@example.com`;
const userName = "Priya Owner";
const PASSWORD = "Test-pass-1234";
const user = (await admin.auth.admin.createUser({ email, email_confirm: true, password: PASSWORD })).data.user!;
await admin.from("profiles").insert({ id: user.id, tenant_id: tenant.id, name: userName, email, role: "OWNER", active: true });
// Roles, staff and staff sessions are owner-only writes through RLS, and this
// client is not the owner, so the fixture is created by the database owner.
// Everything under test then goes through the real HTTP endpoints.
import { execFileSync } from "node:child_process";
const sqlq = (query: string) => {
  const out = execFileSync("letta", ["mcp", "call", "mcp__supaletta__execute_sql", "--args",
    JSON.stringify({ project_id: "ygibmdkrslquamwflshb", query })], { encoding: "utf8", maxBuffer: 1 << 20 });
  return out;
};
const staffToken = `teststaff${stamp}`;
sqlq(`insert into roles (tenant_id, name, description, is_system, permissions) values ('${tenant.id}','Manager','test',false,'security.view,security.manage,settings.manage');
insert into staff (tenant_id, name, employee_id, role_id, active, pin_hash, pin_salt)
  select '${tenant.id}', 'Ravi Staff', 'R${stamp}', id, true, 'test', 'test' from roles where tenant_id='${tenant.id}' and name='Manager';
insert into staff_sessions (staff_id, token, ip, user_agent)
  select id, '${staffToken}', '203.0.113.9', 'Mozilla/5.0 (iPhone) Safari' from staff where tenant_id='${tenant.id}' and name='Ravi Staff';`);
const staff = { id: "" };

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const ownerToken = otp.data.session!.access_token;
const ownerSessionId = otp.data.session!.access_token
  ? JSON.parse(Buffer.from(otp.data.session!.access_token.split(".")[1], "base64").toString()).session_id
  : null;

const api = async (path: string, init: RequestInit = {}, staffAuth = false) => {
  const headers: Record<string, string> = { apikey: ANON, "x-tenant-id": tenant.id };
  if (staffAuth) headers["x-staff-session"] = staffToken;
  else headers.authorization = `Bearer ${ownerToken}`;
  if (init.body) headers["content-type"] = "application/json";
  const r = await fetch(`${SB}/functions/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  console.log("\n── the owner is a person, with a role ──");
  // A real password login, so the audit trail has a LOGIN row written by the
  // auth route rather than by this test.
  await fetch(`${SB}/functions/v1/auth/login`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  let sec = await api("security");
  // Two owner sessions exist by now (the magic-link one this test uses, and the
  // password login above), so identity is checked on both and "current" on the
  // exact one whose token we are holding.
  const ownerSessions = (sec.body?.sessions ?? []).filter((s: any) => s.kind === "owner");
  const ownerSession = ownerSessions[0];
  check("every owner session is named from the profile", ownerSessions.length > 0 && ownerSessions.every((s: any) => s.user?.name === userName), JSON.stringify(ownerSessions.map((s: any) => s.user?.name)));
  check("and carries a role label", ownerSessions.every((s: any) => Boolean(s.role)), JSON.stringify(ownerSessions.map((s: any) => s.role)));
  const current = ownerSessions.filter((s: any) => s.current);
  check("exactly the session in use is badged current", current.length === 1 && current[0]?.id === ownerSessionId, JSON.stringify({ n: current.length, id: current[0]?.id, want: ownerSessionId }));
  check("no session falls back to an IP as its name", (sec.body?.sessions ?? []).every((s: any) => !/^\d+\.\d+\.\d+\.\d+$/.test(String(s.user?.name ?? ""))));

  const staffSession = (sec.body?.sessions ?? []).find((s: any) => s.kind === "staff");
  check("the staff session is named and rolled", staffSession?.user?.name === "Ravi Staff" && staffSession?.role === "Manager", JSON.stringify({ n: staffSession?.user?.name, r: staffSession?.role }));

  console.log("\n── audit rows name the actor ──");
  const loginLog = (sec.body?.logs ?? []).find((l: any) => l.action === "LOGIN");
  check("a login is attributed to the person", loginLog?.actor?.name === userName, JSON.stringify(loginLog?.actor));
  check("with their role", Boolean(loginLog?.actor?.role), String(loginLog?.actor?.role));
  check("the IP is still recorded, as metadata", Boolean(loginLog?.ip));

  console.log("\n── a failed login is an attempt, not a person ──");
  await fetch(`${SB}/functions/v1/auth/login`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "definitely-not-the-password" }),
  });
  sec = await api("security");
  const failed = (sec.body?.logs ?? []).find((l: any) => l.action === "LOGIN_FAILED");
  check("the failure exists", Boolean(failed), JSON.stringify(sec.body?.logs?.[0]));
  check("it is labelled an attempt", failed?.actor?.kind === "attempt", JSON.stringify(failed?.actor));
  check("showing the attempted account, not a person's name", String(failed?.actor?.name ?? "").includes(email), String(failed?.actor?.name));

  console.log("\n── the owner's own session cannot be revoked ──");
  check("the session id is known", Boolean(ownerSessionId));
  const selfRevoke = await api("security", { method: "DELETE", body: JSON.stringify({ sessionId: ownerSessionId }) });
  check("the server refuses it, even as a direct call", selfRevoke.status === 400, `${selfRevoke.status} ${JSON.stringify(selfRevoke.body).slice(0, 90)}`);

  const staffVsOwner = await api("security", { method: "DELETE", body: JSON.stringify({ sessionId: ownerSessionId }) }, true);
  check("a staff member cannot end an owner session", staffVsOwner.status === 403, `${staffVsOwner.status} ${JSON.stringify(staffVsOwner.body).slice(0, 90)}`);

  console.log("\n── a revocation is described by name, never by id ──");
  const staffSessionId = sec.body?.sessions?.find((x: any) => x.kind === "staff")?.id;
  check("the staff session is revocable", Boolean(staffSessionId));
  const revokeStaff = await api("security", { method: "DELETE", body: JSON.stringify({ sessionId: staffSessionId }) });
  check("the owner can end a staff session", revokeStaff.status === 200, JSON.stringify(revokeStaff.body).slice(0, 80));
  const afterLog = await api("security");
  const revokeLog = (afterLog.body?.logs ?? []).find((l: any) => l.action === "SESSION_REVOKED");
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  check("the new audit line names the person", String(revokeLog?.meta ?? "").includes("Ravi Staff"), String(revokeLog?.meta));
  check("and carries no session id", !UUID_RE.test(String(revokeLog?.meta ?? "")), String(revokeLog?.meta));
  check("no audit row anywhere in the payload shows an id",
    (afterLog.body?.logs ?? []).every((l: any) => !UUID_RE.test(`${l.meta ?? ""} ${l.actor?.name ?? ""}`)),
    JSON.stringify((afterLog.body?.logs ?? []).find((l: any) => UUID_RE.test(String(l.meta ?? "")))?.meta));

  console.log("\n── revoke all spares the session doing it ──");
  const revokeAll = await api("security", { method: "PATCH", body: JSON.stringify({ action: "revoke_all" }) });
  check("revoke all succeeds", revokeAll.status === 200, JSON.stringify(revokeAll.body).slice(0, 90));
  sec = await api("security");
  const stillThere = (sec.body?.sessions ?? []).find((s: any) => s.kind === "owner");
  check("the owner is still signed in", Boolean(stillThere), JSON.stringify((sec.body?.sessions ?? []).map((s: any) => s.kind)));
  check("the staff PIN session was revoked", !(sec.body?.sessions ?? []).some((s: any) => s.kind === "staff"));
  const stillWorks = await api("security");
  check("and the owner's token still works afterwards", stillWorks.status === 200, String(stillWorks.status));
} finally {
  sqlq(`delete from staff_sessions where staff_id in (select id from staff where tenant_id='${tenant.id}');
delete from staff where tenant_id='${tenant.id}';
delete from roles where tenant_id='${tenant.id}';`);
  await admin.from("security_logs").delete().eq("tenant_id", tenant.id);
  await admin.from("profiles").delete().eq("id", user.id);
  await admin.from("tenants").delete().eq("id", tenant.id);
  await admin.auth.admin.deleteUser(user.id);
  console.log("\n  scratch restaurant removed");
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
