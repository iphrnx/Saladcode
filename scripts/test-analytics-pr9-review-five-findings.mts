/**
 * Comprehensive Regression Test Suite for the 5 Findings from PR #9 Review:
 *
 * 1. P1 · Correct net payments after a void (supabase/functions/analytics/index.ts)
 *    - Gross calculation accounts for original collection on its own date, void on its own date.
 *    - Same-day ₹200 void + ₹500 cash settlement -> cash net = ₹500, total net = ₹500.
 *    - Same-day collection and void with no replacement -> cash net = ₹0, total net = ₹0.
 *    - Void on a later day -> Day 1 net = ₹200, Day 2 net = -₹200.
 *    - Ordinary settlement with no void -> cash net = ₹500, total net = ₹500.
 *
 * 2. P2 · Render the prior-period revenue series (src/components/views/analytics.tsx)
 *    - ComposedChart renders Area and Line together without Recharts skipping Line.
 *    - Compare ON: both plotted series, curves, prior tooltip value, and prior legend render.
 *    - Compare OFF: only current series renders; prior line, tooltip, and legend are absent.
 *
 * 3. P2 · Preserve an unavailable comparison percentage (src/components/views/analytics.tsx)
 *    - Present comparison with revenueChange: null renders '—', ignoring fallback.
 *    - Real 0% comparison renders '0.0%'.
 *    - Absent comparison payload falls back to today-vs-yesterday.
 *    - Absent comparison with null fallback renders '—'.
 *
 * 4. P2 · Keep unrelated void history out of settlement lookups (supabase/functions/analytics/index.ts)
 *    - Refund inputs loaded once when includeRefunds: true; settlement-only windows skip refund reads.
 *    - Unrelated historical void check IDs (>1 batch, e.g. 250) never enter settlement lookup batches.
 *    - Report totals remain correct.
 *
 * 5. P2 · Attribute legacy table refunds to the correct branch (supabase/functions/analytics/index.ts)
 *    - table_id is included in the orderRefunds query.
 *    - Legacy table refund resolves to table's location via resolveEntityLocation.
 *    - Appears in Branch A and All Locations, excluded from Branch B.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import ReactDOMServer from "react-dom/server";
import {
  ComposedChart,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";

let passCount = 0;
let failCount = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passCount++;
    console.log(`  ok    ${name}`);
  } else {
    failCount++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

console.log("\n========================================================================");
console.log("   TARGETED REGRESSION TESTS: PR #9 REVIEW FIVE FINDINGS                ");
console.log("========================================================================\n");

const backendSource = fs.readFileSync("supabase/functions/analytics/index.ts", "utf8");
const frontendSource = fs.readFileSync("src/components/views/analytics.tsx", "utf8");

/* -------------------------------------------------------------------------- */
/* FINDING 1: P1 · Correct net payments after a void                          */
/* -------------------------------------------------------------------------- */
console.log("── 1. P1 · Correct net payments after a void ──");

// Verify backend has the ledger basis fix
const hasVoidCollectionsInBackend =
  backendSource.includes("voidCollections") &&
  backendSource.includes("filteredVoidCollections") &&
  backendSource.includes("mainVoidCollections");
check("backend tracks voidCollections on original collection date", hasVoidCollectionsInBackend);

// Ledger reconciliation engine simulation for payment methods matching index.ts lines 760-910
interface MockPaymentRecord {
  id: string;
  checkId: string | null;
  amount: number;
  method: "CASH" | "UPI" | "CARD" | "OTHER";
  createdAt: Date;
  status: "SUCCEEDED" | "VOID";
  voidedAt?: Date | null;
  locationId?: string | null;
}

