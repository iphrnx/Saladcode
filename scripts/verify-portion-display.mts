/**
 * Portion sizes, from the moment an order is created to what the till shows.
 *
 * Two flows create the same kind of order — the POS sends a portion with the
 * line, and so does the diner's QR page — and the POS card renders whatever the
 * read path returns. This walks both: create with a portion, check what was
 * stored, check what the API returns, and check the badge on the card.
 *
 *   npm run test:portions-ui
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SITE = process.env.SITE_URL ?? "https://www.thesalad.in";
// The account must be able to reach the dashboard — a tenant whose setup is
// unfinished is routed to onboarding, and the display half of this check would
// then be measuring a sign-in page.
const EMAIL = process.env.EMAIL ?? "phrnx@icloud.com";
const PORT = Number(process.env.CDP_PORT ?? 9651);

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

// ---- the restaurant, a portioned dish and a table ----------------------
const { data: profile } = await admin.from("profiles").select("tenant_id").eq("email", EMAIL).maybeSingle();
const tenantId = profile!.tenant_id as string;
const { data: dish } = await admin
  .from("menu_items")
  .select("id, name, price, portions")
  .eq("tenant_id", tenantId)
  .eq("available", true)
  .not("portions", "is", null)
  .limit(1)
  .maybeSingle();
const portions = Array.isArray((dish as any)?.portions) ? (dish as any).portions : [];
const chosen = portions.find((p: any) => /half/i.test(p.name)) ?? portions[0];
check("the restaurant has a dish with portion sizes", Boolean(dish && chosen),
  `dish=${(dish as any)?.name} portions=${JSON.stringify(portions)}`);

const { data: table } = await admin
  .from("tables")
  .select("id, name, qr_token")
  .eq("tenant_id", tenantId)
  .eq("active", true)
  .limit(1)
  .maybeSingle();

const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const c = createClient(SB, ANON, { auth: { persistSession: false } });
const { data: session } = await c.auth.verifyOtp({ token_hash: link!.properties.hashed_token, type: "magiclink" });
const ownerHeaders = { authorization: `Bearer ${session?.session?.access_token}` };

const made: string[] = [];
const lineOf = (body: any) => {
  const order = body?.order ?? body;
  return { id: order?.id as string | undefined, items: order?.items as any[] | undefined };
};

try {
  // ---- 1. an order created at the POS, with a portion --------------------
  console.log(`\n── an order created at the POS (${chosen?.name}) ──`);
  const posOrder = await call("orders", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      tableId: table?.id ?? null,
      orderType: table ? "DINE_IN" : "TAKEAWAY",
      items: [{ menuItemId: dish!.id, portionId: chosen.id, portion: chosen.name, quantity: 2 }],
    }),
  });
  const pos = lineOf(posOrder.body);
  if (pos.id) made.push(pos.id);
  check("the POS order was accepted", posOrder.status < 400, `${posOrder.status} ${JSON.stringify(posOrder.body).slice(0, 160)}`);
  const posLine = pos.items?.[0];
  check("the API returns the portion on the line", posLine?.portion === chosen.name,
    JSON.stringify(posLine));
  check("the API returns the portion id too", (posLine?.portionId ?? null) === (chosen.id ?? null),
    JSON.stringify({ portionId: posLine?.portionId, expected: chosen.id }));
  check("and the line is priced at the portion, not the base price",
    Number(posLine?.price) === Number(chosen.price),
    `line ${posLine?.price} vs portion ${chosen.price} vs base ${(dish as any).price}`);

  // ---- 2. an order created by a diner, with the same portion -------------
  console.log(`\n── an order created by a diner over QR (${chosen?.name}) ──`);
  const start = await call("table-session", { method: "POST", body: JSON.stringify({ qrToken: (table as any)?.qr_token }) });
  const dinerToken = start.body?.sessionToken as string | undefined;
  check("a diner session started", start.status === 201 && Boolean(dinerToken), `${start.status}`);
  const dinerOrder = await call("orders", {
    method: "POST",
    body: JSON.stringify({
      tableSessionToken: dinerToken,
      orderType: "DINE_IN",
      items: [{ menuItemId: dish!.id, portionId: chosen.id, portion: chosen.name, quantity: 1 }],
    }),
  });
  const diner = lineOf(dinerOrder.body);
  if (diner.id) made.push(diner.id);
  check("the diner's order was accepted", dinerOrder.status < 400, `${dinerOrder.status} ${JSON.stringify(dinerOrder.body).slice(0, 160)}`);
  const dinerLine = diner.items?.[0];
  check("its line carries the portion", dinerLine?.portion === chosen.name, JSON.stringify(dinerLine));
  check("its line carries the portion id", (dinerLine?.portionId ?? null) === (chosen.id ?? null),
    JSON.stringify({ portionId: dinerLine?.portionId, expected: chosen.id }));
  check("and it is priced at the portion", Number(dinerLine?.price) === Number(chosen.price),
    `line ${dinerLine?.price} vs portion ${chosen.price}`);

  // ---- 3. what the read path the till uses returns -----------------------
  console.log("\n── what the till's own feed returns ──");
  const sync = await call(`orders/sync?tenantId=${tenantId}&since=${encodeURIComponent(new Date(Date.now() - 600_000).toISOString())}`, { headers: ownerHeaders });
  const synced = (sync.body?.orders ?? []).filter((o: any) => made.includes(o.id));
  check("both orders come back in the feed the card renders from", synced.length === 2, `found ${synced.length}`);
  for (const o of synced) {
    check(`order #${o.orderNumber}: the feed carries the portion`, o.items?.[0]?.portion === chosen.name,
      JSON.stringify(o.items?.[0]));
  }

  // ---- 4. and what the card actually shows ------------------------------
  console.log("\n── the card at the till ──");
  const chrome = spawn("google-chrome", [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-portion-${PORT}`,
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

    // Establish the session on a view known to accept the magic-link fragment,
    // then switch to the one under test. Going straight to the deeper view left
    // the app on its sign-in page, and the check then passed nothing.
    await send("Page.navigate", { url: `${SITE}/?view=dashboard#${hash}` }, sessionId);
    await sleep(5000);
    await send("Page.navigate", { url: `${SITE}/?view=dashboard` }, sessionId);
    await sleep(11000);
    await send("Page.navigate", { url: `${SITE}/?view=orders` }, sessionId);
    await sleep(9000);

    const cardText = String(await ev(`document.body.innerText`));
    const rendered = synced.map((o: any) => ({
      number: o.orderNumber,
      hasPortionBadge: cardText.includes(`${chosen.name}`),
      cardShown: cardText.includes(`#${o.orderNumber}`),
    }));
    console.log("  cards:", JSON.stringify(rendered));
    check("both orders appear as cards", rendered.every((r: any) => r.cardShown), JSON.stringify(rendered));
    check("the portion is shown on the cards, not just in the data",
      rendered.every((r: any) => r.hasPortionBadge), JSON.stringify(rendered));

    // The line total must be portion × quantity, as the card computes it.
    const expected = (Number(chosen.price) * 2).toFixed(2);
    check("the priced line total matches the portion price × quantity",
      cardText.includes(expected) || cardText.includes(expected.replace(/\.00$/, "")),
      `looked for ${expected}`);

    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    fs.writeFileSync("/root/downloads/portion-cards.png", Buffer.from(shot.data, "base64"));
    console.log("  screenshot: /root/downloads/portion-cards.png");
  } finally {
    chrome.kill();
  }
} catch (e) {
  check("the portion checks ran", false, (e as Error).message);
} finally {
  for (const id of made) {
    await admin.from("order_items").delete().eq("order_id", id);
    await admin.from("orders").delete().eq("id", id);
  }
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
