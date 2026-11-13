/**
 * Order reliability — the client state machine, tested without a network.
 *
 *   - backoff schedule: exponential with cap, jitter always inside ±25%
 *   - happy path: enqueue → submit → confirmed → entry removed
 *   - uncertain failures (network throw, 5xx) stay pending with backoff and
 *     never discard the entry
 *   - definite rejections (4xx) become 'failed' and stay visible
 *   - reconcile-before-retry: a retry looks the key up FIRST; a found order
 *     confirms without re-submitting, a 404 resubmits with the SAME key,
 *     a 401/403 fails, a 5xx stays uncertain
 *   - single-flight: concurrent process() calls produce exactly one POST
 *   - cross-tab claiming: two queues over one storage, one POST
 *   - persistence: a pending entry survives a "reload" (new instance)
 *   - attempt ceiling: 12 uncertain attempts → failed, never a silent drop
 *   - dismiss: reconciles first — a confirmed order is never discarded
 *   - scope isolation: different tenant/actor keys never mix
 *   - POS cart persistence: restore, no-overwrite hydrate, clear
 *
 *   npm run test:order-queue
 */
import assert from "node:assert/strict";
import { OrderQueue, backoffDelayMs, submitEntry } from "../src/lib/order-queue.ts";
import type { QueueEntry } from "../src/lib/order-queue.ts";

let pass = 0;
const fail: string[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (e: any) {
      fail.push(name);
      console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
    }
  })();
}

// -- test doubles ------------------------------------------------------------
class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

type RouteHandler = (url: string, init?: any) => Response | Promise<Response>;

/** A fake edgeFetch that records every call and answers from a route table. */
function fakeFetcher() {
  const calls: Array<{ url: string; body?: any }> = [];
  let route: RouteHandler = () => new Response("{}", { status: 500 });
  const fetcher = (async (url: string, init?: any) => {
    let body: any;
    try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { /* */ }
    calls.push({ url, body });
    return route(url, init);
  }) as any;
  return {
    fetcher,
    calls,
    setRoute(fn: RouteHandler) { route = fn; },
    posts: () => calls.filter((c) => c.url === "/api/orders"),
    lookups: () => calls.filter((c) => c.url.startsWith("/api/orders/by-key/")),
  };
}

const okOrder = (id = "ord-1") =>
  new Response(JSON.stringify({ id, orderNumber: "Z-101", total: 100 }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    key: "11111111-1111-4111-8111-111111111111",
    kind: "diner",
    payload: { items: [{ menuItemId: "m1", quantity: 2 }], tableSessionToken: "tok" },
    state: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    itemCount: 1,
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- backoff -----------------------------------------------------------------
await check("backoff: exponential schedule with cap", () => {
  // fixed rand → deterministic: base * 0.75
  const lo = (n: number) => backoffDelayMs(n, () => 0);
  const hi = (n: number) => backoffDelayMs(n, () => 1);
  assert.equal(lo(1), 750); // 1000 * 0.75
  assert.equal(hi(1), 1250); // 1000 * 1.25
  assert.equal(lo(2), 1500); // 2000 * 0.75
  assert.equal(lo(5), 12000); // 8000 * 0.75
  assert.equal(lo(6), 24000); // 32000 * 0.75
  assert.equal(hi(6), 30000); // capped — the wait never exceeds 30s
  assert.equal(hi(9), 30000);
});

await check("backoff: jitter always within ±25%", () => {
  for (let a = 1; a <= 10; a++) {
    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(a, Math.random);
      const base = 1000 * 2 ** (a - 1);
      const lo = Math.min(30000, base * 0.75);
      const hi = Math.min(30000, base * 1.25);
      assert.ok(d >= lo - 1 && d <= hi + 1, `attempt ${a}: ${d} outside [${lo}, ${hi}]`);
    }
  }
});

// -- happy path ---------------------------------------------------------------
await check("enqueue → submit → confirmed, entry removed", async () => {
  const f = fakeFetcher();
  f.setRoute(() => okOrder("o1"));
  const s = new MemStorage();
  let confirmedOrder: any = null;
  const q = new OrderQueue(s, "k", f.fetcher, { onConfirmed: (o) => (confirmedOrder = o) }, () => 0);
  const e = q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  assert.equal(f.posts().length, 1);
  assert.equal(f.posts()[0].body.idempotencyKey, e.key, "POST carries the idempotency key");
  assert.equal(confirmedOrder?.id, "o1");
  assert.equal(q.load().length, 0, "confirmed entry is removed");
});

// -- uncertain failures stay pending -------------------------------------------
await check("network throw → pending, attempts+1, backoff scheduled", async () => {
  const f = fakeFetcher();
  f.setRoute(() => { throw new TypeError("fetch failed"); });
  const s = new MemStorage();
  const q = new OrderQueue(s, "k", f.fetcher, {}, () => 0);
  q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  const entries = q.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "pending", "uncertain failure must stay pending");
  assert.equal(entries[0].attempts, 1);
  assert.ok(entries[0].nextAttemptAt > 0, "backoff scheduled");
  assert.ok(entries[0].lastError, "error recorded");
});