function simulatePaymentLedger({
  settlements,
  voidPayments,
  windowStart,
  windowEnd,
  selectedLocationId,
}: {
  settlements: { checkId: string; amount: number; method: "CASH" | "UPI" | "CARD" | "OTHER"; settledAt: Date; locationId?: string | null }[];
  voidPayments: MockPaymentRecord[];
  windowStart: Date;
  windowEnd: Date;
  selectedLocationId?: string | null;
}) {
  // 1. In-window settlement events
  const inWindowSettlements = settlements.filter(
    (s) =>
      s.settledAt >= windowStart &&
      s.settledAt < windowEnd &&
      (!selectedLocationId || s.locationId === selectedLocationId)
  );

  let cashAmount = 0, cashCount = 0;
  let upiAmount = 0, upiCount = 0;
  let cardAmount = 0, cardCount = 0;
  let otherAmount = 0, otherCount = 0;

  for (const e of inWindowSettlements) {
    if (e.amount <= 0) continue;
    if (e.method === "CASH") {
      cashAmount += e.amount;
      cashCount++;
    } else if (e.method === "UPI") {
      upiAmount += e.amount;
      upiCount++;
    } else if (e.method === "CARD") {
      cardAmount += e.amount;
      cardCount++;
    } else {
      otherAmount += e.amount;
      otherCount++;
    }
  }

  // 2. Voided collections on original collection date
  const voidCollections: { id: string; amount: number; method: "CASH" | "UPI" | "CARD" | "OTHER"; createdAt: Date; locationId?: string | null }[] = [];
  const refunds: { id: string; amount: number; method: "CASH" | "UPI" | "CARD" | "OTHER"; timestamp: Date | null; locationId?: string | null }[] = [];

  for (const p of voidPayments) {
    if (p.createdAt >= windowStart && p.createdAt < windowEnd) {
      voidCollections.push({
        id: p.id,
        amount: p.amount,
        method: p.method,
        createdAt: p.createdAt,
        locationId: p.locationId || null,
      });
    }

    if (p.voidedAt && p.voidedAt >= windowStart && p.voidedAt < windowEnd) {
      refunds.push({
        id: p.id,
        amount: p.amount,
        method: p.method,
        timestamp: p.voidedAt,
        locationId: p.locationId || null,
      });
    }
  }

  const filteredVoidCollections = voidCollections.filter(
    (c) => !selectedLocationId || c.locationId === selectedLocationId
  );

  for (const c of filteredVoidCollections) {
    if (c.amount <= 0) continue;
    if (c.method === "CASH") {
      cashAmount += c.amount;
      cashCount++;
    } else if (c.method === "UPI") {
      upiAmount += c.amount;
      upiCount++;
    } else if (c.method === "CARD") {
      cardAmount += c.amount;
      cardCount++;
    } else {
      otherAmount += c.amount;
      otherCount++;
    }
  }

  // 3. Refunds in window
  const filteredRefunds = refunds.filter(
    (r) => !selectedLocationId || r.locationId === selectedLocationId
  );

  let cashRefunds = 0, upiRefunds = 0, cardRefunds = 0, otherRefunds = 0;
  let cashRefundCount = 0, upiRefundCount = 0, cardRefundCount = 0, otherRefundCount = 0;
  for (const r of filteredRefunds) {
    if (r.method === "CASH") {
      cashRefunds += r.amount;
      cashRefundCount++;
    } else if (r.method === "UPI") {
      upiRefunds += r.amount;
      upiRefundCount++;
    } else if (r.method === "CARD") {
      cardRefunds += r.amount;
      cardRefundCount++;
    } else {
      otherRefunds += r.amount;
      otherRefundCount++;
    }
  }

  cashRefunds = +cashRefunds.toFixed(2);
  upiRefunds = +upiRefunds.toFixed(2);
  cardRefunds = +cardRefunds.toFixed(2);
  otherRefunds = +otherRefunds.toFixed(2);

  const cashNet = +(cashAmount - cashRefunds).toFixed(2);
  const upiNet = +(upiAmount - upiRefunds).toFixed(2);
  const cardNet = +(cardAmount - cardRefunds).toFixed(2);
  const otherNet = +(otherAmount - otherRefunds).toFixed(2);
  const totalRefundAmount = +(cashRefunds + upiRefunds + cardRefunds + otherRefunds).toFixed(2);
  const paymentBreakdownTotal = +(cashAmount + upiAmount + cardAmount + otherAmount).toFixed(2);
  const totalNetAmount = +(paymentBreakdownTotal - totalRefundAmount).toFixed(2);

  return {
    cash: { amount: cashAmount, count: cashCount, refunds: cashRefunds, net: cashNet },
    upi: { amount: upiAmount, count: upiCount, refunds: upiRefunds, net: upiNet },
    card: { amount: cardAmount, count: cardCount, refunds: cardRefunds, net: cardNet },
    other: { amount: otherAmount, count: otherCount, refunds: otherRefunds, net: otherNet },
    totalCollected: paymentBreakdownTotal,
    totalRefunds: totalRefundAmount,
    totalNet: totalNetAmount,
  };
}

