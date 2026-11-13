/**
 * The onboarding wizard's dark/light toggle.
 *
 * The wizard renders without the app shell — where the app theme is normally
 * applied — so setup always opened light and offered no way to change it.
 * The wizard now applies the stored theme on mount and carries a toggle in
 * the header: it must flip instantly (no reload), hold across steps, and
 * survive a refresh, in both directions. Step 3's Menu Theme cards choose
 * the customer's palette and must keep showing their own under either
 * wizard theme.
 *
 * Needs the dev server running:
 *   npm run dev
 *   npm run test:onboarding-theme
 *
 * Creates a throwaway tenant-less account (the true first-run case) and
 * deletes it at the end. Set ONBOARDING_TEST_SITE to point elsewhere.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.ONBOARDING_TEST_SITE ?? "http://localhost:3000";
// A unique port per run: a chrome that outlives its suite keeps the debug
// port, and the next run's /json/version poll would connect to the zombie —
// driving a browser whose localStorage still holds the last run's theme.
const PORT = Number(process.env.CDP_PORT ?? 20000 + (process.pid % 20000));
const PROFILE = `/tmp/chrome-onb-theme-${PORT}`;
// A previous run's profile may have survived its exit cleanup (chrome keeps
// writing while it shuts down) — and with it, a stored theme that would
// defeat the "fresh browser" half of this suite.
fs.rmSync(PROFILE, { recursive: true, force: true });
const EMAIL = `wizardtheme${Date.now()}@example.com`;
const PASSWORD = `Wz!${Date.now()}aB`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: created, error: createErr } = await admin.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
});
if (createErr || !created.user) {
  console.error("could not create the test user:", createErr?.message);
  process.exit(1);
}
const userId = created.user.id;

// The login endpoint refuses an account without a profile row, so the
// fixture mirrors what register would have made: a tenant mid-onboarding
// (trial running, onboarding not done) and its owner profile.
const { data: tenant, error: tenantErr } = await admin
  .from("tenants")
  .insert({
    name: "Theme Test Cafe",
    slug: `theme-test-${Date.now()}`,
    plan: "pro",
    subscription_status: "trial",
    subscription_plan: null,
    trial_started_at: new Date().toISOString(),
    trial_ends_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    currency: "INR",
    currency_symbol: "₹",
    active: true,
  })
  .select()
  .single();
if (tenantErr || !tenant) {
  console.error("could not create the test tenant:", tenantErr?.message);
  await admin.auth.admin.deleteUser(userId);
  process.exit(1);
}
const { error: profileErr } = await admin.from("profiles").insert({
  id: userId,
  tenant_id: tenant.id,
  name: "Theme Tester",
  email: EMAIL,
  role: "OWNER",
  role_id: null,
  active: true,
});
if (profileErr) {
  console.error("could not create the test profile:", profileErr.message);
  await admin.from("tenants").delete().eq("id", tenant.id);
  await admin.auth.admin.deleteUser(userId);
  process.exit(1);
}

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1000", "about:blank",
], { stdio: "ignore", detached: true });
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

const shot = async (sid: string, name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, sid);
  if (r?.data) {
    fs.writeFileSync(`/tmp/onb-theme-${name}.png`, Buffer.from(r.data, "base64"));
    console.log(`        screenshot: /tmp/onb-theme-${name}.png`);
  }
};

try {
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

  const evaluate = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r?.result?.value;
  };
  /** Wait until the expression returns a truthy value (dev compiles slowly). */
  const waitFor = async (expr: string, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const v = await evaluate(expr);
      if (v) return v;
      await sleep(1000);
    }
    return undefined;
  };
  const isDark = () => evaluate(`document.documentElement.classList.contains('dark')`);
  const bodyHas = (text: string) =>
    evaluate(`(document.body?.innerText || '').includes(${JSON.stringify(text)})`);
  const clickElement = async (finder: string) => {
    // Scroll first, then measure: a button below the fold has viewport
    // coordinates the mouse can't reach, so the click lands nowhere.
    await evaluate(`(() => {
      const el = ${finder};
      if (el) el.scrollIntoView({ block: 'center' });
      return null;
    })()`);
    await sleep(350);
    const box = await evaluate(`(() => {
      const el = ${finder};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    return true;
  };
  // querySelector with an attribute-substring selector proved unreliable over
  // this CDP link (falsy while querySelectorAll saw the element); find()
  // over the full button list matches the way the diagnostics do.
  const TOGGLE = `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '').includes('mode'))`

  // ---- fresh browser: the app's own default applies ---------------------
  console.log("\n── fresh browser: the app default applies ──");
  // Sign in through the real form. The account was created auto-confirmed,
  // so the password grant needs no email — the same place a new owner lands
  // after confirming theirs. (The magic-link hash can't be used: the root
  // page hands those to the admin panel, which signs a non-admin back out.)
  await send("Page.navigate", { url: `${SITE}/?view=login` }, sessionId);
  await waitFor(`(document.body?.innerText || '').includes('Welcome back')`);
  const fill = (selector: string, value: string) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'not found';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
  // The SSR'd form is visible before React hydrates it. A value set into an
  // unhydrated controlled input sits in the DOM without reaching React
  // state — and the next state change (the other field's fill) re-renders
  // and wipes it. Fill both, then re-read both, until both hold at once.
  const EMAIL_SEL = "input[type='email']";
  const PW_SEL = "input[placeholder='••••••••']";
  let credsOk = false;
  for (let i = 0; i < 12 && !credsOk; i++) {
    await fill(EMAIL_SEL, EMAIL);
    await fill(PW_SEL, PASSWORD);
    await sleep(800);
    const e = await evaluate(`document.querySelector(${JSON.stringify(EMAIL_SEL)})?.value ?? null`);
    const p = await evaluate(`document.querySelector(${JSON.stringify(PW_SEL)})?.value ?? null`);
    credsOk = e === EMAIL && p === PASSWORD;
  }
  check("the login form takes the credentials", credsOk);
  await clickElement(`document.querySelector('form button[type="submit"]')`);
  const opened = await waitFor(`(document.body?.innerText || '').includes('Step 1 / 5')`);
  check("the wizard opened", opened === true);
  // Dismiss the cookie banner so it can't sit over a button we click later.
  await clickElement(`[...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Accept All')`);
  const defaultDark = (await isDark()) === true;
  check("the app default (dark) is applied", defaultDark);
  if (!defaultDark) {
    console.log("        [diag] html class:", await evaluate("document.documentElement.className || '(empty)'"));
    console.log("        [diag] stored theme:", await evaluate("localStorage.getItem('the-salad-theme')"));
    console.log("        [diag] prefers dark:", await evaluate("matchMedia('(prefers-color-scheme: dark)').matches"));
  }
  const toggleThere = (await waitFor(`Boolean(${TOGGLE})`, 15)) === true;
  check("the toggle is in the header", toggleThere);
  if (!toggleThere) {
    console.log("        [diag] url:", await evaluate("location.href"));
    console.log("        [diag] labels:", await evaluate(
      "[...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean).join(' | ')"));
    console.log("        [diag] header:", String(await evaluate(
      "document.querySelector('header')?.outerHTML?.slice(0, 400) ?? 'no header'")).replace(/\s+/g, " "));
  }

  // ---- the toggle flips instantly, with no reload ------------------------
  console.log("\n── the toggle flips instantly, no reload ──");
  // Click until the theme actually flips: a bare "the button was clicked"
  // says nothing if the press landed during a re-render.
  let flipped = false;
  for (let i = 0; i < 6 && !flipped; i++) {
    await waitFor(`Boolean(${TOGGLE})`, 15);
    await clickElement(TOGGLE);
    await sleep(700);
    flipped = (await isDark()) === false;
  }
  check("the toggle clicks", flipped);
  await sleep(800);
  check("light applies immediately", (await isDark()) === false);
  check("the wizard did not leave step 1", (await bodyHas("Step 1 / 5")) === true);
  check("the choice is stored",
    (await evaluate(`localStorage.getItem('the-salad-theme')`)) === "light");
  await shot(sessionId, "step1-light");

  // ---- it survives a refresh ---------------------------------------------
  console.log("\n── it survives a refresh ──");
  await send("Page.reload", {}, sessionId);
  await waitFor(`(document.body?.innerText || '').includes('Step 1 / 5')`);
  check("still light after a reload", (await isDark()) === false);

  // ---- and holds across steps ---------------------------------------------
  console.log("\n── and holds across steps ──");
  // Same hydration rule as the login form: fill, re-read, repeat until held.
  const NAME_SEL = "main form input:not([type='file'])";
  for (let i = 0; i < 12; i++) {
    await evaluate(`(() => {
    const el = document.querySelector("main form input:not([type='file'])");
    if (!el) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'Theme Test Cafe');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'set';
  })()`);
    await sleep(700);
    const v = await evaluate(`document.querySelector(${JSON.stringify(NAME_SEL)})?.value ?? null`);
    if (v === "Theme Test Cafe") break;
  }
  const continued = await clickElement(
    `[...document.querySelectorAll('main button')].find((b) => (b.innerText || '').trim() === 'Continue')`);
  check("step 1's Continue clicks", continued === true);
  let step2 = (await bodyHas("Step 2 / 5")) === true;
  for (let i = 0; i < 5 && !step2; i++) {
    await clickElement(
      `[...document.querySelectorAll('main button')].find((b) => (b.innerText || '').trim() === 'Continue')`);
    await sleep(900);
    step2 = (await bodyHas("Step 2 / 5")) === true;
  }
  check("step 2 is reached", step2);
  check("still light on step 2", (await isDark()) === false);
  let dark2 = false;
  for (let i = 0; i < 6 && !dark2; i++) {
    await waitFor(`Boolean(${TOGGLE})`, 15);
    await clickElement(TOGGLE);
    await sleep(700);
    dark2 = (await isDark()) === true;
  }
  check("dark applies immediately on step 2", dark2);
  await shot(sessionId, "step2-dark");

  // ---- step 3 in dark: the menu cards keep their own palettes -------------
  console.log("\n── step 3: the menu cards keep their own palettes ──");
  await evaluate(`localStorage.setItem('the-salad-onboarding', JSON.stringify({
    ownerId: ${JSON.stringify(userId)}, step: 3, updatedAt: Date.now(),
  }))`);
  await send("Page.reload", {}, sessionId);
  await waitFor(`(document.body?.innerText || '').includes('Step 3 / 5')`);
  check("the wizard resumed on step 3", (await bodyHas("Step 3 / 5")) === true);
  check("still dark after the jump", (await isDark()) === true);
  const previews = await evaluate(`[...document.querySelectorAll('main div.light, main div.dark')]
    .map((w) => {
      const inner = w.querySelector('.bg-background');
      const bg = inner ? getComputedStyle(inner).backgroundColor : null;
      return { theme: w.classList.contains('dark') ? 'dark' : 'light', bg };
    })`);
  const lightPreview = previews?.find((p: any) => p.theme === "light")?.bg ?? "";
  const darkPreview = previews?.find((p: any) => p.theme === "dark")?.bg ?? "";
  const rgb = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const lum = (s: string) => { const [r, g, b] = rgb(s); return (r ?? 0) + (g ?? 0) + (b ?? 0); };
  check("the light menu preview stays light under the dark wizard",
    lum(lightPreview) > 600, `light preview bg: ${lightPreview}`);
  check("the dark menu preview stays dark",
    lum(darkPreview) > 0 && lum(darkPreview) < 200, `dark preview bg: ${darkPreview}`);
  await shot(sessionId, "step3-dark");
  let light3 = false;
  for (let i = 0; i < 6 && !light3; i++) {
    await waitFor(`Boolean(${TOGGLE})`, 15);
    await clickElement(TOGGLE);
    await sleep(700);
    light3 = (await isDark()) === false;
  }
  check("back to light on step 3", light3);
  await shot(sessionId, "step3-light");
} finally {
  // chrome.kill() alone reaches only the launcher process — the browser tree
  // survived it once and the zombie's stored theme contaminated the next
  // run. Kill the whole group.
  try { process.kill(-chrome.pid!, "SIGKILL"); } catch { chrome.kill("SIGKILL"); }
  await admin.from("profiles").delete().eq("id", userId);
  await admin.from("tenants").delete().eq("id", tenant.id);
  await admin.auth.admin.deleteUser(userId);
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
