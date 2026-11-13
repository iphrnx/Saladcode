/**
 * iPhone (HEIC) menu upload, driven through the real file input in a real
 * browser against the running site.
 *
 *   - a genuine HEIC (his own menu photo re-encoded) converts and appears
 *     as a JPEG thumbnail
 *   - a corrupt .heic names itself in an error toast, the loading toast is
 *     ALWAYS dismissed, and the good thumbnails survive
 *   - a batch of two HEICs converts one after another
 *
 * Headless Chrome has no native HEIC decoder, so every case here exercises
 * the WASM fallback under its timeout — the path that used to hang.
 * On an iPhone the same code goes through the OS decoder instead.
 *
 *   npm run test:heic-upload
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const EMAIL = `heic-${Date.now()}@example.com`;
const PASSWORD = `HE${Math.random().toString(36).slice(2)}!x`;
const PORT = Number(process.env.CDP_PORT ?? 10417);
const PROFILE = `/tmp/chrome-heic-${PORT}`;
const GOOD = "/tmp/heic-test/menu-photo.heic";
const BIG = "/tmp/heic-test/big-photo.heic";
const BROKEN = "/tmp/heic-test/broken.heic";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: created, error: createError } = await admin.auth.admin.createUser({
  email: EMAIL, password: PASSWORD, email_confirm: true,
});
if (createError || !created.user) throw new Error(`user: ${createError?.message}`);
const { data: tenant } = await admin.from("tenants").insert({
  name: "HEIC Test Cafe", slug: `heic-${Date.now()}`, plan: "pro",
  subscription_status: "trial", subscription_plan: null,
  trial_started_at: new Date().toISOString(),
  trial_ends_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
  currency: "INR", currency_symbol: "₹", active: true,
}).select().single();
await admin.from("roles").insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenant!.id })));
await admin.from("profiles").insert({ id: created.user.id, tenant_id: tenant!.id, name: "HEIC Test", email: EMAIL, role: "OWNER" });

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
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
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  const consoleLogs: string[] = [];
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
    if (m.method === "Runtime.consoleAPICalled") {
      consoleLogs.push(m.params.args.map((a: any) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 400));
    }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("DOM.enable", {}, sessionId);
  const ev = async (expr: string) => {
    for (let i = 0; i < 8; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(300);
    }
    return undefined;
  };
  /** Poll the page until the expression is truthy or the deadline passes. */
  const until = async (expr: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await ev(expr)) return true;
      await sleep(750);
    }
    return false;
  };

  // Sign in through the real form (magic-link hashes route to the admin panel).
  await send("Page.navigate", { url: `${SITE}/?view=login` }, sessionId);
  await sleep(6000);
  const loggedIn = await ev(`(() => {
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const email = document.querySelector('input[type="email"]');
    const pass = document.querySelector('input[type="password"]');
    if (!email || !pass) return 'no form';
    set(email, ${JSON.stringify(EMAIL)});
    set(pass, ${JSON.stringify(PASSWORD)});
    (document.querySelector('button[type="submit"]'))?.click();
    return 'submitted';
  })()`);
  if (loggedIn !== 'submitted') throw new Error(`login: ${loggedIn}`);
  await sleep(9000);
  if (!String(await ev("location.href") ?? "").includes("view=onboarding")) {
    await send("Page.navigate", { url: `${SITE}/?view=onboarding` }, sessionId);
    await sleep(9000);
  }
  // The upload control lives on step 2 — move the flow's own draft there,
  // waiting for the flow to have actually written it first.
  const moved = await until(`(() => {
    const raw = localStorage.getItem('the-salad-onboarding');
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      if (d.step === 2) return true;
      d.step = 2;
      localStorage.setItem('the-salad-onboarding', JSON.stringify(d));
      return true;
    } catch { return false; }
  })()`, 20000);
  if (!moved) throw new Error("no onboarding draft to move");
  await send("Page.reload", {}, sessionId);
  await sleep(9000);
  const stepUp = await until(`document.body.innerText.includes('Drop menu photos')`, 15000);
  if (!stepUp) {
    // Step 2 opens on a choice screen — the dropzone is behind "Start AI import".
    await ev(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /Start AI import/i.test(b.textContent || ''));
      btn?.click();
      return Boolean(btn);
    })()`);
  }
  check("step 2 dropzone is up", await until(`document.body.innerText.includes('Drop menu photos')`, 15000),
    `page says: ${String(await ev("document.body.innerText.slice(0, 500)") ?? "").replace(/\n+/g, " | ")}`);

  const { root } = await send("DOM.getDocument", { depth: -1 }, sessionId);
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' }, sessionId);
  if (!nodeId) throw new Error("file input not found");
  // Toasts auto-dismiss after a few seconds — record every one as it appears.
  await ev(`(() => {
    window.__toastLog = [];
    const t0 = Date.now();
    new MutationObserver(() => {
      document.querySelectorAll('[data-sonner-toast]').forEach((t) => {
        const txt = (t.textContent || '').slice(0, 200);
        if (txt && !window.__toastLog.some((e) => e.txt === txt)) {
          window.__toastLog.push({ at: Date.now() - t0, txt });
        }
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);

  const thumbCount = `document.querySelectorAll('img[alt^="Menu page"]').length`;
  const thumbIsJpeg = `Array.from(document.querySelectorAll('img[alt^="Menu page"]')).every((i) => i.src.startsWith('data:image/jpeg'))`;
  const loadingGone = `!Array.from(document.querySelectorAll('[data-sonner-toast]')).some((t) => /Converting/.test(t.textContent || ''))`;
  const errorToast = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent || '').join(' | ')`;

  // 1. A genuine HEIC converts and appears as a JPEG thumbnail.
  await send("DOM.setFileInputFiles", { nodeId, files: [GOOD] }, sessionId);
  const goodOk = await until(`${thumbCount} >= 1`, 45000);
  if (!goodOk) {
    console.log("  --- toast log ---");
    console.log("   ", JSON.stringify(await ev("window.__toastLog")));
    console.log("  --- browser console around the failure ---");
    for (const l of consoleLogs.filter((x) => !/DevTools|HMR|React Dev/i.test(x)).slice(-12)) console.log("   ", l);
  }
  check("HEIC thumbnail appears", goodOk, `toasts: ${await ev(errorToast)}`);
  check("thumbnail is JPEG data", Boolean(await ev(thumbIsJpeg)));
  check("loading toast cleared after success", await until(loadingGone, 10000));

  // 2. A corrupt .heic errors by name, clears the toast, keeps the good one.
  await send("DOM.setFileInputFiles", { nodeId, files: [BROKEN] }, sessionId);
  check("corrupt file errors", await until(`(${errorToast}).includes('broken.heic')`, 40000));
  check("loading toast cleared after failure", await until(loadingGone, 10000));
  check("good thumbnail survives the failure", (await ev(thumbCount)) === 1);

  // 3. A batch of two real HEICs converts both.
  await send("DOM.setFileInputFiles", { nodeId, files: [GOOD, BIG] }, sessionId);
  check("batch of two converts", await until(`${thumbCount} >= 3`, 60000), `toasts: ${await ev(errorToast)}`);
  check("batch thumbnails are JPEG", Boolean(await ev(thumbIsJpeg)));
  check("loading toast cleared after batch", await until(loadingGone, 10000));

  const img = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/root/downloads/heic-upload-test.png", Buffer.from(img.data, "base64"));
  console.log("  shot  heic-upload-test.png");
} finally {
  chrome.kill();
  try {
    await admin.auth.admin.deleteUser(created.user.id);
    await admin.from("tenants").delete().eq("id", tenant!.id);
  } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
