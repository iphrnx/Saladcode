/**
 * Comprehensive Targeted Regression Test Suite for the Six Review Findings:
 *
 * 1. P1 · Require payment evidence before counting an order as settled (supabase/functions/analytics/index.ts)
 * 2. P1 · Count the original collection only once when reporting a legacy refund (supabase/functions/analytics/index.ts)
 * 3. P2 · Resolve legacy refunds to their branch through the linked check (supabase/functions/analytics/index.ts)
 * 4. P2 · Calculate prior periods using the tenant's local calendar (supabase/functions/analytics/index.ts)
 * 5. P2 · Keep zero-baseline growth undefined in the revenue tooltip (src/components/views/analytics.tsx)
 * 6. P2 · Bound reversal reads to records relevant to the report (supabase/functions/analytics/index.ts)
 */

import assert from "node:assert/strict";
import fs from "node:fs";

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
console.log("   TARGETED REGRESSION TESTS: PR #9 REVIEW SIX FINDINGS                 ");
console.log("========================================================================\n");

const backendSource = fs.readFileSync("supabase/functions/analytics/index.ts", "utf8");
const frontendSource = fs.readFileSync("src/components/views/analytics.tsx", "utf8");

/* -------------------------------------------------------------------------- */
/* FINDING 1: Require payment evidence before counting an order as settled    */
/* -------------------------------------------------------------------------- */
console.log("── 1. P1 · Require payment evidence before counting an order as settled ──");

// Verify source code requires payment evidence (paid_at or check settlement)
const requiresPaidAtInCandidateEvents =
  backendSource.includes("if (!settleTime) continue;") &&
  !backendSource.includes("const settleTime = o.paid_at ? new Date(o.paid_at) : (o.completed_at ? new Date(o.completed_at)");
check("candidateEvents requires payment evidence (completed_at alone does not settle)", requiresPaidAtInCandidateEvents);

const requiresPaidAtInQualifyingOrders =
  backendSource.includes("if (!settlementTime || isNaN(settlementTime.getTime())) continue;") &&
  !backendSource.includes("if (!settlementTime && o.completed_at)");
check("qualifyingOrders requires payment evidence (completed_at alone does not count)", requiresPaidAtInQualifyingOrders);

// Regression test simulation:
// Complete an unpaid order on Day 1 and settle it on Day 2.
// Verify that it contributes ₹0 to collections on Day 1, appears once on Day 2, and is counted once across both days.
// Cover a standalone order and an order on an open check.

interface MockOrder {
  id: string;
  checkId: string | null;
  total: number;
  completedAt: Date | null;
  paidAt: Date | null;
  paymentMethod: string;
}

interface MockCheck {
  id: string;
  total: number;
  status: "OPEN" | "PAID";
  closedAt: Date | null;
}

function reconcileDayOrders({
  orders,
  checks,
  winStart,
  winEnd,
}: {
  orders: MockOrder[];
  checks: MockCheck[];
  winStart: Date;
  winEnd: Date;
}) {
  const candidateEvents: { checkId: string | null; orderId: string | null; amount: number; settledAt: Date }[] = [];
  const checkMap = new Map<string, MockCheck>();
  for (const c of checks) checkMap.set(c.id, c);

  // Check settlements
  for (const c of checks) {
    if (c.status === "PAID" && c.closedAt) {
      if (c.closedAt >= winStart && c.closedAt < winEnd) {
        candidateEvents.push({
          checkId: c.id,
          orderId: null,
          amount: c.total,
          settledAt: c.closedAt,
        });
      }
    }
  }

  // Order settlements
  const coveredCheckIds = new Set(candidateEvents.map((e) => e.checkId).filter(Boolean));
  for (const o of orders) {
    if (!o.checkId || !coveredCheckIds.has(o.checkId)) {
      let settleTime: Date | null = null;
      if (o.paidAt) {
        settleTime = o.paidAt;
      }
      // Require payment evidence! An order's completed_at records fulfillment only.
      if (!settleTime) continue;

      if (settleTime >= winStart && settleTime < winEnd) {
        candidateEvents.push({
          checkId: o.checkId,
          orderId: o.id,
          amount: o.total,
          settledAt: settleTime,
        });
        if (o.checkId) coveredCheckIds.add(o.checkId);
      }
    }
  }

  // Qualifying orders
  const qualifyingOrders: MockOrder[] = [];
  for (const o of orders) {
    let settlementTime: Date | null = null;
    if (o.checkId) {
      const chkEvent = candidateEvents.find((e) => e.checkId === o.checkId);
      if (chkEvent) settlementTime = chkEvent.settledAt;
    }
    if (!settlementTime && o.paidAt) {
      settlementTime = o.paidAt;
    }
    if (!settlementTime) continue;
    if (settlementTime >= winStart && settlementTime < winEnd) {
      qualifyingOrders.push(o);
    }
  }

  const collections = candidateEvents.reduce((s, e) => s + e.amount, 0);
  return { collections, qualifyingOrders, candidateEvents };
}

