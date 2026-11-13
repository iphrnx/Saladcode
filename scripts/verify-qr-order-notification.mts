/**
 * A diner's order must announce itself at the POS, like a staff order does.
 *
 * The sound and the "New Order" toast are fired by the same condition, so the
 * toast is what this watches — audio cannot be asserted, but the branch that
 * plays the chime cannot be reached without it.
 *
 * It opens the POS as the owner in a real browser, places an order through the
 * *diner* route (a table session token, exactly as the QR page does), and waits
 * for the POS to say so.
 *
 *   npm run test:order-notify
 */
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9571);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    ...init,
    headers: { apikey: ANON, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

// ---- the restaurant, a table and a dish to order -----------------------
const { data: profile } = await admin.from("profiles").select("tenant_id").eq("email", EMAIL).maybeSingle();
const tenantId = profile!.tenant_id;
const { data: table } = await admin
  .from("tables")
  .select("id, name, qr_token")
  .eq("tenant_id", tenantId)
  .eq("active", true)
  .limit(1)
  .maybeSingle();
const { data: item } = await admin
  .from("menu_items")
  .select("id, name, price")
  .eq("tenant_id", tenantId)
  .eq("available", true)
  .limit(1)
  .maybeSingle();
check("a table and a dish to order are available", Boolean(table && item), `table=${table?.name} item=${item?.name}`);

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const s = session!.session!;

const chrome = spawn("google-chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-notify-${PORT}`,
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

let createdOrderId: string | null = null;
let sessionToken: string | null = null;

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
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__audio = [];
      // The live contexts, so their state can be read at assertion time. The
      // first version of this probe recorded the state at construction and then
      // reported "suspended" for ever, even after the context had resumed.
      window.__ctxs = [];
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        window.AudioContext = class extends Ctx {
          constructor(...args) {
            super(...args);
            window.__audio.push({ at: Date.now(), state: this.state, resumed: 0, started: 0 });
            window.__ctxs.push(this);
            this.__probe = window.__audio[window.__audio.length - 1];
          }
          resume() { const r = super.resume(); if (this.__probe) this.__probe.resumed++; return r; }
          createOscillator() {
            const osc = super.createOscillator();
            const start = osc.start.bind(osc);
            osc.start = (...a) => { if (this.__probe) this.__probe.started++; return start(...a); };
            return osc;
          }
        };
      }
    `,
  }, sessionId);
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;

  const hash = new URLSearchParams({
    access_token: s.access_token, refresh_token: s.refresh_token, expires_at: String(s.expires_at),
    expires_in: String(s.expires_in), token_type: s.token_type, type: "magiclink",
  }).toString();

  console.log("\n── the POS is open ──");
  await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
  await sleep(5000);
  await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
  await sleep(11000);
  let posReady = false;
  for (let i = 0; i < 20; i++) {
    posReady = Boolean(await ev(`/Point of Sale/i.test(document.body.innerText)`));
    if (posReady) break;
    await sleep(1000);
  }
  check("the POS loaded as the owner", posReady === true);
  // Let the app finish booting (its own data, then the sync) before the order
  // goes in, so this measures the notification and not the boot speed.
  await sleep(6000);

  // ---- a diner scans and orders, through the same routes the QR page uses --
  console.log("\n── a diner places an order ──");
  const start = await call("table-session", { method: "POST", body: JSON.stringify({ qrToken: table!.qr_token }) });
  sessionToken = start.body?.sessionToken ?? null;
  check("the diner's session started", start.status === 201 && Boolean(sessionToken), `${start.status} ${JSON.stringify(start.body).slice(0, 120)}`);

  const order = await call("orders", {
    method: "POST",
    body: JSON.stringify({
      tableSessionToken: sessionToken,
      orderType: "DINE_IN",
      items: [{ menuItemId: item!.id, quantity: 1 }],
    }),
  });
  createdOrderId = order.body?.order?.id ?? order.body?.id ?? null;
  const orderNumber = order.body?.order?.orderNumber ?? order.body?.orderNumber ?? "?";
  check("the diner's order was accepted", order.status === 201 || order.status === 200,
    `${order.status} ${JSON.stringify(order.body).slice(0, 160)}`);

  // ---- the POS must say so, without being touched -------------------------
  console.log("\n── the POS is watched ──");
  let toastText = "";
  for (let i = 0; i < 24; i++) {
    await sleep(1000);
    const seen = await ev(`(() => {
      const nodes = [...document.querySelectorAll('[data-sonner-toast], li[role=status], [role=status]')];
      return nodes.map((n) => (n.textContent || '').trim()).join(' | ');
    })()`);
    if (seen && /New Order/i.test(String(seen))) { toastText = String(seen); break; }
  }
  console.log("  toast seen:", JSON.stringify(toastText).slice(0, 200));
  check("the POS announced the diner's order", /New Order/.test(toastText), String(toastText).slice(0, 140));

  // With nobody having touched the page, a browser will not start audio at all:
  // the chime must at least *ask* to be allowed (resume), rather than starting
  // its oscillators into a suspended context, which is silence pretending to be
  // a sound.
  const untouched = JSON.parse(String(await ev(`JSON.stringify(window.__audio || [])`)));
  console.log("  untouched page:", JSON.stringify(untouched));
  check("the chime reached the audio layer", untouched.length > 0, JSON.stringify(untouched));
  check("and asked to be unmuted rather than playing into a dead context",
    untouched.every((a: any) => a.resumed > 0 || a.state === "running" || a.started === 0), JSON.stringify(untouched));

  // Now the real case: a till that has been used, which is what unlocks audio.
  console.log("\n── after someone touches the till ──");
  // A real click, through the browser's own input pipeline. A synthetic
  // `dispatchEvent` is not user activation, and Chrome will not start audio for
  // one — which is exactly what the first version of this check ran into.
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 120, button: "left", clickCount: 1 }, sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: 120, button: "left", clickCount: 1 }, sessionId);
  await sleep(1500);
  const afterClick = JSON.parse(String(await ev(`JSON.stringify(window.__audio || [])`)));
  console.log("  after the click:", JSON.stringify(afterClick.map((a: any) => ({ state: a.state, resumed: a.resumed })) ));

  let contextsAfterTouch = 0;
  for (let i = 0; i < 8; i++) {
    const r = await call("orders", {
      method: "POST",
      body: JSON.stringify({ tableSessionToken: sessionToken, orderType: "DINE_IN", items: [{ menuItemId: item!.id, quantity: 1 }] }),
    });
    const oid = r.body?.order?.id ?? r.body?.id ?? null;
    if (oid) {
      await sleep(1800);
      await admin.from("order_items").delete().eq("order_id", oid);
      await admin.from("orders").delete().eq("id", oid);
    }
  }
  await sleep(4000);
  const audio = JSON.parse(String(await ev(`JSON.stringify(window.__audio || [])`)));
  const liveStates = JSON.parse(String(await ev(`JSON.stringify((window.__ctxs || []).map((c) => c.state))`)));
  contextsAfterTouch = audio.length;
  console.log("  audio contexts in total:", contextsAfterTouch, "| live states:", JSON.stringify(liveStates));
  console.log("  oscillators started per context:", JSON.stringify(audio.map((a: any) => a.started)));
  check("the chime reuses one context instead of making one per order",
    contextsAfterTouch === 1,
    `${contextsAfterTouch} contexts for 9 orders — this is what used to silence the chime for good, since browsers cap how many a page may hold`);
  check("that context is running, so the sound is audible",
    liveStates.includes("running"), JSON.stringify(liveStates));
  check("and the chime actually rang into it",
    audio.some((a: any) => a.started >= 2), JSON.stringify(audio.map((a: any) => a.started)));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  const fs = await import("node:fs");
  fs.writeFileSync("/root/downloads/diner-order-toast.png", Buffer.from(shot.data, "base64"));
  console.log("  screenshot: /root/downloads/diner-order-toast.png");
} catch (e) {
  check("the notification checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  if (createdOrderId) await admin.from("order_items").delete().eq("order_id", createdOrderId);
  if (createdOrderId) await admin.from("orders").delete().eq("id", createdOrderId);
  if (sessionToken) await admin.from("table_sessions").delete().eq("token", sessionToken);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
