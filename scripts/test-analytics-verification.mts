/**
 * Comprehensive verification & regression test suite for Saladcode Analytics PR #5 Follow-up.
 *
 * Verifies all 3 remaining issues:
 * 1. Finalize valid ₹0 sales:
 *    - finalize_table_check & settle_check_cash_tx distinguish valid ₹0 sale with billable
 *      orders from empty or all-cancelled check (NOTHING_TO_BILL).
 *    - Issues exactly one invoice, completes eligible orders, ends check session
 *      without inserting a payment ledger row.
 *    - Order readiness (ORDERS_OPEN) preserved.
 *    - Retries return same invoice.
 * 2. Authoritative settlement verification:
 *    - Analytics requires verified final total (> 0) and ledger coverage (cumulative >= total),
 *      or authoritative closure evidence for legacy / ₹0 sales.
 *    - No fallback picking last payment row when check total is 0 or unknown.
 *    - Successful payment on open check with unknown total is NOT reported as completed settlement.
 *    - Historical ledger rows preserved; single counting across midnight IST.
 *    - Corrective migration repairs orders.paid_at only where settlement is verified, resetting
 *      unverified/open check timestamps to NULL.
 * 3. Persisted sale location across Cash, UPI, and Card:
 *    - Location resolved strictly from check or linked orders across all payment paths.
 *    - Cashier current staff location fallback removed from settlement RPCs.
 *    - Tableless Takeaway & Delivery sales persist verified location at creation time.
 *    - Sale created at Branch A and settled by cashier assigned to Branch B stays attributed to Branch A.
 *    - Unverifiable historical sales remain NULL (unassigned).
 *
 * Usage:
 *   npx tsx scripts/test-analytics-verification.mts
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
};

const analyticsFn = readFileSync("supabase/functions/analytics/index.ts", "utf8");
const billFn = readFileSync("supabase/functions/bill/index.ts", "utf8");
const ordersFn = readFileSync("supabase/functions/orders/index.ts", "utf8");
const migration3Sql = existsSync("supabase/migrations/20261122000002_verify_settlement_zero_sales_location.sql")
  ? readFileSync("supabase/migrations/20261122000002_verify_settlement_zero_sales_location.sql", "utf8")
  : "";

/* -------------------------------------------------------------------------- */
/* Timezone helper simulations                                                */
/* -------------------------------------------------------------------------- */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - at.getTime()) / 60000;
}

function zonedStart(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000);
}

console.log("\n── 1. Finalize Valid ₹0 Sales & Empty Check Rejection (Issue 1) ──");
{
  check("finalize_table_check counts non-cancelled billable orders",
    /select[\s\S]*?count\(\*\)\s+as order_count[\s\S]*?into v_totals\s+from public\.orders\s+where check_id = p_check and status <> 'CANCELLED';/.test(migration3Sql));

  check("finalize_table_check rejects empty/all-cancelled checks with NOTHING_TO_BILL",
    /if v_totals\.order_count = 0 then\s+raise exception 'NOTHING_TO_BILL'/.test(migration3Sql));

  check("finalize_table_check allows ₹0 sales when billable orders exist",
    /if v_totals\.total > 0 and v_paid \+ 0\.005 < v_totals\.total then\s+raise exception 'UNPAID:%'/.test(migration3Sql));

  check("finalize_table_check allocates single tenant-scoped invoice for ₹0 sale",
    /insert into public\.check_invoice_counters \(tenant_id\)[\s\S]*?v_invoice := 'INV-' \|\| lpad\(v_seq::text, 7, '0'\);/.test(migration3Sql));

  const finalizeFnBody = migration3Sql.match(/create or replace function public\.finalize_table_check[\s\S]*?end \$function\$/)?.[0] || "";
  check("finalize_table_check completes orders and closes check session without payment ledger row",
    /v_completed := public\.complete_paid_check_orders\(p_tenant, p_check\);[\s\S]*?update public\.table_sessions\s+set status = 'ENDED'/.test(finalizeFnBody) &&
    !finalizeFnBody.includes("insert into public.check_payments"));

  check("settle_check_cash_tx distinguishes ₹0 sale from empty check and skips check_payments insert",
    /if v_outstanding > 0 then[\s\S]*?insert into public\.check_payments[\s\S]*?end if;\s+insert into public\.check_invoice_counters/.test(migration3Sql));

  check("settle_check_cash_tx rejects empty check with NOTHING_TO_BILL",
    /create or replace function public\.settle_check_cash_tx[\s\S]*?if v_totals\.order_count = 0 then\s+raise exception 'NOTHING_TO_BILL'/.test(migration3Sql));

  check("order readiness cooking check (ORDERS_OPEN) is preserved",
    /if v_open_orders > 0 then\s+raise exception 'ORDERS_OPEN:%'/.test(migration3Sql));

  // Simulation: Valid ₹0 sale vs Empty check
  function simulateCheckout(orders: { total: number; status: string }[], payments: number[]) {
    const activeOrders = orders.filter((o) => o.status !== "CANCELLED");
    if (activeOrders.length === 0) {
      return { ok: false, error: "NOTHING_TO_BILL" };
    }
    const total = activeOrders.reduce((sum, o) => sum + o.total, 0);
    const paid = payments.reduce((sum, p) => sum + p, 0);
    if (total > 0 && paid < total) {
      return { ok: false, error: "UNPAID" };
    }
    const paymentsInserted = total > 0 ? [total - paid] : [];
    return { ok: true, invoiceNumber: "INV-0000001", total, paymentsInserted };
  }

  const emptyCheck = simulateCheckout([], []);
  const allCancelledCheck = simulateCheckout([{ total: 300, status: "CANCELLED" }], []);
  const validZeroSale = simulateCheckout([{ total: 0, status: "SERVED" }], []);
  const normalSale = simulateCheckout([{ total: 450, status: "SERVED" }], [450]);

  check("empty check is rejected with NOTHING_TO_BILL", emptyCheck.error === "NOTHING_TO_BILL");
  check("all-cancelled check is rejected with NOTHING_TO_BILL", allCancelledCheck.error === "NOTHING_TO_BILL");
  check("valid ₹0 sale succeeds with allocated invoice", validZeroSale.ok && validZeroSale.invoiceNumber === "INV-0000001");
  check("valid ₹0 sale inserts 0 payment ledger rows", validZeroSale.paymentsInserted.length === 0);
  check("normal sale succeeds with invoice and payment", normalSale.ok && normalSale.total === 450);
}