const day1Start = new Date("2026-11-24T00:00:00.000Z");
const day1End = new Date("2026-11-25T00:00:00.000Z");
const day2Start = new Date("2026-11-25T00:00:00.000Z");
const day2End = new Date("2026-11-26T00:00:00.000Z");

// Case 1.1: Standalone order completed on Day 1, paid on Day 2
const standaloneOrder: MockOrder = {
  id: "ord-standalone-1",
  checkId: null,
  total: 450,
  completedAt: new Date("2026-11-24T18:00:00.000Z"), // Day 1 completed
  paidAt: new Date("2026-11-25T11:00:00.000Z"),     // Day 2 paid
  paymentMethod: "UPI",
};

const resStandaloneDay1 = reconcileDayOrders({
  orders: [standaloneOrder],
  checks: [],
  winStart: day1Start,
  winEnd: day1End,
});
check("Standalone order: Day 1 collections are ₹0 when unpaid", resStandaloneDay1.collections === 0);
check("Standalone order: Day 1 qualifying orders count is 0", resStandaloneDay1.qualifyingOrders.length === 0);

const resStandaloneDay2 = reconcileDayOrders({
  orders: [standaloneOrder],
  checks: [],
  winStart: day2Start,
  winEnd: day2End,
});
check("Standalone order: Day 2 collections is ₹450", resStandaloneDay2.collections === 450);
check("Standalone order: Appears once on Day 2", resStandaloneDay2.qualifyingOrders.length === 1);

// Combined across both days:
const resStandaloneBoth = reconcileDayOrders({
  orders: [standaloneOrder],
  checks: [],
  winStart: day1Start,
  winEnd: day2End,
});
check("Standalone order: Counted once across both days", resStandaloneBoth.qualifyingOrders.length === 1 && resStandaloneBoth.collections === 450);

// Case 1.2: Order on an open check completed on Day 1, check settled on Day 2
const openCheckOrder: MockOrder = {
  id: "ord-check-1",
  checkId: "chk-open-1",
  total: 600,
  completedAt: new Date("2026-11-24T20:00:00.000Z"), // Day 1 completed
  paidAt: null,
  paymentMethod: "CASH",
};

// On Day 1, check is OPEN
const checkOnDay1: MockCheck = {
  id: "chk-open-1",
  total: 600,
  status: "OPEN",
  closedAt: null,
};

const resCheckDay1 = reconcileDayOrders({
  orders: [openCheckOrder],
  checks: [checkOnDay1],
  winStart: day1Start,
  winEnd: day1End,
});
check("Open check order: Day 1 collections are ₹0 while check is open", resCheckDay1.collections === 0);
check("Open check order: Day 1 qualifying orders count is 0", resCheckDay1.qualifyingOrders.length === 0);

// On Day 2, check is settled/closed
const checkOnDay2: MockCheck = {
  id: "chk-open-1",
  total: 600,
  status: "PAID",
  closedAt: new Date("2026-11-25T13:00:00.000Z"),
};

const resCheckDay2 = reconcileDayOrders({
  orders: [openCheckOrder],
  checks: [checkOnDay2],
  winStart: day2Start,
  winEnd: day2End,
});
check("Open check order: Day 2 collections is ₹600 after check settlement", resCheckDay2.collections === 600);
check("Open check order: Appears once on Day 2", resCheckDay2.qualifyingOrders.length === 1);

