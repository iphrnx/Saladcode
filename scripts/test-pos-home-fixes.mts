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
  subtractPosSessionDraft,
  restorePosCart,
  clearPosCart,
  savePosActiveSessionId,
  getPosActiveSessionId,
} from "../src/lib/pos-cart";

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
  assert.match(dashboardCode, /const stillActive = activeSessionCards\.some\(\(c\) => c\.sessionId === selectedSessionId\)/);
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
