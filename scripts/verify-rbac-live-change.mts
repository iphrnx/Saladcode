/**
 * A role changed while the shift is open.
 *
 * The server re-derives the caller's permissions on every request, so a
 * permission taken away is enforced there at once. The page, though, holds the
 * module list it loaded with — and would keep offering a module whose every
 * request now answers 403, for as long as the tab stayed open. This proves the
 * page notices: a refused request makes it re-read its own permissions and drop
 * what it has lost, without a reload and without signing out.
 *
 *   npm run test:rbac-live-change
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// Point the suite at the local edge harness instead of the deployed functions,
// so a change can be verified before it ships:
//   RBAC_BASE_URL=http://127.0.0.1:8787 npm run test:rbac-matrix
const BASE = (process.env.RBAC_BASE_URL ?? SB).replace(/\/$/, "");
const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const PORT = 9611;

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const email = `live-${stamp}@example.com`;
const PIN = "2468";
const employeeId = `L${stamp.toString().slice(-6)}`;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tenantId: string | null = null, uid: string | null = null, roleId: string | null = null;

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-live-${stamp}`,
  "--no-sandbox", "--disable-gpu", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

let ws: WebSocket | null = null; let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (m: string, p: any = {}, s?: string) => new Promise<any>((res) => {
  const i = ++id; pending.set(i, res);
  ws!.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
});

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/functions/v1/${path}`, {
    ...init,
    headers: { apikey: ANON, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

try {
  // ---- a restaurant with a custom role that holds Orders -------------------
  const { data: created } = await admin.auth.admin.createUser({ email, password: "live-123456", email_confirm: true });
  uid = created!.user!.id;
  const { data: tenant } = await admin.from("tenants").insert({
    name: `Live ${stamp}`, slug: `live-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true,
  }).select().single();
  tenantId = tenant!.id;
  const { data: roles } = await admin.from("roles")
    .insert([...DEFAULT_ROLES, {
      name: "Shift Lead", permissions: "dashboard.view,tables.view,orders.view",
      description: "Front of house", is_system: false, color: "#7dd3fc",
    }].map((r) => ({ ...r, tenant_id: tenantId })))
    .select();
  const ownerRole = roles!.find((r) => r.name === "Owner")!;
  roleId = roles!.find((r) => r.name === "Shift Lead")!.id;
  await admin.from("profiles").insert({
    id: uid, tenant_id: tenantId, name: "Live Owner", email, role: "OWNER", role_id: ownerRole.id, active: true,
  });

  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: si } = await c.auth.signInWithPassword({ email, password: "live-123456" });
  const ownerHeaders = { authorization: `Bearer ${si!.session!.access_token}` };
  const made = await call("staff/manage", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ name: "Shift Lead", employeeId, pin: PIN, roleId }),
  });
  check("the staff member was created", made.status < 400, `${made.status} ${JSON.stringify(made.body).slice(0, 140)}`);

  // ---- sign in through the real keypad ------------------------------------
  let version: any = null;
  for (let i = 0; i < 60; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId);
  const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;
  const click = (text: string) => ev(`(() => {
    const b = [...document.querySelectorAll('button, [aria-label]')].find((x) => new RegExp(${JSON.stringify(text)}, 'i').test(x.getAttribute('aria-label') || x.textContent || ''));
    if (!b) return 'missing';
    for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return 'clicked';
  })()`);
  const rail = () => ev(`JSON.stringify([...document.querySelectorAll('aside [aria-label], nav [aria-label]')].map((b) => b.getAttribute('aria-label')))`);
  const body = () => ev(`document.body.innerText.slice(0, 400)`);

  await send("Page.navigate", { url: `${SITE}/?view=staff-login&tenant=${tenant!.slug}` }, sessionId);
  await sleep(7000);
  await click("Shift Lead");
  await sleep(1500);
  for (const d of PIN.split("")) { await click(`^${d}$`); await sleep(200); }
  await sleep(9000);

  const before = JSON.parse(String(await rail()) || "[]");
  check("the rail offers Orders while the role holds it", before.some((l: string) => /orders/i.test(l)), JSON.stringify(before));

  // ---- take orders.view away, mid-session ---------------------------------
  const { error: revokeError } = await admin.from("roles")
    .update({ permissions: "dashboard.view,tables.view" }).eq("id", roleId);
  check("the role was changed in the database", !revokeError, revokeError?.message ?? "");

  // The page is not reloaded and nobody signs in again. The delta poll it is
  // already running answers 403, which is the signal to re-read.
  let after: string[] = before;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    after = JSON.parse(String(await rail()) || "[]");
    if (!after.some((l: string) => /orders/i.test(l))) break;
  }
  check("the rail drops Orders once the role has lost it", !after.some((l: string) => /orders/i.test(l)),
    `still ${JSON.stringify(after)}`);
  check("the staff member is still signed in, not bounced to a login page",
    !/employee id|enter your pin/i.test(String(await body())), String(await body()).slice(0, 200));

  // And the module they were left on is one they still hold.
  const shown = String(await body());
  check("they land on a module the role still opens", !/access denied|do not have permission/i.test(shown),
    shown.slice(0, 200));

  // ---- give it back: the page should pick it up too ------------------------
  await admin.from("roles").update({ permissions: "dashboard.view,tables.view,orders.view" }).eq("id", roleId);
  await call("orders/sync?tenantId=" + tenantId + "&since=1970-01-01T00:00:00Z", { headers: { "x-staff-session": "x" } });
  let restored: string[] = after;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    // A reload is the honest way back for a grant: the page has no reason to
    // re-read on success, and none is needed until something is refused.
    await send("Page.navigate", { url: `${SITE}/?view=staff-dashboard` }, sessionId);
    await sleep(4000);
    restored = JSON.parse(String(await rail()) || "[]");
    if (restored.some((l: string) => /orders/i.test(l))) break;
  }
  check("Orders comes back after a reload once the role holds it again",
    restored.some((l: string) => /orders/i.test(l)), JSON.stringify(restored));
} catch (e) {
  check("the live-change checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  if (tenantId) {
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId);
    await admin.from("profiles").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  if (uid) await admin.auth.admin.deleteUser(uid).catch(() => {});
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