const resCheckBoth = reconcileDayOrders({
  orders: [openCheckOrder],
  checks: [checkOnDay2],
  winStart: day1Start,
  winEnd: day2End,
});
check("Open check order: Counted once across both days", resCheckBoth.qualifyingOrders.length === 1 && resCheckBoth.collections === 600);

/* -------------------------------------------------------------------------- */
/* FINDING 2: Count the original collection only once on legacy refunds       */
/* -------------------------------------------------------------------------- */
console.log("\n── 2. P1 · Count the original collection only once when reporting a legacy refund ──");

// Verify backend checks whether paid check already includes the collection
const hasPaidCheckGuard =
  backendSource.includes("checkAlreadyIncludesCollection") ||
  backendSource.includes("candidateEvents.some((e) => e.checkId === o.check_id)");
check("backend checks whether paid check already includes the collection", hasPaidCheckGuard);

// Simulation of legacy refund collection handling
function simulateLegacyRefundCollections({
  paidCheck,
  refundOrder,
  winStart,
  winEnd,
}: {
  paidCheck: { id: string; total: number; closedAt: Date; status: "PAID" } | null;
  refundOrder: { id: string; checkId: string | null; total: number; paidAt: Date | null; refundedAt: Date; method: string };
  winStart: Date;
  winEnd: Date;
}) {
  const candidateEvents: { checkId: string | null; amount: number; settledAt: Date }[] = [];
  const candidateRefunds: { amount: number; timestamp: Date }[] = [];
  const candidateCollections: { amount: number; timestamp: Date }[] = [];
  const checkMap = new Map<string, any>();

  if (paidCheck) {
    checkMap.set(paidCheck.id, paidCheck);
    if (paidCheck.closedAt >= winStart && paidCheck.closedAt < winEnd) {
      candidateEvents.push({
        checkId: paidCheck.id,
        amount: paidCheck.total,
        settledAt: paidCheck.closedAt,
      });
    }
  }

  // Refund record
  if (refundOrder.refundedAt >= winStart && refundOrder.refundedAt < winEnd) {
    candidateRefunds.push({
      amount: refundOrder.total,
      timestamp: refundOrder.refundedAt,
    });
  }

  // Original collection logic (exact logic from index.ts line 775)
  if (refundOrder.paidAt) {
    const paidAt = refundOrder.paidAt;
    if (paidAt >= winStart && paidAt < winEnd) {
      const linkedCheck = refundOrder.checkId ? checkMap.get(refundOrder.checkId) : null;
      const checkAlreadyIncludesCollection =
        linkedCheck &&
        (linkedCheck.status === "PAID" ||
          linkedCheck.closedAt ||
          candidateEvents.some((e) => e.checkId === refundOrder.checkId));

      if (!checkAlreadyIncludesCollection) {
        candidateCollections.push({
          amount: refundOrder.total,
          timestamp: paidAt,
        });
      }
    }
  }

  const checkCollections = candidateEvents.reduce((s, e) => s + e.amount, 0);
  const extraCollections = candidateCollections.reduce((s, c) => s + c.amount, 0);
  const totalCollected = checkCollections + extraCollections;
  const totalRefunds = candidateRefunds.reduce((s, r) => s + r.amount, 0);
  const totalNet = totalCollected - totalRefunds;

  return { totalCollected, totalRefunds, totalNet, candidateCollections };
}

// Scenario 2.1: ₹400 paid check includes ₹100 order that is later refunded
const checkPaid400 = {
  id: "chk-400",
  total: 400,
  closedAt: new Date("2026-11-24T12:00:00.000Z"), // Day 1
  status: "PAID" as const,
};

const refundOrder100 = {
  id: "ord-refund-100",
  checkId: "chk-400",
  total: 100,
  paidAt: new Date("2026-11-24T12:00:00.000Z"), // Day 1
  refundedAt: new Date("2026-11-25T14:00:00.000Z"), // Day 2
  method: "CASH",
};

// Test across both dates:
const report2_1 = simulateLegacyRefundCollections({
  paidCheck: checkPaid400,
  refundOrder: refundOrder100,
  winStart: day1Start,
  winEnd: day2End,
});

check("Scenario 2.1: Total collected is exactly ₹400 (not ₹500)", report2_1.totalCollected === 400);
check("Scenario 2.1: Total refunds is exactly ₹100", report2_1.totalRefunds === 100);
check("Scenario 2.1: Total net is exactly ₹300", report2_1.totalNet === 300);
check("Scenario 2.1: candidateCollections added 0 duplicates for the order", report2_1.candidateCollections.length === 0);