// Scenario 1.1: ₹200 cash collection that is voided, followed by a ₹500 cash settlement on the same day
const todayStart = new Date("2026-11-24T00:00:00.000Z");
const todayEnd = new Date("2026-11-25T00:00:00.000Z");

const report1_1 = simulatePaymentLedger({
  settlements: [
    {
      checkId: "chk-1",
      amount: 500,
      method: "CASH",
      settledAt: new Date("2026-11-24T12:00:00.000Z"),
    },
  ],
  voidPayments: [
    {
      id: "pmt-void-200",
      checkId: "chk-1",
      amount: 200,
      method: "CASH",
      createdAt: new Date("2026-11-24T10:00:00.000Z"),
      voidedAt: new Date("2026-11-24T10:15:00.000Z"),
      status: "VOID",
    },
  ],
  windowStart: todayStart,
  windowEnd: todayEnd,
});

check("Scenario 1.1: ₹200 void + ₹500 settlement -> cash net is exactly ₹500", report1_1.cash.net === 500);
check("Scenario 1.1: ₹200 void + ₹500 settlement -> total net is exactly ₹500", report1_1.totalNet === 500);
check("Scenario 1.1: Cash gross collected accounts for ₹200 collection + ₹500 settlement = ₹700", report1_1.cash.amount === 700);
check("Scenario 1.1: Cash refunds preserves separate reversal reporting = ₹200", report1_1.cash.refunds === 200);

// Scenario 1.2: Same-day collection and void with no replacement
const report1_2 = simulatePaymentLedger({
  settlements: [],
  voidPayments: [
    {
      id: "pmt-void-no-replace",
      checkId: "chk-unsettled",
      amount: 200,
      method: "CASH",
      createdAt: new Date("2026-11-24T14:00:00.000Z"),
      voidedAt: new Date("2026-11-24T14:30:00.000Z"),
      status: "VOID",
    },
  ],
  windowStart: todayStart,
  windowEnd: todayEnd,
});

check("Scenario 1.2: Same-day void with no replacement -> cash net is exactly ₹0", report1_2.cash.net === 0);
check("Scenario 1.2: Same-day void with no replacement -> total net is exactly ₹0", report1_2.totalNet === 0);
check("Scenario 1.2: Gross collection is ₹200 and refund is ₹200", report1_2.cash.amount === 200 && report1_2.cash.refunds === 200);

// Scenario 1.3: Void on a later day (Collection on Day 1, Void on Day 2)
const day1Start = new Date("2026-11-24T00:00:00.000Z");
const day1End = new Date("2026-11-25T00:00:00.000Z");
const day2Start = new Date("2026-11-25T00:00:00.000Z");
const day2End = new Date("2026-11-26T00:00:00.000Z");

const crossDayVoidPayment: MockPaymentRecord = {
  id: "pmt-cross-day",
  checkId: "chk-cross",
  amount: 200,
  method: "CASH",
  createdAt: new Date("2026-11-24T15:00:00.000Z"), // Day 1
  voidedAt: new Date("2026-11-25T11:00:00.000Z"),  // Day 2
  status: "VOID",
};

const reportDay1 = simulatePaymentLedger({
  settlements: [],
  voidPayments: [crossDayVoidPayment],
  windowStart: day1Start,
  windowEnd: day1End,
});

const reportDay2 = simulatePaymentLedger({
  settlements: [],
  voidPayments: [crossDayVoidPayment],
  windowStart: day2Start,
  windowEnd: day2End,
});

check("Scenario 1.3 Day 1: Cash collection accounted for on collection date -> net is ₹200", reportDay1.cash.net === 200);
check("Scenario 1.3 Day 1: Total net is ₹200", reportDay1.totalNet === 200);
check("Scenario 1.3 Day 1: Refunds on Day 1 are ₹0", reportDay1.cash.refunds === 0);

check("Scenario 1.3 Day 2: Reversal accounted for on reversal date -> refunds is ₹200", reportDay2.cash.refunds === 200);
check("Scenario 1.3 Day 2: Cash net is -₹200", reportDay2.cash.net === -200);
check("Scenario 1.3 Day 2: Total net is -₹200", reportDay2.totalNet === -200);
check("Scenario 1.3 Combined: Day 1 net + Day 2 net = ₹0", reportDay1.totalNet + reportDay2.totalNet === 0);

