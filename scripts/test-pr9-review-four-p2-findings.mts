/**
 * Regression test suite for the four P2 findings from PR #9 review (head 81ba802):
 *
 * 1. Handle skipped local midnights (America/Santiago 2026-09-05 & 2026-09-06)
 * 2. Limit Average Dine-in Duration to dine-in checks (exclude takeaway/delivery; unavailable state when 0)
 * 3. Deduplicate cross-day refunds linked only by idempotency_key (honor query date filters)
 * 4. Align monthly tooltip assertions (verified via test-analytics-monthly-tooltip-render.mts + test-pr9-four-findings-suite.mts)
 */

import { createServer, Server } from "node:http";
import { spawn, ChildProcess } from "node:child_process";

console.log("========================================================================");
console.log("   PR #9 REVIEW: 4 P2 FINDINGS REGRESSION SUITE                         ");
console.log("========================================================================");

let totalPassed = 0;
let totalFailed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    totalPassed++;
    console.log(`  \u2713 ok    ${name}`);
  } else {
    totalFailed++;
    console.error(`  \u2717 FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(
  JSON.stringify({ sub: "usr-mock-owner", session_id: "sess-1", role: "authenticated" })
).toString("base64url");
const dummyJwt = `${header}.${payload}.signature`;

let tenantTimezone = "Asia/Kolkata";
let mockChecks: any[] = [];
let mockPayments: any[] = [];
let mockOrders: any[] = [];

function filterPostgrest(rows: any[], url: URL) {
  let result = [...rows];
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "select" || key === "order" || key === "range" || key === "limit") continue;

    if (value.startsWith("eq.")) {
      const target = value.slice(3);
      if (key === "tenant_id") {
        // Honor tenant isolation when row specifies tenant_id, default to ten-mock-1
        result = result.filter((r) => String(r.tenant_id ?? "ten-mock-1") === target);
      } else {
        result = result.filter((r) => String(r[key] ?? "") === target);
      }
    } else if (value.startsWith("neq.")) {
      const target = value.slice(4);
      result = result.filter((r) => String(r[key] ?? "") !== target);
    } else if (value.startsWith("gte.")) {
      const target = value.slice(4);
      result = result.filter((r) => r[key] && String(r[key]) >= target);
    } else if (value.startsWith("lt.")) {
      const target = value.slice(3);
      result = result.filter((r) => r[key] && String(r[key]) < target);
    } else if (value.startsWith("is.")) {
      const target = value.slice(3);
      if (target === "null") {
        result = result.filter((r) => r[key] === null || r[key] === undefined);
      }
    } else if (value.startsWith("in.")) {
      const raw = value.slice(3);
      const inside = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
      const set = new Set(inside.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")));
      result = result.filter((r) => set.has(String(r[key] ?? "")));
    }
  }
  return result;
}

const MOCK_DB_PORT = 54328;
const EDGE_PORT = 8000;

const mockServer: Server = createServer((req, res) => {
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
    res.end(
      JSON.stringify([
        {
          id: "ten-mock-1",
          name: "Mock Restaurant",
          plan: "pro",
          subscription_plan: "pro",
          subscription_status: "active",
          current_period_end: new Date(Date.now() + 86400000).toISOString(),
          active: true,
          currency_symbol: "\u20B9",
        },
      ])
    );
    return;
  }
  if (url.pathname.includes("/rest/v1/settings")) {
    res.writeHead(200);
    res.end(JSON.stringify([{ value: tenantTimezone }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/user_roles")) {
    res.writeHead(200, { "content-range": "0-0/1" });
    res.end(JSON.stringify([{ role: "owner" }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/locations")) {
    res.writeHead(200, { "content-range": "0-0/1" });
    res.end(JSON.stringify([{ id: "loc-1", name: "Main Location", is_primary: true }]));
    return;
  }
  if (url.pathname.includes("/rest/v1/tables")) {
    res.writeHead(200, { "content-range": "0-0/0" });
    res.end(JSON.stringify([]));
    return;
  }
  if (url.pathname.includes("/rest/v1/categories") || url.pathname.includes("/rest/v1/menu_items")) {
    res.writeHead(200, { "content-range": "0-0/0" });
    res.end(JSON.stringify([]));
    return;
  }
  if (url.pathname.includes("/rest/v1/table_checks")) {
    const filtered = filterPostgrest(mockChecks, url);
    res.writeHead(200, { "content-range": `0-${Math.max(filtered.length - 1, 0)}/${filtered.length}` });
    res.end(JSON.stringify(filtered));
    return;
  }
  if (url.pathname.includes("/rest/v1/check_payments")) {
    const filtered = filterPostgrest(mockPayments, url);
    res.writeHead(200, { "content-range": `0-${Math.max(filtered.length - 1, 0)}/${filtered.length}` });
    res.end(JSON.stringify(filtered));
    return;
  }
  if (url.pathname.includes("/rest/v1/orders")) {
    const filtered = filterPostgrest(mockOrders, url);
    res.writeHead(200, { "content-range": `0-${Math.max(filtered.length - 1, 0)}/${filtered.length}` });
    res.end(JSON.stringify(filtered));
    return;
  }

  res.writeHead(200, { "content-range": "0-0/0" });
  res.end(JSON.stringify([]));
});

let denoProcess: ChildProcess | null = null;

async function queryAnalytics(params: string) {
  const res = await fetch(`http://127.0.0.1:${EDGE_PORT}/?${params}`, {
    headers: {
      Authorization: `Bearer ${dummyJwt}`,
      apiKey: "mock-anon-key",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Analytics HTTP ${res.status}: ${txt}`);
  }
  return await res.json();
}

async function startServer(): Promise<void> {
  return new Promise((resolve) => {
    mockServer.listen(MOCK_DB_PORT, "127.0.0.1", () => {
      denoProcess = spawn(
        "deno",
        ["run", "--allow-all", "--allow-env", "supabase/functions/analytics/index.ts"],
        {
          env: {
            ...process.env,
            PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}`,
            SUPABASE_URL: `http://127.0.0.1:${MOCK_DB_PORT}`,
            SUPABASE_ANON_KEY: "mock-anon-key",
            SUPABASE_SERVICE_ROLE_KEY: "mock-service-role-key",
            PORT: String(EDGE_PORT),
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );

      denoProcess.stderr?.on("data", (d) => {
        const str = d.toString();
        if (str.includes("ERR") || str.includes("Error")) {
          console.error(`[Deno ERR] ${str.trim()}`);
        }
      });

      const checkReady = async () => {
        for (let i = 0; i < 40; i++) {
          try {
            const r = await fetch(`http://127.0.0.1:${EDGE_PORT}/`, { method: "OPTIONS" });
            if (r.ok || r.status === 204) {
              resolve();
              return;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 150));
        }
        resolve();
      };
      checkReady();
    });
  });
}