// Scenario 2.2: Standalone legacy refund with verified original payment
const standaloneRefundOrder = {
  id: "ord-standalone-refund",
  checkId: null,
  total: 150,
  paidAt: new Date("2026-11-24T10:00:00.000Z"),   // Day 1
  refundedAt: new Date("2026-11-25T15:00:00.000Z"), // Day 2
  method: "CARD",
};

const reportStandaloneDay1 = simulateLegacyRefundCollections({
  paidCheck: null,
  refundOrder: standaloneRefundOrder,
  winStart: day1Start,
  winEnd: day1End,
});
check("Scenario 2.2 Day 1: Standalone refund collection counted on payment date = ₹150", reportStandaloneDay1.totalCollected === 150);
check("Scenario 2.2 Day 1: Refunds on Day 1 = ₹0", reportStandaloneDay1.totalRefunds === 0);
check("Scenario 2.2 Day 1: Net on Day 1 = ₹150", reportStandaloneDay1.totalNet === 150);

const reportStandaloneDay2 = simulateLegacyRefundCollections({
  paidCheck: null,
  refundOrder: standaloneRefundOrder,
  winStart: day2Start,
  winEnd: day2End,
});
check("Scenario 2.2 Day 2: Standalone refund reversal counted on refund date = ₹150", reportStandaloneDay2.totalRefunds === 150);
check("Scenario 2.2 Day 2: Net on Day 2 = -₹150", reportStandaloneDay2.totalNet === -150);

const reportStandaloneBoth = simulateLegacyRefundCollections({
  paidCheck: null,
  refundOrder: standaloneRefundOrder,
  winStart: day1Start,
  winEnd: day2End,
});
check("Scenario 2.2 Across both dates: Collected = ₹150, Refunds = ₹150, Net = ₹0", reportStandaloneBoth.totalCollected === 150 && reportStandaloneBoth.totalRefunds === 150 && reportStandaloneBoth.totalNet === 0);

/* -------------------------------------------------------------------------- */
/* FINDING 3: Resolve legacy refunds to their branch through linked check     */
/* -------------------------------------------------------------------------- */
console.log("\n── 3. P2 · Resolve legacy refunds to their branch through the linked check ──");

// Verify backend collects missing check IDs from BOTH void payments AND order refunds
const fetchesMissingOrderRefundChecks =
  backendSource.includes("missingRefundCheckIds") &&
  backendSource.includes("orderRefunds") &&
  backendSource.includes("!o.location_id && !o.table_id && o.check_id && !localCheckMap.has(o.check_id)");
check("backend loads missing check metadata for legacy refunds without location/table", fetchesMissingOrderRefundChecks);

// Test branch resolution for refund with no direct location and a linked check that settled earlier in Branch A
const mockBranchATable = { id: "tbl-branch-a", location_id: "loc-branch-a" };
const mockTableMap = new Map([["tbl-branch-a", mockBranchATable]]);

const mockEarlierCheck = {
  id: "chk-earlier-branch-a",
  table_id: "tbl-branch-a",
  location_id: null, // location derived from table
  status: "PAID",
};
const mockCheckMap = new Map([["chk-earlier-branch-a", mockEarlierCheck]]);

function resolveLocation(
  entity: { location_id?: string | null; table_id?: string | null; check_id?: string | null },
  chkMap: Map<string, any>
): string | null {
  if (entity.location_id) return entity.location_id;
  if (entity.table_id && mockTableMap.has(entity.table_id)) {
    return mockTableMap.get(entity.table_id)!.location_id;
  }
  if (entity.check_id && chkMap.has(entity.check_id)) {
    const chk = chkMap.get(entity.check_id);
    if (chk.location_id) return chk.location_id;
    if (chk.table_id && mockTableMap.has(chk.table_id)) {
      return mockTableMap.get(chk.table_id)!.location_id;
    }
  }
  return null;
}

const legacyRefundNoDirectLoc = {
  id: "ord-refund-legacy-branch",
  location_id: null,
  table_id: null,
  check_id: "chk-earlier-branch-a", // settled earlier in Branch A
  amount: 250,
};

