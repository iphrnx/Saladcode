/**
 * The POS "End session" flow, as the diner experiences it.
 *
 * A table session can be ended from the POS dashboard for a table where
 * nothing was ever ordered. The diner's screen then shows "Your table
 * session has ended" — and it used to show a "View Bill" link for a bill
 * that did not exist.
 *
 * This drives the real flow in a real browser: open the table's QR URL, let
 * the diner's page mint its session, optionally place an order in it, end
 * the session from the POS side, and read what the diner is left looking at.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/test-end-session.mts
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

// The tables we drive. Both belong to alex-cafe, which the administrator owns.
const { data: tables } = await admin
  .from("tables")
  .select("id, name, qr_token, tenant_id, active")
  .eq("tenant_id", "d10b6fa5-8660-43df-bef7-a45eca04e1eb")
  .eq("active", true)
  .limit(4);
const tOrder = (tables ?? [])[0];
const tEmpty = (tables ?? [])[1];

if (!tOrder || !tEmpty) {
  console.log("not enough tables to test with");
  process.exit(0);
}

const { data: menuItem } = await admin
  .from("menu_items")
  .select("id, name, price")
  .eq("tenant_id", tOrder.tenant_id)
  .eq("available", true)
  .limit(1)
  .maybeSingle();
if (!menuItem) {
  console.log("no menu item to order with");
  process.exit(0);
}

const profile = "/tmp/chrome-end-session-profile";
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn("google-chrome", [
  "--headless=new", "--remote-debugging-port=9224", `--user-data-dir=${profile}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
  "--window-size=1400,1000", "about:blank",
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

/** The token of the session the diner's page just minted. */
async function latestSessionToken(tableId: string): Promise<string | null> {
  const { data } = await admin
    .from("table_sessions")
    .select("token, status")
    .eq("table_id", tableId)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.token ?? null;
}

try {
  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch("http://127.0.0.1:9224/json/version")).json(); break; }
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
  await send("Network.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  const body = async () => {
    const r = await send("Runtime.evaluate", {
      expression: "document.body.innerText", returnByValue: true,
    }, sessionId);
    return String(r.result?.value ?? "");
  };

  // ---- Case 1: a session with an order -----------------------------------
  console.log(`\n── a table with an order — ${tOrder.name} ──`);
  await send("Page.navigate", {
    url: `${SITE}/?view=public-menu&table=${tOrder.qr_token}`,
  }, sessionId);
  await sleep(9000);
  check("the menu opened", !(await body()).includes("Menu access requires a table session"));

  const tokenWithOrder = await latestSessionToken(tOrder.id);
  check("the diner's page minted a session", Boolean(tokenWithOrder));

  let orderId: string | null = null;
  if (tokenWithOrder) {
    const res = await fetch(`${SB}/functions/v1/orders`, {
      method: "POST",
      headers: { apikey: ANON, "content-type": "application/json" },
      body: JSON.stringify({
        tableSessionToken: tokenWithOrder,
        items: [{ menuItemId: menuItem.id, quantity: 1 }],
      }),
    });
    const placed: any = await res.json().catch(() => null);
    orderId = placed?.order?.id ?? null;
    check("an order was placed in that session", res.status === 201, `status ${res.status}`);
  }

  // The POS ends the session.
  await admin
    .from("table_sessions")
    .update({ status: "ENDED", ended_at: new Date().toISOString() })
    .eq("token", tokenWithOrder!);
  await sleep(4000);

  const withOrder = await body();
  check("the diner sees the session ended", withOrder.includes("Your table session has ended"));
  check("a bill is offered for a session with an order", withOrder.includes("View Bill"));
  check("it is not the no-order message", !withOrder.includes("No orders were placed on this table"));

  // ---- Case 2: a session with no order ------------------------------------
  console.log(`\n── a table with no order — ${tEmpty.name} ──`);
  await send("Page.navigate", {
    url: `${SITE}/?view=public-menu&table=${tEmpty.qr_token}`,
  }, sessionId);
  await sleep(9000);
  check("the menu opened", !(await body()).includes("Menu access requires a table session"));

  const emptyToken = await latestSessionToken(tEmpty.id);
  check("the diner's page minted a session", Boolean(emptyToken));

  await admin
    .from("table_sessions")
    .update({ status: "ENDED", ended_at: new Date().toISOString() })
    .eq("token", emptyToken!);
  await sleep(4000);

  const noOrder = await body();
  check("the diner sees the session ended", noOrder.includes("Your table session has ended"));
  check("no bill is offered for a session with no order", !noOrder.includes("View Bill"));
  check("it says there is nothing to bill", noOrder.includes("No orders were placed on this table"));

  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync("/root/downloads/session-ended-no-order.png", Buffer.from(shot.data, "base64"));

  // ---- Clean up -----------------------------------------------------------
  if (orderId) await admin.from("orders").delete().eq("id", orderId);
  for (const t of [tokenWithOrder, emptyToken]) {
    if (t) await admin.from("table_sessions").delete().eq("token", t);
  }
} catch (e) {
  console.log("failed:", (e as Error).message);
  failures++;
} finally {
  chrome.kill();
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
