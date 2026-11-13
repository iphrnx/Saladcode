/**
 * Signing out, from every place that offers it.
 *
 * The phone drawer's button had no handler at all, so this checks the outcome
 * rather than the click: after tapping it the session must be *gone*, not merely
 * redirected. It proves that by asking for a protected page afterwards — a
 * cosmetic redirect would leave the session alive and the page would load.
 *
 *   npm run test:sign-out
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9911);
const PROFILE = `/tmp/chrome-signout-${PORT}`;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const signIn = async () => {
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
  return data!.session!;
};

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=390,844", "about:blank",
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
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  const ev = async (expr: string) => {
    for (let i = 0; i < 10; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(400);
    }
    return undefined;
  };
  /**
   * A real click, through the browser's input pipeline, at the centre of the
   * element.
   *
   * Synthetic events were enough for plain buttons but not for the drawer, which
   * is Radix: it ignored the dispatched events, the sheet never opened, and the
   * check then reported the Sign out row missing when it was really the drawer
   * that was missing.
   */
  const boxOf = (selectorJs: string) => ev(`(() => {
    const el = ${selectorJs};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
  const clickAt = async (box: string | null) => {
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    return true;
  };

  const arrive = async (session: any) => {
    const hash = new URLSearchParams({
      access_token: session.access_token, refresh_token: session.refresh_token,
      expires_at: String(session.expires_at), expires_in: String(session.expires_in),
      token_type: session.token_type, type: "magiclink",
    }).toString();
    await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
    await sleep(5000);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
    await sleep(11000);
  };
  const signedIn = () => ev(`/Point of Sale|Orders|Active sessions/i.test(document.body.innerText) && !/Sign in to your restaurant dashboard/i.test(document.body.innerText)`);

  // ---- the drawer on a phone --------------------------------------------
  console.log("\n── the phone drawer ──");
  await arrive(await signIn());
  check("signed in to the dashboard", (await signedIn()) === true, String(await ev(`document.body.innerText.slice(0, 100)`)));

  const hamburger = await boxOf(`document.querySelector('button[aria-label="Open main menu"]')`);
  check("the phone's menu button is on screen", await clickAt(hamburger), String(hamburger));
  await sleep(1800);

  // Proof the drawer is up, so "Sign out is missing" cannot mean "the drawer
  // never opened" — which is exactly how this check lied the first time.
  const drawerUp = await ev(`(() => {
    const t = document.body.innerText;
    return /Main Menu/i.test(t) && /Sign out/i.test(t);
  })()`);
  check("the drawer opened, with Sign out in it", drawerUp === true,
    String(await ev(`document.body.innerText.slice(0, 160)`)).replace(/\n/g, " | "));

  const signOutBox = await boxOf(`[...document.querySelectorAll('button')]
    .filter((b) => (b.innerText || '').trim() === 'Sign out')
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0]`);
  check("the Sign out row has an area to press", Boolean(signOutBox), String(signOutBox));
  await clickAt(signOutBox);
  await sleep(7000);

  // Assertions on the address rather than on wording: the app decides where to
  // go from whether the session is still good, and text changes.
  const after = JSON.parse(String(await ev(`JSON.stringify({
    url: window.location.search,
    posVisible: /Point of Sale/i.test(document.body.innerText),
  })`)));
  check("tapping it leaves the dashboard", after.posVisible === false && /view=login/.test(after.url),
    JSON.stringify(after));

  // The part that matters: the session is gone, not just the screen. A live
  // session would render the dashboard here; a dead one bounces to sign in.
  await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
  await sleep(9000);
  const protectedPage = JSON.parse(String(await ev(`JSON.stringify({
    url: window.location.search,
    posVisible: /Point of Sale/i.test(document.body.innerText),
  })`)));
  check("and the session really ended: the dashboard no longer opens",
    protectedPage.posVisible === false && /view=login/.test(protectedPage.url), JSON.stringify(protectedPage));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/sign-out-mobile.png", Buffer.from(shot.data, "base64"));
} catch (e) {
  check("the sign-out checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* gone */ }
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
