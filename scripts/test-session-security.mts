/**
 * Session-lifecycle security regressions.
 *
 *   npm run test:session-security
 *
 * Covers the findings from the November 2026 lifecycle audit: the anon
 * public-read leak (all five tables), the diner token that used to ride in the
 * /active and /listSessions payloads, the header-first validate path, and the
 * cross-tenant / cross-table refusals that guard the rest.
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const ZHUT = "87b90e86-f705-428f-8245-7b3659052443";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};
const anonGet = async (path: string) => {
  const res = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: ANON } });
  return { status: res.status, body: await res.text() };
};
const pub = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SB}/functions/v1/${path}`, { ...init, headers: { apikey: ANON, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const tables = (await admin.from("tables").select("id,name,qr_token").eq("tenant_id", ZHUT).eq("active", true).order("name")).data!;
const t1 = tables[0], t2 = tables[1];
const started = await pub("table-session", { method: "POST", body: JSON.stringify({ qrToken: t1.qr_token }) });
const tok = started.body.sessionToken as string;
const sid = started.body.sessionId as string;

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: "zhut@demo.com" });
const otp = await admin.auth.verifyOtp({ token_hash: (link as any).properties.hashed_token, type: "magiclink" });
const jwt = otp.data.session!.access_token;

try {
  console.log("\n── anon must not read tenant tables through PostgREST ──");
  for (const [name, body] of [
    ["tables", "tables?select=id,qr_token&limit=1"],
    ["tenants", "tenants?select=name&limit=1"],
    ["menu_items", "menu_items?select=name&limit=1"],
    ["categories", "categories?select=name&limit=1"],
    ["customer_reviews", "customer_reviews?select=rating&limit=1"],
  ] as const) {
    const r = await anonGet(body);
    const denied = r.status === 401 || r.status === 403 || r.body.includes("42501");
    check(`anon is denied ${name}`, denied, `${r.status} ${r.body.slice(0, 80)}`);
  }

  console.log("\n── the diner token must not appear in staff payloads ──");
  const active = await fetch(`${SB}/functions/v1/table-session/active`, {
    headers: { apikey: ANON, authorization: `Bearer ${jwt}`, "x-tenant-id": ZHUT },
  });
  const groups = (await active.json()) as any[];
  const sessions = groups.flatMap((g) => g.sessions);
  check("/active has sessions", sessions.length > 0);
  check("/active does not leak a session token", sessions.every((s) => !("token" in s)), JSON.stringify(sessions[0] ?? {}).slice(0, 120));

  const recent = await fetch(`${SB}/functions/v1/table-session/end?tableId=${t1.id}`, {
    headers: { apikey: ANON, authorization: `Bearer ${jwt}`, "x-tenant-id": ZHUT },
  });
  const rows = (await recent.json()) as any[];
  check("/end list does not leak a session token", rows.every((s) => !("token" in s)), JSON.stringify(rows[0] ?? {}).slice(0, 120));

  console.log("\n── the header-first validate path ──");
  const viaHeader = await pub(`table-session/validate?tenantId=${ZHUT}&tableId=${t1.id}`, { headers: { "x-session-token": tok } });
  check("validate accepts the token in a header", viaHeader.status === 200 && viaHeader.body?.sessionStatus === "ACTIVE", `${viaHeader.status}`);
  const viaQuery = await pub(`table-session/validate?sessionToken=${tok}`);
  check("validate still accepts the query fallback", viaQuery.status === 200 && viaQuery.body?.sessionStatus === "ACTIVE", `${viaQuery.status}`);

  console.log("\n── the refusals that were already there ──");
  const garbage = await pub("table-session/validate?sessionToken=" + "0".repeat(48));
  check("a guessed token is refused 401", garbage.status === 401, `${garbage.status}`);
  const crossTable = await pub(`table-session/validate?tenantId=${ZHUT}&tableId=${t2.id}`, { headers: { "x-session-token": tok } });
  check("a session cannot open another table", crossTable.status === 403, `${crossTable.status}`);
  const crossTenant = await fetch(`${SB}/functions/v1/table-session/active`, {
    headers: { apikey: ANON, authorization: `Bearer ${jwt}`, "x-tenant-id": "00000000-0000-0000-0000-000000000000" },
  });
  check("a claimed tenant you do not own is refused", crossTenant.status === 403, `${crossTenant.status}`);
  const noAuth = await fetch(`${SB}/functions/v1/table-session/active`, { headers: { apikey: ANON } });
  check("/active without a session is 401", noAuth.status === 401, `${noAuth.status}`);
} finally {
  await admin.from("table_sessions").delete().eq("id", sid);
  console.log("\n  scratch session removed");
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
