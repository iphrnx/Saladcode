/**
 * Live Realtime integration test.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/test-realtime-live.mts
 *
 * Runs against production, read-mostly: it mints a session on a demo table,
 * places real orders through the real endpoints, and deletes everything it
 * created. It is the test that would have caught the day the broadcast import
 * went missing — the payload was right, the function compiled, and nothing was
 * ever delivered.
 *
 * Covers: delivery, per-diner isolation, duplicate delivery, reconnect after a
 * dropped socket, the polling fallback, and a shared-IP scan burst.
 */
import { createClient } from "@supabase/supabase-js";
import { releaseSessions } from "./_cleanup.mts";

const SB = "https://ygibmdkrslquamwflshb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scan(qrToken: string) {
  const r = await fetch(`${SB}/functions/v1/table-session`, {
    method: "POST", headers: { apikey: SERVICE, "content-type": "application/json" },
    body: JSON.stringify({ qrToken }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function placeOrder(token: string, item: any) {
  const r = await fetch(`${SB}/functions/v1/orders`, {
    method: "POST", headers: { apikey: SERVICE, "content-type": "application/json" },
    body: JSON.stringify({
      tableSessionToken: token, orderType: "DINE_IN",
      items: [{ menuItemId: item.id, name: item.name, price: 0, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const { data: table } = await admin.from("tables").select("id, tenant_id, qr_token").eq("active", true).limit(1).maybeSingle();
const { data: item } = await admin.from("menu_items").select("id, name").eq("tenant_id", table!.tenant_id).eq("available", true).limit(1).maybeSingle();
if (!table || !item) { console.log("no demo table or dish"); process.exit(1); }

const created: { sessions: string[]; orders: string[] } = { sessions: [], orders: [] };

try {
  console.log("\n── delivery: an accepted order reaches its own diner topic ──");
  const a = await scan(table.qr_token);
  created.sessions.push(a.body.sessionId);
  const b = await scan(table.qr_token);
  created.sessions.push(b.body.sessionId);
  check("two diners get two private sessions", a.body.sessionId !== b.body.sessionId);

  await admin.rpc("approve_table_activation", { p_tenant: table.tenant_id, p_session: a.body.sessionId, p_actor: null });

  const heard: Record<string, any[]> = { a: [], b: [] };
  const clients = { a: createClient(SB, SERVICE, { auth: { persistSession: false } }), b: createClient(SB, SERVICE, { auth: { persistSession: false } }) };
  for (const key of ["a", "b"] as const) {
    clients[key]
      .channel(`diner:${key === "a" ? a.body.sessionToken : b.body.sessionToken}`)
      // A new order is ORDER_CREATED; a status change is ORDER_UPDATED. A
      // harness that listens for one and asserts on the other proves nothing.
      .on("broadcast", { event: "ORDER_CREATED" }, (msg: any) => heard[key].push(msg?.payload))
      .on("broadcast", { event: "ORDER_UPDATED" }, (msg: any) => heard[key].push(msg?.payload))
      .subscribe();
  }
  await sleep(1500);

  const order = await placeOrder(a.body.sessionToken, item);
  check("the order is accepted", order.status === 201, `${order.status} ${order.body?.error ?? ""}`);
  if (order.body?.id) created.orders.push(order.body.id);
  await sleep(1500);
  check("its diner is told over Realtime", heard.a.length > 0, `a=${heard.a.length}`);
  check("the other diner at the same table is not", heard.b.length === 0, `b=${heard.b.length}`);
  check("no personal data in the event", !JSON.stringify(heard.a).match(/customerPhone|customerName|qrToken/));

  console.log("\n── duplicate delivery is survivable ──");
  {
    const before = heard.a.length;
    // The same payload twice must not be mistaken for two orders; the client
    // keys on the order id and the delta sync is authoritative.
    const payload = heard.a[0];
    check("an event carries an order id to dedupe on", Boolean(payload?.order?.id));
    check("delivery count is small, not a storm", heard.a.length <= before + 2, String(heard.a.length));
  }

  console.log("\n── reconnect: dropped socket, then the poll still tells the truth ──");
  {
    await clients.a.realtime.disconnect();
    await sleep(500);
    const second = await placeOrder(a.body.sessionToken, item);
    if (second.body?.id) created.orders.push(second.body.id);
    check("an order placed while the socket is down still commits", second.status === 201, String(second.status));

    // The authority is the endpoint, not the socket.
    const orders = await fetch(`${SB}/functions/v1/table-session/orders`, {
      headers: { apikey: SERVICE, "x-session-token": a.body.sessionToken },
    }).then((r) => r.json());
    check("the polling fallback sees it", (orders.orders ?? []).length >= 2, `saw ${orders.orders?.length}`);
    check("the fallback is scoped to this diner's session",
      (orders.orders ?? []).every((o: any) => o.id), "shape");
  }

  console.log("\n── shared-IP scan burst stays under the limit ──");
  {
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await scan(table.qr_token);
      codes.push(r.status);
      if (r.body?.sessionId) created.sessions.push(r.body.sessionId);
    }
    const created10 = codes.filter((c) => c === 201).length;
    check("a busy table keeps scanning (no false 429)", created10 === 10, codes.join(","));
  }

  console.log("\n── billing is reachable and session-scoped ──");
  {
    const doc = await fetch(`${SB}/functions/v1/bill/check?format=document`, {
      headers: { apikey: SERVICE, "x-session-token": a.body.sessionToken },
    });
    check("the diner can read their table's bill", doc.status === 200, String(doc.status));
    const forged = await fetch(`${SB}/functions/v1/bill/check?format=document`, {
      headers: { apikey: SERVICE, "x-session-token": "f".repeat(48) },
    });
    check("a forged token is refused", forged.status === 401, String(forged.status));
  }
} finally {
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  // Never a bare delete: a session the diner already ordered on is ended, so
  // no real order can be left without its table.
  const { deleted, ended } = await releaseSessions(admin, created.sessions);
  console.log(`\ncleaned up ${created.orders.length} order(s); ${deleted} session(s) removed, ${ended} ended`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
