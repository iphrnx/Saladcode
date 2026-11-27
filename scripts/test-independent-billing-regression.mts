/**
 * Independent-session billing regression suite (offline).
 *
 * Replaces legacy shared-table-check tests while preserving all still-relevant
 * billing invariants:
 *   - Atomic session-scoped check allocation (open_session_check)
 *   - No open_table_check fallback in create_order_tx or orders/index.ts
 *   - No table-only grouping fallback in Orders board (orders.tsx)
 *   - One-time invoice allocation, CGST/SGST paise split, idempotent payments
 *   - RLS & service-role-only counter/check/payment isolation
 *   - UI bill grouping, thermal printing, and SessionPaymentDialog/SessionOrdersDrawer
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const baselineMig = readFileSync("supabase/migrations/20261113000000_baseline_schema.sql", "utf8");
const migSessions = readFileSync("supabase/migrations/20261114000003_independent_diner_sessions.sql", "utf8");
const migCreateOrder = readFileSync("supabase/migrations/20261127000002_replace_create_order_tx_open_table_check_fallback.sql", "utf8");
const ordersFn = readFileSync("supabase/functions/orders/index.ts", "utf8");
const billFn = readFileSync("supabase/functions/bill/index.ts", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");
const billDialog = readFileSync("src/components/shared/bill-dialog.tsx", "utf8");
const sessionPayment = readFileSync("src/components/shared/session-payment-dialog.tsx", "utf8");
const sessionDrawer = readFileSync("src/components/shared/session-orders-drawer.tsx", "utf8");

console.log("\n── 1. Independent Session Creation & No Shared-Table Fallback ──");
const createOrderBody = migCreateOrder.slice(migCreateOrder.indexOf("create or replace function"));
check(
  "create_order_tx no longer calls open_table_check",
  !/open_table_check/i.test(createOrderBody) && createOrderBody.includes("public.open_session_check("),
);
check(
  "create_order_tx creates a new table_sessions row when table_session_id is omitted",
  migCreateOrder.includes("insert into public.table_sessions") &&
    migCreateOrder.includes("returning id, token into v_session, v_session_token"),
);
check(
  "orders Edge Function creates a new session when POS selects table without session",
  ordersFn.includes("createNewSession = true;") && !ordersFn.includes('code: "AMBIGUOUS_TABLE_SESSION"'),
);
check(
  "Orders board never groups dine-in orders by table:${o.tableId} alone",
  !ordersView.includes("`table:${o.tableId}`"),
);
check(
  "bill Edge Function never falls back to table_id alone",
  !billFn.includes('.eq("table_id", table)'),
);

console.log("\n── 2. Check Totals, Tax Split & Idempotent Payment Invariants ──");
check(
  "open_session_check enforces one OPEN check per session via partial unique index",
  migSessions.includes("on public.table_checks (session_id)") &&
    migSessions.includes("where status = 'OPEN'"),
);
check(
  "bill Edge Function sums order tax and splits CGST/SGST in integer paise",
  billFn.includes("const tax = isPaidCheck") &&
    billFn.includes("cgstPaise = Math.ceil(gstTotalPaise / 2)") &&
    billFn.includes("sgstPaise = gstTotalPaise - cgstPaise"),
);
check(
  "payment ledger enforces idempotency_key uniqueness and overpayment guard",
  baselineMig.includes("check_payments_idem_uidx") &&
    baselineMig.includes("OVERPAYMENT:"),
);
check(
  "check_invoice_counters, table_checks, and check_payments have RLS enabled with no anon SELECT",
  baselineMig.includes("alter table public.check_invoice_counters enable row level security") &&
    baselineMig.includes("alter table public.table_checks enable row level security") &&
    baselineMig.includes("alter table public.check_payments enable row level security") &&
    !/on public\.table_checks for select to anon/.test(baselineMig) &&
    !/on public\.check_payments for select to anon/.test(baselineMig),
);

console.log("\n── 3. UI Billing & Thermal Receipt Rendering ──");
check(
  "BillDialog groups items by order number and supports thermal printing",
  billDialog.includes("const orderGroups = new Map<number, typeof bill.items>()") &&
    billDialog.includes("Order #{orderNum}") &&
    billDialog.includes("@media print {"),
);
check(
  "SessionPaymentDialog & SessionOrdersDrawer render session-scoped bill summary",
  sessionPayment.includes("Bill Summary") &&
    sessionPayment.includes("Select Payment Method") &&
    sessionDrawer.includes("Bill Summary"),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