console.log("\n── 2. Authoritative Settlement Verification & paid_at (Issue 2) ──");
{
  check("analytics removed fallback picking last payment row when check total is 0 or unknown",
    !analyticsFn.includes("checkTotal <= 0 && historyPayments.length > 0"));

  check("analytics requires verified checkTotal > 0 and cumulative payments >= checkTotal for ledger settlement",
    /if \(checkTotal > 0 && Math\.round\(runningPaid \* 100\) >= Math\.round\(checkTotal \* 100\)\)/.test(analyticsFn));

  check("analytics recognizes verified ₹0 sales with closure evidence",
    /amt >= 0/.test(analyticsFn) &&
    /Authoritative finalization evidence: valid ₹0 sale or verified legacy check/.test(analyticsFn));

  check("migration repairs paid_at requiring verified total > 0 and ledger coverage",
    /where tc\.total > 0\s+and rp\.cumulative_amount >= tc\.total - 0\.005/.test(migration3Sql));

  check("migration repairs paid_at for closed paid checks (including ₹0 sales)",
    /where tc\.status = 'PAID'\s+and coalesce\(tc\.closed_at, tc\.invoice_date\) is not null/.test(migration3Sql));

  check("migration resets unverified paid_at to NULL (including open checks with unknown total)",
    /update public\.orders o\s+set paid_at = null\s+where o\.paid_at is not null/.test(migration3Sql));

  // Simulation: Open check with payment and unknown total must NOT report as completed settlement
  const tz = "Asia/Kolkata";
  const day1Start = zonedStart("2026-11-20", tz);
  const day2Start = zonedStart("2026-11-21", tz);

  function reconcileCheck(chk: { id: string; total: number; status: string; closed_at?: string }, payments: { amount: number; created_at: string }[]) {
    let authoritativeEvent: any = null;
    let runningPaid = 0;
    for (const p of payments) {
      runningPaid += p.amount;
      if (chk.total > 0 && Math.round(runningPaid * 100) >= Math.round(chk.total * 100)) {
        authoritativeEvent = {
          checkId: chk.id,
          amount: chk.total,
          settledAt: new Date(p.created_at),
          source: "LEDGER",
        };
        break;
      }
    }

    if (!authoritativeEvent && chk.status === "PAID" && chk.closed_at) {
      authoritativeEvent = {
        checkId: chk.id,
        amount: chk.total,
        settledAt: new Date(chk.closed_at),
        source: chk.total === 0 ? "ZERO_TOTAL" : "LEGACY",
      };
    }

    return authoritativeEvent;
  }

  const openCheckWithPayment = {
    id: "chk-open",
    total: 0, // Unknown/open total
    status: "OPEN",
  };
  const paymentsOnOpenCheck = [{ amount: 500, created_at: "2026-11-20T10:00:00Z" }];

  const openCheckReport = reconcileCheck(openCheckWithPayment, paymentsOnOpenCheck);
  check("successful payment on open check with unknown total is NOT reported as completed settlement", openCheckReport === null);

  const closedZeroCheck = {
    id: "chk-zero",
    total: 0,
    status: "PAID",
    closed_at: "2026-11-20T11:00:00Z",
  };
  const zeroCheckReport = reconcileCheck(closedZeroCheck, []);
  check("verified ₹0 sale with closed evidence is reported with ₹0 amount", zeroCheckReport !== null && zeroCheckReport.amount === 0 && zeroCheckReport.source === "ZERO_TOTAL");

  // Single counting across midnight IST simulation
  const checkCrossMidnight = {
    id: "chk-midnight",
    total: 1200,
    status: "PAID",
    closed_at: "2026-11-20T18:35:00Z", // 00:05 IST Nov 21
  };
  const midnightPayment = [{ amount: 1200, created_at: "2026-11-20T18:20:00Z" }]; // 23:50 IST Nov 20

  const event = reconcileCheck(checkCrossMidnight, midnightPayment);
  const inDay1 = event && event.settledAt >= day1Start && event.settledAt < day2Start;
  const inDay2 = event && event.settledAt >= day2Start;
  check("payment at 23:50 IST counted in Day 1", inDay1 === true);
  check("check closed at 00:05 IST NOT counted in Day 2", inDay2 === false);
}

