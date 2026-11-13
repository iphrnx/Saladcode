/**
 * Screenshot an owner-dashboard view at a chosen viewport, and measure it.
 *
 * The owner session lives in the browser client's storage, so it is handed to
 * the page the way a magic link hands it over — in the URL fragment, which the
 * Supabase browser client detects and persists.
 *
 *   VIEW=roles WIDTH=390 HEIGHT=844 OUT=/root/downloads/roles.png \
 *   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/shot-view.mts
 *
 * It prints the height of every card and pill it finds, which is how a
 * spacing change gets judged — by the numbers, not by eye.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const VIEW = process.env.VIEW ?? "roles";
const OUT = process.env.OUT ?? "/root/downloads/view.png";
const WIDTH = Number(process.env.WIDTH ?? 390);
const HEIGHT = Number(process.env.HEIGHT ?? 844);
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const REF = "ygibmdkrslquamwflshb";

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({
  token_hash: link!.properties.hashed_token,
  type: "magiclink",
});
const s = session!.session!;

const profile = "/tmp/chrome-view-profile";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", "--remote-debugging-port=9226", `--user-data-dir=${profile}`,
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

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch("http://127.0.0.1:9226/json/version")).json(); break; }
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

  // The Supabase browser client detects a session in the URL and persists it,
  // which is how a magic link works.
  const hash = new URLSearchParams({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: String(s.expires_at),
    expires_in: String(s.expires_in),
    token_type: s.token_type,
    type: "magiclink",
  }).toString();

  await send("Page.navigate", { url: `${SITE}/?view=${VIEW}#${hash}` }, sessionId);
  await sleep(4000);
  await send("Page.navigate", { url: `${SITE}/?view=${VIEW}` }, sessionId);
  await sleep(9000);

  const text = await send("Runtime.evaluate", {
    expression: "document.body.innerText.slice(0, 160)", returnByValue: true,
  }, sessionId);
  console.log("page says:", JSON.stringify(text.result?.value ?? ""));

  const metrics = await send("Runtime.evaluate", {
    expression: `(() => {
      const box = (e) => { const r = e.getBoundingClientRect();
        return { t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; };
      const cards = [...document.querySelectorAll('[class*="rounded-2xl"][class*="bg-card"]')]
        .map(box).filter(b => b.h > 0);
      const pills = [...document.querySelectorAll('button.rounded-full, [class*="rounded-full"]')]
        .map(box).filter(b => b.h > 0 && b.h < 60);
      return JSON.stringify({ doc: document.documentElement.scrollHeight, cards, pills: pills.slice(0, 10) });
    })()`,
    returnByValue: true,
  }, sessionId);
  console.log("metrics:", metrics.result?.value);

  const shot = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
  }, sessionId);
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("saved", OUT, fs.statSync(OUT).size, "bytes");
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