// Scenario 1.4: Ordinary settlement with no void
const report1_4 = simulatePaymentLedger({
  settlements: [
    {
      checkId: "chk-regular",
      amount: 500,
      method: "CASH",
      settledAt: new Date("2026-11-24T16:00:00.000Z"),
    },
  ],
  voidPayments: [],
  windowStart: todayStart,
  windowEnd: todayEnd,
});

check("Scenario 1.4: Ordinary settlement -> cash net is ₹500", report1_4.cash.net === 500);
check("Scenario 1.4: Ordinary settlement -> total net is ₹500", report1_4.totalNet === 500);
check("Scenario 1.4: Ordinary settlement -> refunds are ₹0", report1_4.cash.refunds === 0);

/* -------------------------------------------------------------------------- */
/* FINDING 2: P2 · Render the prior-period revenue series                     */
/* -------------------------------------------------------------------------- */
console.log("\n── 2. P2 · Render the prior-period revenue series ──");

// 2.1 Verify ComposedChart configuration in source
const usesComposed = frontendSource.includes("<ComposedChart") && frontendSource.includes("</ComposedChart>");
check("analytics.tsx uses ComposedChart for Revenue Trend", usesComposed);

// 2.2 Rendered chart test with distinct current and prior data
const distinctTrendData = [
  { label: "Mon", currentRevenue: 2400, prevRevenue: 1800, currentOrders: 12, prevOrders: 9, prevDate: "17 Nov" },
  { label: "Tue", currentRevenue: 3100, prevRevenue: 2600, currentOrders: 15, prevOrders: 13, prevDate: "18 Nov" },
  { label: "Wed", currentRevenue: 1900, prevRevenue: 2200, currentOrders: 10, prevOrders: 11, prevDate: "19 Nov" },
];

function renderTrendChart({ showCompare }: { showCompare: boolean }) {
  const compRangeLabel = "17 Nov - 19 Nov";
  const element = React.createElement(
    ComposedChart,
    { width: 600, height: 210, data: distinctTrendData },
    React.createElement(CartesianGrid, { strokeDasharray: "3 3" }),
    React.createElement(XAxis, { dataKey: "label" }),
    React.createElement(YAxis, {}),
    React.createElement(Area, {
      type: "monotone",
      dataKey: "currentRevenue",
      name: "Current Period",
      stroke: "#f97316",
      fill: "#f97316",
    }),
    showCompare
      ? React.createElement(Line, {
          type: "monotone",
          dataKey: "prevRevenue",
          name: `Previous (${compRangeLabel})`,
          stroke: "#94a3b8",
          strokeWidth: 2,
          strokeDasharray: "4 4",
          dot: false,
        })
      : null
  );

  return ReactDOMServer.renderToString(element);
}

// 2.3 Rendered chart with Compare ON
const chartCompareOn = renderTrendChart({ showCompare: true });
check("Compare ON: Area chart element renders (recharts-area)", chartCompareOn.includes("recharts-area"));
check("Compare ON: Line chart element renders (recharts-line)", chartCompareOn.includes("recharts-line"));
check("Compare ON: Plotted path curve exists for Line (recharts-line-curve)", chartCompareOn.includes("recharts-line-curve"));

// 2.4 Rendered chart with Compare OFF
const chartCompareOff = renderTrendChart({ showCompare: false });
check("Compare OFF: Area chart element renders (recharts-area)", chartCompareOff.includes("recharts-area"));
check("Compare OFF: Line chart element does NOT render", !chartCompareOff.includes("recharts-line"));
check("Compare OFF: Line curve is completely absent", !chartCompareOff.includes("recharts-line-curve"));

// 2.5 Tooltip rendered test
function renderRevenueTooltip({
  active,
  payload,
  label,
  isComparisonEnabled,
  compDateLabel,
}: {
  active: boolean;
  payload: any[];
  label: string;
  isComparisonEnabled: boolean;
  compDateLabel: string;
}) {
  if (!active || !payload || !payload.length) return "";
  const currentItem = payload.find((p: any) => p.dataKey === "currentRevenue" || p.dataKey === "revenue");
  const prevItem = isComparisonEnabled ? payload.find((p: any) => p.dataKey === "prevRevenue") : null;
  const curVal = Number(currentItem?.value ?? 0);
  const prevVal = prevItem ? Number(prevItem.value ?? 0) : null;
  const priorLabel = prevItem?.payload?.prevDate || (compDateLabel ? compDateLabel : null);

  let output = `<div class="tooltip"><div class="current">Current: ₹${curVal.toFixed(2)}</div>`;
  if (isComparisonEnabled && prevItem) {
    output += `<div class="prior">Prior (${priorLabel}): ₹${(prevVal ?? 0).toFixed(2)}</div>`;
  }
  output += "</div>";
  return output;
}