function stopServer() {
  if (denoProcess) {
    denoProcess.kill("SIGKILL");
    denoProcess = null;
  }
  mockServer.close();
}

await startServer();

try {
  // =========================================================================
  // 1. P2 · Handle skipped local midnights (America/Santiago 2026-09-05 / 06)
  // =========================================================================
  console.log("\n── 1. P2 · Handle skipped local midnights (America/Santiago) ──");
  tenantTimezone = "America/Santiago";

  mockChecks = [];
  mockPayments = [];
  mockOrders = [
    {
      id: "ord-santiago-sep5",
      order_number: 101,
      order_type: "TAKEAWAY",
      status: "COMPLETED",
      payment_status: "PAID",
      total: 120,
      items_total: 120,
      location_id: "loc-1",
      created_at: "2026-09-06T03:20:00.000Z",
      paid_at: "2026-09-06T03:30:00.000Z", // 2026-09-05 23:30:00 -04:00
      completed_at: "2026-09-06T03:30:00.000Z",
      items: [],
    },
    {
      id: "ord-santiago-sep6",
      order_number: 102,
      order_type: "TAKEAWAY",
      status: "COMPLETED",
      payment_status: "PAID",
      total: 180,
      items_total: 180,
      location_id: "loc-1",
      created_at: "2026-09-06T04:00:00.000Z",
      paid_at: "2026-09-06T04:00:00.000Z", // 2026-09-06 01:00:00 -03:00 (first valid instant of Sep 6)
      completed_at: "2026-09-06T04:00:00.000Z",
      items: [],
    },
  ];

  const sep5Report = await queryAnalytics("from=2026-09-05&to=2026-09-05");
  const sep6Report = await queryAnalytics("from=2026-09-06&to=2026-09-06");

  check(
    "Sep 5 Santiago report includes 2026-09-06T03:30:00Z (₹120) and excludes 04:00:00Z",
    sep5Report.totalRevenue === 120,
    `actual: ${sep5Report.totalRevenue}`
  );
  check(
    "Sep 6 Santiago report includes 2026-09-06T04:00:00Z (₹180) and excludes 03:30:00Z",
    sep6Report.totalRevenue === 180,
    `actual: ${sep6Report.totalRevenue}`
  );

  // =========================================================================
  // 2. P2 · Limit Average Dine-in Duration to dine-in checks
  // =========================================================================
  console.log("\n── 2. P2 · Limit Average Dine-in Duration to dine-in checks ──");
  tenantTimezone = "Asia/Kolkata";

  mockChecks = [
    {
      id: "chk-dine-1",
      order_type: "DINE_IN",
      status: "PAID",
      location_id: "loc-1",
      total: 500,
      created_at: "2026-09-10T06:00:00.000Z",
      closed_at: "2026-09-10T06:40:00.000Z", // 40 min
    },
    {
      id: "chk-dine-2",
      order_type: "DINE_IN",
      status: "PAID",
      location_id: "loc-1",
      total: 400,
      created_at: "2026-09-10T07:00:00.000Z",
      closed_at: "2026-09-10T07:20:00.000Z", // 20 min
    },
    {
      id: "chk-takeaway-1",
      order_type: "TAKEAWAY",
      status: "PAID",
      location_id: "loc-1",
      total: 200,
      created_at: "2026-09-10T08:00:00.000Z",
      closed_at: "2026-09-10T08:10:00.000Z", // 10 min (must be excluded)
    },
    {
      id: "chk-delivery-1",
      order_type: "DELIVERY",
      status: "PAID",
      location_id: "loc-1",
      total: 300,
      created_at: "2026-09-10T09:00:00.000Z",
      closed_at: "2026-09-10T09:25:00.000Z", // 25 min (must be excluded)
    },
  ];
  mockPayments = [
    { id: "pay-d1", check_id: "chk-dine-1", amount: 500, method: "CASH", status: "SUCCEEDED", location_id: "loc-1", created_at: "2026-09-10T06:40:00.000Z" },
    { id: "pay-d2", check_id: "chk-dine-2", amount: 400, method: "CASH", status: "SUCCEEDED", location_id: "loc-1", created_at: "2026-09-10T07:20:00.000Z" },
    { id: "pay-t1", check_id: "chk-takeaway-1", amount: 200, method: "CASH", status: "SUCCEEDED", location_id: "loc-1", created_at: "2026-09-10T08:10:00.000Z" },
    { id: "pay-del1", check_id: "chk-delivery-1", amount: 300, method: "CASH", status: "SUCCEEDED", location_id: "loc-1", created_at: "2026-09-10T09:25:00.000Z" },
  ];
  mockOrders = [
    { id: "ord-d1", check_id: "chk-dine-1", order_type: "DINE_IN", status: "COMPLETED", payment_status: "PAID", total: 500, location_id: "loc-1", created_at: "2026-09-10T06:00:00.000Z", paid_at: "2026-09-10T06:40:00.000Z", items: [] },
    { id: "ord-d2", check_id: "chk-dine-2", order_type: "DINE_IN", status: "COMPLETED", payment_status: "PAID", total: 400, location_id: "loc-1", created_at: "2026-09-10T07:00:00.000Z", paid_at: "2026-09-10T07:20:00.000Z", items: [] },
    { id: "ord-t1", check_id: "chk-takeaway-1", order_type: "TAKEAWAY", status: "COMPLETED", payment_status: "PAID", total: 200, location_id: "loc-1", created_at: "2026-09-10T08:00:00.000Z", paid_at: "2026-09-10T08:10:00.000Z", items: [] },
    { id: "ord-del1", check_id: "chk-delivery-1", order_type: "DELIVERY", status: "COMPLETED", payment_status: "PAID", total: 300, location_id: "loc-1", created_at: "2026-09-10T09:00:00.000Z", paid_at: "2026-09-10T09:25:00.000Z", items: [] },
  ];

  const mixedSvcReport = await queryAnalytics("from=2026-09-10&to=2026-09-10");
  check(
    "Mixed report: Average Dine-in Duration is 30 min (only 40m + 20m dine-in checks)",
    mixedSvcReport.operationsPerformance?.serviceTime?.averageMinutes === 30,
    `actual: ${mixedSvcReport.operationsPerformance?.serviceTime?.averageMinutes}`
  );
  check(
    "Mixed report: contributingRecords is 2 (excludes takeaway & delivery)",
    mixedSvcReport.operationsPerformance?.serviceTime?.contributingRecords === 2,
    `actual: ${mixedSvcReport.operationsPerformance?.serviceTime?.contributingRecords}`
  );

  // Takeaway-and-delivery-only report -> unavailable state (null, 0)
  mockChecks = mockChecks.filter((c) => c.order_type !== "DINE_IN");
  mockPayments = mockPayments.filter((p) => p.id === "pay-t1" || p.id === "pay-del1");
  mockOrders = mockOrders.filter((o) => o.order_type !== "DINE_IN");

  const nonDineInReport = await queryAnalytics("from=2026-09-10&to=2026-09-10");
  check(
    "Takeaway/delivery-only report: averageMinutes is null (unavailable state)",
    nonDineInReport.operationsPerformance?.serviceTime?.averageMinutes === null,
    `actual: ${nonDineInReport.operationsPerformance?.serviceTime?.averageMinutes}`
  );
  check(
    "Takeaway/delivery-only report: contributingRecords is 0",
    nonDineInReport.operationsPerformance?.serviceTime?.contributingRecords === 0,
    `actual: ${nonDineInReport.operationsPerformance?.serviceTime?.contributingRecords}`
  );

  // =========================================================================
  // 3. P2 · Deduplicate cross-day refunds linked only by idempotency_key
  // =========================================================================
  console.log("\n── 3. P2 · Deduplicate cross-day refunds linked only by idempotency_key ──");
  tenantTimezone = "Asia/Kolkata";

  mockChecks = [
    {
      id: "chk-idemp-1",
      order_type: "DINE_IN",
      status: "OPEN",
      location_id: "loc-1",
      total: 200,
      created_at: "2026-09-12T06:00:00.000Z",
    },
  ];
  mockPayments = [
    {
      id: "pay-void-idemp-1",
      tenant_id: "ten-mock-1",
      check_id: "chk-idemp-1",
      amount: 200,
      method: "UPI",
      status: "VOID",
      location_id: "loc-1",
      created_at: "2026-09-12T06:00:00.000Z", // Day 1
      voided_at: "2026-09-12T07:00:00.000Z",  // Day 1
      idempotency_key: "shared-idemp-key-200",
    },
    // Different tenant with same idempotency_key must NOT leak into ten-mock-1
    {
      id: "pay-void-other-tenant",
      tenant_id: "ten-other-999",
      check_id: "chk-other",
      amount: 999,
      method: "UPI",
      status: "VOID",
      location_id: "loc-other",
      created_at: "2026-09-12T06:00:00.000Z",
      voided_at: "2026-09-12T07:00:00.000Z",
      idempotency_key: "shared-idemp-key-200",
    },
  ];
  mockOrders = [
    // Day 2 legacy refund linked ONLY by idempotency_key (no payment_id)
    {
      id: "ord-legacy-idemp-day2",
      tenant_id: "ten-mock-1",
      payment_status: "REFUNDED",
      payment_method: "UPI",
      total: 200,
      location_id: "loc-1",
      created_at: "2026-09-12T06:00:00.000Z",
      refunded_at: "2026-09-13T06:00:00.000Z", // Day 2
      idempotency_key: "shared-idemp-key-200",
      items: [],
    },
    // Day 2 independent ₹50 refund
    {
      id: "ord-legacy-indep-day2",
      tenant_id: "ten-mock-1",
      payment_status: "REFUNDED",
      payment_method: "CASH",
      total: 50,
      location_id: "loc-1",
      created_at: "2026-09-13T07:00:00.000Z",
      refunded_at: "2026-09-13T08:00:00.000Z", // Day 2
      idempotency_key: "indep-key-50",
      items: [],
    },
  ];

  const day1Report = await queryAnalytics("from=2026-09-12&to=2026-09-12");
  const day2Report = await queryAnalytics("from=2026-09-13&to=2026-09-13");
  const combinedReport = await queryAnalytics("from=2026-09-12&to=2026-09-13");

  check(
    "Day 1 refunds = ₹200 (ledger void attributed to Day 1)",
    day1Report.discountsAndRefunds?.totalRefunds === 200,
    `actual: ${day1Report.discountsAndRefunds?.totalRefunds}`
  );
  check(
    "Day 2 refunds = ₹50 (idempotency-linked Day 2 legacy refund deduplicated; ₹50 independent preserved)",
    day2Report.discountsAndRefunds?.totalRefunds === 50,
    `actual: ${day2Report.discountsAndRefunds?.totalRefunds}`
  );
  check(
    "Combined (Day 1 + Day 2) refunds = ₹250",
    combinedReport.discountsAndRefunds?.totalRefunds === 250,
    `actual: ${combinedReport.discountsAndRefunds?.totalRefunds}`
  );
} finally {
  stopServer();
}

console.log("\n========================================================================");
console.log(`  SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED`);
console.log("========================================================================");

if (totalFailed > 0) process.exit(1);