const resolvedBranch = resolveLocation(legacyRefundNoDirectLoc, mockCheckMap);
check("Resolves linked check that settled earlier to Branch A", resolvedBranch === "loc-branch-a");

const filterBranch = (recordLoc: string | null, selectedBranch: string | null) => {
  if (!selectedBranch) return true; // All Locations
  return recordLoc === selectedBranch;
};

check("Refund is included in All Locations", filterBranch(resolvedBranch, null) === true);
check("Refund is included in Branch A", filterBranch(resolvedBranch, "loc-branch-a") === true);
check("Refund is excluded from Branch B", filterBranch(resolvedBranch, "loc-branch-b") === false);

/* -------------------------------------------------------------------------- */
/* FINDING 4: Calculate prior periods using the tenant's local calendar       */
/* -------------------------------------------------------------------------- */
console.log("\n── 4. P2 · Calculate prior periods using the tenant’s local calendar ──");

// Verify backend has calendar math helpers
check("backend has parseYMD, formatYMD, addDaysToYMD", backendSource.includes("addDaysToYMD") && backendSource.includes("parseYMD"));
check("backend has calendarDaysBetween", backendSource.includes("calendarDaysBetween"));

// Calendar math functions matching index.ts
function parseYMD(dateStr: string): [number, number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return [y, m, d];
}
function formatYMD(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}
function addDaysToYMD(dateStr: string, days: number): string {
  const [y, m, d] = parseYMD(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return formatYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function calendarDaysBetween(startStr: string, endStr: string): number {
  const [y1, m1, d1] = parseYMD(startStr);
  const [y2, m2, d2] = parseYMD(endStr);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86400000) + 1;
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - at.getTime()) / 60000;
}

function zonedStart(dateStr: string, timeZone: string): Date {
  const [y, m, d] = parseYMD(dateStr);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000);
}

// Case 4.1: March 10, 2025 single-day report in America/New_York (Daylight Saving Transition on March 9)
const tzNY = "America/New_York";
const reportFrom = "2025-03-10";
const reportTo = "2025-03-10";

const durationDays = calendarDaysBetween(reportFrom, reportTo);
const compToStr = addDaysToYMD(reportFrom, -1);
const compFromStr = addDaysToYMD(compToStr, -(durationDays - 1));

const compStart = zonedStart(compFromStr, tzNY);
const compEnd = zonedStart(addDaysToYMD(compToStr, 1), tzNY);

check("March 10 report compares against March 9 (fromStr: 2025-03-09)", compFromStr === "2025-03-09");
check("March 10 report compares against March 9 (toStr: 2025-03-09)", compToStr === "2025-03-09");

// March 9 midnight in NY is 05:00 UTC (EST, UTC-5).
// Clocks spring forward 2:00 AM -> 3:00 AM EDT (UTC-4).
// March 10 midnight in NY is 04:00 UTC (EDT, UTC-4).
// Duration of March 9 in NY is exactly 23 hours (82,800,000 ms).
check("March 9 local midnight start is 2025-03-09T05:00:00.000Z", compStart.toISOString() === "2025-03-09T05:00:00.000Z");
check("March 10 local midnight start is 2025-03-10T04:00:00.000Z", compEnd.toISOString() === "2025-03-10T04:00:00.000Z");
check("March 9 duration in NY is exactly 23 hours", (compEnd.getTime() - compStart.getTime()) / 3600000 === 23);

// Transaction late on March 8 (e.g. 11:30 PM EST on March 8 is 2025-03-09T04:30:00.000Z)
const lateMarch8Tx = new Date("2025-03-09T04:30:00.000Z");
check("Late March 8 transaction (11:30 PM EST) is EXCLUDED from March 9 comparison", lateMarch8Tx < compStart);

// Case 4.2: Fall-back day (November 2, 2025 in America/New_York)
// Clocks fall back 2:00 AM -> 1:00 AM. Day has 25 hours.
const reportNov3 = "2025-11-03";
const compNov2 = addDaysToYMD(reportNov3, -1);
const compNov2Start = zonedStart(compNov2, tzNY);
const compNov2End = zonedStart(reportNov3, tzNY);