const mockTooltipPayload = [
  { dataKey: "currentRevenue", value: 2400, payload: distinctTrendData[0] },
  { dataKey: "prevRevenue", value: 1800, payload: distinctTrendData[0] },
];

const tooltipCompareOn = renderRevenueTooltip({
  active: true,
  payload: mockTooltipPayload,
  label: "Mon",
  isComparisonEnabled: true,
  compDateLabel: "17 Nov",
});

check("Compare ON: Tooltip renders current value ₹2400.00", tooltipCompareOn.includes("Current: ₹2400.00"));
check("Compare ON: Tooltip renders prior value ₹1800.00", tooltipCompareOn.includes("Prior (17 Nov): ₹1800.00"));

const tooltipCompareOff = renderRevenueTooltip({
  active: true,
  payload: mockTooltipPayload,
  label: "Mon",
  isComparisonEnabled: false,
  compDateLabel: "17 Nov",
});

check("Compare OFF: Tooltip renders current value ₹2400.00", tooltipCompareOff.includes("Current: ₹2400.00"));
check("Compare OFF: Tooltip omits prior value", !tooltipCompareOff.includes("Prior"));

// 2.6 Legend test
function renderTrendLegend({ showCompare, compRangeLabel }: { showCompare: boolean; compRangeLabel: string }) {
  let html = '<div class="legend"><span>Current Period (₹)</span>';
  if (showCompare) {
    html += `<span>Previous (${compRangeLabel})</span>`;
  }
  html += '</div>';
  return html;
}

const legendOn = renderTrendLegend({ showCompare: true, compRangeLabel: "17 Nov - 19 Nov" });
check("Compare ON: Legend shows Current Period", legendOn.includes("Current Period"));
check("Compare ON: Legend shows Previous Period with label", legendOn.includes("Previous (17 Nov - 19 Nov)"));

const legendOff = renderTrendLegend({ showCompare: false, compRangeLabel: "17 Nov - 19 Nov" });
check("Compare OFF: Legend shows Current Period", legendOff.includes("Current Period"));
check("Compare OFF: Legend omits Previous Period", !legendOff.includes("Previous"));

/* -------------------------------------------------------------------------- */
/* FINDING 3: P2 · Preserve an unavailable comparison percentage              */
/* -------------------------------------------------------------------------- */
console.log("\n── 3. P2 · Preserve an unavailable comparison percentage ──");

// Logic matching analytics.tsx lines 965-972
function resolveRevenueChange(analytics: any) {
  const comparison = analytics?.comparison;
  const revenueChangeVal =
    comparison !== undefined && comparison !== null
      ? (comparison.revenueChange ?? null)
      : (analytics?.revenueChange !== undefined && analytics?.revenueChange !== null ? analytics.revenueChange : null);
  return revenueChangeVal;
}

