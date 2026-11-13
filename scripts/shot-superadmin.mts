/**
 * Screenshot a Super Admin page.
 *
 * The admin sign-in is an email code. The code is read from the admin API's
 * own magic-link response, so the browser never has to receive an email.
 *
 *   PAGE=ai-provider OUT=/root/downloads/ai-provider.png npx tsx scripts/shot-superadmin.mts
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const PAGE = process.env.PAGE ?? "ai-provider";
const OUT = process.env.OUT ?? `/root/downloads/superadmin-${PAGE}.png`;
const WIDTH = Number(process.env.WIDTH ?? 1280);
const HEIGHT = Number(process.env.HEIGHT ?? 900);
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
if (error) throw new Error(error.message);
const code = (link!.properties as any).email_otp as string;
if (!code) throw new Error("no otp code came back");

const profile = "/tmp/chrome-superadmin-profile";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", "--remote-debugging-port=9229", `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  `--window-size=${WIDTH},${HEIGHT}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws!.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evalJs(expression: string, sessionId: string) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  return r.result?.value;
}

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch("http://127.0.0.1:9229/json/version")).json(); break; }
    catch { await sleep(250); }
  }
  if (!version) throw new Error("Chrome did not start");
  ws = new WebSocket(version.webSocketDebuggerUrl) as unknown as WebSocket;
  await new Promise((r) => (ws!.onopen = r));
  ws.onmessage = (e: any) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
  };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: WIDTH < 640,
  }, sessionId);

  // Sign in with the code. The address is on the allowlist, so the exchange
  // succeeds. The email is never sent — the code comes from the admin API,
  // which is the point of the test: the page is exercised without depending
  // on the SMTP provider.
  await send("Page.navigate", { url: `${SITE}/superadmin/login` }, sessionId);
  await sleep(4000);

  const signedIn = await evalJs(`(async () => {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, code: ${JSON.stringify(code)} }),
    });
    return res.status + ' ' + (await res.text()).slice(0, 120);
  })()`, sessionId);
  console.log("sign-in:", signedIn);
  await sleep(1500);

  const who = await evalJs(`document.body.innerText.slice(0, 120)`, sessionId);
  console.log("after sign-in:", JSON.stringify(who));

  await send("Page.navigate", { url: `${SITE}/superadmin/${PAGE}` }, sessionId);
  await sleep(7000);
  const text = await evalJs(`document.body.innerText.slice(0, 700)`, sessionId);
  console.log("page says:\n" + text);

  const m = await evalJs(`(() => {
    const de = document.documentElement;
    const wide = [];
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > de.clientWidth + 1) {
        wide.push({ t: e.tagName.toLowerCase(), c: (e.className||'').toString().slice(0,60), w: Math.round(r.width), right: Math.round(r.right) });
      }
    }
    return JSON.stringify({ vw: de.clientWidth, scrollW: de.scrollWidth, docH: de.scrollHeight, wide: wide.slice(0, 6) });
  })()`, sessionId);
  console.log("metrics:", m);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("saved", OUT);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
