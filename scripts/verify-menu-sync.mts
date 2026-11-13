/**
 * Hiding a dish at the till, seen from the table.
 *
 * A diner's menu is fetched once when the session starts, so this checks the two
 * cases that used to need a reload: a dish hidden at the POS must leave the
 * diner's screen on its own, and must come back when it is shown again.
 *
 * "Without refreshing" is asserted, not assumed: a marker is put on the page
 * before the change and read back after it, so a check that quietly reloaded the
 * page would fail rather than look like success.
 *
 *   npm run test:menu-sync
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 10141);
const PROFILE = `/tmp/chrome-menusync-${PORT}`;

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

const { data: profile } = await admin.from("profiles").select("tenant_id").eq("email", EMAIL).maybeSingle();
const tenantId = profile!.tenant_id as string;
// Two dishes: one to hide, one that must never be touched.
const { data: dishes } = await admin
  .from("menu_items").select("id, name, available").eq("tenant_id", tenantId).eq("available", true).limit(2);
const target = dishes?.[0];
const bystander = dishes?.[1];
check("the restaurant has two visible dishes", Boolean(target && bystander),
  JSON.stringify(dishes?.map((d: any) => d.name)));

const { data: table } = await admin
  .from("tables").select("id, qr_token").eq("tenant_id", tenantId).eq("active", true).limit(1).maybeSingle();
await admin.from("table_sessions").delete().eq("tenant_id", tenantId).eq("status", "ACTIVE");

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const ownerHeaders = { authorization: `Bearer ${session?.session?.access_token}` };

/** The POS's own write path for the availability switch. */
const setAvailable = (id: string, available: boolean) =>
  call("menu", {
    method: "PATCH",
    headers: { ...ownerHeaders, "x-tenant-id": tenantId },
    body: JSON.stringify({ id, available }),
  });

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

let orderId: string | null = null;
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
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  const ev = async (expr: string) => {
    for (let i = 0; i < 10; i++) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
      if (r?.result?.value !== undefined) return r.result.value;
      await sleep(300);
    }
    return undefined;
  };
  const seen = (name: string) => ev(`document.body.innerText.includes(${JSON.stringify(name)})`);
  const waitFor = async (name: string, present: boolean, seconds: number) => {
    for (let i = 0; i < seconds * 2; i++) {
      if ((await seen(name)) === present) return true;
      await sleep(500);
    }
    return false;
  };

  console.log("\n── a diner opens the menu ──");
  await send("Page.navigate", { url: `${SITE}/?table=${(table as any)?.qr_token}` }, sessionId);
  const listed = await waitFor(String(target!.name), true, 40);
  check("the dish is on the diner's menu", listed === true,
    String(await ev(`document.body.innerText.slice(0, 120)`)).replace(/\n/g, " | "));
  // A marker on the page: if anything reloads it, this is gone.
  await ev(`window.__untouched = 'yes'`);
  const markerBefore = await ev(`window.__untouched`);

  // An order that must survive the whole exercise untouched.
  const { data: liveSession } = await admin
    .from("table_sessions").select("token").eq("tenant_id", tenantId).eq("status", "ACTIVE").limit(1).maybeSingle();
  sessionToken = liveSession?.token ?? null;
  const order = await call("orders", {
    method: "POST",
    body: JSON.stringify({ tableSessionToken: sessionToken, orderType: "DINE_IN", items: [{ menuItemId: bystander!.id, quantity: 1 }] }),
  });
  const placed = order.body?.order ?? order.body;
  orderId = placed?.id ?? null;
  check("an order was placed to watch", Boolean(orderId), `${order.status} ${JSON.stringify(order.body).slice(0, 120)}`);
  // Read the order back from the database, so the comparison below is the same
  // shape before and after — the API's lines carry joins the row does not.
  const readOrderItems = async () =>
    JSON.stringify(
      (await admin.from("order_items").select("id, name, quantity, price, status").eq("order_id", orderId!)).data ?? [],
    );
  const orderBefore = await readOrderItems();

  console.log("\n── the till hides the dish ──");
  const hidden = await setAvailable(target!.id, false);
  check("the hide was accepted", hidden.status < 400, `${hidden.status} ${JSON.stringify(hidden.body).slice(0, 140)}`);
  const wentAway = await waitFor(String(target!.name), false, 20);
  check("it leaves the diner's menu on its own", wentAway === true, "still on screen after 20s");
  check("without the page reloading", (await ev(`window.__untouched`)) === markerBefore,
    "the marker is gone — the page was reloaded, so this proves nothing");
  check("and the other dish is untouched", (await seen(String(bystander!.name))) === true);

  console.log("\n── the till shows it again ──");
  const shown = await setAvailable(target!.id, true);
  check("the unhide was accepted", shown.status < 400, `${shown.status}`);
  const cameBack = await waitFor(String(target!.name), true, 20);
  // Only meaningful if it left: without the first half, a dish that never
  // disappeared "comes back" for free, which is exactly what this check did when
  // the broadcast was taken out to prove it bites.
  check("it comes back on its own", wentAway === true && cameBack === true,
    wentAway ? "not on screen after 20s" : "it never left, so its return proves nothing");
  check("again without a reload", (await ev(`window.__untouched`)) === markerBefore);

  // ---- nothing else moved ------------------------------------------------
  console.log("\n── and nothing else changed ──");
  const { data: after } = await admin.from("orders").select("id, total, status").eq("id", orderId).maybeSingle();
  const orderAfter = await readOrderItems();
  check("the order is exactly as it was", Boolean(after) && orderAfter === orderBefore,
    `${orderAfter} vs ${orderBefore}`);
  const { data: others } = await admin
    .from("menu_items").select("id, available").eq("tenant_id", tenantId).eq("available", false);
  check("no other dish was hidden by this", (others ?? []).length === 0, JSON.stringify(others));

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
  fs.writeFileSync("/root/downloads/menu-sync.png", Buffer.from(shot.data, "base64"));
} catch (e) {
  check("the menu-sync checks ran", false, (e as Error).message);
} finally {
  chrome.kill();
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* gone */ }
  if (target) await admin.from("menu_items").update({ available: true }).eq("id", target.id);
  if (orderId) {
    await admin.from("order_items").delete().eq("order_id", orderId);
    await admin.from("orders").delete().eq("id", orderId);
  }
  await admin.from("table_sessions").delete().eq("tenant_id", tenantId).eq("status", "ACTIVE");
  console.log("\n  (dish shown again, test order and session removed)");
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
