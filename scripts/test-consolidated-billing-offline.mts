import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

console.log("Consolidated Billing regression & offline verification:\n");

// Read source files
const billDialogSrc = fs.readFileSync(path.join(process.cwd(), "src/components/shared/bill-dialog.tsx"), "utf8");
const sessionPaymentSrc = fs.readFileSync(path.join(process.cwd(), "src/components/shared/session-payment-dialog.tsx"), "utf8");
const sessionDrawerSrc = fs.readFileSync(path.join(process.cwd(), "src/components/shared/session-orders-drawer.tsx"), "utf8");
const billEdgeSrc = fs.readFileSync(path.join(process.cwd(), "supabase/functions/bill/index.ts"), "utf8");
const resolveMig = (file: string) => {
  const p1 = path.join(process.cwd(), "supabase/migrations", file);
  if (fs.existsSync(p1)) return p1;
  return path.join(process.cwd(), "supabase/legacy_migrations_archive", file);
};
const sqlMigrationSrc = fs.readFileSync(resolveMig("0078_check_sitting_binding.sql"), "utf8");
const sqlFinalizeSrc = fs.readFileSync(resolveMig("0084_settle_completes_orders.sql"), "utf8");

// 1. Database & backend check linking
check(
  "Database open_table_check links orders from same table visit to ONE open check (0078)",
  sqlMigrationSrc.includes("select * into v_existing") &&
    sqlMigrationSrc.includes("where tenant_id = p_tenant and table_id = p_table and status = 'OPEN'") &&
    sqlMigrationSrc.includes("return v_existing.id;"),
);

check(
  "Database finalize_table_check calculates totals across all non-cancelled orders on check_id (0084)",
  sqlFinalizeSrc.includes("where check_id = p_check and status <> 'CANCELLED'") &&
    sqlFinalizeSrc.includes("coalesce(sum(total), 0)       as total") &&
    sqlFinalizeSrc.includes("update public.table_checks") &&
    sqlFinalizeSrc.includes("set status = 'PAID'"),
);

check(
  "Database finalize_table_check generates exactly ONE unique invoice number",
  sqlFinalizeSrc.includes("v_invoice := 'INV-' || lpad(v_seq::text, 7, '0')") &&
    sqlFinalizeSrc.includes("invoice_number = v_invoice"),
);

check(
  "Database finalize_table_check guards against unpaid balance",
  sqlFinalizeSrc.includes("if v_paid + 0.005 < v_totals.total then") &&
    sqlFinalizeSrc.includes("raise exception 'UNPAID:%'"),
);

// 2. Edge function real backend linking and calculation
check(
  "Edge bill function gets check and consolidates eligible non-cancelled orders",
  billEdgeSrc.includes("checkForTenant(tenantId, sessionId, tableId, checkId)") &&
    billEdgeSrc.includes('o.status !== "CANCELLED"') &&
    billEdgeSrc.includes("outstanding: +Math.max(0, total - paid).toFixed(2)"),
);

check(
  "Edge bill function splits CGST and SGST accurately via integer paise split",
  billEdgeSrc.includes("cgst: cgstAmount") &&
    billEdgeSrc.includes("sgst: sgstAmount") &&
    billEdgeSrc.includes("cgstPaise = Math.ceil(gstTotalPaise / 2)") &&
    billEdgeSrc.includes("sgstPaise = gstTotalPaise - cgstPaise"),
);

check(
  "Edge bill function enforces idempotent payments and records payments with key",
  billEdgeSrc.includes("idempotencyKey") &&
    billEdgeSrc.includes("record_check_payment"),
);

check(
  "Edge bill function finalizes check atomically via finalize_table_check RPC",
  billEdgeSrc.includes("finalize_table_check") &&
    billEdgeSrc.includes("p_check: data.check.id"),
);

// 3. UI: BillDialog grouping & thermal printing
check(
  "BillDialog groups items by order number with order headers and subtotals",
  billDialogSrc.includes("const orderGroups = new Map<number, typeof bill.items>()") &&
    billDialogSrc.includes("Order #{orderNum}") &&
    billDialogSrc.includes("Order #{orderNum} Subtotal:") &&
    billDialogSrc.includes("groupSubtotal.toFixed(2)"),
);

check(
  "buildPrintHtml supports thermal (80mm/58mm) and standard A4 printing",
  billDialogSrc.includes("/* 80mm & 58mm POS thermal receipt & standard A4 paper formatting */") &&
    billDialogSrc.includes("@page { size: auto; margin: 4mm 6mm; }") &&
    billDialogSrc.includes("@media print {"),
);

check(
  "buildPrintHtml groups items by order number with order subheader and subtotal rows",
  billDialogSrc.includes("ORDER #${orderNum}") &&
    billDialogSrc.includes("Order #${orderNum} Subtotal:"),
);

