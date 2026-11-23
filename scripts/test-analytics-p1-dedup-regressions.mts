/**
 * Regression test suite for Saladcode PR #9 refund deduplication fixes.
 *
 * Requirements:
 * 1. A ₹300 ledger void and a linked legacy record for that same reversal → ₹300 total.
 * 2. A ₹300 ledger void and a distinct ₹100 order refund on the same check → ₹400 total.
 * 3. The same records queried one day at a time and across both days → each reversal appears once on its verified date.
 */

import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Dummy JWT
const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({
  sub: "usr-mock-owner",
  session_id: "sess-1",
  role: "authenticated",
})).toString("base64url");
const dummyJwt = `${header}.${payload}.signature`;

// Asia/Kolkata date strings and ISO timestamps
// Monday: 2026-11-23
// Tuesday: 2026-11-24
const MON_DATE = "2026-11-23";
const TUE_DATE = "2026-11-24";
const MON_NOON = "2026-11-23T06:30:00.000Z"; // Monday 12:00 IST
const TUE_NOON = "2026-11-24T06:30:00.000Z"; // Tuesday 12:00 IST

const mockLocations = [
  { id: "loc-1", name: "Main Dining", is_primary: true },
];

const mockTables = [
  { id: "tbl-1", name: "Table 1", location_id: "loc-1" },
];

// Checks
const mockChecks = [
  // Check 1: Has ₹300 ledger void on Monday and a linked legacy order refund
  {
    id: "chk-linked",
    table_id: "tbl-1",
    session_id: "sess-1",
    order_type: "DINE_IN",
    status: "PAID",
    subtotal: 300,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 300,
    paid_total: 300,
    closed_at: MON_NOON,
    location_id: "loc-1",
    created_at: MON_NOON,
  },
  // Check 2: Has ₹300 ledger void on Tuesday AND a distinct ₹100 order refund on the same check
  {
    id: "chk-distinct",
    table_id: "tbl-1",
    session_id: "sess-2",
    order_type: "DINE_IN",
    status: "PAID",
    subtotal: 400,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 400,
    paid_total: 400,
    closed_at: TUE_NOON,
    location_id: "loc-1",
    created_at: TUE_NOON,
  },
];

// Ledger payments
const mockPayments = [
  // Check 1 ledger void: ₹300 on Monday
  {
    id: "pay-void-300-mon",
    check_id: "chk-linked",
    amount: 300,
    method: "CASH",
    status: "VOID",
    staff_id: "stf-1",
    location_id: "loc-1",
    created_at: MON_NOON,
    voided_at: MON_NOON,
  },
  // Check 2 ledger void: ₹300 on Tuesday
  {
    id: "pay-void-300-tue",
    check_id: "chk-distinct",
    amount: 300,
    method: "UPI",
    status: "VOID",
    staff_id: "stf-1",
    location_id: "loc-1",
    created_at: TUE_NOON,
    voided_at: TUE_NOON,
  },
];

// Orders
const mockOrders = [
  // 1. Linked legacy record for Check 1:
  // Explicitly references payment_id "pay-void-300-mon"
  {
    id: "ord-linked-legacy",
    order_number: 101,
    order_type: "DINE_IN",
    table_id: "tbl-1",
    table_session_id: "sess-1",
    check_id: "chk-linked",
    payment_id: "pay-void-300-mon", // Verified payment ID link!
    status: "CANCELLED",
    payment_status: "REFUNDED",
    payment_method: "CASH",
    items_total: 300,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 300,
    paid_at: MON_NOON,
    refunded_at: MON_NOON,
    created_at: MON_NOON,
    location_id: "loc-1",
    items: [],
  },
  // 2. Distinct order refund on Check 2:
  // On the same check "chk-distinct", but NOT linked to "pay-void-300-tue" via structured payment_id.
  // Note: Its notes and cancellation_reason explicitly mention "pay-void-300-tue", but because
  // mentions in text do not prove same reversal, it must NOT be deduplicated!
  {
    id: "ord-distinct-100",
    order_number: 102,
    order_type: "DINE_IN",
    table_id: "tbl-1",
    table_session_id: "sess-2",
    check_id: "chk-distinct", // Same check as pay-void-300-tue!
    payment_id: null,         // Distinct reversal, no payment ID link!
    status: "CANCELLED",
    payment_status: "REFUNDED",
    payment_method: "CARD",
    items_total: 100,
    discount: 0,
    tax: 0,
    service_charge: 0,
    total: 100,
    cancellation_reason: "Refunding partial order items after void of pay-void-300-tue",
    notes: "Customer complained; references pay-void-300-tue on check chk-distinct",
    paid_at: TUE_NOON,
    refunded_at: TUE_NOON,
    created_at: TUE_NOON,
    location_id: "loc-1",
    items: [],
  },
];