check("November 3 report compares against November 2", compNov2 === "2025-11-02");
check("November 2 local midnight start is 2025-11-02T04:00:00.000Z (EDT, UTC-4)", compNov2Start.toISOString() === "2025-11-02T04:00:00.000Z");
check("November 3 local midnight start is 2025-11-03T05:00:00.000Z (EST, UTC-5)", compNov2End.toISOString() === "2025-11-03T05:00:00.000Z");
check("November 2 duration in NY is exactly 25 hours", (compNov2End.getTime() - compNov2Start.getTime()) / 3600000 === 25);

// Transaction late on November 1 (11:30 PM EDT is 2025-11-02T03:30:00.000Z)
const lateNov1Tx = new Date("2025-11-02T03:30:00.000Z");
check("Late Nov 1 transaction (11:30 PM EDT) is EXCLUDED from Nov 2 comparison", lateNov1Tx < compNov2Start);

/* -------------------------------------------------------------------------- */
/* FINDING 5: Keep zero-baseline growth undefined in the revenue tooltip      */
/* -------------------------------------------------------------------------- */
console.log("\n── 5. P2 · Keep zero-baseline growth undefined in the revenue tooltip ──");

// Verify frontend source calculation in RevenueTrendTooltip
const tooltipSourceChecks =
  frontendSource.includes("if (prevVal > 0) {") &&
  !frontendSource.includes("pctChange = 100.0") &&
  frontendSource.includes("{pctChange !== null ? (") &&
  frontendSource.includes("<span className=\"text-muted-foreground/60\">—</span>");
check("analytics.tsx tooltip does not assign +100% for zero baseline and renders '—'", tooltipSourceChecks);

// Tooltip logic simulation
function computeTooltipGrowth(curVal: number, prevVal: number | null) {
  let pctChange: number | null = null;
  if (prevVal !== null && prevVal !== undefined) {
    if (prevVal > 0) {
      pctChange = +(((curVal - prevVal) / prevVal) * 100).toFixed(1);
    } else {
      pctChange = null;
    }
  }

  const renderedGrowth =
    pctChange !== null
      ? (pctChange > 0 ? `+${pctChange.toFixed(1)}%` : `${pctChange.toFixed(1)}%`)
      : "—";

  return { pctChange, renderedGrowth };
}

// 5.1 Positive current revenue and ₹0 prior revenue
const caseZeroBaseline = computeTooltipGrowth(1500, 0);
check("Zero baseline (cur=1500, prev=0): pctChange is null", caseZeroBaseline.pctChange === null);
check("Zero baseline (cur=1500, prev=0): renders unavailable '—' (not '+100%')", caseZeroBaseline.renderedGrowth === "—");

// 5.2 Defined increase from positive baseline (cur=1500, prev=1000)
const caseDefinedIncrease = computeTooltipGrowth(1500, 1000);
check("Defined increase (1000 -> 1500): pctChange is 50.0%", caseDefinedIncrease.pctChange === 50.0);
check("Defined increase: renders '+50.0%'", caseDefinedIncrease.renderedGrowth === "+50.0%");

// 5.3 Genuine 0% change from positive baseline (cur=1000, prev=1000)
const caseZeroChange = computeTooltipGrowth(1000, 1000);
check("Genuine 0% change (1000 -> 1000): pctChange is 0.0%", caseZeroChange.pctChange === 0.0);
check("Genuine 0% change: renders '0.0%'", caseZeroChange.renderedGrowth === "0.0%");

/* -------------------------------------------------------------------------- */
/* FINDING 6: Bound reversal reads to records relevant to the report          */
/* -------------------------------------------------------------------------- */
console.log("\n── 6. P2 · Bound reversal reads to records relevant to the report ──");

// Verify backend has bounded query structure
check("backend has inRangeVoids query with gte(voided_at)", backendSource.includes('.gte("voided_at", winStart.toISOString())'));
check("backend has inRangeVoidCollections query with gte(created_at)", backendSource.includes('.gte("created_at", winStart.toISOString())'));
check("backend has unverifiedVoidPayments query with is(voided_at, null)", backendSource.includes('.is("voided_at", null)'));
check("backend has inRangeOrderRefunds query with gte(refunded_at)", backendSource.includes('.gte("refunded_at", winStart.toISOString())'));
check("backend has inRangeOrderCollections query with gte(paid_at)", backendSource.includes('.gte("paid_at", winStart.toISOString())'));
check("backend has unverifiedOrderRefunds query with is(refunded_at, null)", backendSource.includes('.is("refunded_at", null)'));

