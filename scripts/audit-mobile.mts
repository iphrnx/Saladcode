/**
 * Audit every owner-dashboard view at a phone size.
 *
 * One browser, one session, every view in turn. For each one it reports the
 * things that actually make a page feel broken on a phone:
 *
 *   - horizontal overflow, and which element is causing it
 *   - elements wider than the viewport
 *   - cards that are mostly empty
 *   - tap targets that are too small to hit
 *   - text that is too small to read
 *
 *   VIEW=roles WIDTH=390 OUT=/root/downloads/audit npx tsx scripts/audit-mobile.mts
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const WIDTH = Number(process.env.WIDTH ?? 390);
const HEIGHT = Number(process.env.HEIGHT ?? 844);
const OUT = process.env.OUT ?? "/root/downloads/audit";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";

const VIEWS = (process.env.VIEWS ??
  "dashboard,orders,analytics,menu,qr,promos,roles,security,settings").split(",");

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({
  token_hash: link!.properties.hashed_token,
  type: "magiclink",
});
const s = session!.session!;

fs.mkdirSync(OUT, { recursive: true });

const profile = "/tmp/chrome-audit-profile";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", "--remote-debugging-port=9227", `--user-data-dir=${profile}`,
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
    try { version = await (await fetch("http://127.0.0.1:9227/json/version")).json(); break; }
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

  // Hand the session over the way a magic link does.
  const hash = new URLSearchParams({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: String(s.expires_at),
    expires_in: String(s.expires_in),
    token_type: s.token_type,
    type: "magiclink",
  }).toString();
  await send("Page.navigate", { url: `${SITE}/?view=${VIEWS[0]}#${hash}` }, sessionId);
  await sleep(4000);

  for (const view of VIEWS) {
    await send("Page.navigate", { url: `${SITE}/?view=${view}` }, sessionId);
    await sleep(3500);

    const report = await send("Runtime.evaluate", {
      expression: `(() => {
        const vw = document.documentElement.clientWidth;
        const de = document.documentElement;
        const sel = (e) => e.tagName.toLowerCase()
          + (e.id ? '#' + e.id : '')
          + (e.className && typeof e.className === 'string'
              ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');

        // Anything sticking out past the right edge of the screen.
        const wide = [];
        for (const e of document.querySelectorAll('body *')) {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > vw + 1 || r.width > vw + 1) {
            wide.push({ sel: sel(e).slice(0, 70), w: Math.round(r.width), right: Math.round(r.right) });
          }
        }
        // The outermost offenders are the useful ones.
        const offenders = wide.filter(o => !wide.some(p =>
          p !== o && p.sel !== o.sel && p.w > o.w && p.right >= o.right - 1 && p.sel.length > o.sel.length));

        // Tap targets that are too small.
        const small = [];
        for (const e of document.querySelectorAll('button, a, [role=button], input, select')) {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < 32 || r.width < 32) {
            small.push({ sel: sel(e).slice(0, 60), w: Math.round(r.width), h: Math.round(r.height),
                         t: (e.textContent || '').trim().slice(0, 18) });
          }
        }

        // Text that is too small to read.
        const tiny = [];
        for (const e of document.querySelectorAll('body *')) {
          if (!e.childElementCount) {
            const fs = parseFloat(getComputedStyle(e).fontSize);
            if (fs && fs < 10 && (e.textContent || '').trim()) {
              tiny.push({ sel: sel(e).slice(0, 50), fs, t: (e.textContent || '').trim().slice(0, 20) });
            }
          }
        }

        // Cards that are mostly air.
        const cards = [...document.querySelectorAll('[class*="rounded-2xl"], [class*="rounded-xl"]')]
          .map(e => { const r = e.getBoundingClientRect();
                      return { h: Math.round(r.height), w: Math.round(r.width), t: Math.round(r.top) }; })
          .filter(c => c.h > 140 && c.w > 250);

        return JSON.stringify({
          vw,
          scrollW: de.scrollWidth,
          overflow: de.scrollWidth > vw + 1 ? de.scrollWidth - vw : 0,
          docH: de.scrollHeight,
          offenders: offenders.slice(0, 6),
          small: small.slice(0, 6),
          tiny: tiny.slice(0, 4),
          bigCards: cards.slice(0, 6),
        });
      })()`,
      returnByValue: true,
    }, sessionId);

    const r = JSON.parse(report.result?.value || "{}");
    const shot = await send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: true,
    }, sessionId);
    fs.writeFileSync(`${OUT}/${view}.png`, Buffer.from(shot.data, "base64"));

    console.log(`\n=== ${view} ===`);
    console.log(`  page ${r.docH}px tall, overflow ${r.overflow ? r.overflow + "px HORIZONTAL" : "none"}`);
    if (r.offenders?.length) {
      console.log("  wider than the screen:");
      for (const o of r.offenders) console.log(`    ${o.w}px  ${o.sel}`);
    }
    if (r.bigCards?.length) {
      console.log("  large cards:");
      for (const c of r.bigCards) console.log(`    ${c.w}x${c.h} at y=${c.t}`);
    }
    if (r.small?.length) {
      console.log("  small tap targets:");
      for (const t of r.small) console.log(`    ${t.w}x${t.h}  ${t.sel} "${t.t}"`);
    }
    if (r.tiny?.length) {
      console.log("  very small text:");
      for (const t of r.tiny) console.log(`    ${t.fs}px  ${t.sel} "${t.t}"`);
    }
  }
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