// Mock Supabase REST server
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
    }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/user_roles")) {
    res.writeHead(200, { "content-range": "0-0/1" });
    res.end(JSON.stringify([{ role: "owner" }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/locations")) {
    res.writeHead(200, { "content-range": "0-0/1" });
    res.end(JSON.stringify(mockLocations));
    return;
  }
  if (url.pathname.includes("/rest/v1/tables")) {
    res.writeHead(200, { "content-range": "0-0/1" });
    res.end(JSON.stringify(mockTables));
    return;
  }
  if (url.pathname.includes("/rest/v1/menu_items") || url.pathname.includes("/rest/v1/menu_categories")) {
    res.writeHead(200, { "content-range": "0-0/0" });
    res.end(JSON.stringify([]));
    return;
  }
  if (url.pathname.includes("/rest/v1/check_payments")) {
    const statusParam = url.searchParams.get("status");
    if (statusParam === "eq.SUCCEEDED") {
      res.writeHead(200, { "content-range": "0-0/0" });
      res.end(JSON.stringify([]));
      return;
    }
    if (statusParam === "eq.VOID") {
      res.writeHead(200, { "content-range": `0-${mockPayments.length - 1}/${mockPayments.length}` });
      res.end(JSON.stringify(mockPayments));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify([]));
    return;
  }
  if (url.pathname.includes("/rest/v1/table_checks")) {
    res.writeHead(200, { "content-range": `0-${mockChecks.length - 1}/${mockChecks.length}` });
    res.end(JSON.stringify(mockChecks));
    return;
  }
  if (url.pathname.includes("/rest/v1/orders")) {
    const psParam = url.searchParams.get("payment_status") || "";
    if (psParam.startsWith("in.")) {
      const refOrders = mockOrders.filter((o) => o.payment_status === "REFUNDED");
      res.writeHead(200, { "content-range": `0-${refOrders.length - 1}/${refOrders.length}` });
      res.end(JSON.stringify(refOrders));
      return;
    }
    const nonRefOrders = mockOrders.filter((o) => o.payment_status !== "REFUNDED");
    res.writeHead(200, { "content-range": `0-${nonRefOrders.length - 1}/${nonRefOrders.length}` });
    res.end(JSON.stringify(nonRefOrders));
    return;
  }
  if (url.pathname.includes("/rest/v1/security_logs")) {
    res.writeHead(200, { "content-range": "0-0/0" });
    res.end(JSON.stringify([]));
    return;
  }

  res.writeHead(200, { "content-range": "0-0/0" });
  res.end(JSON.stringify([]));
});