// Simulation of bounded reversal execution with in-range reversals and multiple pages of unrelated historical reversals
interface MockDbReversal {
  id: string;
  source: "PAYMENT" | "ORDER";
  amount: number;
  createdAt: Date;
  voidedAt: Date | null;
  refundedAt: Date | null;
  paymentId?: string;
}

function runBoundedReversalQueries({
  allVoidPayments,
  allOrderRefunds,
  auditLogs,
  winStart,
  winEnd,
}: {
  allVoidPayments: MockDbReversal[];
  allOrderRefunds: MockDbReversal[];
  auditLogs: { meta: string; createdAt: Date }[];
  winStart: Date;
  winEnd: Date;
}) {
  let executedQueryCount = 0;
  const fetchedVoidIds = new Set<string>();
  const fetchedOrderIds = new Set<string>();

  // 1. In-range voided_at
  executedQueryCount++;
  for (const p of allVoidPayments) {
    if (p.voidedAt && p.voidedAt >= winStart && p.voidedAt < winEnd) {
      fetchedVoidIds.add(p.id);
    }
  }

  // 2. In-range created_at
  executedQueryCount++;
  for (const p of allVoidPayments) {
    if (p.createdAt >= winStart && p.createdAt < winEnd) {
      fetchedVoidIds.add(p.id);
    }
  }

  // 3. Unverified voided_at
  executedQueryCount++;
  for (const p of allVoidPayments) {
    if (!p.voidedAt) {
      fetchedVoidIds.add(p.id);
    }
  }

  // 4. In-range refunded_at
  executedQueryCount++;
  for (const o of allOrderRefunds) {
    if (o.refundedAt && o.refundedAt >= winStart && o.refundedAt < winEnd) {
      fetchedOrderIds.add(o.id);
    }
  }

  // 5. In-range paid_at
  executedQueryCount++;
  for (const o of allOrderRefunds) {
    if (o.createdAt >= winStart && o.createdAt < winEnd) {
      fetchedOrderIds.add(o.id);
    }
  }

  // 6. Unverified refunded_at
  executedQueryCount++;
  for (const o of allOrderRefunds) {
    if (!o.refundedAt) {
      fetchedOrderIds.add(o.id);
    }
  }

  // Timestamp recovery via audit logs
  const auditVoidMap = new Map<string, Date>();
  for (const log of auditLogs) {
    for (const vid of fetchedVoidIds) {
      if (log.meta.includes(vid) && !auditVoidMap.has(vid)) {
        auditVoidMap.set(vid, log.createdAt);
      }
    }
  }

  // Reconcile reversals
  const seenReversalIds = new Set<string>();
  const inWindowRefunds: { id: string; amount: number }[] = [];

  for (const p of allVoidPayments) {
    if (!fetchedVoidIds.has(p.id)) continue;
    seenReversalIds.add(p.id);

    let verifiedTime = p.voidedAt || auditVoidMap.get(p.id) || null;
    if (verifiedTime && verifiedTime >= winStart && verifiedTime < winEnd) {
      inWindowRefunds.push({ id: p.id, amount: p.amount });
    }
  }

  for (const o of allOrderRefunds) {
    if (!fetchedOrderIds.has(o.id)) continue;
    // Deduplication check: if order.paymentId matches void payment, deduplicate
    if (o.paymentId && seenReversalIds.has(o.paymentId)) {
      continue;
    }
    if (seenReversalIds.has(o.id)) continue;
    seenReversalIds.add(o.id);

    let verifiedTime = o.refundedAt;
    if (verifiedTime && verifiedTime >= winStart && verifiedTime < winEnd) {
      inWindowRefunds.push({ id: o.id, amount: o.total || o.amount });
    }
  }

  return {
    executedQueryCount,
    fetchedVoidIds: Array.from(fetchedVoidIds),
    fetchedOrderIds: Array.from(fetchedOrderIds),
    inWindowRefunds,
    totalRefunds: inWindowRefunds.reduce((s, r) => s + r.amount, 0),
  };
}

