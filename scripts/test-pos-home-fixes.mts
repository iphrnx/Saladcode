/**
 * Targeted Regression Suite for POS Home Fixes (B1–B10)
 *
 * Verifies:
 * 1. Third independent dine-in sitting on the same table (isolated session, check, order, KOT #1).
 * 2. Adding to an existing sitting reuses session & check and increments KOT.
 * 3. Atomic rollback on create_order_tx failure (zero orphan table_sessions / table_checks).
 * 4. Idempotent retry returns the exact same order without leaving an empty session.
 * 5. Closed session rejection preserves draft and refuses order attachment.
 * 6. POS cart draft isolation: session drafts never overwrite unattached default cart,
 *    delayed confirmation subtracts only submitted items, and restorePosCart never
 *    hydrates a stale selectedSessionId.
 * 7. UI & Edge Function isolation invariants (scan-only QR hidden, no checkByTable fallback,
 *    no balance-based dedup, no groupCheck UNSETTLED bleed, clean labels without S1).
 *
 * Usage: npx tsx --env-file=.env.local scripts/test-pos-home-fixes.mts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  savePosSessionDraft,
  getPosSessionDraft,
  clearPosSessionDraft,
  subtractPosSessionDraft,
  subtractLinesFromCart,
  saveRecoverablePosDraft,
  getRecoverablePosDraft,
  getRecoverablePosDrafts,
  clearRecoverablePosDraft,
  subtractRecoverablePosDraft,
  recoverDraftToUnattachedCart,
  tryRecoverDraftToUnattachedCart,
  findEditableSession,
  isSessionEditable,
  resolveSessionLifecycle,
  restorePosCart,
  clearPosCart,
  savePosActiveSessionId,
  getPosActiveSessionId,
  clearPosActiveSessionId,
} from "../src/lib/pos-cart";
import { OrderQueue, type StorageLike } from "../src/lib/order-queue";
import { writeStored } from "../src/lib/storage-keys";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}: ${err?.message || err}`);
    failed++;
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ [FAIL] ${name}: ${err?.message || err}`);
    failed++;
  }
}

// ── 1. Cart Draft Isolation & Delayed Confirmation (Offline) ─────────────────
console.log("\n── 1. POS Cart Draft Protection & Delayed Confirmation ──");

const backing = new Map<string, string>();
(globalThis as any).window = (globalThis as any).window ?? globalThis;
(globalThis as any).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => backing.set(k, v),
  removeItem: (k: string) => backing.delete(k),
};

const T = "tenant-pos-fix";
const U = "user-pos-fix";

check("session draft save does not overwrite unattached default cart", () => {
  clearPosCart(T, U);
  savePosSessionDraft(T, U, null, {
    cart: [{ menuItemId: "m1", name: "Burger", price: 150, quantity: 1 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    selectedSessionId: null,
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });
  savePosSessionDraft(T, U, "sess-A", {
    cart: [{ menuItemId: "m2", name: "Pasta", price: 250, quantity: 2 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    selectedSessionId: "sess-A",
    customerName: "Alice",
    customerPhone: "",
    promoCode: "SAVE10",
  });

  const restored = restorePosCart(T, U);
  assert.ok(restored, "default cart should be restored");
  assert.equal(restored.selectedSessionId ?? null, null, "restored cart must not carry stale selectedSessionId");
  assert.equal(restored.cart.length, 1);
  assert.equal(restored.cart[0].menuItemId, "m1");
});

check("delayed confirmation subtracts only submitted items and preserves newer items in originating draft", () => {
  savePosSessionDraft(T, U, "sess-A", {
    cart: [
      { menuItemId: "m2", name: "Pasta", price: 250, quantity: 3 },
      { menuItemId: "m3", name: "Fries", price: 90, quantity: 1 },
    ],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    selectedSessionId: "sess-A",
    customerName: "Alice",
    customerPhone: "",
    promoCode: "",
  });

  // Order originally submitted 2x Pasta; user added 1x Pasta + 1x Fries before confirmation arrived
  const remaining = subtractPosSessionDraft(T, U, "sess-A", [
    { menuItemId: "m2", quantity: 2 },
  ]);

  assert.ok(remaining, "remaining items must be preserved");
  assert.equal(remaining.cart.length, 2);
  assert.equal(remaining.cart[0].menuItemId, "m2");
  assert.equal(remaining.cart[0].quantity, 1, "only submitted quantity subtracted");
  assert.equal(remaining.cart[1].menuItemId, "m3");

  // Default cart untouched
  const def = getPosSessionDraft(T, U, null);
  assert.equal(def?.cart[0].menuItemId, "m1");
});

check("subtractPosSessionDraft deletes draft when all submitted items are consumed", () => {
  savePosSessionDraft(T, U, "sess-B", {
    cart: [{ menuItemId: "m4", name: "Tea", price: 40, quantity: 2 }],
    orderType: "TAKEAWAY",
    selectedTableId: null,
    selectedSessionId: "sess-B",
    customerName: "Bob",
    customerPhone: "",
    promoCode: "",
  });
  const rem = subtractPosSessionDraft(T, U, "sess-B", [{ menuItemId: "m4", quantity: 2 }]);
  assert.equal(rem, null);
  assert.equal(getPosSessionDraft(T, U, "sess-B"), null);
});

check("active session id persists and clears independently", () => {
  savePosActiveSessionId(T, U, "sess-A");
  assert.equal(getPosActiveSessionId(T, U), "sess-A");
  savePosActiveSessionId(T, U, null);
  assert.equal(getPosActiveSessionId(T, U), null);
});

await checkAsync("PR#14 P1-1: delayed confirmation after switching sittings subtracts confirmed items from snapshot & preserves sitting cart", async () => {
  clearPosCart(T, U);
  const queueStore = new Map<string, string>();
  const memStorage: StorageLike = {
    getItem: (k) => queueStore.get(k) ?? null,
    setItem: (k, v) => queueStore.set(k, v),
    removeItem: (k) => queueStore.delete(k),
  };

  let resolveOrder!: (res: Response) => void;
  const deferredFetcher = (() => new Promise<Response>((r) => { resolveOrder = r; })) as any;

  // 1. Cashier builds unattached cart (2x Burger Half + 1x Fries) and submits 1x Burger Half + 1x Fries
  let preSelectSnapshot: any = {
    cart: [
      { menuItemId: "m1", name: "Burger", portionId: "half", portion: "Half", price: 120, quantity: 2 },
      { menuItemId: "m3", name: "Fries", price: 90, quantity: 1 },
    ],
    orderType: "DINE_IN" as const,
    selectedTableId: "tbl-1",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  };
  savePosSessionDraft(T, U, null, { ...preSelectSnapshot, selectedSessionId: null });

  let currentSessionId: string | null = "sess-A";
  let sittingCart = [{ menuItemId: "m2", name: "Pasta", price: 250, quantity: 1 }];

  const q = new OrderQueue(memStorage, `${T}-${U}-q`, deferredFetcher, {
    onConfirmed: (_order, entry) => {
      const originSessionId = entry.payload.tableSessionId ?? null;
      const submittedLines = entry.payload.items ?? [];
      if (currentSessionId !== originSessionId) {
        subtractPosSessionDraft(T, U, originSessionId, submittedLines);
        if (!originSessionId && preSelectSnapshot) {
          const remainingPre = subtractLinesFromCart(preSelectSnapshot.cart, submittedLines);
          preSelectSnapshot = remainingPre.length > 0 ? { ...preSelectSnapshot, cart: remainingPre } : null;
        }
      }
    },
  });

  // Enqueue unattached order while on unattached cart, then switch to sess-A before it resolves
  q.enqueue("pos", {
    tableId: "tbl-1",
    orderType: "DINE_IN",
    items: [
      { menuItemId: "m1", portionId: "half", portion: "Half", quantity: 1 },
      { menuItemId: "m3", quantity: 1 },
    ],
  }, 2);

  // Resolve delayed confirmation while sess-A is selected
  resolveOrder(new Response(JSON.stringify({ id: "ord-1", orderNumber: 101 }), { status: 201 }));
  await new Promise((r) => setTimeout(r, 20));

  // Sitting cart is intact
  assert.equal(sittingCart.length, 1);
  assert.equal(sittingCart[0].menuItemId, "m2");

  // Leaving sitting restores only the unsubmitted 1x Burger (Half), Fries is absent
  assert.ok(preSelectSnapshot, "unsubmitted quantity must remain in snapshot");
  assert.equal(preSelectSnapshot.cart.length, 1);
  assert.equal(preSelectSnapshot.cart[0].menuItemId, "m1");
  assert.equal(preSelectSnapshot.cart[0].portionId, "half");
  assert.equal(preSelectSnapshot.cart[0].quantity, 1);

  const storedDefault = getPosSessionDraft(T, U, null);
  assert.equal(storedDefault?.cart.length, 1);
  assert.equal(storedDefault?.cart[0].quantity, 1);
});

await checkAsync("PR#14 P1-2a: remote settlement restores prior unattached cart and recovers unsent items once", async () => {
  clearPosCart(T, U);
  // Prior unattached cart
  savePosSessionDraft(T, U, null, {
    cart: [{ menuItemId: "m1", name: "Burger", price: 150, quantity: 1 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    selectedSessionId: null,
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });
  // Unsent draft on sess-A
  savePosSessionDraft(T, U, "sess-A", {
    cart: [{ menuItemId: "m5", name: "Pizza", price: 300, quantity: 2 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-2",
    selectedSessionId: "sess-A",
    customerName: "Alice",
    customerPhone: "",
    promoCode: "",
  });

  // Remote settlement recovery moves sess-A's unsent items to recoverable draft
  const sessDraft = getPosSessionDraft(T, U, "sess-A")!;
  saveRecoverablePosDraft(T, U, {
    sessionId: "sess-A",
    cart: sessDraft.cart,
    orderType: sessDraft.orderType,
    selectedTableId: sessDraft.selectedTableId,
    customerName: sessDraft.customerName,
    customerPhone: sessDraft.customerPhone,
    promoCode: sessDraft.promoCode,
  });
  clearPosSessionDraft(T, U, "sess-A");

  // Prior unattached cart is intact
  const prior = restorePosCart(T, U);
  assert.equal(prior?.cart.length, 1);
  assert.equal(prior?.cart[0].menuItemId, "m1");

  // Refuses recovery while unattached cart is non-empty
  assert.equal(recoverDraftToUnattachedCart(T, U, prior!.cart), null);

  // Clear unattached cart, then recover once
  clearPosSessionDraft(T, U, null);
  const recovered = recoverDraftToUnattachedCart(T, U, []);
  assert.ok(recovered);
  assert.equal(recovered.selectedSessionId, null);
  assert.equal(recovered.cart.length, 1);
  assert.equal(recovered.cart[0].menuItemId, "m5");
  assert.equal(recovered.cart[0].quantity, 2);

  // Second recovery attempt returns null (once-only)
  assert.equal(getRecoverablePosDraft(T, U), null);
  assert.equal(recoverDraftToUnattachedCart(T, U, []), null);
});

await checkAsync("PR#14 P1-2b: in-flight checkout on closed sitting holds recovery, retains items on closed-session rejection, and subtracts on confirm", async () => {
  clearPosCart(T, U);
  const queueStore = new Map<string, string>();
  const memStorage: StorageLike = {
    getItem: (k) => queueStore.get(k) ?? null,
    setItem: (k, v) => queueStore.set(k, v),
    removeItem: (k) => queueStore.delete(k),
  };

  let resolveOrder!: (res: Response) => void;
  const deferredFetcher = (() => new Promise<Response>((r) => { resolveOrder = r; })) as any;

  let recoverable = saveRecoverablePosDraft(T, U, {
    sessionId: "sess-closed",
    cart: [
      { menuItemId: "m5", name: "Pizza", price: 300, quantity: 2 },
      { menuItemId: "m6", name: "Coke", price: 60, quantity: 1 },
    ],
    orderType: "DINE_IN",
    selectedTableId: "tbl-2",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });

  const q = new OrderQueue(memStorage, `${T}-${U}-q2`, deferredFetcher, {
    onConfirmed: (_order, entry) => {
      recoverable = subtractRecoverablePosDraft(T, U, entry.payload.tableSessionId, entry.payload.items ?? []);
    },
    onFailed: (_err, entry) => {
      q.retire(entry.key);
    },
  });

  q.enqueue("pos", {
    tableId: "tbl-2",
    tableSessionId: "sess-closed",
    orderType: "DINE_IN",
    items: [{ menuItemId: "m5", quantity: 1 }],
  }, 1);

  // While checkout is in-flight, recovery is held
  const held = q.load().some((e) => (e.state === "pending" || e.state === "submitting") && e.payload?.tableSessionId === recoverable?.sessionId);
  assert.equal(held, true, "recovery must be held while checkout is unresolved");

  // Server rejects with closed-session 400
  resolveOrder(new Response(JSON.stringify({ error: "SESSION_INVALID_OR_ENDED" }), { status: 400 }));
  await new Promise((r) => setTimeout(r, 20));

  const heldAfterReject = q.load().some((e) => (e.state === "pending" || e.state === "submitting") && e.payload?.tableSessionId === recoverable?.sessionId);
  assert.equal(heldAfterReject, false, "recovery unblocked after rejection");
  const retained = getRecoverablePosDraft(T, U);
  assert.equal(retained?.cart.length, 2, "all items retained after closed-session rejection");
  assert.equal(retained?.cart[0].quantity, 2);

  // If an in-flight checkout confirms instead, only confirmed quantities are subtracted
  const sub = subtractRecoverablePosDraft(T, U, "sess-closed", [{ menuItemId: "m5", quantity: 1 }]);
  assert.equal(sub?.cart[0].quantity, 1, "confirmed 1x Pizza subtracted, 1x Pizza + 1x Coke remain");
  assert.equal(sub?.cart[1].quantity, 1);
  clearRecoverablePosDraft(T, U);
});

await checkAsync("PR#14 review P1: confirming last item of a sitting restores original unattached cart and survives reload", async () => {
  clearPosCart(T, U);
  const queueStore = new Map<string, string>();
  const memStorage: StorageLike = {
    getItem: (k) => queueStore.get(k) ?? null,
    setItem: (k, v) => queueStore.set(k, v),
    removeItem: (k) => queueStore.delete(k),
  };

  // 1. Cashier builds unattached cart (2x Burger on tbl-1)
  let preSelectSnapshot: any = {
    cart: [{ menuItemId: "m1", name: "Burger", price: 150, quantity: 2 }],
    orderType: "DINE_IN" as const,
    selectedTableId: "tbl-1",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  };
  savePosSessionDraft(T, U, null, { ...preSelectSnapshot, selectedSessionId: null });

  // 2. Cashier opens sitting sess-A and adds 1x Pasta
  let selectedSessionId: string | null = "sess-A";
  let selectedTableId: string | null = "tbl-2";
  let cart = [{ menuItemId: "m2", name: "Pasta", price: 250, quantity: 1 }];
  savePosSessionDraft(T, U, "sess-A", {
    cart,
    orderType: "DINE_IN",
    selectedTableId: "tbl-2",
    selectedSessionId: "sess-A",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });

  const mockFetcher = (async () =>
    new Response(JSON.stringify({ id: "ord-200", orderNumber: 200 }), { status: 201 })) as any;

  const q = new OrderQueue(memStorage, `${T}-${U}-q3`, mockFetcher, {
    onConfirmed: (_order, entry) => {
      const originSessionId = entry.payload.tableSessionId ?? null;
      const submittedLines = entry.payload.items ?? [];
      if (selectedSessionId === originSessionId) {
        cart = subtractLinesFromCart(cart, submittedLines);
        if (cart.length === 0) {
          clearPosSessionDraft(T, U, originSessionId);
          if (originSessionId) {
            clearPosActiveSessionId(T, U);
            const pre = preSelectSnapshot ?? getPosSessionDraft(T, U, null);
            if (pre) {
              cart = [...pre.cart];
              selectedTableId = pre.selectedTableId;
              selectedSessionId = null;
              // Simulate persistence effect running on restored unattached cart
              savePosSessionDraft(T, U, null, { ...pre, selectedSessionId: null });
            }
            preSelectSnapshot = null;
          }
        }
      }
    },
  });

  q.enqueue("pos", {
    tableId: "tbl-2",
    tableSessionId: "sess-A",
    orderType: "DINE_IN",
    items: [{ menuItemId: "m2", quantity: 1 }],
  }, 1);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(selectedSessionId, null);
  assert.equal(selectedTableId, "tbl-1");
  assert.equal(cart.length, 1);
  assert.equal(cart[0].menuItemId, "m1");
  assert.equal(cart[0].quantity, 2);

  // Survives reload
  const reloaded = restorePosCart(T, U);
  assert.ok(reloaded, "unattached cart must survive reload after sitting confirmation");
  assert.equal(reloaded.selectedTableId, "tbl-1");
  assert.equal(reloaded.cart.length, 1);
  assert.equal(reloaded.cart[0].menuItemId, "m1");
  assert.equal(reloaded.cart[0].quantity, 2);
});

check("PR#14 review P2-1: ended sitting with unpaid bill is NOT editable, while open sitting with cancelled last order stays editable", () => {
  const sessionGroups = [
    {
      tableId: "tbl-1",
      sessions: [
        {
          id: "sess-ended-unpaid",
          status: "ENDED",
          orderType: "DINE_IN" as const,
          check: { status: "UNSETTLED" },
        },
        {
          id: "sess-open-cancelled",
          status: "ACTIVE",
          orderType: "DINE_IN" as const,
          check: { status: "OPEN" },
        },
      ],
    },
  ];

  assert.equal(isSessionEditable("sess-ended-unpaid", sessionGroups), false, "ended sitting with unpaid bill cannot be edited");
  assert.equal(findEditableSession("sess-ended-unpaid", sessionGroups), null);

  assert.equal(isSessionEditable("sess-open-cancelled", sessionGroups), true, "open sitting remains editable after last order cancelled");
  const found = findEditableSession("sess-open-cancelled", sessionGroups);
  assert.equal(found?.sessionId, "sess-open-cancelled");
  assert.equal(found?.tableId, "tbl-1");
});

check("PR#14 review P2-2: multiple closed sittings keep separate recovery drafts and recover/dismiss independently (with legacy compatibility)", () => {
  clearPosCart(T, U);

  // Verify legacy single-object format is preserved and normalized
  writeStored(
    "posCart",
    JSON.stringify({
      sessionId: "sess-legacy",
      cart: [{ menuItemId: "m0", name: "Soup", price: 100, quantity: 1 }],
      orderType: "DINE_IN",
      selectedTableId: "tbl-0",
      promoCode: "",
      savedAt: 1000,
    }),
    `${T}-${U}-recoverable`,
  );
  assert.equal(getRecoverablePosDrafts(T, U).length, 1);
  assert.equal(getRecoverablePosDraft(T, U, "sess-legacy")?.cart[0].menuItemId, "m0");

  // Close two more sittings with unsent items before recovering any
  saveRecoverablePosDraft(T, U, {
    sessionId: "sess-1",
    cart: [{ menuItemId: "m1", name: "Burger", price: 150, quantity: 2 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    customerName: "Alice",
    customerPhone: "",
    promoCode: "",
  });
  saveRecoverablePosDraft(T, U, {
    sessionId: "sess-2",
    cart: [{ menuItemId: "m2", name: "Pasta", price: 250, quantity: 1 }],
    orderType: "TAKEAWAY",
    selectedTableId: null,
    customerName: "Bob",
    customerPhone: "",
    promoCode: "",
  });

  const all = getRecoverablePosDrafts(T, U);
  assert.equal(all.length, 3, "all three drafts (legacy + sess-1 + sess-2) survive independently");

  // Dismiss legacy draft -> only sess-legacy removed
  clearRecoverablePosDraft(T, U, "sess-legacy");
  assert.equal(getRecoverablePosDraft(T, U, "sess-legacy"), null);
  assert.equal(getRecoverablePosDrafts(T, U).length, 2);

  // Recover sess-1 -> sess-2 remains intact
  const rec1 = recoverDraftToUnattachedCart(T, U, [], "sess-1");
  assert.equal(rec1?.cart[0].menuItemId, "m1");
  assert.equal(rec1?.cart[0].quantity, 2);
  assert.equal(getRecoverablePosDraft(T, U, "sess-1"), null);
  assert.equal(getRecoverablePosDraft(T, U, "sess-2")?.cart[0].menuItemId, "m2");

  // Clear unattached cart, then recover sess-2 independently
  clearPosSessionDraft(T, U, null);
  const rec2 = recoverDraftToUnattachedCart(T, U, [], "sess-2");
  assert.equal(rec2?.cart[0].menuItemId, "m2");
  assert.equal(rec2?.orderType, "TAKEAWAY");
  assert.equal(getRecoverablePosDrafts(T, U).length, 0);
});

check("PR#14 P2-1 (lifecycle): open sitting omitted from /active after last order cancelled stays selected; confirmed closure triggers recovery", () => {
  const sid = "sess-old-cancelled";
  // Omitted from `/table-session/active` (`sessionGroups = []`), but authoritative `tableSessions` is ACTIVE
  const openRes = resolveSessionLifecycle(
    sid,
    [],
    { [sid]: { id: sid, tableId: "tbl-3", status: "ACTIVE", endedAt: null } },
    {},
    [{ tableSessionId: sid, checkId: "chk-3", orderType: "DINE_IN", customerName: "Sam" }],
  );
  assert.equal(openRes.state, "open");
  assert.equal(openRes.editable?.sessionId, sid);
  assert.equal(openRes.editable?.tableId, "tbl-3");

  // Omitted from both `/table-session/active` and `tableSessions` -> unknown (must NOT treat as closed)
  const unknownRes = resolveSessionLifecycle(sid, [], {}, {}, []);
  assert.equal(unknownRes.state, "unknown");

  // Confirmed ENDED in `tableSessions` -> closed (safe to move draft to recovery)
  const closedRes = resolveSessionLifecycle(
    sid,
    [],
    { [sid]: { id: sid, tableId: "tbl-3", status: "ENDED", endedAt: new Date().toISOString() } },
    {},
    [],
  );
  assert.equal(closedRes.state, "closed");
  assert.equal(closedRes.editable, null);
});

check("PR#14 P2-2 (quota): storage write failure preserves source draft in both move directions and retry succeeds once", () => {
  clearPosCart(T, U);

  // Direction A: session draft -> recoverable draft
  savePosSessionDraft(T, U, "sess-q1", {
    cart: [{ menuItemId: "m1", name: "Burger", price: 150, quantity: 2 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    selectedSessionId: "sess-q1",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });

  const origSetItem = (globalThis as any).localStorage.setItem;
  // Simulate QuotaExceededError when writing recoverable storage
  (globalThis as any).localStorage.setItem = (k: string, v: string) => {
    if (k.includes("-recoverable")) {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    }
    return origSetItem(k, v);
  };

  const failedMoveA = saveRecoverablePosDraft(T, U, {
    sessionId: "sess-q1",
    cart: getPosSessionDraft(T, U, "sess-q1")!.cart,
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });
  assert.equal(failedMoveA, null, "must report failure when recoverable write throws");
  // Source session draft must survive untouched
  assert.equal(getPosSessionDraft(T, U, "sess-q1")?.cart[0].quantity, 2);

  // Clear quota error and retry -> succeeds and source can be cleared
  (globalThis as any).localStorage.setItem = origSetItem;
  const retryMoveA = saveRecoverablePosDraft(T, U, {
    sessionId: "sess-q1",
    cart: getPosSessionDraft(T, U, "sess-q1")!.cart,
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });
  assert.ok(retryMoveA, "retry succeeds once storage is writable");
  clearPosSessionDraft(T, U, "sess-q1");
  assert.equal(getPosSessionDraft(T, U, "sess-q1"), null);
  assert.equal(getRecoverablePosDraft(T, U, "sess-q1")?.cart[0].quantity, 2);

  // Direction B: recoverable draft -> unattached cart
  (globalThis as any).localStorage.setItem = (k: string, v: string) => {
    if (k.includes("-drafts") || k.endsWith(`${T}-${U}`)) {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    }
    return origSetItem(k, v);
  };

  const failedMoveB = tryRecoverDraftToUnattachedCart(T, U, [], "sess-q1");
  assert.equal(failedMoveB.ok, false);
  if (!failedMoveB.ok) assert.equal(failedMoveB.reason, "storage_error");
  // Source recoverable draft must survive untouched
  assert.equal(getRecoverablePosDraft(T, U, "sess-q1")?.cart[0].quantity, 2);

  // Clear quota error and retry -> moves exactly once
  (globalThis as any).localStorage.setItem = origSetItem;
  const retryMoveB = tryRecoverDraftToUnattachedCart(T, U, [], "sess-q1");
  assert.equal(retryMoveB.ok, true);
  if (retryMoveB.ok) {
    assert.equal(retryMoveB.snapshot.cart[0].menuItemId, "m1");
    assert.equal(retryMoveB.snapshot.cart[0].quantity, 2);
  }
  assert.equal(getRecoverablePosDraft(T, U, "sess-q1"), null);
  const secondMoveB = tryRecoverDraftToUnattachedCart(T, U, [], "sess-q1");
  assert.equal(secondMoveB.ok, false);
});

await checkAsync("PR#14 P2-1 (checkout): active sitting omitted from floor list after last order cancelled still submits to original sitting", async () => {
  const sid = "sess-omitted-active";
  const sessions: any[] = []; // Omitted from /table-session/active (and therefore floor list)
  const tableSessions = {
    [sid]: { id: sid, tableId: "tbl-4", status: "ACTIVE", endedAt: null },
  };
  const lifecycle = resolveSessionLifecycle(sid, sessions, tableSessions, {}, []);
  assert.notEqual(lifecycle.state, "closed", "active sitting omitted from floor list must not be treated as closed at checkout");
  assert.equal(lifecycle.state, "open");

  const queueStore = new Map<string, string>();
  const memStorage: StorageLike = {
    getItem: (k) => queueStore.get(k) ?? null,
    setItem: (k, v) => queueStore.set(k, v),
    removeItem: (k) => queueStore.delete(k),
  };

  let capturedPayload: any = null;
  const mockFetcher = (async (_url: string, init?: RequestInit) => {
    capturedPayload = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify({ id: "ord-301", orderNumber: 301, tableSessionId: sid }), { status: 201 });
  }) as any;

  const q = new OrderQueue(memStorage, `${T}-${U}-q4`, mockFetcher);
  q.enqueue("pos", {
    tableId: "tbl-4",
    tableSessionId: sid,
    createNewSitting: false,
    orderType: "DINE_IN",
    items: [{ menuItemId: "m1", quantity: 1 }],
  }, 1);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(capturedPayload?.tableSessionId, sid, "checkout must submit to the original sitting ID");
  assert.equal(capturedPayload?.createNewSitting, false);

  // When confirmed ENDED, lifecycle is 'closed' and checkout would block
  const closedLifecycle = resolveSessionLifecycle(
    sid,
    sessions,
    { [sid]: { id: sid, tableId: "tbl-4", status: "ENDED", endedAt: new Date().toISOString() } },
    {},
    [],
  );
  assert.equal(closedLifecycle.state, "closed");
});

check("PR#14 P2-2 (partial write fault): canonical write failure preserves source; canonical success + legacy mirror failure leaves single copy", () => {
  clearPosCart(T, U);

  saveRecoverablePosDraft(T, U, {
    sessionId: "sess-partial",
    cart: [{ menuItemId: "m1", name: "Burger", price: 150, quantity: 3 }],
    orderType: "DINE_IN",
    selectedTableId: "tbl-1",
    customerName: "",
    customerPhone: "",
    promoCode: "",
  });

  const origSetItem = (globalThis as any).localStorage.setItem;

  // Case A: failure on first (canonical -drafts) write
  (globalThis as any).localStorage.setItem = (k: string, v: string) => {
    if (k.includes("-drafts")) {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    }
    return origSetItem(k, v);
  };
  const resA = tryRecoverDraftToUnattachedCart(T, U, [], "sess-partial");
  assert.equal(resA.ok, false);
  if (!resA.ok) assert.equal(resA.reason, "storage_error");
  assert.equal(restorePosCart(T, U), null, "canonical write failed so nothing committed");
  assert.equal(getRecoverablePosDraft(T, U, "sess-partial")?.cart[0].quantity, 3, "source recoverable draft preserved");

  // Case B: canonical -drafts succeeds, legacy mirror suffix fails
  (globalThis as any).localStorage.setItem = (k: string, v: string) => {
    if (k.endsWith(`${T}-${U}`)) {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    }
    return origSetItem(k, v);
  };
  const resB = tryRecoverDraftToUnattachedCart(T, U, [], "sess-partial");
  assert.equal(resB.ok, true, "canonical commit succeeds even if legacy mirror write fails");
  assert.equal(getRecoverablePosDraft(T, U, "sess-partial"), null, "recoverable source cleared so no duplicate copy exists");

  // Simulate reload: only one usable copy exists with exact items and quantities
  (globalThis as any).localStorage.setItem = origSetItem;
  const reloaded = restorePosCart(T, U);
  assert.ok(reloaded, "recovered cart survives reload");
  assert.equal(reloaded.cart.length, 1);
  assert.equal(reloaded.cart[0].menuItemId, "m1");
  assert.equal(reloaded.cart[0].quantity, 3);
  assert.equal(tryRecoverDraftToUnattachedCart(T, U, [], "sess-partial").ok, false, "cannot recover a second time");
});

delete (globalThis as any).localStorage;

// ── 2. UI & Edge Function Isolation Static Invariants ────────────────────────
console.log("\n── 2. UI & Edge Function Isolation Invariants ──");

const dashboardCode = fs.readFileSync(path.resolve("src/components/views/dashboard.tsx"), "utf-8");
const tableSessionCode = fs.readFileSync(path.resolve("supabase/functions/table-session/index.ts"), "utf-8");
const ordersFnCode = fs.readFileSync(path.resolve("supabase/functions/orders/index.ts"), "utf-8");

check("table-session/active never falls back to checkByTable for session checks", () => {
  assert.match(tableSessionCode, /\(s as any\)\.check = \(s\.id && checkBySession\[s\.id\]\) \|\| null;/);
  assert.match(tableSessionCode, /const chk = \(s\.id && checkBySession\[s\.id\]\) \|\| null;/);
});

check("POS Home removes groupCheck fallback, UNSETTLED bleed, and balance-based dedup", () => {
  assert.doesNotMatch(dashboardCode, /groupCheck\?\.status === 'UNSETTLED'/);
  assert.doesNotMatch(dashboardCode, /groupCheck\?\.status === 'PAID'/);
  assert.doesNotMatch(dashboardCode, /Math\.abs\(c\.outstanding - Number\(b\.outstanding\)\) < 0\.01/);
  assert.match(dashboardCode, /o\.tableSessionId === s\.id && o\.status !== 'CANCELLED' && o\.status !== 'PENDING_ACTIVATION'/);
});

check("POS Home keeps scan-only QR sessions hidden and blocks cancelled/held in pendingBills", () => {
  assert.match(dashboardCode, /if \(total === 0 && activeOrders\.length === 0\) return/);
  assert.match(dashboardCode, /b\.checkId \? o\.checkId === b\.checkId : \(b\.sessionId \? o\.tableSessionId === b\.sessionId : false\)/);
});

check("POS Home allows new dine-in order on tables with 2+ active sessions", () => {
  assert.match(dashboardCode, /const isAmbiguousSitting = false/);
  assert.doesNotMatch(dashboardCode, /This table has multiple active diner sessions\. Please select which diner\/bill/);
});

check("POS Home cleans up session labels (no S1, chronological Diner N)", () => {
  assert.doesNotMatch(dashboardCode, /· S1/);
  assert.doesNotMatch(dashboardCode, /· S\$\{/);
  assert.match(dashboardCode, /return sessionNumber \? `Takeaway · Diner \$\{sessionNumber\}` : 'Takeaway'/);
  assert.match(dashboardCode, /return sessionNumber \? `Delivery · Diner \$\{sessionNumber\}` : 'Delivery'/);
  assert.match(dashboardCode, /return `\$\{tableName\} · Diner \$\{sessionNumber\}`/);
});

check("POS Home handles delayed confirmation, refresh, and remote settlement cleanup", () => {
  assert.match(dashboardCode, /subtractPosSessionDraft\(tenantId, userId, originSessionId, submittedLines\)/);
  assert.match(dashboardCode, /resolveSessionLifecycle\(selectedSessionId, sessions, tableSessions, checks, data\?\.orders\)/);
  assert.match(dashboardCode, /resolveSessionLifecycle\(savedActiveSessionId, sessions, tableSessions, checks, data\?\.orders\)/);
  assert.match(ordersFnCode, /createNewSession = true/);
});

// ── 3. Isolated Database E2E: 3rd Sitting, Rollback, Idempotency & Closure ───
console.log("\n── 3. Isolated Database E2E (3rd Sitting, Rollback, Idempotency) ──");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY || SERVICE_KEY.startsWith("<YOUR_")) {
  console.log("  ⚠️  Skipping live DB checks (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured)");
} else {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const slug = `pos-fix-audit-${Date.now()}`;
  let tenantId: string | null = null;

  try {
    const { data: tenant, error: tErr } = await db
      .from("tenants")
      .insert({ name: "POS Fix Audit Tenant", slug, currency_symbol: "₹", tax_rate: 5, service_charge: 0, active: true })
      .select("id")
      .single();
    if (tErr || !tenant) throw new Error(`Tenant setup failed: ${tErr?.message}`);
    tenantId = tenant.id;

    const { data: cat, error: cErr } = await db
      .from("categories")
      .insert({ tenant_id: tenantId, name: "Mains", sort_order: 1 })
      .select("id")
      .single();
    if (cErr || !cat) throw new Error(`Category setup failed: ${cErr?.message}`);

    const { data: item, error: iErr } = await db
      .from("menu_items")
      .insert({ tenant_id: tenantId, category_id: cat.id, name: "Audit Bowl", price: 200, available: true })
      .select("id")
      .single();
    if (iErr || !item) throw new Error(`Menu item setup failed: ${iErr?.message}`);

    const { data: table, error: tblErr } = await db
      .from("tables")
      .insert({ tenant_id: tenantId, name: "Table 1", seats: 4, area: "Main", active: true, qr_token: `qr-${Date.now()}` })
      .select("id")
      .single();
    if (tblErr || !table) throw new Error(`Table setup failed: ${tblErr?.message}`);

    const placePosOrder = async (opts: { sessionId?: string | null; createNewSession?: boolean; idempKey?: string }) => {
      const { data, error } = await db.rpc("create_order_tx", {
        p_order: {
          tenant_id: tenantId,
          table_id: table.id,
          table_session_id: opts.sessionId ?? null,
          create_new_session: opts.createNewSession ? true : undefined,
          order_type: "DINE_IN",
          items_total: 200,
          discount: 0,
          tax: 10,
          service_charge: 0,
          total: 210,
        },
        p_items: [{ menu_item_id: item.id, name: "Audit Bowl", price: 200, quantity: 1, status: "PENDING" }],
        p_promo_code_id: null,
        p_idempotency_key: opts.idempKey ?? crypto.randomUUID(),
      });
      if (error) throw new Error(error.message);
      return data as { order_id: string; check_id: string; table_session_id: string; deduplicated?: boolean };
    };

    let s1: any, s2: any, s3: any;
    const s3Key = crypto.randomUUID();

    await checkAsync("1st, 2nd, and 3rd independent sittings on same table create distinct sessions, checks, and KOT #1", async () => {
      s1 = await placePosOrder({ createNewSession: true });
      s2 = await placePosOrder({ createNewSession: true });
      s3 = await placePosOrder({ createNewSession: true, idempKey: s3Key });

      assert.notEqual(s1.table_session_id, s2.table_session_id);
      assert.notEqual(s2.table_session_id, s3.table_session_id);
      assert.notEqual(s1.table_session_id, s3.table_session_id);
      assert.notEqual(s1.check_id, s2.check_id);
      assert.notEqual(s2.check_id, s3.check_id);

      const { data: oi3 } = await db.from("order_items").select("kot_number").eq("order_id", s3.order_id).single();
      assert.equal(oi3?.kot_number, 1, "3rd independent sitting starts at KOT #1");
    });

    await checkAsync("adding order to existing Session 2 reuses check and increments KOT to #2", async () => {
      const s2Add = await placePosOrder({ sessionId: s2.table_session_id });
      assert.equal(s2Add.table_session_id, s2.table_session_id);
      assert.equal(s2Add.check_id, s2.check_id);

      const { data: oi2 } = await db.from("order_items").select("kot_number").eq("order_id", s2Add.order_id).single();
      assert.equal(oi2?.kot_number, 2);
    });

    await checkAsync("idempotent retry on 3rd sitting returns same order without creating extra session", async () => {
      const { count: beforeSessions } = await db
        .from("table_sessions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      const replay = await placePosOrder({ createNewSession: true, idempKey: s3Key });
      assert.equal(replay.deduplicated, true);
      assert.equal(replay.order_id, s3.order_id);
      assert.equal(replay.table_session_id, s3.table_session_id);

      const { count: afterSessions } = await db
        .from("table_sessions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      assert.equal(afterSessions, beforeSessions, "no empty/duplicate session created on retry");
    });

    await checkAsync("atomic rollback on unavailable item leaves zero orphan sessions or checks", async () => {
      const { count: beforeSessions } = await db
        .from("table_sessions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      const { error: failErr } = await db.rpc("create_order_tx", {
        p_order: {
          tenant_id: tenantId,
          table_id: table.id,
          create_new_session: true,
          order_type: "DINE_IN",
          items_total: 200,
          discount: 0,
          tax: 10,
          service_charge: 0,
          total: 210,
        },
        p_items: [{ menu_item_id: crypto.randomUUID(), name: "Ghost Dish", price: 200, quantity: 1 }],
        p_promo_code_id: null,
        p_idempotency_key: crypto.randomUUID(),
      });
      assert.ok(failErr?.message.includes("ITEM_UNAVAILABLE"), "must reject unavailable item");

      const { count: afterSessions } = await db
        .from("table_sessions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId);

      assert.equal(afterSessions, beforeSessions, "failed atomic tx must not leave orphan session");
    });

    await checkAsync("closed session rejects new order attachment while siblings remain active", async () => {
      await db.from("table_sessions").update({ status: "ENDED", ended_at: new Date().toISOString() }).eq("id", s1.table_session_id);

      let rejected = false;
      try {
        await placePosOrder({ sessionId: s1.table_session_id });
      } catch (e: any) {
        rejected = e.message.includes("SESSION_INVALID_OR_ENDED");
      }
      assert.equal(rejected, true, "ended session must reject new order");

      const { data: s2Row } = await db.from("table_sessions").select("status").eq("id", s2.table_session_id).single();
      assert.equal(s2Row?.status, "ACTIVE", "sibling session remains ACTIVE");
    });
  } finally {
    if (tenantId) {
      await db.from("tenants").delete().eq("id", tenantId);
    }
  }
}

console.log("\n================================================================");
console.log(`  TOTAL: ${passed} PASSED, ${failed} FAILED`);
console.log("================================================================\n");

if (failed > 0) process.exit(1);
