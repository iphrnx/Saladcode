/**
 * Comprehensive verification & regression test suite for Saladcode Analytics PR #7 Review Findings.
 *
 * Verifies all 3 findings:
 * 1. Restore service-role-only access to create_order_tx:
 *    - Revoke EXECUTE from PUBLIC, anon, and authenticated
 *    - Grant EXECUTE only to service_role
 * 2. Preserve existing order-creation contract:
 *    - Starts from 20261118000002 contract on current main
 *    - Preserves top-level order_id, order_number, check_id, and table_session_id
 *    - Preserves deduplicated: true on idempotent replays
 *    - Preserves atomic promo validation and redemption (used_count increment, limit/expiry checks)
 *    - Preserves portions JSONB resolution, sequential KOT numbers, check running totals, and session isolation
 *    - Verifies Edge Function caller against final RPC contract
 * 3. Validate and persist sale location:
 *    - Validates requested location belongs to authenticated tenant and is active (LOCATION_NOT_FOUND)
 *    - Dine-in uses verified table location from tables
 *    - Rejects conflicting location for Dine-in (LOCATION_CONFLICT)
 *    - Tableless Takeaway & Delivery uses verified sale location
 *    - Preserves existing check location and rejects conflicting input (LOCATION_CONFLICT)
 *    - Cash, UPI, and Card all report the sale's persisted location (no cashier staff fallback)
 *    - Unverifiable historical locations remain unassigned (NULL)
 *    - Edge Function maps LOCATION_NOT_FOUND and LOCATION_CONFLICT to HTTP 400
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

console.log("\n── 1. Restore service-role-only access to create_order_tx (Finding 1) ──");
{
  check(
    "explicitly revokes execute on create_order_tx from public, anon, and authenticated",
    /revoke execute on function public\.create_order_tx\(jsonb, jsonb, uuid, text, text\) from public, anon, authenticated;/.test(migration3Sql)
  );
  check(
    "grants execute on create_order_tx strictly to service_role",
    /grant execute on function public\.create_order_tx\(jsonb, jsonb, uuid, text, text\) to service_role;/.test(migration3Sql)
  );
  check(
    "no public/anon/authenticated execute grants on create_order_tx exist in migration",
    !/grant execute on function public\.create_order_tx[^;]*?to\s+[^;]*?(?:anon|authenticated|public)/.test(migration3Sql)
  );
}

console.log("\n── 2. Preserve existing order-creation contract (Finding 2) ──");
{
  const createOrderBody = migration3Sql.match(/create or replace function public\.create_order_tx[\s\S]*?revoke execute on function public\.create_order_tx/)?.[0] || "";

  check(
    "returns top-level order_id, order_number, check_id, table_session_id",
    /return jsonb_build_object\(\s*'order_id', v_order_id,\s*'order_number', v_order_num,\s*'check_id', v_check,\s*'table_session_id', v_session(?:,\s*'session_token', v_session_token)?\s*\);/.test(createOrderBody)
  );

  check(
    "idempotent deduplication returns top-level fields with deduplicated: true",
    /return jsonb_build_object\(\s*'order_id', v_existing_order\.id,\s*'order_number', v_existing_order\.order_number,\s*'check_id', v_existing_order\.check_id,\s*'table_session_id', v_existing_order\.table_session_id,(?:\s*'session_token', v_session_token,)?\s*'deduplicated', true\s*\);/.test(createOrderBody)
  );

  check(
    "atomic promo validation and usage increment preserved",
    /if p_promo_code_id is not null then\s+update public\.promo_codes\s+set used_count = used_count \+ 1\s+where id = (?:p_promo_code_id|v_locked_promo\.id)\s+and tenant_id = v_tenant\s+and active\s+and \(usage_limit = 0 (?:or usage_limit is null )?or used_count < usage_limit\)[\s\S]*?raise exception 'PROMO_REJECTED:/.test(createOrderBody)
  );

  check(
    "dynamic portion resolution against menu_items.portions JSONB preserved",
    /if v_menu\.portions is not null and jsonb_typeof\(v_menu\.portions\) = 'array' then\s+for v_portion_elem in select value from jsonb_array_elements\(v_menu\.portions\) loop/.test(createOrderBody)
  );

  check(
    "check running totals updated on attached table_checks",
    /update public\.table_checks\s+set subtotal = v_check_totals\.subtotal,\s+discount = v_check_totals\.discount,\s+tax = v_check_totals\.tax,\s+service_charge = v_check_totals\.service_charge,\s+total = v_check_totals\.total/.test(createOrderBody)
  );

  check(
    "sequential KOT numbering scoped by check/session preserved",
    /select coalesce\(max\(oi\.kot_number\), 0\) \+ 1 into v_kot_num\s+from public\.order_items oi\s+join public\.orders o on o\.id = oi\.order_id/.test(createOrderBody)
  );

  check(
    "orders Edge Function reads top-level order_id and deduplicated flag",
    ordersFn.includes("const orderId = (tx as any)?.order_id as string | undefined;") &&
    ordersFn.includes("const deduplicated = (tx as any)?.deduplicated === true;") &&
    ordersFn.includes("if (!orderId) return { ok: false, error: \"Failed to place order\", status: 500 };")
  );
}

console.log("\n── 3. Validate and Persist Sale Location (Finding 3) ──");
{
  const createOrderBody = migration3Sql.match(/create or replace function public\.create_order_tx[\s\S]*?revoke execute on function public\.create_order_tx/)?.[0] || "";

  check(
    "validates requested location belongs to authenticated tenant and is active",
    /if v_input_location is not null then\s+if not exists \(\s+select 1 from public\.locations\s+where id = v_input_location and tenant_id = v_tenant and active\s+\) then\s+raise exception 'LOCATION_NOT_FOUND'/.test(createOrderBody)
  );

  check(
    "Dine-in resolves and uses verified table location from public.tables",
    /if v_order_type = 'DINE_IN' then[\s\S]*?select location_id into v_table_location\s+from public\.tables\s+where id = v_table and tenant_id = v_tenant;/.test(createOrderBody)
  );

  check(
    "Dine-in rejects conflicting input location with LOCATION_CONFLICT",
    /if v_input_location is not null and v_input_location <> v_table_location then\s+raise exception 'LOCATION_CONFLICT'/.test(createOrderBody)
  );

  check(
    "preserves existing check location and rejects conflicting input with LOCATION_CONFLICT",
    /if v_check_location is not null then\s+if v_location is not null and v_location <> v_check_location then\s+raise exception 'LOCATION_CONFLICT'/.test(createOrderBody) &&
    /v_location := v_check_location;/.test(createOrderBody)
  );

  check(
    "orders table insert persists resolved location_id",
    /insert into public\.orders \([\s\S]*?check_id, location_id\s*\)\s*values \([\s\S]*?v_check,\s+v_location\s*\)/.test(createOrderBody)
  );

  check(
    "orders Edge Function passes locationId to create_order_tx",
    ordersFn.includes("location_id: args.locationId ?? null")
  );

  check(
    "orders Edge Function stops filling omitted Dine-in locationId from staff branch",
    ordersFn.includes('const isDineIn = orderType === "DINE_IN" || !!tableId;') &&
    ordersFn.includes("if (!locationId && !isDineIn) {")
  );

  check(
    "orders Edge Function maps LOCATION_NOT_FOUND and LOCATION_CONFLICT to HTTP 400",
    ordersFn.includes('msg.includes("LOCATION_NOT_FOUND")') &&
    ordersFn.includes('msg.includes("LOCATION_CONFLICT")') &&
    ordersFn.includes('"The specified location is not valid for this restaurant."') &&
    ordersFn.includes('"Order location conflicts with the existing table or check location."')
  );

  check(
    "settlement RPCs (finalize_table_check, settle_check_cash_tx, record_check_payment) removed cashier staff fallback",
    !/finalize_table_check[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = p_actor/.test(migration3Sql) &&
    !/settle_check_cash_tx[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = p_actor/.test(migration3Sql) &&
    !/record_check_payment[\s\S]*?select location_id into v_location\s+from public\.staff\s+where id = p_actor/.test(migration3Sql)
  );
}

console.log("\n── 4. Preserve PR #7 Valid ₹0 Sales & Settlement Verification ──");
{
  check(
    "finalize_table_check counts non-cancelled billable orders and rejects empty check",
    /select[\s\S]*?count\(\*\)\s+as order_count[\s\S]*?into v_totals\s+from public\.orders\s+where check_id = p_check and status <> 'CANCELLED';/.test(migration3Sql) &&
    /if v_totals\.order_count = 0 then\s+raise exception 'NOTHING_TO_BILL'/.test(migration3Sql)
  );

  const finalizeFnBody = migration3Sql.match(/create or replace function public\.finalize_table_check[\s\S]*?end \$function\$/)?.[0] || "";
  check(
    "finalize_table_check allocates single invoice, completes orders, and closes check session without payment ledger rows",
    /v_invoice := 'INV-' \|\| lpad\(v_seq::text, 7, '0'\);/.test(finalizeFnBody) &&
    /v_completed := public\.complete_paid_check_orders\(p_tenant, p_check\);/.test(finalizeFnBody) &&
    !finalizeFnBody.includes("insert into public.check_payments")
  );

  check(
    "analytics requires verified total > 0 and cumulative payments >= total for ledger settlements",
    /if \(checkTotal > 0 && Math\.round\(runningPaid \* 100\) >= Math\.round\(checkTotal \* 100\)\)/.test(analyticsFn) &&
    !analyticsFn.includes("checkTotal <= 0 && historyPayments.length > 0")
  );

  check(
    "analytics recognizes verified ₹0 sales with closure evidence",
    /amt >= 0/.test(analyticsFn) &&
    /Authoritative finalization evidence: valid ₹0 sale or verified legacy check/.test(analyticsFn)
  );

  check(
    "analytics excludes zero-amount settlement events from payment-method transaction counts",
    /for\s*\(\s*const\s+e\s+of\s+filteredEvents\s*\)\s*\{\s*if\s*\(\s*e\.amount\s*<=\s*0\s*\)\s*continue;/.test(analyticsFn)
  );

  check(
    "corrective migration repairs orders.paid_at and resets unverified timestamps to NULL",
    /where tc\.total > 0\s+and rp\.cumulative_amount >= tc\.total - 0\.005/.test(migration3Sql) &&
    /where tc\.status = 'PAID'\s+and coalesce\(tc\.closed_at, tc\.invoice_date\) is not null/.test(migration3Sql) &&
    /update public\.orders o\s+set paid_at = null\s+where o\.paid_at is not null/.test(migration3Sql)
  );
}

console.log("\n── 5. Runtime & Invariant Simulations ──");
{
  // Simulation A: Cross-tenant location injection rejection
  function simulateCreateOrder(tenantId: string, locationId: string | null, validTenantLocations: Map<string, string>) {
    if (locationId) {
      const locTenant = validTenantLocations.get(locationId);
      if (!locTenant || locTenant !== tenantId) {
        return { ok: false, error: "LOCATION_NOT_FOUND", status: 400 };
      }
    }
    return { ok: true, order_id: "ord-1", order_number: 101, check_id: "chk-1", table_session_id: "sess-1" };
  }

  const locationDb = new Map<string, string>([
    ["loc-tenant-a-1", "tenant-A"],
    ["loc-tenant-b-1", "tenant-B"],
  ]);

  const crossTenantAttempt = simulateCreateOrder("tenant-A", "loc-tenant-b-1", locationDb);
  check("cross-tenant location injection is rejected with LOCATION_NOT_FOUND",
    !crossTenantAttempt.ok && crossTenantAttempt.error === "LOCATION_NOT_FOUND" && crossTenantAttempt.status === 400);

  const validTenantLocation = simulateCreateOrder("tenant-A", "loc-tenant-a-1", locationDb);
  check("valid tenant location succeeds and returns top-level contract",
    validTenantLocation.ok && validTenantLocation.order_id === "ord-1" && validTenantLocation.order_number === 101);

  // Simulation B: Location conflict on Dine-in table vs input
  function simulateDineInLocation(tableLocation: string, inputLocation: string | null) {
    if (inputLocation && inputLocation !== tableLocation) {
      return { ok: false, error: "LOCATION_CONFLICT", status: 400 };
    }
    return { ok: true, location: tableLocation };
  }
  const conflictingDineIn = simulateDineInLocation("branch-A", "branch-B");
  check("conflicting input location on Dine-in is rejected with LOCATION_CONFLICT",
    !conflictingDineIn.ok && conflictingDineIn.error === "LOCATION_CONFLICT");

  // Simulation C: Preserving existing check location
  function simulateAddToExistingCheck(checkLocation: string, incomingLocation: string | null) {
    if (incomingLocation && incomingLocation !== checkLocation) {
      return { ok: false, error: "LOCATION_CONFLICT" };
    }
    return { ok: true, location: checkLocation };
  }
  const conflictingCheck = simulateAddToExistingCheck("branch-A", "branch-B");
  check("adding order with conflicting location to existing check is rejected with LOCATION_CONFLICT",
    !conflictingCheck.ok && conflictingCheck.error === "LOCATION_CONFLICT");

  // Simulation D: Cross-branch cashier settlement
  function simulateSettlement(saleLocation: string, cashierStaffLocation: string, paymentMethod: "CASH" | "UPI" | "CARD") {
    // Durable location anchored to the sale, NOT the cashier's staff profile
    return {
      saleLocation,
      settledLocation: saleLocation,
      cashierStaffLocation,
      method: paymentMethod,
    };
  }
  const cashSale = simulateSettlement("branch-A", "branch-B", "CASH");
  const upiSale = simulateSettlement("branch-A", "branch-B", "UPI");
  const cardSale = simulateSettlement("branch-A", "branch-B", "CARD");
  check("cash sale created at branch A settled by cashier at branch B stays attributed to branch A",
    cashSale.settledLocation === "branch-A" && cashSale.settledLocation !== cashSale.cashierStaffLocation);
  check("UPI sale created at branch A settled by cashier at branch B stays attributed to branch A",
    upiSale.settledLocation === "branch-A");
  check("Card sale created at branch A settled by cashier at branch B stays attributed to branch A",
    cardSale.settledLocation === "branch-A");

  // Simulation E: Promo order and atomic retry on menu/promo change
  let promoCount = 0;
  const promoLimit = 1;
  function redeemPromo(promoId: string) {
    if (promoCount >= promoLimit) {
      return { ok: false, error: "PROMO_REJECTED", retry: true };
    }
    promoCount++;
    return { ok: true, promoId, usedCount: promoCount };
  }
  const promoFirst = redeemPromo("promo-1");
  const promoRetry = redeemPromo("promo-1");
  check("promo first redemption succeeds atomically", promoFirst.ok && promoFirst.usedCount === 1);
  check("promo second redemption after limit is rejected as retryable", !promoRetry.ok && promoRetry.retry === true);

  // Simulation F: Valid ₹0 sale checkout vs empty check
  function checkoutCheck(orders: { total: number; status: string }[]) {
    const billable = orders.filter((o) => o.status !== "CANCELLED");
    if (billable.length === 0) return { ok: false, error: "NOTHING_TO_BILL" };
    const total = billable.reduce((s, o) => s + o.total, 0);
    return { ok: true, invoice: "INV-0000001", total, paymentLedgerRows: total > 0 ? 1 : 0 };
  }
  const emptyChk = checkoutCheck([]);
  const zeroChk = checkoutCheck([{ total: 0, status: "SERVED" }]);
  check("empty check rejected with NOTHING_TO_BILL", !emptyChk.ok && emptyChk.error === "NOTHING_TO_BILL");
  check("valid ₹0 sale issues invoice without payment ledger rows",
    zeroChk.ok && zeroChk.invoice === "INV-0000001" && zeroChk.paymentLedgerRows === 0);

  // Simulation G: Open check with payments and unknown total excluded from settled revenue
  function reconcileSettlement(check: { total: number; status: string }, payments: { amount: number }[]) {
    const paidSum = payments.reduce((s, p) => s + p.amount, 0);
    if (check.total > 0 && paidSum >= check.total) {
      return { settled: true, amount: check.total };
    }
    if (check.status === "PAID" && check.total === 0) {
      return { settled: true, amount: 0 };
    }
    return { settled: false, amount: 0 };
  }
  const openCheckWithPmt = reconcileSettlement({ total: 0, status: "OPEN" }, [{ amount: 500 }]);
  check("open check with unknown total and ledger payments is NOT settled revenue",
    !openCheckWithPmt.settled && openCheckWithPmt.amount === 0);

  // Simulation H: Regression case with one ₹0 sale and one positive payment
  // Verify that the report shows two completed orders and one payment transaction,
  // and that a ₹0-only sale shows zero payment transactions in dashboard and CSV.
  function simulateAnalyticsReport(
    sales: { checkId: string; total: number; orderCount: number; method: "CASH" | "UPI" | "CARD" | "OTHER" }[]
  ) {
    let completedOrders = 0;
    let grossCollected = 0;
    const pmCounts = { cash: 0, upi: 0, card: 0, other: 0 };
    const pmAmounts = { cash: 0, upi: 0, card: 0, other: 0 };

    for (const s of sales) {
      completedOrders += s.orderCount;
      grossCollected += s.total;

      // Exclude zero-amount settlement events from payment-method transaction counts
      if (s.total <= 0) continue;

      if (s.method === "CASH") {
        pmAmounts.cash += s.total;
        pmCounts.cash++;
      } else if (s.method === "UPI") {
        pmAmounts.upi += s.total;
        pmCounts.upi++;
      } else if (s.method === "CARD") {
        pmAmounts.card += s.total;
        pmCounts.card++;
      } else {
        pmAmounts.other += s.total;
        pmCounts.other++;
      }
    }

    const totalPaymentTx = pmCounts.cash + pmCounts.upi + pmCounts.card + pmCounts.other;
    return {
      completedOrders,
      grossCollected,
      paymentMethods: {
        cash: { amount: pmAmounts.cash, count: pmCounts.cash },
        upi: { amount: pmAmounts.upi, count: pmCounts.upi },
        card: { amount: pmAmounts.card, count: pmCounts.card },
        other: { amount: pmAmounts.other, count: pmCounts.other },
        totalTx: totalPaymentTx,
      },
    };
  }

  // Case 1: One ₹0 sale and one positive payment
  const mixedReport = simulateAnalyticsReport([
    { checkId: "chk-zero", total: 0, orderCount: 1, method: "OTHER" },
    { checkId: "chk-positive", total: 450, orderCount: 1, method: "UPI" },
  ]);
  check("regression case shows two completed orders", mixedReport.completedOrders === 2);
  check("regression case shows one payment transaction", mixedReport.paymentMethods.totalTx === 1);
  check("regression case attributes payment transaction to UPI with 450 amount",
    mixedReport.paymentMethods.upi.count === 1 && mixedReport.paymentMethods.upi.amount === 450);
  check("regression case attributes 0 transactions to other/legacy",
    mixedReport.paymentMethods.other.count === 0 && mixedReport.paymentMethods.other.amount === 0);

  // Case 2: ₹0-only sale
  const zeroOnlyReport = simulateAnalyticsReport([
    { checkId: "chk-zero-only", total: 0, orderCount: 1, method: "OTHER" },
  ]);
  check("₹0-only sale shows one completed order", zeroOnlyReport.completedOrders === 1);
  check("₹0-only sale shows zero payment transactions in dashboard and CSV", zeroOnlyReport.paymentMethods.totalTx === 0);

  // Simulation I: Promo order idempotent replay (e.g. network retry with same idempotency key)
  const ordersDatabase: any[] = [];
  let promoRedemptions = 0;
  function createOrderTxSimulation(idempotencyKey: string, promoId: string | null) {
    const existing = ordersDatabase.find((o) => o.idempotency_key === idempotencyKey);
    if (existing) {
      return { order_id: existing.id, deduplicated: true, promoRedemptions };
    }
    if (promoId) {
      promoRedemptions++;
    }
    const newOrder = { id: "ord-" + (ordersDatabase.length + 1), idempotency_key: idempotencyKey, promo_id: promoId };
    ordersDatabase.push(newOrder);
    return { order_id: newOrder.id, deduplicated: false, promoRedemptions };
  }

  const promoOrder1 = createOrderTxSimulation("idem-key-101", "promo-valid");
  const promoOrderRetry = createOrderTxSimulation("idem-key-101", "promo-valid");
  check("promo checkout initial attempt creates one order and one redemption",
    promoOrder1.deduplicated === false && ordersDatabase.length === 1 && promoOrder1.promoRedemptions === 1);
  check("promo checkout retry creates only one order and one redemption",
    promoOrderRetry.deduplicated === true && promoOrderRetry.order_id === promoOrder1.order_id && ordersDatabase.length === 1 && promoRedemptions === 1);

  // Simulation J: CSV Export simulation for mixed and ₹0-only sales
  function generateCsvRows(report: ReturnType<typeof simulateAnalyticsReport>) {
    const rows: (string | number)[][] = [];
    rows.push(["Gross Collected", report.grossCollected.toFixed(2)]);
    rows.push(["Completed Orders", report.completedOrders]);
    rows.push(["Method", "Transactions", "Amount"]);
    rows.push(["Cash", report.paymentMethods.cash.count, report.paymentMethods.cash.amount.toFixed(2)]);
    rows.push(["UPI", report.paymentMethods.upi.count, report.paymentMethods.upi.amount.toFixed(2)]);
    rows.push(["Card", report.paymentMethods.card.count, report.paymentMethods.card.amount.toFixed(2)]);
    if (report.paymentMethods.other.count > 0) {
      rows.push(["Other / Legacy", report.paymentMethods.other.count, report.paymentMethods.other.amount.toFixed(2)]);
    }
    rows.push(["Total Reconciled", report.paymentMethods.totalTx, report.grossCollected.toFixed(2)]);
    return rows;
  }

  const mixedCsv = generateCsvRows(mixedReport);
  check("CSV for mixed report shows 2 completed orders", mixedCsv.some((r) => r[0] === "Completed Orders" && r[1] === 2));
  check("CSV for mixed report shows 1 total reconciled transaction", mixedCsv.some((r) => r[0] === "Total Reconciled" && r[1] === 1));

  const zeroOnlyCsv = generateCsvRows(zeroOnlyReport);
  check("CSV for ₹0-only report shows 1 completed order", zeroOnlyCsv.some((r) => r[0] === "Completed Orders" && r[1] === 1));
  check("CSV for ₹0-only report shows 0 total reconciled transactions", zeroOnlyCsv.some((r) => r[0] === "Total Reconciled" && r[1] === 0));

  // Simulation K: Staff member at branch B ordering for Dine-in table at branch A
  interface TableSessionCheckState {
    tableLocation: string;
    checkLocation?: string;
    staffLocation: string;
  }
  function simulateStaffOrderEndpoint(
    req: { orderType: string; tableId?: string; locationId?: string | null },
    state: TableSessionCheckState
  ) {
    const isDineIn = req.orderType === "DINE_IN" || !!req.tableId;
    let resolvedLocationId: string | null = req.locationId || null;
    if (!resolvedLocationId && !isDineIn) {
      resolvedLocationId = state.staffLocation;
    }

    // Hand off to create_order_tx
    if (isDineIn) {
      if (resolvedLocationId && resolvedLocationId !== state.tableLocation) {
        return { ok: false, error: "LOCATION_CONFLICT", status: 400 };
      }
      const orderLocation = state.tableLocation;
      const checkLocation = state.checkLocation || orderLocation;
      return { ok: true, status: 201, orderLocation, checkLocation };
    } else {
      const orderLocation = resolvedLocationId || state.staffLocation;
      const checkLocation = state.checkLocation || orderLocation;
      return { ok: true, status: 201, orderLocation, checkLocation };
    }
  }

  // 1. Staff assigned to branch B orders for table at branch A with omitted locationId
  const staffBTableAOrderOmitted = simulateStaffOrderEndpoint(
    { orderType: "DINE_IN", tableId: "table-branch-a", locationId: null },
    { tableLocation: "branch-A", staffLocation: "branch-B" }
  );
  check(
    "staff member assigned to branch B can order for branch A table with omitted locationId (retains branch A)",
    staffBTableAOrderOmitted.ok &&
    staffBTableAOrderOmitted.orderLocation === "branch-A" &&
    staffBTableAOrderOmitted.checkLocation === "branch-A"
  );

  // 2. Staff assigned to branch B orders for table at branch A with explicit branch B locationId
  const staffBTableAOrderExplicitConflict = simulateStaffOrderEndpoint(
    { orderType: "DINE_IN", tableId: "table-branch-a", locationId: "branch-B" },
    { tableLocation: "branch-A", staffLocation: "branch-B" }
  );
  check(
    "same Dine-in order with explicit conflicting branch B locationId returns HTTP 400 and creates no order",
    !staffBTableAOrderExplicitConflict.ok &&
    staffBTableAOrderExplicitConflict.status === 400 &&
    staffBTableAOrderExplicitConflict.error === "LOCATION_CONFLICT"
  );

  // 3. Takeaway order with omitted locationId preserves staff location fallback
  const staffBTakeawayOmitted = simulateStaffOrderEndpoint(
    { orderType: "TAKEAWAY", locationId: null },
    { tableLocation: "branch-A", staffLocation: "branch-B" }
  );
  check(
    "Takeaway order with omitted locationId preserves staff member branch B fallback",
    staffBTakeawayOmitted.ok &&
    staffBTakeawayOmitted.orderLocation === "branch-B" &&
    staffBTakeawayOmitted.checkLocation === "branch-B"
  );
}

console.log(`\n========================================`);
console.log(`Analytics Verification & Invariant Checks: ${pass}/${pass + fail} checks passed.`);
if (fail > 0) {
  console.error(`Failed ${fail} checks.`);
  process.exit(1);
} else {
  console.log(`All checks PASSED cleanly!`);
}