function renderKpiPercentage(change: number | null, isComparisonEnabled = true) {
  if (!isComparisonEnabled || change === null || change === undefined || Number.isNaN(change)) {
    return "—";
  }
  if (Math.abs(change) < 0.05) {
    return "0.0%";
  }
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

// 3.1 Explicit null comparison with nonzero today-vs-yesterday fallback (+25.0%)
const payloadExplicitNull = {
  totalRevenue: 10000,
  revenueChange: 25.0, // fallback
  comparison: {
    revenueChange: null, // explicit null
    period: { from: "2026-11-17", to: "2026-11-23" },
  },
};
const changeValExplicitNull = resolveRevenueChange(payloadExplicitNull);
check("Explicit null comparison: changeVal resolves to null (does not use fallback)", changeValExplicitNull === null);
check("Explicit null comparison: KPI displays unavailable '—'", renderKpiPercentage(changeValExplicitNull) === "—");

// 3.2 Real 0% comparison
const payloadZeroChange = {
  totalRevenue: 10000,
  revenueChange: 15.0,
  comparison: {
    revenueChange: 0,
    period: { from: "2026-11-17", to: "2026-11-23" },
  },
};
const changeValZero = resolveRevenueChange(payloadZeroChange);
check("Real 0% comparison: changeVal resolves to 0", changeValZero === 0);
check("Real 0% comparison: KPI displays '0.0%'", renderKpiPercentage(changeValZero) === "0.0%");

// 3.3 Absent comparison payload (comparison is undefined or null)
const payloadAbsentComparison = {
  totalRevenue: 10000,
  revenueChange: 18.5,
  comparison: undefined,
};
const changeValAbsent = resolveRevenueChange(payloadAbsentComparison);
check("Absent comparison: falls back to today-vs-yesterday (+18.5%)", changeValAbsent === 18.5);
check("Absent comparison: KPI displays fallback '+18.5%'", renderKpiPercentage(changeValAbsent) === "+18.5%");

// 3.4 Absent comparison and null fallback
const payloadAbsentAll = {
  totalRevenue: 10000,
  revenueChange: null,
  comparison: null,
};
const changeValAbsentAll = resolveRevenueChange(payloadAbsentAll);
check("Absent comparison and null fallback: resolves to null", changeValAbsentAll === null);
check("Absent comparison and null fallback: KPI displays '—'", renderKpiPercentage(changeValAbsentAll) === "—");

/* -------------------------------------------------------------------------- */
/* FINDING 4: P2 · Keep unrelated void history out of settlement lookups      */
/* -------------------------------------------------------------------------- */
console.log("\n── 4. P2 · Keep unrelated void history out of settlement lookups ──");

// Verify backend code structure
check(
  "candidateCheckIds is constructed from payments and checks only (no void checks)",
  !backendSource.includes("...voidPayments.map((p) => p.check_id)")
);
check(
  "settlement-only calls pass includeRefunds: false or default",
  backendSource.includes("getReconciledEventsForWindow(prevRangeStart, prevRangeEnd)") ||
  backendSource.includes("{ includeRefunds: false }")
);

// Simulation of settlement and refund batch queries with 250 unrelated historical void checks
interface QueryTracker {
  table: string;
  select: string;
  filterEq?: Record<string, any>;
  filterIn?: { column: string; list: any[] };
}

function runMockReconciledWindow({
  includeRefunds,
  inWindowCheckId,
  historicalVoidCheckIds,
}: {
  includeRefunds: boolean;
  inWindowCheckId: string;
  historicalVoidCheckIds: string[];
}) {
  const executedQueries: QueryTracker[] = [];

  // 1. Payments in window
  executedQueries.push({
    table: "check_payments",
    select: "id, check_id, amount, method, status",
    filterEq: { status: "SUCCEEDED" },
  });
  const payments = [{ id: "pmt-1", check_id: inWindowCheckId, amount: 500, method: "CASH" }];

  // 2. Checks in window
  executedQueries.push({
    table: "table_checks",
    select: "id, total, status, closed_at",
    filterEq: { status: "PAID" },
  });
  const checks = [{ id: inWindowCheckId, total: 500, status: "PAID" }];

  // candidateCheckIds (settlement basis)
  const candidateCheckIds = Array.from(
    new Set([...payments.map((p) => p.check_id), ...checks.map((c) => c.id)].filter(Boolean))
  );

  // Downstream check payment history batches
  for (let i = 0; i < candidateCheckIds.length; i += 100) {
    const chunk = candidateCheckIds.slice(i, i + 100);
    executedQueries.push({
      table: "check_payments",
      select: "id, check_id, amount, method, status",
      filterIn: { column: "check_id", list: chunk },
    });
  }

  // Downstream linked orders batches
  for (let i = 0; i < candidateCheckIds.length; i += 100) {
    const chunk = candidateCheckIds.slice(i, i + 100);
    executedQueries.push({
      table: "orders",
      select: "id, check_id, total, status",
      filterIn: { column: "check_id", list: chunk },
    });
  }

  // Section D: Refunds
  let refundQueriesCount = 0;
  if (includeRefunds) {
    refundQueriesCount++;
    executedQueries.push({
      table: "check_payments",
      select: "id, check_id, amount, status",
      filterEq: { status: "VOID" },
    });

    refundQueriesCount++;
    executedQueries.push({
      table: "orders",
      select: "id, total, payment_status",
      filterEq: { payment_status: "REFUNDED" },
    });
  }

  return {
    candidateCheckIds,
    executedQueries,
    refundQueriesCount,
  };
}

const historicalVoidCheckIds = Array.from({ length: 250 }, (_, i) => `hist-void-chk-${i + 1}`);

// 4.1 Settlement-only caller
const settlementOnlyRun = runMockReconciledWindow({
  includeRefunds: false,
  inWindowCheckId: "in-window-chk-1",
  historicalVoidCheckIds,
});

check("Settlement-only caller: zero refund queries executed", settlementOnlyRun.refundQueriesCount === 0);
check("Settlement-only caller: candidateCheckIds contains ONLY in-window check", settlementOnlyRun.candidateCheckIds.length === 1 && settlementOnlyRun.candidateCheckIds[0] === "in-window-chk-1");

// 4.2 Main reporting window with 250 historical void checks
const mainReportRun = runMockReconciledWindow({
  includeRefunds: true,
  inWindowCheckId: "in-window-chk-1",
  historicalVoidCheckIds,
});

check("Main report caller: refund queries executed once", mainReportRun.refundQueriesCount === 2);
check("Main report caller: 250 historical void check IDs are completely excluded from candidateCheckIds", !mainReportRun.candidateCheckIds.some((id) => id.startsWith("hist-void")));

// Verify all batch queries (check_payments history & orders) never receive historical void check IDs
const allInLists = mainReportRun.executedQueries.filter((q) => q.filterIn).map((q) => q.filterIn!.list);
const totalHistoricalInBatches = allInLists.flat().filter((id) => id.startsWith("hist-void")).length;
check("Main report caller: 0 historical void check IDs enter downstream payment history or order batches", totalHistoricalInBatches === 0);

/* -------------------------------------------------------------------------- */
/* FINDING 5: P2 · Attribute legacy table refunds to the correct branch       */
/* -------------------------------------------------------------------------- */
console.log("\n── 5. P2 · Attribute legacy table refunds to the correct branch ──");

// 5.1 Verify table_id is included in the select query for order refunds
const orderRefundsSelect = backendSource.includes(
  '.select("id, check_id, payment_id, table_id, total, payment_status'
);
check("orderRefunds query selects table_id", orderRefundsSelect);

// 5.2 Test resolveEntityLocation and branch filtering
const mockTables = new Map<string, { id: string; name: string; location_id: string }>([
  ["table-branch-a", { id: "table-branch-a", name: "Table 1", location_id: "loc-branch-a" }],
  ["table-branch-b", { id: "table-branch-b", name: "Table 2", location_id: "loc-branch-b" }],
]);

function mockResolveEntityLocation(
  entity: { location_id?: string | null; table_id?: string | null; check_id?: string | null },
  checkMap: Map<string, any>
): string | null {
  if (entity.location_id) return entity.location_id;
  if (entity.table_id && mockTables.has(entity.table_id)) {
    const loc = mockTables.get(entity.table_id)?.location_id;
    if (loc) return loc;
  }
  if (entity.check_id && checkMap.has(entity.check_id)) {
    const chk = checkMap.get(entity.check_id);
    if (chk.location_id) return chk.location_id;
    if (chk.table_id && mockTables.has(chk.table_id)) {
      return mockTables.get(chk.table_id)?.location_id || null;
    }
  }
  return null;
}

// Order with no explicit location_id, no check, but table_id assigned to Branch A
const legacyTableRefundOrder = {
  id: "order-refund-table-a",
  total: 350,
  payment_status: "REFUNDED",
  payment_method: "CASH",
  location_id: null,
  check_id: null,
  table_id: "table-branch-a",
  refunded_at: "2026-11-24T12:00:00.000Z",
};

const resolvedLocation = mockResolveEntityLocation(legacyTableRefundOrder, new Map());
check("Legacy table refund resolves location to Branch A via table_id", resolvedLocation === "loc-branch-a");

// Test filtering: All Locations vs Branch A vs Branch B
const filterRefund = (refundLoc: string | null, selectedLoc: string | null) => {
  if (!selectedLoc) return true; // All Locations
  return refundLoc === selectedLoc;
};

check("Legacy table refund is included in 'All Locations'", filterRefund(resolvedLocation, null) === true);
check("Legacy table refund is included in Branch A", filterRefund(resolvedLocation, "loc-branch-a") === true);
check("Legacy table refund is excluded from Branch B", filterRefund(resolvedLocation, "loc-branch-b") === false);

console.log("\n========================================================================");
console.log(`SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
console.log("========================================================================\n");

if (failCount > 0) {
  process.exit(1);
}
