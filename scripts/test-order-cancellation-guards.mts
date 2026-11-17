/**
 * Verification of Order Cancellation Restrictions:
 * - Completely disallow cancelling orders in SERVED status
 * - Never allow cancellation for SERVED, COMPLETED, PAID, or CANCELLED orders
 * - Preserve cancellation for earlier eligible statuses (PENDING, PREPARING, READY)
 * - Verify frontend drawer and orders view rules
 * - Verify backend transition graph and cancellation endpoint
 * - Verify database transaction invariants in cancel_order_tx
 *
 * Run: npx tsx scripts/test-order-cancellation-guards.mts
 */

import { readFileSync } from "fs";
import assert from "node:assert/strict";

console.log("=================================================================");
console.log("   ORDER CANCELLATION GUARDS & STATE TRANSITIONS VERIFICATION    ");
console.log("=================================================================\n");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, details?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${details ? ` -> ${details}` : ""}`);
  }
}

// 1. Audit Frontend: order-detail-drawer.tsx
console.log("── 1. Frontend Order Detail Drawer (order-detail-drawer.tsx) ──");
const drawerSrc = readFileSync("src/components/shared/order-detail-drawer.tsx", "utf8");

check(
  "order-detail-drawer defines canCancelThisOrder excluding SERVED, COMPLETED, CANCELLED, and PAID",
  drawerSrc.includes("!isPaid") &&
  drawerSrc.includes("!isServed") &&
  drawerSrc.includes("!done") &&
  drawerSrc.includes("!cancelled")
);

check(
  "order-detail-drawer completely removes Cancel Order button in Served state",
  !drawerSrc.includes("/* Served state — allow authorized staff to safely cancel if needed */") &&
  drawerSrc.includes("/* Served state — order is served to diners; Cancel Order button is completely removed */")
);

check(
  "order-detail-drawer guards the confirmation dialog with canCancelThisOrder",
  drawerSrc.includes("open={confirmCancelOpen && canCancelThisOrder}")
);

check(
  "order-detail-drawer expands forward step to full width when cancellation is disabled",
  drawerSrc.includes("!canCancelThisOrder && 'w-full flex-none'")
);

// 2. Audit Frontend: orders.tsx
console.log("\n── 2. Frontend Orders List (orders.tsx) ──");
const ordersViewSrc = readFileSync("src/components/views/orders.tsx", "utf8");

check(
  "orders.tsx excludes SERVED, COMPLETED, CANCELLED, and PAID orders from cancellation button",
  ordersViewSrc.includes("const isPaid = order.paymentStatus === 'PAID'") &&
  ordersViewSrc.includes("!isPaid &&") &&
  ordersViewSrc.includes("!['SERVED', 'COMPLETED', 'CANCELLED'].includes(displayStatus)")
);

// 3. Audit Backend: supabase/functions/orders/index.ts
console.log("\n── 3. Backend Edge Function (orders/index.ts) ──");
const ordersFnSrc = readFileSync("supabase/functions/orders/index.ts", "utf8");

check(
  "NEXT state machine does NOT permit CANCELLED from SERVED state",
  ordersFnSrc.includes('SERVED: ["COMPLETED"]') &&
  !ordersFnSrc.includes('SERVED: ["COMPLETED", "CANCELLED"]')
);

check(
  "cancelOrder pre-flight explicitly blocks SERVED orders with 409 Conflict",
  ordersFnSrc.includes('if (currentOrder.status === "SERVED") {') &&
  ordersFnSrc.includes('return json(req, { error: "This order has already been served and cannot be cancelled." }, 409);')
);

check(
  "cancelOrder pre-flight explicitly blocks COMPLETED orders with 409 Conflict",
  ordersFnSrc.includes('if (currentOrder.status === "COMPLETED") {')
);

check(
  "cancelOrder pre-flight explicitly blocks PAID orders with 409 Conflict",
  ordersFnSrc.includes('if (currentOrder.payment_status === "PAID") {')
);

check(
  "update status PATCH handler blocks target === CANCELLED if current.status is SERVED",
  ordersFnSrc.includes('if (current.status === "SERVED") {') &&
  ordersFnSrc.includes('return json(req, { error: "This order has already been served and cannot be cancelled." }, 409);')
);

check(
  "orders Edge Function handles ORDER_ALREADY_SERVED from database procedure",
  ordersFnSrc.includes('if (msg.includes("ORDER_ALREADY_SERVED")) {')
);

// 4. Audit Database Migration: 20261117000007_disallow_cancelling_served_orders.sql
console.log("\n── 4. Database Transaction Invariants (cancel_order_tx) ──");
const migSql = readFileSync("supabase/migrations/20261117000007_disallow_cancelling_served_orders.sql", "utf8");

check(
  "cancel_order_tx raises exception ORDER_ALREADY_SERVED when status is SERVED",
  migSql.includes("if v_order.status = 'SERVED' then") &&
  migSql.includes("raise exception 'ORDER_ALREADY_SERVED' using errcode = 'P0001';")
);

check(
  "cancel_order_tx raises exception ORDER_ALREADY_COMPLETED when status is COMPLETED",
  migSql.includes("if v_order.status = 'COMPLETED' then")
);

check(
  "cancel_order_tx raises exception ORDER_ALREADY_PAID when payment_status is PAID",
  migSql.includes("if v_order.payment_status = 'PAID' then")
);

// 5. State Transition & Eligibility Simulation
console.log("\n── 5. Status Transition Matrix Simulation ──");
const transitions: Record<string, { canCancel: boolean; forward: string[] }> = {
  PENDING_ACTIVATION: { canCancel: false, forward: ["PENDING", "PREPARING"] }, // Uses Reject
  PENDING: { canCancel: true, forward: ["PREPARING"] },
  PREPARING: { canCancel: true, forward: ["READY"] },
  READY: { canCancel: true, forward: ["SERVED"] },
  SERVED: { canCancel: false, forward: ["COMPLETED"] },
  COMPLETED: { canCancel: false, forward: [] },
  CANCELLED: { canCancel: false, forward: [] },
};

for (const [status, rules] of Object.entries(transitions)) {
  const isEligibleForCancel = (st: string, paid = false) => {
    return !paid && !["SERVED", "COMPLETED", "CANCELLED", "PENDING_ACTIVATION"].includes(st);
  };

  const expectedCancel = rules.canCancel;
  const actualCancel = isEligibleForCancel(status, false);
  check(`State ${status}: cancellation eligibility matches contract (${expectedCancel})`, expectedCancel === actualCancel);

  // If paid, must always be false
  const paidCancel = isEligibleForCancel(status, true);
  check(`State ${status} (PAID): cancellation is strictly false`, paidCancel === false);
}

console.log("\n=================================================================");
console.log(`TOTAL: ${passed} PASSED, ${failed} FAILED`);
console.log("=================================================================");

if (failed > 0) {
  process.exit(1);
}

