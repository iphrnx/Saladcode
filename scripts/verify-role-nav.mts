/**
 * What each role actually sees, in a browser.
 *
 * The API matrix proves the endpoints refuse; this proves the app stops
 * offering what was refused, and that a role never lands somewhere misleading.
 * For every role it signs in the way a staff member does — their name, then
 * their PIN — and checks two things:
 *
 *   1. the module rail lists exactly the modules the role's permissions imply,
 *   2. typing an app URL (`/?view=settings`) never shows a screen the role does
 *      not hold, and never dumps them on the owner sign-in page — which is
 *      where a staff member used to end up, told to sign in as someone they
 *      are not.
 *
 * The roles include a custom one, built with a combination no system role has,
 * so the check is not just re-reading the seeded defaults.
 *
 *   npm run test:role-nav
 *   RBAC_VIEWS=all npm run test:role-nav     # every view, every role
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

/**
 * Read a role's `permissions` column the way the server does.
 *
 * `_shared/auth.ts` has the real `splitPermissions`, but it pulls in the Deno
 * database module and will not load in Node. This mirrors its rule: a text
 * column that may hold either a comma list or a JSON array. A naive `split(",")`
 * reads the JSON form as one long permission that matches nothing — which looks
 * exactly like a role holding nothing, and would make this test lie.
 */