await check("5xx → uncertain → pending", async () => {
  const f = fakeFetcher();
  f.setRoute(() => new Response("Server error", { status: 502 }));
  const q = new OrderQueue(new MemStorage(), "k", f.fetcher, {}, () => 0);
  q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  assert.equal(q.load()[0].state, "pending");
});

// -- definite rejection ---------------------------------------------------------
await check("4xx → failed, kept, never auto-retried", async () => {
  const f = fakeFetcher();
  f.setRoute(() => new Response(JSON.stringify({ error: "One or more items are no longer available" }), { status: 400 }));
  const s = new MemStorage();
  const q = new OrderQueue(s, "k", f.fetcher, {}, () => 0);
  q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  const entries = q.load();
  assert.equal(entries[0].state, "failed");
  assert.match(entries[0].lastError, /no longer available/);
  // A later process() must not touch a failed entry.
  await q.process();
  await sleep(10);
  assert.equal(f.posts().length, 1, "failed entry is not auto-retried");
  assert.equal(q.load()[0].state, "failed", "failed entry is never silently discarded");
});

// -- reconcile before retry ------------------------------------------------------
await check("retry: lookup FIRST, found → confirm without re-POST", async () => {
  const f = fakeFetcher();
  const order = { id: "o9", orderNumber: "Z-9" };
  f.setRoute((url) =>
    url.startsWith("/api/orders/by-key/")
      ? new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("{}", { status: 500 }),
  );
  const r = await submitEntry(entry({ attempts: 1 }), f.fetcher);
  assert.equal(r.outcome, "confirmed");
  assert.equal((r as any).order.id, "o9");
  assert.equal(f.posts().length, 0, "a found order must not be re-submitted");
  assert.equal(f.lookups().length, 1);
  assert.ok(f.lookups()[0].url.includes("tableSessionToken=tok"), "diner lookup carries the session token");
});

await check("retry: 404 → resubmit with the SAME key", async () => {
  const f = fakeFetcher();
  let posted = false;
  f.setRoute((url) => {
    if (url.startsWith("/api/orders/by-key/")) return new Response("Not found", { status: 404 });
    posted = true;
    return okOrder("o2");
  });
  const e = entry({ attempts: 2 });
  const r = await submitEntry(e, f.fetcher);
  assert.equal(r.outcome, "confirmed");
  assert.ok(posted, "404 leads to a resubmission");
  assert.equal(f.posts()[0].body.idempotencyKey, e.key, "the SAME idempotency key is reused");
});

await check("retry: lookup 401 → rejected (session ended)", async () => {
  const f = fakeFetcher();
  f.setRoute((url) =>
    url.startsWith("/api/orders/by-key/")
      ? new Response("Session ended", { status: 403 })
      : new Response("{}", { status: 500 }),
  );
  const r = await submitEntry(entry({ attempts: 1 }), f.fetcher);
  assert.equal(r.outcome, "rejected");
});

await check("retry: lookup 5xx → uncertain, still no POST", async () => {
  const f = fakeFetcher();
  f.setRoute((url) =>
    url.startsWith("/api/orders/by-key/")
      ? new Response("boom", { status: 503 })
      : new Response("{}", { status: 500 }),
  );
  const r = await submitEntry(entry({ attempts: 1 }), f.fetcher);
  assert.equal(r.outcome, "uncertain");
  assert.equal(f.posts().length, 0);
});

await check("first attempt (attempts=0) never does a lookup", async () => {
  const f = fakeFetcher();
  f.setRoute(() => okOrder());
  await submitEntry(entry({ attempts: 0 }), f.fetcher);
  assert.equal(f.lookups().length, 0);
  assert.equal(f.posts().length, 1);
});

// -- single-flight ---------------------------------------------------------------
await check("single-flight: two concurrent process() → one POST", async () => {
  const f = fakeFetcher();
  let inFlight = 0;
  f.setRoute(async () => {
    inFlight++;
    await sleep(20);
    return okOrder();
  });
  const q = new OrderQueue(new MemStorage(), "k", f.fetcher, {}, () => 0);
  q.enqueue("diner", { items: [] }, 1);
  await Promise.all([q.process(), q.process()]);
  await sleep(40);
  assert.equal(inFlight, 1, "only one submission cycle may run per queue");
  assert.equal(f.posts().length, 1);
});