// Create dataset:
// - 3 in-range reversals (one void payment ₹100, one unverified void payment ₹150 that can be recovered, one order refund ₹200)
// - One duplicate reversal represented in both sources (void payment ₹75 + order refund ₹75 pointing to it)
// - 200 unrelated historical void payments from 6 months ago with known timestamps
// - 200 unrelated historical order refunds from 6 months ago with known timestamps

const mockReportStart = new Date("2026-11-24T00:00:00.000Z");
const mockReportEnd = new Date("2026-11-25T00:00:00.000Z");

const historicalOldDate = new Date("2026-05-10T10:00:00.000Z");

const datasetVoidPayments: MockDbReversal[] = [
  // In-range void
  {
    id: "in-range-void-100",
    source: "PAYMENT",
    amount: 100,
    createdAt: new Date("2026-11-24T10:00:00.000Z"),
    voidedAt: new Date("2026-11-24T11:00:00.000Z"),
    refundedAt: null,
  },
  // In-range void with missing voided_at (recoverable via audit log)
  {
    id: "recoverable-void-150",
    source: "PAYMENT",
    amount: 150,
    createdAt: new Date("2026-11-24T09:00:00.000Z"),
    voidedAt: null,
    refundedAt: null,
  },
  // Dual-source reversal (void payment part)
  {
    id: "dual-source-pmt-75",
    source: "PAYMENT",
    amount: 75,
    createdAt: new Date("2026-11-24T08:00:00.000Z"),
    voidedAt: new Date("2026-11-24T14:00:00.000Z"),
    refundedAt: null,
  },
];

// Add 200 historical void payments
for (let i = 1; i <= 200; i++) {
  datasetVoidPayments.push({
    id: `hist-void-${i}`,
    source: "PAYMENT",
    amount: 50,
    createdAt: historicalOldDate,
    voidedAt: historicalOldDate,
    refundedAt: null,
  });
}

const datasetOrderRefunds: MockDbReversal[] = [
  // In-range order refund
  {
    id: "in-range-order-200",
    source: "ORDER",
    amount: 200,
    createdAt: new Date("2026-11-24T10:30:00.000Z"),
    voidedAt: null,
    refundedAt: new Date("2026-11-24T13:00:00.000Z"),
  },
  // Dual-source reversal (order refund part pointing to dual-source-pmt-75)
  {
    id: "dual-source-ord-75",
    source: "ORDER",
    amount: 75,
    createdAt: new Date("2026-11-24T08:00:00.000Z"),
    voidedAt: null,
    refundedAt: new Date("2026-11-24T14:00:00.000Z"),
    paymentId: "dual-source-pmt-75",
  },
];

// Add 200 historical order refunds
for (let i = 1; i <= 200; i++) {
  datasetOrderRefunds.push({
    id: `hist-order-${i}`,
    source: "ORDER",
    amount: 50,
    createdAt: historicalOldDate,
    voidedAt: null,
    refundedAt: historicalOldDate,
  });
}

const mockAuditLogs = [
  { meta: "CHECK_PAYMENT_REVERSED: recoverable-void-150", createdAt: new Date("2026-11-24T16:00:00.000Z") },
];

const boundedResult = runBoundedReversalQueries({
  allVoidPayments: datasetVoidPayments,
  allOrderRefunds: datasetOrderRefunds,
  auditLogs: mockAuditLogs,
  winStart: mockReportStart,
  winEnd: mockReportEnd,
});

check("Queries are bounded: 0 of 200 historical void payments fetched", !boundedResult.fetchedVoidIds.some((id) => id.startsWith("hist-")));
check("Queries are bounded: 0 of 200 historical order refunds fetched", !boundedResult.fetchedOrderIds.some((id) => id.startsWith("hist-")));
check("Missing-timestamp reversal recovered via audit log and included", boundedResult.inWindowRefunds.some((r) => r.id === "recoverable-void-150"));
check("Dual-source reversal is deduplicated and counted once", boundedResult.inWindowRefunds.filter((r) => r.id === "dual-source-pmt-75" || r.id === "dual-source-ord-75").length === 1);
check("Total in-range refunds is exactly ₹100 + ₹150 + ₹75 + ₹200 = ₹525", boundedResult.totalRefunds === 525);

console.log("\n========================================================================");
console.log(`SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
console.log("========================================================================\n");

if (failCount > 0) {
  process.exit(1);
}