function readPermissions(raw: unknown): string[] {
  const value = String(raw ?? "").trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      /* not JSON — fall through */
    }
  }
  return value.split(",").map((p) => p.trim()).filter(Boolean);
}

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const PORT = Number(process.env.CDP_PORT ?? 9501);
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else {
    fail++;
    failures.push(label);
  }
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    ...init,
    headers: { apikey: ANON, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

/**
 * The roles to walk through, and the PIN each one signs in with.
 *
 * `Host` is custom, created below: it can see the floor and the order book and
 * can ring nothing up. No seeded role has that shape — Waiter, the closest,
 * also holds orders.manage — so it is the one that tests the write gates.
 */
const CUSTOM_ROLE = { name: "Host", permissions: ["dashboard.view", "tables.view", "orders.view"] };
const ROLES: { name: string; pin: string; custom?: boolean }[] = [
  { name: "Manager", pin: "1234" },
  { name: "Cashier", pin: "2345" },
  { name: "Kitchen", pin: "3456" },
  { name: "Waiter", pin: "4567" },
  { name: "Host", pin: "5678", custom: true },
];

/**
 * Which modules a role should be offered, stated as a rule over its
 * permissions rather than as a copy of the server's map — the point is to
 * catch the two drifting apart. These mirror `_shared/staff-modules.ts` (the
 * single source `staff/index.ts` serves), which in turn mirrors the client's
 * VIEW_PERMISSIONS: a module is offered only when the role holds the key the
 * module's screens and data endpoints actually require. The QR module is the
 * one that used to drift — offered on `tables.view` while the screen and
 * `/api/qr` demand `qr.manage`, which handed a Cashier a "Tables & QR" module
 * that answered 403 on every load.
 */
const MODULE_RULES: { module: string; label: RegExp; holds: (p: string[]) => boolean }[] = [
  { module: "dashboard", label: /dashboard|point of sale|\bpos\b/i, holds: (p) => p.includes("dashboard.view") && p.includes("tables.view") },
  { module: "orders", label: /orders/i, holds: (p) => p.includes("orders.view") },
  { module: "menu", label: /menu/i, holds: (p) => p.includes("menu.view") },
  { module: "qr", label: /\btables?\b|qr/i, holds: (p) => p.includes("qr.manage") },
  { module: "promos", label: /promo/i, holds: (p) => p.includes("promos.view") },
  { module: "analytics", label: /analytic/i, holds: (p) => p.includes("analytics.view") },
  { module: "roles", label: /role|staff/i, holds: (p) => ["roles.view", "roles.manage", "staff.view", "staff.manage"].some((k) => p.includes(k)) },
  { module: "security", label: /security/i, holds: (p) => p.includes("security.view") },
  { module: "settings", label: /settings/i, holds: (p) => p.includes("settings.view") },
];

/** The views to type in directly. `all` walks every one. */
const TYPED_VIEWS =
  process.env.RBAC_VIEWS === "all"
    ? ["dashboard", "orders", "menu", "qr", "promos", "analytics", "roles", "security", "settings", "billing"]
    : ["orders", "menu", "qr", "roles", "settings"];

const email = `nav-test-${stamp}@example.com`;
let tenantId: string | null = null;
let ownerUserId: string | null = null;

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-nav-${stamp}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
const send = (method: string, params: any = {}, sid?: string) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws!.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

try {
  // ---- a restaurant with one staff member per role -------------------------
  //
  // Provisioned through the admin API rather than `auth/register`: email
  // confirmation is on and the sending domain is not verified yet, so a real
  // signup answers 429 — which would make this unrunnable for a reason that has
  // nothing to do with permissions. Same rows, same `DEFAULT_ROLES`.
  const password = "nav-test-123456";
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name: "Nav Test" },
  });
  if (authError || !created?.user) throw new Error(`createUser: ${authError?.message}`);
  ownerUserId = created.user.id;

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: `Nav Test ${stamp}`, slug: `nav-test-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true })
    .select().single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  tenantId = tenant.id;

  const { data: seeded, error: rolesError } = await admin
    .from("roles")
    .insert(
      [
        ...DEFAULT_ROLES,
        { ...CUSTOM_ROLE, permissions: CUSTOM_ROLE.permissions.join(","), description: "Front of house", is_system: false, color: "#7dd3fc" },
      ].map((r) => ({ ...r, tenant_id: tenant.id })),
    )
    .select();
  if (rolesError) throw new Error(`roles: ${rolesError.message}`);

  const { error: profileError } = await admin.from("profiles").insert({
    id: ownerUserId, tenant_id: tenant.id, name: "Nav Test", email,
    role: "OWNER", role_id: (seeded ?? []).find((r) => r.name === "Owner")?.id ?? null, active: true,
  });
  if (profileError) throw new Error(`profile: ${profileError.message}`);

  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await c.auth.signInWithPassword({ email, password });
  if (signInError || !signIn?.session) throw new Error(`signIn: ${signInError?.message}`);
  const ownerHeaders = { authorization: `Bearer ${signIn.session.access_token}` };

  const roleByName = new Map((seeded ?? []).map((r) => [r.name, r]));
  const permissionsFor: Record<string, string[]> = {};
  const pins: Record<string, string> = {};

  for (const [i, role] of ROLES.entries()) {
    const row = roleByName.get(role.name);
    if (!row) throw new Error(`the ${role.name} role is missing`);
    permissionsFor[role.name] = readPermissions(row.permissions);
    pins[role.name] = role.pin;
    const made = await call("staff/manage", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: `${role.name} Tester`, employeeId: `N${String(stamp).slice(-5)}${i}`, pin: role.pin, roleId: row.id }),
    });
    check(`a ${role.name} staff member exists`, made.status < 400, `${made.status} ${JSON.stringify(made.body).slice(0, 140)}`);
  }

  // ---- a browser -----------------------------------------------------------
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  /**
   * What the page is showing right now.
   *
   * Returns null while the page is between documents: a navigation destroys the
   * execution context, and evaluating in the gap yields nothing at all — which
   * `JSON.parse` would report as a syntax error, hiding the real state of the
   * test behind a message about "undefined".
   */
  const readState = async () => {
    const raw = await ev(`JSON.stringify({
      text: document.body.innerText.slice(0, 900),
      navLabels: [...document.querySelectorAll('aside [aria-label], nav [aria-label]')].map((b) => b.getAttribute('aria-label') || ''),
      header: (document.querySelector('header h1, header h2, [data-module-label]')?.textContent || '').trim(),
      url: location.href,
      accessDenied: /Access Denied|do not have permission/i.test(document.body.innerText),
      ownerLogin: /Sign In to your restaurant dashboard|SELECT YOUR NAME/i.test(document.body.innerText),
    })`);
    if (typeof raw !== "string") return null;
    try { return JSON.parse(raw); } catch { return null; }
  };

  /**
   * Read the page once it has stopped moving.
   *
   * A fixed sleep is not enough: on a dev server each view compiles the first
   * time it is opened, and a screen still saying "Loading your role
   * workspace…" would be recorded as a broken one. Wait for the shell to
   * arrive — the rail, or a refusal — and only then read.
   */
  const settle = async (timeoutMs = 25_000) => {
    const started = Date.now();
    let last: any = null;
    for (;;) {
      const state = await readState();
      if (state) last = state;
      if (state && (state.navLabels.length > 0 || state.accessDenied)) return state;
      if (Date.now() - started > timeoutMs) {
        return last ?? { text: "", navLabels: [], header: "", url: "", accessDenied: false, ownerLogin: false };
      }
      await sleep(400);
    }
  };

  for (const role of ROLES) {
    const held = permissionsFor[role.name];
    console.log(`\n${role.name} — ${held.length} permissions`);

    // A fresh browser identity each time, so the previous role's session cannot
    // be what answers the next role's request.
    await send("Network.clearBrowserCookies", {}, sessionId);
    await send("Storage.clearDataForOrigin", { origin: SITE, storageTypes: "all" }, sessionId);

    // Sign in the way a staff member does: their name, then their PIN.
    //
    // Not by splicing the session cookie in: the staff cookie is issued by
    // supabase.co and is a partitioned third-party cookie, so it only works when
    // the browser stores it as a result of the real cross-origin login. Setting
    // it against the site's own hostname silently does nothing — and a check
    // built on that passes while proving nothing.
    await send("Page.navigate", { url: `${SITE}/?view=staff-login&tenant=${tenant.slug}` }, sessionId);
    await sleep(9000);
    const clickedName = await ev(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /${role.name} Tester/.test(b.textContent || ''));
      if (!btn) return 'name not listed';
      for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      return 'clicked';
    })()`);
    check(`${role.name} is listed on the sign-in page`, clickedName === "clicked", String(clickedName));
    await sleep(1500);
    const pinResult = await ev(`(async () => {
      for (const digit of ${JSON.stringify(role.pin.split(""))}) {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === digit);
        if (!b) return 'no keypad digit ' + digit;
        for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        await new Promise((r) => setTimeout(r, 250));
      }
      return 'entered';
    })()`);
    check(`${role.name}'s PIN is accepted by the keypad`, pinResult === "entered", String(pinResult));
    await sleep(4000);

    const state = await settle();
    console.log(`  rail: ${JSON.stringify(state.navLabels)}`);
    check(`${role.name} lands in the app, not back on a login page`, state.ownerLogin === false, String(state.text).slice(0, 200));
    // Every check below reads the rail, so an empty list would make them all
    // pass by finding nothing — which is how a check stops testing anything.
    check(`${role.name}'s module rail was found`, state.navLabels.length > 0, JSON.stringify(state.navLabels));

    for (const rule of MODULE_RULES) {
      const offered = state.navLabels.some((l: string) => rule.label.test(l));
      const expected = rule.holds(held);
      check(
        `${role.name} ${expected ? "is offered" : "is not offered"} ${rule.module}`,
        offered === expected,
        `rail ${JSON.stringify(state.navLabels)} (holds ${held.join(",") || "nothing"})`,
      );
    }
    check(`${role.name} is not offered anything outside its permissions`,
      state.navLabels.every((l: string) => MODULE_RULES.some((r) => r.label.test(l) && r.holds(held))),
      JSON.stringify(state.navLabels));

    // ---- typing an app URL ------------------------------------------------
    for (const view of TYPED_VIEWS) {
      await send("Page.navigate", { url: `${SITE}/?view=${view}` }, sessionId);
      await sleep(1200);
      const typed = await settle();
      const label = `${role.name} typing /?view=${view}`;
      check(`${label} does not land on the owner sign-in page`, typed.ownerLogin === false, String(typed.text).slice(0, 180));
      // Typed-in URLs are refused by redirect, not by a full-page denial: the
      // staff member is moved to a module their role opens (or their first
      // module), and never shown an "Access Denied" screen.
      check(`${label} shows the app, never an Access Denied screen`, typed.navLabels.length > 0 && typed.accessDenied === false, String(typed.text).slice(0, 180));
      check(`${label} stays inside the staff shell`, /view=staff-dashboard/.test(typed.url || ""), `url "${typed.url}"`);
      const leaked = MODULE_RULES.filter((r) => !r.holds(held) && r.label.test(typed.header));
      check(`${label} does not open a module the role lacks`, leaked.length === 0, `header "${typed.header}"`);
    }

    if (role.name === "Kitchen") {
      await send("Page.navigate", { url: `${SITE}/?view=staff-dashboard` }, sessionId);
      await sleep(3000);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      fs.writeFileSync("/root/downloads/kitchen-nav.png", Buffer.from(shot.data, "base64"));
      console.log("  screenshot: /root/downloads/kitchen-nav.png");
    }
  }
} catch (e) {
  check("the browser checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  if (tenantId) {
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId).eq("is_system", false);
    for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs"]) {
      await admin.from(t).delete().eq("tenant_id", tenantId);
    }
    await admin.from("profiles").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(() => {});
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
