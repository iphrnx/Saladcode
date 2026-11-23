import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Create valid dummy JWT with sub: "usr-mock-owner"
const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  sub: "usr-mock-owner",
  session_id: "sess-1",
  role: "authenticated",
})).toString("base64url");
const dummyJwt = `${header}.${payload}.signature`;

// Target date: 2026-11-20 in Asia/Kolkata
const TARGET_DATE = "2026-11-20";
const T_START = "2026-11-19T18:30:00.000Z"; // 2026-11-20 00:00:00 IST
const T_MID = "2026-11-20T06:30:00.000Z";   // 2026-11-20 12:00:00 IST (Hour 12)
const T_LATE = "2026-11-20T14:30:00.000Z";  // 2026-11-20 20:00:00 IST (Hour 20)

// Mock datasets for Batch 2 testing
const mockTables = [
  { id: "tbl-1", name: "Table 1", location_id: "loc-1" },
  { id: "tbl-2", name: "Table 2", location_id: "loc-2" },
];

const mockChecks = [
  // 1. Multi-order check: Check A total 500, DINE_IN at Table 1
  {
    id: "chk-a",
    table_id: "tbl-1",
    session_id: "sess-1",
    order_type: "DINE_IN",
    status: "PAID",
    subtotal: 500,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 500,
    paid_total: 500,
    closed_at: T_MID,
    location_id: "loc-1",
    created_at: T_MID,
  },
  // 2. Check total differs from order total: Check B total 450 (due to 50 discount), TAKEAWAY
  {
    id: "chk-b",
    table_id: null,
    session_id: "sess-b",
    order_type: "TAKEAWAY",
    status: "PAID",
    subtotal: 500,
    discount: 50,
    tax: 0,
    service_charge: 0,
    total: 450,
    paid_total: 450,
    closed_at: T_MID,
    location_id: "loc-1",
    created_at: T_MID,
  },
  // 3. Zero-value check: Check C total 0
  {
    id: "chk-c",
    table_id: "tbl-1",
    session_id: "sess-c",
    order_type: "DINE_IN",
    status: "PAID",
    subtotal: 0,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 0,
    paid_total: 0,
    closed_at: T_LATE,
    location_id: "loc-1",
    created_at: T_LATE,
  },
  // 4. Second session at Table 1: Check D total 800
  {
    id: "chk-d",
    table_id: "tbl-1",
    session_id: "sess-2",
    order_type: "DINE_IN",
    status: "PAID",
    subtotal: 800,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 800,
    paid_total: 800,
    closed_at: T_LATE,
    location_id: "loc-1",
    created_at: T_LATE,
  },
  // 5. Check for void payment test: Check E
  {
    id: "chk-e",
    table_id: null,
    session_id: "sess-e",
    order_type: "DELIVERY",
    status: "OPEN",
    subtotal: 150,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 150,
    paid_total: 0,
    closed_at: null,
    location_id: "loc-1",
    created_at: T_MID,
  },
];

const mockPayments = [
  // Payments for Check A: 500 via CARD
  {
    id: "pay-a",
    check_id: "chk-a",
    amount: 500,
    method: "CARD",
    status: "SUCCEEDED",
    location_id: "loc-1",
    created_at: T_MID,
  },
  // Payments for Check B: 450 via UPI
  {
    id: "pay-b",
    check_id: "chk-b",
    amount: 450,
    method: "UPI",
    status: "SUCCEEDED",
    location_id: "loc-1",
    created_at: T_MID,
  },
  // Payments for Check D: 800 via CASH
  {
    id: "pay-d",
    check_id: "chk-d",
    amount: 800,
    method: "CASH",
    status: "SUCCEEDED",
    location_id: "loc-1",
    created_at: T_LATE,
  },
  // Void payment for Check E: 150 CASH reversed at loc-1
  {
    id: "pay-e-void",
    check_id: "chk-e",
    amount: 150,
    method: "CASH",
    status: "VOID",
    location_id: "loc-1",
    created_at: T_MID,
  },
];

