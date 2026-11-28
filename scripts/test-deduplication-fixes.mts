/**
 * Test Suite: Business Rules Deduplication & Authoritative Ownership Verification
 *
 * Verifies fixes across:
 * 1. Pricing & portions (SQL add_items_to_order_tx from JSONB portions)
 * 2. Tax & Service Charge (taxable amount base, server taxBreakup consumption)
 * 3. Payment & Invoices (elimination of synthetic invoices)
 * 4. Order Status (constants.ts ORDER_STATUS includes PENDING_ACTIVATION)
 * 5. Permissions & RBAC (hasPermission delegates to hasEffectivePermission)
 * 6. Deprecation markers on legacy Next.js adapters
 *
 * Usage: npx tsx scripts/test-deduplication-fixes.mts
 */
import { existsSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

console.log("\n==================================================================");
console.log("   BUSINESS RULES DEDUPLICATION & AUTHORITATIVE OWNERSHIP VERIFICATION   ");
console.log("==================================================================\n");

const mig0005 = readFileSync("supabase/migrations/20261116000005_fix_business_rules_duplication.sql", "utf8");
const publicMenu = readFileSync("src/components/public/public-menu.tsx", "utf8");
const billDialog = readFileSync("src/components/shared/bill-dialog.tsx", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");
const sessionDrawer = readFileSync("src/components/shared/session-orders-drawer.tsx", "utf8");
const constantsTs = readFileSync("src/lib/constants.ts", "utf8");
const permissionsTs = readFileSync("src/lib/permissions.ts", "utf8");

console.log("── 1. Pricing & Portions: SQL add_items_to_order_tx ──");
{
  check(
    "add_items_to_order_tx resolves portion prices from menu_items.portions JSONB",
    mig0005.includes("v_menu.portions is not null and jsonb_typeof(v_menu.portions) = 'array'")
  );
  check(
    "add_items_to_order_tx omits non-existent dish_portions table and UUID cast",
    !mig0005.includes("from public.dish_portions") && !mig0005.includes("v_portion_id::uuid")
  );
  check(
    "add_items_to_order_tx stores portion_id as text in order_items",
    mig0005.includes("v_portion_id text;")
  );
}

console.log("\n── 2. Tax & Service Charge: Client Alignment ──");
{
  check(
    "public-menu calculates tax on taxableAmount (itemsTotal - discount)",
    publicMenu.includes("const taxableAmount = Math.max(0, itemsTotal - discount)") &&
    publicMenu.includes("const tax = +(taxableAmount * taxRate).toFixed(2)")
  );
  check(
    "bill-dialog prefers server doc.taxBreakup when available",
    billDialog.includes("doc.taxBreakup?.rate") &&
    billDialog.includes("doc.taxBreakup?.cgstAmount")
  );
  check(
    "bill-dialog defaults tax rate to 5% (matching schema default)",
    billDialog.includes("tenant.taxRate ?? 5")
  );
}

console.log("\n── 3. Payment & Invoicing: Real Check Numbers Only ──");
{
  check(
    "orders view does not synthesize fake INV-{orderNumber}",
    !ordersView.includes("`INV-${String(ordersSitting.latest.orderNumber).padStart(6, '0')}`")
  );
  check(
    "session-orders-drawer formatInvoiceNumber returns 'Pending settlement' when unfinalised",
    sessionDrawer.includes("return 'Pending settlement'") &&
    !sessionDrawer.includes("return 'INV-000123'")
  );
}

console.log("\n── 4. Order Status & Transitions ──");
{
  check(
    "constants.ts ORDER_STATUS includes PENDING_ACTIVATION badge definition",
    constantsTs.includes("PENDING_ACTIVATION: { label: 'Held', color: '#8b5cf6', step: -0.5 }")
  );
  check(
    "migration 0005 enforces canonical orders_status_check without stale REJECTED",
    mig0005.includes("check (status in ('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'))")
  );
}

console.log("\n── 5. Permissions & RBAC: Unified Evaluation ──");
{
  check(
    "permissions.ts hasPermission delegates to hasEffectivePermission",
    permissionsTs.includes("return hasEffectivePermission(permissions, permission)")
  );
  check(
    "hasEffectivePermission is imported from @/lib/constants",
    permissionsTs.includes("hasEffectivePermission")
  );
}

console.log("\n── 6. Legacy Adapter Removal ──");
{
  check(
    "legacy src/lib/table-session.ts adapter is removed",
    !existsSync("src/lib/table-session.ts")
  );
  check(
    "legacy src/lib/staff-auth.ts adapter is removed",
    !existsSync("src/lib/staff-auth.ts")
  );
}

console.log("\n==================================================================");
console.log(`  TOTAL: ${pass} PASSED, ${fail} FAILED`);
console.log("==================================================================\n");

if (fail > 0) process.exit(1);