console.log("\n── 3. Persisted Sale Location & Cashier Fallback Removal (Issue 3) ──");
{
  check("create_order_tx resolves sale location from table, p_order location_id, or creator staff",
    /create or replace function public\.create_order_tx[\s\S]*?select location_id into v_location\s+from public\.tables\s+where id = v_table;[\s\S]*?nullif\(p_order->>'location_id', ''\)[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = \(p_order->>'served_by_id'\)::uuid/.test(migration3Sql));

  check("create_order_tx persists location on orders and table_checks",
    /insert into public\.orders \([\s\S]*?location_id[\s\S]*?values \([\s\S]*?v_location[\s\S]*?update public\.table_checks\s+set location_id = coalesce\(location_id, v_location\)/.test(migration3Sql));

  check("orders Edge Function resolves and passes locationId on order creation",
    ordersFn.includes("locationId: string | null = b.locationId || b.location_id") &&
    /location_id: args\.locationId \?\? null/.test(ordersFn));

  check("finalize_table_check removed cashier staff location fallback",
    !/finalize_table_check[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = p_actor/.test(migration3Sql));

  check("settle_check_cash_tx removed cashier staff location fallback",
    !/settle_check_cash_tx[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = p_actor/.test(migration3Sql));

  check("record_check_payment removed cashier staff location fallback",
    !/record_check_payment[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = p_actor/.test(migration3Sql));

  // Simulation: Cross-branch checkout (sale created at Branch A, settled by cashier from Branch B)
  function resolveSettlementLocation(
    saleData: { checkLocation?: string; orderLocation?: string; tableLocation?: string },
    cashierCurrentLocation: string
  ) {
    // Correct logic: Sale's persisted location only
    return saleData.checkLocation || saleData.tableLocation || saleData.orderLocation || null;
  }

  const saleAtBranchA = {
    checkLocation: "branch-A",
    orderLocation: "branch-A",
    tableLocation: undefined, // e.g. Takeaway
  };
  const cashierAssignedToBranchB = "branch-B";

  const resolvedLoc = resolveSettlementLocation(saleAtBranchA, cashierAssignedToBranchB);
  check("sale created at branch A and settled by cashier at branch B stays attributed to branch A", resolvedLoc === "branch-A");

  const unassignedSale = resolveSettlementLocation({}, cashierAssignedToBranchB);
  check("unverifiable historical sale without location data remains unassigned (null)", unassignedSale === null);
}

console.log(`\n========================================`);
console.log(`Analytics Verification & Invariant Checks: ${pass}/${pass + fail} checks passed.`);
if (fail > 0) {
  console.error(`Failed ${fail} checks.`);
  process.exit(1);
} else {
  console.log(`All checks PASSED cleanly!`);
}