const mockOrders = [
  // Multi-order check A: Order 1 (300) and Order 2 (200)
  {
    id: "ord-a1",
    order_number: 101,
    order_type: "DINE_IN",
    table_id: "tbl-1",
    table_session_id: "sess-1",
    check_id: "chk-a",
    status: "COMPLETED",
    payment_status: "PAID",
    items_total: 300,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 300,
    paid_at: T_MID,
    completed_at: T_MID,
    created_at: T_MID,
    location_id: "loc-1",
    items: [{ id: "oi-1", menu_item_id: "item-1", name: "Salad", price: 300, quantity: 1 }],
  },
  {
    id: "ord-a2",
    order_number: 102,
    order_type: "DINE_IN",
    table_id: "tbl-1",
    table_session_id: "sess-1",
    check_id: "chk-a",
    status: "COMPLETED",
    payment_status: "PAID",
    items_total: 200,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 200,
    paid_at: T_MID,
    completed_at: T_MID,
    created_at: T_MID,
    location_id: "loc-1",
    items: [{ id: "oi-2", menu_item_id: "item-1", name: "Salad", price: 200, quantity: 1 }],
  },
  // Check B: Order total 500 (check total is 450)
  {
    id: "ord-b",
    order_number: 103,
    order_type: "TAKEAWAY",
    table_id: null,
    table_session_id: null,
    check_id: "chk-b",
    status: "COMPLETED",
    payment_status: "PAID",
    items_total: 500,
    discount: 50,
    tax: 0,
    service_charge: 0,
    total: 500,
    paid_at: T_MID,
    completed_at: T_MID,
    created_at: T_MID,
    location_id: "loc-1",
    items: [{ id: "oi-3", menu_item_id: "item-1", name: "Salad", price: 500, quantity: 1 }],
  },
  // Check C: Zero-value order
  {
    id: "ord-c",
    order_number: 104,
    order_type: "DINE_IN",
    table_id: "tbl-1",
    table_session_id: "sess-c",
    check_id: "chk-c",
    status: "COMPLETED",
    payment_status: "PAID",
    items_total: 0,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 0,
    paid_at: T_LATE,
    completed_at: T_LATE,
    created_at: T_LATE,
    location_id: "loc-1",
    items: [],
  },
  // Check D: Session 2 at Table 1
  {
    id: "ord-d",
    order_number: 105,
    order_type: "DINE_IN",
    table_id: "tbl-1",
    table_session_id: "sess-2",
    check_id: "chk-d",
    status: "COMPLETED",
    payment_status: "PAID",
    items_total: 800,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 800,
    paid_at: T_LATE,
    completed_at: T_LATE,
    created_at: T_LATE,
    location_id: "loc-1",
    items: [{ id: "oi-4", menu_item_id: "item-1", name: "Salad", price: 800, quantity: 1 }],
  },
  // Legacy order refund 1: Standalone order at loc-1 (100 via UPI)
  {
    id: "ord-ref-1",
    order_number: 106,
    order_type: "DELIVERY",
    table_id: null,
    table_session_id: null,
    check_id: null,
    status: "CANCELLED",
    payment_status: "REFUNDED",
    payment_method: "UPI",
    items_total: 100,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 100,
    paid_at: T_MID,
    updated_at: T_MID,
    created_at: T_MID,
    location_id: "loc-1",
    items: [],
  },
  // Legacy order refund 2: Duplicate of Check E (should NOT be double-counted!)
  {
    id: "ord-ref-dup",
    order_number: 107,
    order_type: "DELIVERY",
    table_id: null,
    table_session_id: null,
    check_id: "chk-e",
    status: "CANCELLED",
    payment_status: "REFUNDED",
    payment_method: "CASH",
    items_total: 150,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 150,
    paid_at: T_MID,
    updated_at: T_MID,
    created_at: T_MID,
    location_id: "loc-1",
    items: [],
  },
  // Legacy order refund 3: Unresolved location refund (50 via OTHER, location_id: null)
  {
    id: "ord-ref-unresolved",
    order_number: 108,
    order_type: "TAKEAWAY",
    table_id: null,
    table_session_id: null,
    check_id: null,
    status: "CANCELLED",
    payment_status: "REFUNDED",
    payment_method: "OTHER",
    items_total: 50,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 50,
    paid_at: T_MID,
    updated_at: T_MID,
    created_at: T_MID,
    location_id: null,
    items: [],
  },
];