// -- cross-tab claiming ------------------------------------------------------------
await check("claim race: two queues, one storage → exactly one POST", async () => {
  const f = fakeFetcher();
  f.setRoute(async () => { await sleep(15); return okOrder(); });
  const s = new MemStorage();
  const q1 = new OrderQueue(s, "k", f.fetcher, {}, () => 0);
  const q2 = new OrderQueue(s, "k", f.fetcher, {}, () => 0);
  q1.enqueue("diner", { items: [] }, 1);
  await Promise.all([q1.process(), q2.process()]);
  await sleep(60);
  assert.equal(f.posts().length, 1, "the losing claim must step aside");
  assert.equal(q1.load().length + q2.load().length, 0, "confirmed on both views");
});

// -- persistence across "reload" -----------------------------------------------------
await check("pending entry survives a reload (new instance over same storage)", async () => {
  const s = new MemStorage();
  let t = 1000;
  const clock = () => t;
  const f = fakeFetcher();
  f.setRoute(() => { throw new Error("offline"); });
  const q1 = new OrderQueue(s, "k", f.fetcher, {}, clock);
  const e = q1.enqueue("diner", { items: [{ menuItemId: "m1", quantity: 1 }] }, 1);
  await sleep(10);
  assert.equal(q1.load()[0].state, "pending");

  // "Reload": brand-new instance, same storage, time has moved past backoff.
  t = 100_000;
  const f2 = fakeFetcher();
  f2.setRoute(() => okOrder("o-after-reload"));
  let confirmed: any = null;
  const q2 = new OrderQueue(s, "k", f2.fetcher, { onConfirmed: (o) => (confirmed = o) }, clock);
  await q2.process();
  assert.equal(confirmed?.id, "o-after-reload");
  assert.equal(f2.posts().length, 0, "the lookup already had it — no re-submit");
  assert.ok(f2.lookups()[0]?.url.includes(e.key), "reconciled with the SAME key");
});

// -- attempt ceiling -------------------------------------------------------------------
await check("12 uncertain attempts → failed (never a silent drop)", async () => {
  const f = fakeFetcher();
  f.setRoute(() => { throw new Error("down"); });
  const s = new MemStorage();
  let t = 0;
  const q = new OrderQueue(s, "k", f.fetcher, {}, () => t);
  q.enqueue("diner", { items: [] }, 1);
  for (let i = 0; i < 15; i++) {
    t += 60_000; // past any backoff
    await q.process();
  }
  const entries = q.load();
  assert.equal(entries.length, 1, "the entry is still there");
  assert.equal(entries[0].state, "failed", "exhausted retries become visible failure");
  assert.equal(entries[0].attempts, 12);
});

// -- dismiss / retry ---------------------------------------------------------------------
await check("dismiss of a rejected entry removes it", async () => {
  const f = fakeFetcher();
  f.setRoute((url) => (url.startsWith("/api/orders/by-key/") ? new Response("nf", { status: 404 }) : new Response("no", { status: 400 })));
  const q = new OrderQueue(new MemStorage(), "k", f.fetcher, {}, () => 0);
  const e = q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  assert.equal(q.load()[0].state, "failed");
  const r = await q.dismiss(e.key);
  assert.equal(r, "removed");
  assert.equal(q.load().length, 0);
});