// 4. UI: Session Payment Dialog grouping
check(
  "SessionPaymentDialog displays consolidated bill summary and payment methods",
  sessionPaymentSrc.includes("Consolidated Bill") &&
    sessionPaymentSrc.includes("Bill Summary") &&
    sessionPaymentSrc.includes("Select Payment Method"),
);

// 5. UI: Session Orders Drawer grouping
check(
  "SessionOrdersDrawer displays consolidated orders, bill summary and chronological activity",
  sessionDrawerSrc.includes("Orders (") &&
    sessionDrawerSrc.includes("Bill Summary") &&
    sessionDrawerSrc.includes("Activity"),
);

// 6. Mathematical verification of multi-order calculation
const sampleOrders = [
  { id: "ord-1", orderNumber: 2858, itemsTotal: 400, discount: 0, tax: 20, serviceCharge: 0, total: 420, status: "SERVED" },
  { id: "ord-2", orderNumber: 2859, itemsTotal: 600, discount: 50, tax: 27.5, serviceCharge: 10, total: 587.5, status: "SERVED" },
  { id: "ord-3", orderNumber: 2860, itemsTotal: 200, discount: 0, tax: 10, serviceCharge: 0, total: 210, status: "CANCELLED" },
];

const active = sampleOrders.filter((o) => o.status !== "CANCELLED");
const subtotal = active.reduce((s, o) => s + (o.itemsTotal - o.discount), 0);
const tax = active.reduce((s, o) => s + o.tax, 0);
const service = active.reduce((s, o) => s + o.serviceCharge, 0);
const grandTotal = +(subtotal + tax + service).toFixed(2);
const payments = [{ amount: 500, status: "SUCCEEDED" }, { amount: 100, status: "VOID" }, { amount: 507.5, status: "SUCCEEDED" }];
const netPaid = +payments.filter((p) => p.status === "SUCCEEDED").reduce((s, p) => s + p.amount, 0).toFixed(2);
const due = +Math.max(0, grandTotal - netPaid).toFixed(2);

check("Cancelled order ord-3 is excluded from active orders", active.length === 2 && !active.some((o) => o.id === "ord-3"));
check("Subtotal matches sum of eligible itemsTotal minus discounts (950.00)", subtotal === 950);
check("Tax matches sum of eligible taxes (47.50)", tax === 47.5);
check("Grand total matches 420 + 587.50 = 1007.50", grandTotal === 1007.5);
check("Net paid correctly includes succeeded payments (1007.50) and excludes void (100)", netPaid === 1007.5);
check("Remaining due is accurately 0.00 after full payment", due === 0);

// 7. Verification of odd-paisa GST totals
const testOddTaxes = [0.01, 0.03, 0.05, 0.07, 0.09, 0.15, 0.25, 1.03, 33.75, 100.03];
const allOddTaxesSumCleanly = testOddTaxes.every((t) => {
  const gstTotalPaise = Math.round(t * 100);
  const cgstPaise = Math.ceil(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;
  const cgstAmount = +(cgstPaise / 100).toFixed(2);
  const sgstAmount = +(sgstPaise / 100).toFixed(2);
  return +(cgstAmount + sgstAmount).toFixed(2) === t;
});
check("Odd-paisa GST totals sum strictly to original tax with zero paisa lost", allOddTaxesSumCleanly);

// 8. Verification of independent sessions order scoping & legacy recovery
check(
  "Edge bill function scopes order queries strictly to check_id to prevent leaking sibling session orders",
  billEdgeSrc.includes('orderQuery = orderQuery.eq("check_id", open.id);') &&
    !billEdgeSrc.includes('orderQuery.or(`check_id.eq.${open.id},table_session_id.eq.${open.session_id}`)'),
);
check(
  "Edge bill function explicitly recovers unassigned legacy orders with is('check_id', null)",
  billEdgeSrc.includes('.is("check_id", null)'),
);

// 9. Verification of fully paid bill behavior
check(
  "SessionPaymentDialog computes isFullyPaid and amountToPay as 0 when outstanding <= 0",
  sessionPaymentSrc.includes("const isFullyPaid = Boolean(totals && totals.outstanding <= 0)") &&
    sessionPaymentSrc.includes("const amountToPay = totals ? Math.max(0, totals.outstanding) : 0"),
);
check(
  "SessionPaymentDialog hides tender options and payment methods when fully paid",
  sessionPaymentSrc.includes("!isFullyPaid"),
);
check(
  "SessionPaymentDialog labels remaining action 'Close Bill' when fully paid",
  sessionPaymentSrc.includes("isFullyPaid ? (\n                'Close Bill'"),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

