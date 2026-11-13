import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const EMAIL = "lelokhalo@demo.com";

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;

const profile = "/tmp/chrome-receipt-profile";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", "--remote-debugging-port=9226", `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1400,950", "about:blank",
  "--disable-popup-blocking",
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
async function evaljs(sid: string, expr: string): Promise<any> {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  return r.result?.value;
}
async function shot(sid: string, out: string) {
  const img = await send("Page.captureScreenshot", { format: "png" }, sid);
  fs.writeFileSync(out, Buffer.from(img.data, "base64"));
  console.log("saved", out, fs.statSync(out).size);
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

  // The @supabase/ssr browser client keeps the session in a chunked,
  // base64url cookie — set it exactly the way its own storage would.
  const { stringToBase64URL } = await import("@supabase/ssr/dist/main/utils/base64url.js");
  const { createChunks } = await import("@supabase/ssr/dist/main/utils/chunker.js");
  const key = "sb-ygibmdkrslquamwflshb-auth-token";
  const encoded = "base64-" + stringToBase64URL(JSON.stringify(s));
  const chunks = createChunks(key, encoded);
  await send("Network.enable", {}, sessionId);
  for (const ch of chunks) {
    const res = await send("Network.setCookie", {
      name: ch.name, value: ch.value, url: `${SITE}/`, httpOnly: false, sameSite: "Lax",
    }, sessionId);
    console.log("setCookie result:", JSON.stringify(res));
  }
  console.log("set", chunks.length, "cookie chunk(s),", encoded.length, "chars");

  await send("Page.navigate", { url: `${SITE}/?view=settings` }, sessionId);
  await sleep(14000);
  console.log("in-page cookie:", JSON.stringify(await evaljs(sessionId, "document.cookie.slice(0, 120)")));
  console.log("in-page url:", JSON.stringify(await evaljs(sessionId, "location.href")));

  console.log("page:", JSON.stringify((await evaljs(sessionId, "document.body.innerText.slice(0,80)")) ?? ""));

  // Dismiss the cookie banner so it cannot cover anything.
  await evaljs(sessionId, `
    (() => { const b = [...document.querySelectorAll('button')].find(e => (e.textContent||'').trim() === 'Reject All');
      if (b) b.click(); return 1; })()`);
  await sleep(400);

  // Open the Billing tab — Radix activates on pointerdown, so dispatch the
  // real sequence instead of a bare click().
  const tab = await evaljs(sessionId, `
    (() => { const b = [...document.querySelectorAll('[role="tab"]')].find(e => (e.textContent||'').trim().toLowerCase() === 'billing');
      if (!b) return 'no-tab';
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      b.click();
      return 'clicked'; })()`);
  console.log("tab:", tab);
  await sleep(3500);
  console.log("active tab:", JSON.stringify(await evaljs(sessionId,
    "document.querySelector('[role=tab][data-state=active]')?.textContent")));

  // Scroll the payment history row into view and screenshot.
  await evaljs(sessionId, `
    (() => { const h = [...document.querySelectorAll('h3,h2,p,div')].find(e => e.textContent?.trim() === 'Payment history');
      h?.scrollIntoView({ block: 'start' }); return 1; })()`);
  await sleep(600);
  await shot(sessionId, "/tmp/shot-billing-row.png");

  // Open the receipt modal via the Print button.
  const pr = await evaljs(sessionId, `
    (() => { const b = [...document.querySelectorAll('button')].find(e => e.title === 'Print the bill');
      if (!b) return 'no-print-btn'; b.click(); return 'clicked'; })()`);
  console.log("print btn:", pr);
  await sleep(900);
  await shot(sessionId, "/tmp/shot-receipt-modal.png");

  // Click Download in the payment row and check the saved file is named
  // after the issued document, not the raw transaction id.
  const DL = "/tmp/dl-test";
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  const dl = await evaljs(sessionId, `
    (() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent?.trim() === 'Download');
      if (!b) return 'no-download-btn'; b.click(); return 'clicked'; })()`);
  console.log("download click:", dl);
  let savedFile = "";
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const files = fs.readdirSync(DL).filter((f) => !f.endsWith(".crdownload"));
    if (files.length) { savedFile = files[0]; break; }
  }
  console.log("saved file:", savedFile || "NONE");
  // The receipt modal's document number, for the identity check.
  const modalNum = await evaljs(sessionId, `
    /No\\. ((?:INV|RFND)-\\d{4}-\\d{2}-\\d{5})/.exec(document.querySelector('[role=dialog]')?.textContent ?? '')?.[1] ?? null`);
  console.log("receipt shows:", modalNum, "| download named after it:", savedFile.includes(modalNum ?? "\0"));

  // Click the modal's Print button and capture the print sheet — it opens
  // as a popup window (a separate CDP target).
  await evaljs(sessionId, `
    (() => { const b = [...document.querySelectorAll('button')].find(e => e.textContent?.includes('Print / save as PDF'));
      if (!b) return 'no-modal-print'; b.click(); return 'clicked'; })()`);
  let printShot = "no-popup";
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const { targetInfos } = await send("Target.getTargets");
    const pop = targetInfos.find((t: any) => t.type === "page" && t.title.startsWith("Invoice"));
    if (pop) {
      const { sessionId: psid } = await send("Target.attachToTarget", { targetId: pop.targetId, flatten: true });
      await send("Page.enable", {}, psid);
      await sleep(1200);
      await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1300, deviceScaleFactor: 1.4, mobile: false }, psid);
      await sleep(300);
      await shot(psid, "/tmp/shot-print-sheet.png");
      await send("Target.closeTarget", { targetId: pop.targetId });
      printShot = "captured";
      break;
    }
  }
  console.log("print sheet:", printShot);
} catch (e) {
  console.log("failed:", (e as Error).message);
} finally {
  chrome.kill();
}
