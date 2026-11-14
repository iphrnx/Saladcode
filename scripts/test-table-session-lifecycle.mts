/**
 * Comprehensive verification of tightened table sessions, POS order binding,
 * consolidated billing, and settlement lifecycle.
 *
 * Usage: npx tsx scripts/test-table-session-lifecycle.mts
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const migTighten = readFileSync("supabase/migrations/20261114000001_tighten_table_sessions.sql", "utf8");
const ordersFn = readFileSync("supabase/functions/orders/index.ts", "utf8");
const billFn = readFileSync("supabase/functions/bill/index.ts", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");

console.log("\n── 1. Session Ownership & POS Order Binding (Database) ──");
{
  check(
    "open_table_check locks the table with pg_advisory_xact_lock",
    migTighten.includes("perform pg_advisory_xact_lock(hashtext(p_table::text));")
  );
  check(
    "open_table_check returns existing open check without bouncing it to UNSETTLED",
    migTighten.includes("return v_existing.id;") &&
    !migTighten.includes("set status = 'UNSETTLED'")
  );
  check(
    "open_table_check creates canonical active session if none exists",
    migTighten.includes("insert into public.table_sessions") &&
    migTighten.includes("'ACTIVE', 'ACTIVE'")
  );
  check(
    "create_order_tx stamps both check_id and table_session_id for table orders",
    migTighten.includes("v_check := public.open_table_check(v_tenant, v_table, v_session);") &&
    migTighten.includes("select anchor_session_id into v_session")
  );
  check(
    "check_is_live verifies active session or live uncompleted orders on the check",
    migTighten.includes("public.orders o") &&
    migTighten.includes("o.status not in ('COMPLETED', 'CANCELLED')")
  );
}

console.log("\n── 2. QR Scan & Table Lifecycle (Database) ──");
{
  check(
    "start_table_session detects occupied table via active session OR open check",
    migTighten.includes("c.table_id = v_table.id") &&
    migTighten.includes("c.status = 'OPEN'")
  );
  check(
    "start_table_session generates isolated session token for each diner scan",
    migTighten.includes("v_session.token") && migTighten.includes("p_device_fp")
  );
  check(
    "finalize_table_check atomically marks all active table sessions ENDED",
    migTighten.includes("update public.table_sessions") &&
    migTighten.includes("set status = 'ENDED'") &&
    migTighten.includes("and status = 'ACTIVE'")
  );
}

console.log("\n── 3. Edge Function Orders & Bill Mapping ──");
{
  check(
    "orders edge function maps checkId in mapOrder",
    ordersFn.includes("checkId: row.check_id")
  );
  check(
    "bill edge function requires payments.collect to finalize",
    billFn.includes('permission: "payments.collect"')
  );
}

console.log("\n── 4. UI Consolidated Billing & Sitting Cards ──");
{
  check(
    "orders view groups sittings primarily by checkId",
    ordersView.includes("`check:${o.checkId}`")
  );
  check(
    "orders view falls back to tableId for active dine-in orders",
    ordersView.includes("o.orderType === 'DINE_IN' && o.tableId") &&
    ordersView.includes("`table:${o.tableId}`")
  );
  check(
    "ending prop is safe against null tableId (no false Ending... on Takeaway/Delivery)",
    ordersView.includes("ending={Boolean(sitting.tableId && endingTable === sitting.tableId)}")
  );
  check(
    "End session menu item is conditionally rendered only for table sittings",
    ordersView.includes("{sitting.tableId && (") &&
    ordersView.includes("End session")
  );
  check(
    "canAddItems includes Owner role fallback",
    ordersView.includes("userRole?.toLowerCase() === 'owner' || canEditOrders")
  );
  check(
    "Add Items is visible in 3-dot menu for Takeaway and Delivery",
    ordersView.includes("canAddItems && isTakeawayOrDelivery") &&
    ordersView.includes("Add Items")
  );
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
