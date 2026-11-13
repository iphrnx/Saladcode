/**
 * The table on an order, from where it was placed to what the card says.
 *
 * Dine-in orders must carry the table they belong to — both the one a diner
 * places by scanning that table's QR code, and the one a cashier rings up for
 * it — and the card must name that table. Takeaway and delivery have no table
 * and must not pretend to.
 *
 *   npm run test:order-table
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9671);

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
const { data: table } = await admin
  .from("tables").select("id, name, qr_token")
  .eq("tenant_id", tenantId).eq("active", true).limit(1).maybeSingle();
const { data: dish } = await admin
  .from("menu_items").select("id, name").eq("tenant_id", tenantId).eq("available", true).limit(1).maybeSingle();
check("the restaurant has a table and a dish", Boolean(table && dish), `table=${(table as any)?.name}`);

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const ownerHeaders = { authorization: `Bearer ${session?.session?.access_token}` };

const made: string[] = [];
try {
  // ---- a diner's dine-in order, through the QR session --------------------
  console.log("\n── a diner orders at their table ──");
  const start = await call("table-session", { method: "POST", body: JSON.stringify({ qrToken: (table as any).qr_token }) });
  const dinerOrder = await call("orders", {
    method: "POST",
    body: JSON.stringify({ tableSessionToken: start.body?.sessionToken, orderType: "DINE_IN", items: [{ menuItemId: dish!.id, quantity: 1 }] }),
  });
  const diner = dinerOrder.body?.order ?? dinerOrder.body;
  if (diner?.id) made.push(diner.id);
  check("the order was accepted", dinerOrder.status < 400, `${dinerOrder.status} ${JSON.stringify(dinerOrder.body).slice(0, 140)}`);
  check("it carries the table the diner scanned", diner?.tableId === table!.id, `tableId=${diner?.tableId} expected ${table!.id}`);
  check("the card's payload names that table", diner?.table?.name === (table as any).name, JSON.stringify(diner?.table));
  const { data: dinerRow } = await admin.from("orders").select("table_id, table_session_id").eq("id", diner!.id).maybeSingle();
  check("and the stored row has both the table and the session",
    dinerRow?.table_id === table!.id && Boolean(dinerRow?.table_session_id), JSON.stringify(dinerRow));

  // ---- a POS order for a table, and a takeaway ---------------------------
  console.log("\n── the till rings up a table, and a takeaway ──");
  const posOrder = await call("orders", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ tableId: table!.id, orderType: "DINE_IN", items: [{ menuItemId: dish!.id, quantity: 1 }] }),
  });
  const pos = posOrder.body?.order ?? posOrder.body;
  if (pos?.id) made.push(pos.id);
  check("the till's dine-in order carries the table", pos?.tableId === table!.id, `tableId=${pos?.tableId}`);

  const takeaway = await call("orders", {
    method: "POST", headers: ownerHeaders,
    body: JSON.stringify({ tableId: null, orderType: "TAKEAWAY", items: [{ menuItemId: dish!.id, quantity: 1 }] }),
  });
  const away = takeaway.body?.order ?? takeaway.body;
  if (away?.id) made.push(away.id);
  check("a takeaway has no table, and is not given one", !away?.tableId && !away?.table, JSON.stringify({ tableId: away?.tableId, table: away?.table }));

  // ---- what the cards say ------------------------------------------------
  console.log("\n── the cards ──");
  const chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-table-${PORT}`,
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
    ws.onmessage = (e: any) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    const ev = async (expr: string) =>
      (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId))?.result?.value;
    const hash = new URLSearchParams({
      access_token: session!.session!.access_token, refresh_token: session!.session!.refresh_token,
      expires_at: String(session!.session!.expires_at), expires_in: String(session!.session!.expires_in),
      token_type: session!.session!.token_type, type: "magiclink",
    }).toString();
    await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
    await sleep(5000);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
    await sleep(11000);
    await send("Page.navigate", { url: `${SITE}/?view=orders` }, sessionId);
    await sleep(9000);

    // Read each card's own text, not a slice of the page: a fixed-length window
    // runs straight into the next card, which is how the first version of this
    // check reported a takeaway "showing a table" and a dine-in card "showing a
    // dash" when neither was true.
    const cards = JSON.parse(String(await ev(`(() => {
      const grab = (n) => {
        const label = '#' + n;
        const card = [...document.querySelectorAll('div[role="button"], .card-premium, [class*="rounded-2xl"]')]
          .find((el) => (el.innerText || '').startsWith(label));
        // Raw text: tidying it here would mean a regex with a backslash
        // inside this template literal, which the literal eats before the
        // page ever sees it.
        return card ? card.innerText || null : null;
      };
      return JSON.stringify({
        dineIn: grab(${diner?.orderNumber}),
        posTable: grab(${pos?.orderNumber}),
        takeaway: grab(${away?.orderNumber}),
      });
    })()`)));
    for (const key of ['dineIn', 'posTable', 'takeaway']) {
      if (typeof cards[key] === 'string') cards[key] = cards[key].split(String.fromCharCode(10)).join(' | ');
    }
    console.log("  diner card:", JSON.stringify(cards.dineIn)?.slice(0, 200));
    console.log("  till card:", JSON.stringify(cards.posTable)?.slice(0, 200));
    console.log("  takeaway card:", JSON.stringify(cards.takeaway)?.slice(0, 200));

    const tableName = String((table as any).name);
    const dashTable = (t: string | null) => Boolean(t && /\|\s*—\s*\|/.test(t));
    check("the diner's card names the table, not a dash",
      typeof cards.dineIn === "string" && cards.dineIn.includes(tableName) && !dashTable(cards.dineIn),
      String(cards.dineIn));
    check("the till's card names the table too",
      typeof cards.posTable === "string" && cards.posTable.includes(tableName) && !dashTable(cards.posTable),
      String(cards.posTable));
    check("the takeaway card says takeaway and shows no table",
      typeof cards.takeaway === "string" && /Takeaway/i.test(cards.takeaway) && !cards.takeaway.includes(tableName),
      String(cards.takeaway));

    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    fs.writeFileSync("/root/downloads/order-table-cards.png", Buffer.from(shot.data, "base64"));
    console.log("  screenshot: /root/downloads/order-table-cards.png");
  } finally {
    chrome.kill();
  }
} catch (e) {
  check("the table checks ran", false, (e as Error).message);
} finally {
  for (const id of made) {
    await admin.from("order_items").delete().eq("order_id", id);
    await admin.from("orders").delete().eq("id", id);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