// Setup mock Supabase REST server
const mockServer = createServer((req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  res.setHeader("Content-Type", "application/json");

  if (url.pathname.includes("/auth/v1/user")) {
    res.writeHead(200);
    res.end(JSON.stringify({ id: "usr-mock-owner", email: "owner@example.com", role: "authenticated" }));
    return;
  }
  if (url.pathname.includes("/rest/v1/profiles")) {
    res.writeHead(200);
    res.end(JSON.stringify([{ id: "usr-mock-owner", tenant_id: "ten-mock-1", role: "Owner", active: true }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/tenants")) {
    res.writeHead(200);
    res.end(JSON.stringify([{
      id: "ten-mock-1",
      name: "Mock Restaurant",
      plan: "pro",
      subscription_plan: "pro",
      subscription_status: "active",
      current_period_end: new Date(Date.now() + 86400000).toISOString(),
      active: true,
      currency_symbol: "₹",
    }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/subscription_plans")) {
    res.writeHead(200);
    res.end(JSON.stringify([{
      id: "pro",
      name: "Pro",
      features: [],
      feature_keys: ["multi_location_reporting", "analytics_advanced"],
      is_active: true,
      trial_days: 14,
    }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/settings")) {
    res.writeHead(200);
    res.end(JSON.stringify([{ value: "Asia/Kolkata" }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/locations")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      { id: "loc-1", name: "Branch 1", is_primary: true, active: true, tenant_id: "ten-mock-1" },
      { id: "loc-2", name: "Branch 2", is_primary: false, active: true, tenant_id: "ten-mock-1" },
    ]));
    return;
  }
  if (url.pathname.includes("/rest/v1/tables")) {
    res.writeHead(200);
    res.end(JSON.stringify(mockTables));
    return;
  }
  if (url.pathname.includes("/rest/v1/menu_items")) {
    res.writeHead(200);
    res.end(JSON.stringify([
      { id: "item-1", name: "Salad", is_active: true, category: { name: "Food" } }
    ]));
    return;
  }
  if (url.pathname.includes("/rest/v1/check_payments")) {
    // Check status filter in query
    if (url.searchParams.get("status") === "eq.VOID") {
      res.writeHead(200);
      res.end(JSON.stringify(mockPayments.filter((p) => p.status === "VOID")));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(mockPayments.filter((p) => p.status === "SUCCEEDED")));
    return;
  }
  if (url.pathname.includes("/rest/v1/table_checks")) {
    res.writeHead(200);
    res.end(JSON.stringify(mockChecks));
    return;
  }
  if (url.pathname.includes("/rest/v1/orders")) {
    const psParam = url.searchParams.get("payment_status") || "";
    // Check if querying REFUNDED (via in.(REFUNDED,refunded))
    if (psParam.startsWith("in.")) {
      res.writeHead(200);
      res.end(JSON.stringify(mockOrders.filter((o) => o.payment_status === "REFUNDED")));
      return;
    }
    // Querying non-refunded orders (via neq.REFUNDED)
    res.writeHead(200);
    res.end(JSON.stringify(mockOrders.filter((o) => o.payment_status !== "REFUNDED" && o.status !== "CANCELLED")));
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify([]));
});

mockServer.listen(54322, "127.0.0.1", async () => {
  console.log("Mock Supabase backend listening on http://127.0.0.1:54322");

  const denoProc = spawn("deno", ["run", "--allow-all", "--allow-env", "supabase/functions/analytics/index.ts"], {
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}`,
      SUPABASE_URL: "http://127.0.0.1:54322",
      SUPABASE_ANON_KEY: "mock-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role-key",
      PORT: "8001",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  denoProc.stdout.on("data", (d) => console.log(`[Deno stdout] ${d.toString().trim()}`));
  denoProc.stderr.on("data", (d) => console.error(`[Deno stderr] ${d.toString().trim()}`));

  await new Promise((r) => setTimeout(r, 1500));

  try {
    // TEST 1: Tenant-wide (All Locations) for TARGET_DATE
    console.log("\n--- TEST 1: All Locations Reconciliation ---");
    const res1 = await fetch(`http://127.0.0.1:8000/?from=${TARGET_DATE}&to=${TARGET_DATE}`, {
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();

    // Financial Overview:
    // Check A: 500, Check B: 450, Check C: 0, Check D: 800 => Total Revenue = 1750
    console.log("Total Revenue:", data1.totalRevenue);
    assert.equal(data1.totalRevenue, 1750, "Total revenue must be exactly 1750 (500 + 450 + 0 + 800)");

    // Completed Orders:
    // ord-a1, ord-a2, ord-b, ord-c, ord-d => 5 orders
    console.log("Total Orders:", data1.totalOrders);
    assert.equal(data1.totalOrders, 5, "Total orders must be exactly 5");

    // AOV: 1750 / 5 = 350
    console.log("AOV:", data1.avgOrder);
    assert.equal(data1.avgOrder, 350);

    // Section 3: Order Types reconciliation:
    // DINE_IN: Check A (500) + Check C (0) + Check D (800) = 1300 revenue, 4 orders (a1, a2, c, d)
    // TAKEAWAY: Check B (450) = 450 revenue, 1 order (b)
    const dineInType = data1.typeBreakdown.find((t: any) => t.type === "DINE_IN");
    const takeawayType = data1.typeBreakdown.find((t: any) => t.type === "TAKEAWAY");
    console.log("Order Types Breakdown:", data1.typeBreakdown);
    assert.equal(dineInType.revenue, 1300, "DINE_IN revenue must be 1300");
    assert.equal(dineInType.count, 4, "DINE_IN count must be 4");
    assert.equal(takeawayType.revenue, 450, "TAKEAWAY revenue must be 450");
    assert.equal(takeawayType.count, 1, "TAKEAWAY count must be 1");

    const totalTypeRev = data1.typeBreakdown.reduce((s: number, t: any) => s + t.revenue, 0);
    assert.equal(totalTypeRev, data1.totalRevenue, "Sum of order type revenues must exactly match totalRevenue");

    // Section 4: Sales by Hour reconciliation:
    // Hour 12 (T_MID): Check A (500) + Check B (450) = 950, 3 orders (a1, a2, b)
    // Hour 20 (T_LATE): Check C (0) + Check D (800) = 800, 2 orders (c, d)
    console.log("Hourly (Hour 12):", data1.hourlyBreakdown[12]);
    console.log("Hourly (Hour 20):", data1.hourlyBreakdown[20]);
    assert.equal(data1.hourlyBreakdown[12].revenue, 950, "Hour 12 revenue must be 950");
    assert.equal(data1.hourlyBreakdown[12].orders, 3, "Hour 12 order count must be 3");
    assert.equal(data1.hourlyBreakdown[20].revenue, 800, "Hour 20 revenue must be 800");
    assert.equal(data1.hourlyBreakdown[20].orders, 2, "Hour 20 order count must be 2");

    const totalHourlyRev = data1.hourlyBreakdown.reduce((s: number, h: any) => s + h.revenue, 0);
    assert.equal(totalHourlyRev, data1.totalRevenue, "Sum of hourly revenues must exactly match totalRevenue");

    // Section 8: Top Tables:
    // Table 1 had two independent sessions (sess-1: Check A = 500, sess-2: Check D = 800, plus sess-c: Check C = 0)
    // Sessions: sess-1, sess-c, sess-2 => 3 sessions, total rev = 1300
    const tbl1 = data1.topTables.find((t: any) => t.tableId === "tbl-1");
    console.log("Top Table 1:", tbl1);
    assert.ok(tbl1, "Table 1 must exist");
    assert.equal(tbl1.sessionCount, 3, "Table 1 must have 3 independent sessions");
    assert.equal(tbl1.revenue, 1300, "Table 1 revenue must be 1300");

    // Section 7 & 10: Refunds reconciliation & deduplication:
    // Void check payment: Check E (150 CASH)
    // Legacy order refund 1: ord-ref-1 (100 UPI)
    // Legacy order refund 2: ord-ref-dup (150 on Check E) -> DEDUPLICATED, NOT DOUBLE-COUNTED!
    // Legacy order refund 3: ord-ref-unresolved (50 OTHER) -> included in All Locations
    // Total refunds = 150 (Cash) + 100 (UPI) + 50 (Other) = 300
    console.log("Payment Methods Refunds:", data1.paymentMethods.totalRefunds, data1.paymentMethods);
    console.log("Discounts & Refunds:", data1.discountsAndRefunds.totalRefunds, data1.discountsAndRefunds.refundsByMethod);
    assert.equal(data1.paymentMethods.totalRefunds, 300, "Total refunds must be exactly 300 (deduplicated)");
    assert.equal(data1.discountsAndRefunds.totalRefunds, 300, "Discounts & Refunds must match paymentMethods total refunds");
    assert.equal(data1.paymentMethods.cash.refunds, 150, "Cash refund must be 150");
    assert.equal(data1.paymentMethods.upi.refunds, 100, "UPI refund must be 100");
    assert.equal(data1.discountsAndRefunds.refundedTransactionsCount, 3, "Refund transaction count must be 3 (deduplicated)");

    // TEST 2: Location isolation (Branch 1 vs Branch 2)
    console.log("\n--- TEST 2: Location Isolation & Unresolved Refunds Prevention ---");
    const resLoc1 = await fetch(`http://127.0.0.1:8000/?from=${TARGET_DATE}&to=${TARGET_DATE}&location_id=loc-1`, {
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });
    const dataLoc1 = await resLoc1.json();
    console.log("Branch 1 Total Refunds:", dataLoc1.paymentMethods.totalRefunds);
    // Loc 1 should only see Loc 1 refunds: Check E void (150) + ord-ref-1 (100) = 250!
    // Unresolved refund (50) MUST NOT leak into Branch 1!
    assert.equal(dataLoc1.paymentMethods.totalRefunds, 250, "Branch 1 must NOT include unresolved refunds (must be 250, not 300)");
    assert.equal(dataLoc1.discountsAndRefunds.totalRefunds, 250, "Discounts & Refunds for Branch 1 must be 250");

    const resLoc2 = await fetch(`http://127.0.0.1:8000/?from=${TARGET_DATE}&to=${TARGET_DATE}&location_id=loc-2`, {
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });
    const dataLoc2 = await resLoc2.json();
    console.log("Branch 2 Total Refunds:", dataLoc2.paymentMethods.totalRefunds);
    // Loc 2 has no sales and no refunds: must be 0, NOT leak unresolved refund!
    assert.equal(dataLoc2.paymentMethods.totalRefunds, 0, "Branch 2 must have 0 refunds");
    assert.equal(dataLoc2.totalRevenue, 0, "Branch 2 must have 0 revenue");

    console.log("\n✓ Batch 2: ALL reconciliation tests passed successfully!");
  } finally {
    denoProc.kill();
    mockServer.close();
  }
});