await check("dismiss reconciles first: a committed order is confirmed, not discarded", async () => {
  const f = fakeFetcher();
  f.setRoute((url) =>
    url.startsWith("/api/orders/by-key/")
      ? new Response(JSON.stringify({ id: "o-late" }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("x", { status: 400 }),
  );
  let confirmed: any = null;
  const q = new OrderQueue(new MemStorage(), "k", f.fetcher, { onConfirmed: (o) => (confirmed = o) }, () => 0);
  const e = q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  const r = await q.dismiss(e.key);
  assert.equal(r, "confirmed");
  assert.equal(confirmed?.id, "o-late");
  assert.equal(q.load().length, 0);
});

await check("dismiss of an uncertain entry keeps it", async () => {
  const f = fakeFetcher();
  f.setRoute(() => { throw new Error("offline"); });
  const q = new OrderQueue(new MemStorage(), "k", f.fetcher, {}, () => 0);
  const e = q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  const r = await q.dismiss(e.key);
  assert.equal(r, "uncertain");
  assert.equal(q.load().length, 1, "an uncertain entry is never dropped");
});

await check("manual retry resets a failed entry with the same key", async () => {
  const f = fakeFetcher();
  let calls = 0;
  f.setRoute(() => { calls++; return calls < 2 ? new Response("no", { status: 400 }) : okOrder("o-retry"); });
  const q = new OrderQueue(new MemStorage(), "k", f.fetcher, {}, () => 0);
  const e = q.enqueue("diner", { items: [] }, 1);
  await sleep(10);
  assert.equal(q.load()[0].state, "failed");
  q.retry(e.key);
  await sleep(10);
  assert.equal(q.load().length, 0, "manual retry succeeded");
  assert.equal(f.posts()[1]?.body?.idempotencyKey, e.key);
});

// -- scope isolation -----------------------------------------------------------------------
await check("scope isolation: two queues never see each other's entries", async () => {
  const f = fakeFetcher();
  f.setRoute(() => okOrder());
  const sa = new MemStorage();
  const sb = new MemStorage();
  const qa = new OrderQueue(sa, "tenantA-user1", f.fetcher, {}, () => 0);
  const qb = new OrderQueue(sb, "tenantB-user2", f.fetcher, {}, () => 0);
  qa.enqueue("pos", { items: [] }, 1);
  await sleep(10);
  assert.equal(qa.load().length, 0);
  assert.equal(qb.load().length, 0, "B never had an entry");
  assert.equal(sb.map.size, 0, "B's storage was never written");
});

// -- POS cart persistence --------------------------------------------------------------------
await check("POS cart: persist, restore, clear — scoped by tenant+user", async () => {
  const { persistPosCart, restorePosCart, clearPosCart } = await import("../src/lib/pos-cart.ts");
  // storage-keys helpers read window.localStorage; shim it.
  const backing = new Map<string, string>();
  (globalThis as any).window = (globalThis as any).window ?? globalThis;
  (globalThis as any).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => backing.set(k, v),
    removeItem: (k: string) => backing.delete(k),
  };
  persistPosCart("t1", "u1", { cart: [{ menuItemId: "m1", name: "Chai", price: 20, quantity: 2 }], orderType: "TAKEAWAY", selectedTableId: null, promoCode: "" });
  const restored = restorePosCart("t1", "u1");
  assert.equal(restored?.cart?.length, 1);
  assert.equal(restored?.orderType, "TAKEAWAY");
  assert.equal(restorePosCart("t2", "u1"), null, "another tenant's cart is invisible");
  assert.equal(restorePosCart("t1", "u2"), null, "another user's cart is invisible");
  clearPosCart("t1", "u1");
  assert.equal(restorePosCart("t1", "u1"), null);
  delete (globalThis as any).localStorage;
});

// -- store hydrate / subtract -----------------------------------------------------------------
await check("store: hydrateCart only fills an empty cart", async () => {
  const { useStore } = await import("../src/lib/store.ts");
  const s = useStore.getState();
  s.clearCart();
  s.hydrateCart({ cart: [{ menuItemId: "m1", name: "Chai", price: 20, quantity: 1 }], orderType: "DELIVERY" });
  assert.equal(useStore.getState().cart.length, 1);
  assert.equal(useStore.getState().orderType, "DELIVERY");
  // A second hydrate with a NON-empty cart must not overwrite.
  s.hydrateCart({ cart: [{ menuItemId: "m2", name: "Coffee", price: 30, quantity: 5 }] });
  assert.equal(useStore.getState().cart[0].menuItemId, "m1", "existing cart wins");
  assert.equal(useStore.getState().cart.length, 1);
  s.clearCart();
});

await check("store: subtractCartLines removes only submitted quantities", async () => {
  const { useStore } = await import("../src/lib/store.ts");
  const s = useStore.getState();
  s.clearCart();
  s.addToCart({ menuItemId: "m1", name: "Chai", price: 20, portion: "Full", portionId: "full" }, 3);
  s.addToCart({ menuItemId: "m2", name: "Toast", price: 40 }, 2);
  // The submitted snapshot had 2 chai; the cashier added 1 more while it was in flight.
  s.subtractCartLines([{ menuItemId: "m1", portion: "Full", portionId: "full", quantity: 2 }]);
  const cart = useStore.getState().cart;
  assert.equal(cart.find((c) => c.menuItemId === "m1")?.quantity, 1, "only the submitted quantity leaves");
  assert.equal(cart.find((c) => c.menuItemId === "m2")?.quantity, 2, "untouched lines stay");
  s.clearCart();
});

console.log(`\n${pass} passed, ${fail.length} failed${fail.length ? `: ${fail.join(", ")}` : ""}`);
process.exit(fail.length ? 1 : 0);
