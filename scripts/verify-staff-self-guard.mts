/**
 * The staff card does not offer what the server will refuse.
 *
 * The server will not let you change your own role — `staff.manage` is held by
 * Manager, and the role a Manager would move themselves to is the escalation —
 * and it will not let you act on an account that holds a permission you do not.
 * A card that still offers those controls teaches the wrong thing about what the
 * role can do, and reports a refusal as a broken app.
 *
 *   RBAC_BASE_URL=http://127.0.0.1:8787 npm run test:staff-self-guard
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = (process.env.RBAC_BASE_URL ?? SB).replace(/\/$/, "");
const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const PORT = 9613;

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const email = `guard-${stamp}@example.com`;
const PIN = "1357";
const employeeId = `G${stamp.toString().slice(-6)}`;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shift Lead holds `staff.manage` — the key the card is drawn under. Junior's
// keys are a strict subset of the lead's, so Junior sits below it and stays
// reachable. Boss holds settings, which the lead does not, so Boss sits above
// it and is out of reach.
const SHIFT_LEAD = "dashboard.view,roles.view,staff.view,staff.manage,orders.view,tables.view";
const JUNIOR = "dashboard.view,orders.view";
const BOSS = "dashboard.view,staff.view,settings.view,settings.manage,orders.view,tables.view";

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-guard-${stamp}`,
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

let tenantId: string | null = null, uid: string | null = null;

try {
  const { data: created } = await admin.auth.admin.createUser({ email, password: "guard-123456", email_confirm: true });
  uid = created!.user!.id;
  const { data: tenant } = await admin.from("tenants").insert({
    name: `Guard ${stamp}`, slug: `guard-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true,
  }).select().single();
  tenantId = tenant!.id;

  const { data: roles } = await admin.from("roles")
    .insert([...DEFAULT_ROLES,
      { name: "Shift Lead", permissions: SHIFT_LEAD, description: "Front of house", is_system: false, color: "#7dd3fc" },
      { name: "Junior", permissions: JUNIOR, description: "Below the lead", is_system: false, color: "#86efac" },
      { name: "Boss", permissions: BOSS, description: "Above the lead", is_system: false, color: "#f472b6" },
    ].map((r) => ({ ...r, tenant_id: tenantId })))
    .select();
  const ownerRole = roles!.find((r) => r.name === "Owner")!;
  const leadRole = roles!.find((r) => r.name === "Shift Lead")!;
  const juniorRole = roles!.find((r) => r.name === "Junior")!;
  const bossRole = roles!.find((r) => r.name === "Boss")!;
  await admin.from("profiles").insert({
    id: uid, tenant_id: tenantId, name: "Guard Owner", email, role: "OWNER", role_id: ownerRole.id, active: true,
  });

  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: si } = await c.auth.signInWithPassword({ email, password: "guard-123456" });
  const ownerHeaders = { authorization: `Bearer ${si!.session!.access_token}` };

  const makeStaff = async (name: string, emp: string, roleId: string) => {
    const r = await call("staff/manage", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ name, employeeId: emp, pin: PIN, roleId }),
    });
    return r.body?.id as string;
  };
  const meId = await makeStaff("Shift Lead", employeeId, leadRole.id);
  const juniorId = await makeStaff("Junior", `${employeeId}J`, juniorRole.id);
  const bossId = await makeStaff("Boss", `${employeeId}B`, bossRole.id);
  check("the three staff accounts were created",
    Boolean(meId && juniorId && bossId), JSON.stringify({ meId, juniorId, bossId }));

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

  // Which state is the role selector in, on the card carrying this name?
  const selectorState = (name: string) => ev(`(() => {
    const boxes = [...document.querySelectorAll('[role="combobox"]')];
    // The card is the *shallowest* ancestor that names it. Anything that climbs
    // to the list container matches every card, so the find picks the first box
    // and every answer comes back from the first row.
    let box = null, bestDepth = 9;
    for (const b of boxes) {
      let n = b;
      for (let d = 0; d < 8 && n; d++, n = n.parentElement) {
        if (new RegExp(${JSON.stringify(name)}).test(n.innerText || '')) {
          if (d < bestDepth) { bestDepth = d; box = b; }
          break;
        }
      }
    }
    if (!box) return 'no-combobox';
    return (box.disabled || box.getAttribute('data-disabled') !== null || box.getAttribute('aria-disabled') === 'true')
      ? 'disabled' : 'enabled';
  })()`);

  await send("Page.navigate", { url: `${SITE}/?view=staff-login&tenant=${tenant!.slug}` }, sessionId);
  await sleep(7000);
  await click("Shift Lead");
  await sleep(1500);
  for (const d of PIN.split("")) { await click(`^${d}$`); await sleep(200); }
  await sleep(9000);

  const shown = await ev("document.body.innerText.slice(0, 200)");
  check("the Shift Lead signed in", !/sign in|enter your pin/i.test(String(shown)), String(shown).slice(0, 160));

  // The staff shell lands on the role's first module, so open Roles & Staff
  // from the rail, then the Staff Accounts tab, the way a real user would.
  await click("Roles & Staff");
  await sleep(7000);
  await click("Staff Accounts");
  await sleep(2500);

  check("the staff tab is open", /Staff Accounts/i.test(String(await ev("document.body.innerText.slice(0, 600)"))), "");

  check("your own role selector is disabled", (await selectorState("Shift Lead")) === "disabled", String(await selectorState("Shift Lead")));
  check("a role below yours keeps its selector", (await selectorState("Junior")) === "enabled", String(await selectorState("Junior")));
  check("a role above yours has its selector disabled", (await selectorState("Boss")) === "disabled", String(await selectorState("Boss")));

  // ---- and the server refuses exactly what the card stopped offering -------
  const token = await ev("sessionStorage.getItem('the-salad-staff-token')");
  check("the staff session token is readable", typeof token === "string" && token.length > 10, String(token).slice(0, 40));
  const staffHeaders = { "x-staff-session": String(token), "x-tenant-id": tenantId! };

  const selfMove = await call(`staff/manage/${meId}`, {
    method: "PATCH", headers: staffHeaders, body: JSON.stringify({ roleId: bossRole.id }),
  });
  check("the server refuses your own role change (403)", selfMove.status === 403, `${selfMove.status} ${JSON.stringify(selfMove.body)}`);

  const onBoss = await call(`staff/manage/${bossId}`, {
    method: "PATCH", headers: staffHeaders, body: JSON.stringify({ active: false }),
  });
  check("the server refuses acting on an account above you (403)", onBoss.status === 403, `${onBoss.status} ${JSON.stringify(onBoss.body)}`);

  const onJunior = await call(`staff/manage/${juniorId}`, {
    method: "PATCH", headers: staffHeaders, body: JSON.stringify({ active: false }),
  });
  check("the server still allows acting on an account below you", onJunior.status < 400, `${onJunior.status} ${JSON.stringify(onJunior.body)}`);
} catch (e) {
  check("the staff self-guard checks ran", false, (e as Error).message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill("SIGKILL");
  if (tenantId) {
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId);
    await admin.from("profiles").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  if (uid) await admin.auth.admin.deleteUser(uid).catch(() => {});
  console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
  process.exit(fail ? 1 : 0);
}