mockServer.listen(54326, "127.0.0.1", async () => {
  console.log("Mock Supabase backend listening on http://127.0.0.1:54326");

  const denoProc = spawn("deno", ["run", "--allow-all", "--allow-env", "supabase/functions/analytics/index.ts"], {
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}`,
      SUPABASE_URL: "http://127.0.0.1:54326",
      SUPABASE_ANON_KEY: "mock-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role-key",
      PORT: "8000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  denoProc.stdout.on("data", (d) => console.log(`[Deno] ${d.toString().trim()}`));
  denoProc.stderr.on("data", (d) => console.error(`[Deno ERR] ${d.toString().trim()}`));

  await new Promise((r) => setTimeout(r, 1500));

  try {
    console.log("\n=======================================================");
    console.log("TEST 1: Monday Query (2026-11-23)");
    console.log("Expectation: Check 1 has ₹300 ledger void + linked legacy record → ₹300 total (deduplicated!)");
    const resMon = await fetch(`http://127.0.0.1:8000/?from=${MON_DATE}&to=${MON_DATE}`, {
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });
    assert.equal(resMon.status, 200);
    const dataMon = await resMon.json();

    console.log("Monday Total Refunds:", dataMon.discountsAndRefunds.totalRefunds);
    console.log("Monday PaymentMethods Total Refunds:", dataMon.paymentMethods.totalRefunds);
    console.log("Monday Cash Refunds:", dataMon.paymentMethods.cash.refunds);

    // REGRESSION 1 VERIFICATION:
    // A ₹300 ledger void and a linked legacy record for that same reversal → ₹300 total (not ₹600!)
    assert.equal(dataMon.discountsAndRefunds.totalRefunds, 300, "₹300 ledger void and linked legacy record must yield exactly ₹300 total");
    assert.equal(dataMon.paymentMethods.totalRefunds, 300);
    assert.equal(dataMon.paymentMethods.cash.refunds, 300);
    console.log("✓ REGRESSION 1 PASSED: ₹300 ledger void + linked legacy record = ₹300 total!");

    console.log("\n=======================================================");
    console.log("TEST 2: Tuesday Query (2026-11-24)");
    console.log("Expectation: Check 2 has ₹300 ledger void (UPI) AND distinct ₹100 order refund (Card) on the same check → ₹400 total!");
    const resTue = await fetch(`http://127.0.0.1:8000/?from=${TUE_DATE}&to=${TUE_DATE}`, {
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });
    assert.equal(resTue.status, 200);
    const dataTue = await resTue.json();

    console.log("Tuesday Total Refunds:", dataTue.discountsAndRefunds.totalRefunds);
    console.log("Tuesday PaymentMethods Total Refunds:", dataTue.paymentMethods.totalRefunds);
    console.log("Tuesday UPI Refunds (₹300 ledger void):", dataTue.paymentMethods.upi.refunds);
    console.log("Tuesday Card Refunds (distinct ₹100 order refund on same check):", dataTue.paymentMethods.card.refunds);

    // REGRESSION 2 VERIFICATION:
    // A ₹300 ledger void and a distinct ₹100 order refund on the same check → ₹400 total (neither skipped!)
    assert.equal(dataTue.paymentMethods.upi.refunds, 300, "Tuesday UPI ledger void must be ₹300");
    assert.equal(dataTue.paymentMethods.card.refunds, 100, "Tuesday distinct order refund on same check must be ₹100 (NOT skipped by shared check ID!)");
    assert.equal(dataTue.discountsAndRefunds.totalRefunds, 400, "A ₹300 ledger void and a distinct ₹100 order refund on same check must yield exactly ₹400 total");
    assert.equal(dataTue.paymentMethods.totalRefunds, 400);
    console.log("✓ REGRESSION 2 PASSED: ₹300 ledger void + distinct ₹100 order refund on same check = ₹400 total!");

    console.log("\n=======================================================");
    console.log("TEST 3: Both Days Combined Query (2026-11-23 to 2026-11-24)");
    console.log("Expectation: Queried across both days → ₹300 (Monday) + ₹400 (Tuesday) = ₹700 total. Each reversal appears once on its verified date!");
    const resBoth = await fetch(`http://127.0.0.1:8000/?from=${MON_DATE}&to=${TUE_DATE}`, {
      headers: {
        "apikey": "mock-anon-key",
        "authorization": `Bearer ${dummyJwt}`,
        "x-tenant-id": "ten-mock-1",
      },
    });
    assert.equal(resBoth.status, 200);
    const dataBoth = await resBoth.json();

    console.log("Both Days Total Refunds:", dataBoth.discountsAndRefunds.totalRefunds);
    console.log("Both Days Cash Refunds (Monday ₹300):", dataBoth.paymentMethods.cash.refunds);
    console.log("Both Days UPI Refunds (Tuesday ₹300):", dataBoth.paymentMethods.upi.refunds);
    console.log("Both Days Card Refunds (Tuesday ₹100):", dataBoth.paymentMethods.card.refunds);

    // REGRESSION 3 VERIFICATION:
    // The same records queried one day at a time and across both days → each reversal appears once on its verified date.
    assert.equal(dataBoth.paymentMethods.cash.refunds, 300, "Both days Cash refunds must be ₹300 (from Monday)");
    assert.equal(dataBoth.paymentMethods.upi.refunds, 300, "Both days UPI refunds must be ₹300 (from Tuesday)");
    assert.equal(dataBoth.paymentMethods.card.refunds, 100, "Both days Card refunds must be ₹100 (from Tuesday)");
    assert.equal(dataBoth.discountsAndRefunds.totalRefunds, 700, "Both days total refunds must be exactly ₹700 (300 + 400)");
    assert.equal(dataBoth.paymentMethods.totalRefunds, 700);

    // Verify daily breakdown in trend:
    const monTrend = dataBoth.discountsAndRefunds.trend.find((t: any) => t.date === MON_DATE);
    const tueTrend = dataBoth.discountsAndRefunds.trend.find((t: any) => t.date === TUE_DATE);
    console.log("Monday Daily Trend Refund:", monTrend?.refunds);
    console.log("Tuesday Daily Trend Refund:", tueTrend?.refunds);
    assert.equal(monTrend?.refunds, 300, "Monday trend must show ₹300 refund");
    assert.equal(tueTrend?.refunds, 400, "Tuesday trend must show ₹400 refund");

    console.log("✓ REGRESSION 3 PASSED: Across both days each reversal appears once on its verified date (300 + 400 = 700)!");

    console.log("\n=======================================================");
    console.log("ALL DEDUPLICATION REGRESSION TESTS PASSED! 🎉");
    console.log("=======================================================\n");

  } finally {
    denoProc.kill();
    mockServer.close();
  }
});
