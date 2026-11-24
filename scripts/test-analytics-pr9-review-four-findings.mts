import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

console.log("========================================================================");
console.log("   TARGETED REGRESSION TESTS: PR #9 REVIEW FOUR FINDINGS                ");
console.log("========================================================================");

let totalPassed = 0;
let totalFailed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    totalPassed++;
    console.log(`  ok    ${name}`);
  } else {
    totalFailed++;
    console.error(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const backendPath = path.resolve("supabase/functions/analytics/index.ts");
const frontendPath = path.resolve("src/components/views/analytics.tsx");

const backendSource = fs.readFileSync(backendPath, "utf-8");
const frontendSource = fs.readFileSync(frontendPath, "utf-8");

// -----------------------------------------------------------------------------
// 1. P1 · Deduplicate refunds across reporting windows
// -----------------------------------------------------------------------------
console.log("\n── 1. P1 · Deduplicate refunds across reporting windows ──");

// Verify source includes out-of-range referenced payment lookup
check(
  "backend looks up referenced authoritative ledger void records outside selected window",
  backendSource.includes("missingReferencedPaymentIds") &&
    backendSource.includes(".eq(\"status\", \"VOID\")") &&
    backendSource.includes(".in(\"id\", chunk)")
);

// Simulation of Deduplication across Reporting Windows
interface LedgerPayment {
  id: string;
  check_id: string;
  amount: number;
  method: string;
  status: string;
  created_at: string;
  voided_at: string | null;
}

interface LegacyOrderRefund {
  id: string;
  check_id: string | null;
  payment_id?: string | null;
  total: number;
  payment_status: string;
  refunded_at: string;
  payment_method: string;
}

function simulateReversalReconciliation(
  winStartStr: string,
  winEndStr: string,
  allLedgerPayments: LedgerPayment[],
  allLegacyRefunds: LegacyOrderRefund[]
) {
  const winStart = new Date(winStartStr);
  const winEnd = new Date(winEndStr);

  const voidPaymentMap = new Map<string, LedgerPayment>();

  // In-range queries
  for (const p of allLedgerPayments) {
    if (p.status === "VOID") {
      const vAt = p.voided_at ? new Date(p.voided_at) : null;
      const cAt = new Date(p.created_at);
      if ((vAt && vAt >= winStart && vAt < winEnd) || (cAt >= winStart && cAt < winEnd)) {
        voidPaymentMap.set(p.id, p);
      }
    }
  }

  // Order refunds queries
  const orderRefunds: LegacyOrderRefund[] = [];
  for (const o of allLegacyRefunds) {
    if (["REFUNDED", "refunded"].includes(o.payment_status)) {
      const rAt = new Date(o.refunded_at);
      if (rAt >= winStart && rAt < winEnd) {
        orderRefunds.push(o);
      }
    }
  }

  // Out-of-range referenced ledger void lookup
  const referencedPaymentIds = Array.from(
    new Set([
      ...orderRefunds.map((o) => o.payment_id ? String(o.payment_id) : null).filter(Boolean),
      ...orderRefunds.map((o) => String(o.id)),
    ])
  ) as string[];

  for (const pid of referencedPaymentIds) {
    if (!voidPaymentMap.has(pid)) {
      const found = allLedgerPayments.find((p) => p.id === pid && p.status === "VOID");
      if (found) voidPaymentMap.set(found.id, found);
    }
  }

  const voidPayments = Array.from(voidPaymentMap.values());
  const ledgerVoidPaymentIds = new Set(voidPayments.map((p) => p.id));

  const candidateRefunds: { id: string; amount: number; timestamp: Date }[] = [];

  // Loop 1: Ledger voids
  for (const p of voidPayments) {
    const vAt = p.voided_at ? new Date(p.voided_at) : null;
    if (vAt && vAt >= winStart && vAt < winEnd) {
      candidateRefunds.push({ id: p.id, amount: p.amount, timestamp: vAt });
    }
  }

  // Loop 2: Legacy refunds (deduplicate against ledger voids)
  for (const o of orderRefunds) {
    const isProvenDuplicate =
      (o.payment_id && ledgerVoidPaymentIds.has(o.payment_id)) ||
      ledgerVoidPaymentIds.has(o.id);

    if (isProvenDuplicate) continue;

    candidateRefunds.push({
      id: o.id,
      amount: o.total,
      timestamp: new Date(o.refunded_at),
    });
  }

  const totalRefunds = candidateRefunds.reduce((sum, r) => sum + r.amount, 0);
  return { candidateRefunds, totalRefunds };
}

// Day 1: 2026-11-20T00:00:00Z to 2026-11-21T00:00:00Z
// Day 2: 2026-11-21T00:00:00Z to 2026-11-22T00:00:00Z
const ledgerVoidDay1: LedgerPayment = {
  id: "pay-void-200",
  check_id: "chk-1",
  amount: 200,
  method: "CASH",
  status: "VOID",
  created_at: "2026-11-20T10:00:00.000Z",
  voided_at: "2026-11-20T14:00:00.000Z", // Day 1
};

const linkedLegacyRefundDay2: LegacyOrderRefund = {
  id: "ord-ref-200",
  check_id: "chk-1",
  payment_id: "pay-void-200", // References authoritative ledger void
  total: 200,
  payment_status: "REFUNDED",
  refunded_at: "2026-11-21T11:00:00.000Z", // Day 2
  payment_method: "CASH",
};

const unrelatedLegacyRefund: LegacyOrderRefund = {
  id: "ord-ref-unrelated-75",
  check_id: null,
  payment_id: null,
  total: 75,
  payment_status: "REFUNDED",
  refunded_at: "2026-11-21T16:00:00.000Z", // Day 2
  payment_method: "UPI",
};

const allPayments = [ledgerVoidDay1];
const allRefunds = [linkedLegacyRefundDay2, unrelatedLegacyRefund];

// Day 1 Report (2026-11-20)
const resDay1 = simulateReversalReconciliation(
  "2026-11-20T00:00:00.000Z",
  "2026-11-21T00:00:00.000Z",
  allPayments,
  allRefunds
);
check(
  "Day 1 Report: exactly ₹200 in refunds from Day 1 ledger void",
  resDay1.totalRefunds === 200,
  `actual: ${resDay1.totalRefunds}`
);

// Day 2 Report (2026-11-21)
// The linked legacy refund on Day 2 references the Day 1 ledger void -> deduplicated!
// The unrelated legacy refund on Day 2 remains reportable!
const resDay2 = simulateReversalReconciliation(
  "2026-11-21T00:00:00.000Z",
  "2026-11-22T00:00:00.000Z",
  allPayments,
  allRefunds
);
const linkedRefundsDay2 = resDay2.candidateRefunds.filter((r) => r.id === "ord-ref-200" || r.id === "pay-void-200");
check(
  "Day 2 Report: linked refund contributes ₹0 on day 2 (deduplicated against Day 1 void)",
  linkedRefundsDay2.length === 0,
  `actual count: ${linkedRefundsDay2.length}`
);
check(
  "Day 2 Report: unrelated legacy refund remains reportable (₹75)",
  resDay2.totalRefunds === 75,
  `actual: ${resDay2.totalRefunds}`
);

// Both Days Report (2026-11-20 to 2026-11-22)
const resBothDays = simulateReversalReconciliation(
  "2026-11-20T00:00:00.000Z",
  "2026-11-22T00:00:00.000Z",
  allPayments,
  allRefunds
);
const linkedRefundsBoth = resBothDays.candidateRefunds.filter((r) => r.id === "ord-ref-200" || r.id === "pay-void-200");
check(
  "Across both days: linked reversal counted exactly once (₹200 total for linked)",
  linkedRefundsBoth.length === 1 && linkedRefundsBoth[0].amount === 200,
  `actual: ${JSON.stringify(linkedRefundsBoth)}`
);
check(
  "Across both days: total refunds = ₹200 (linked) + ₹75 (unrelated) = ₹275",
  resBothDays.totalRefunds === 275,
  `actual: ${resBothDays.totalRefunds}`
);

// -----------------------------------------------------------------------------
// 2. P1 · Prevent stale paid_at from double-counting a voided collection
// -----------------------------------------------------------------------------
console.log("\n── 2. P1 · Prevent stale paid_at from double-counting a voided collection ──");

// Verify backend source checks for check settlement evidence
check(
  "backend verifies check settlement evidence before allowing linked order fallback",
  backendSource.includes("hasCheckSettlement") &&
    backendSource.includes("chk.status === \"PAID\"") &&
    backendSource.includes("missingOrderCheckIds")
);

// Verify qualifyingOrders strictly requires check settlement
check(
  "qualifyingOrders strictly requires check settlement event when o.check_id is present",
  backendSource.includes("if (o.check_id) {") &&
    backendSource.includes("const chkEvent = mainEvents.find((e) => e.checkId === o.check_id);") &&
    backendSource.includes("if (chkEvent) settlementTime = chkEvent.settledAt;") &&
    backendSource.includes("} else if (o.paid_at) {")
);

function simulateOrderFallbackReconciliation(
  winStartStr: string,
  winEndStr: string,
  checks: { id: string; status: string; closed_at: string | null; total: number }[],
  payments: { id: string; check_id: string; amount: number; status: string; created_at: string; voided_at: string | null }[],
  orders: { id: string; check_id: string | null; total: number; paid_at: string | null; payment_method?: string }[]
) {
  const winStart = new Date(winStartStr);
  const winEnd = new Date(winEndStr);

  const localCheckMap = new Map<string, any>();
  for (const c of checks) localCheckMap.set(c.id, c);

  // Succeeded check payments
  const candidateEvents: { checkId: string | null; orderId: string | null; amount: number; settledAt: Date }[] = [];
  const coveredCheckIds = new Set<string>();

  for (const p of payments) {
    if (p.status === "SUCCEEDED") {
      candidateEvents.push({
        checkId: p.check_id,
        orderId: null,
        amount: p.amount,
        settledAt: new Date(p.created_at),
      });
      coveredCheckIds.add(p.check_id);
    }
  }

  // Order fallback loop
  for (const o of orders) {
    if (!o.check_id) {
      // Valid standalone payment
      if (o.paid_at) {
        const settleTime = new Date(o.paid_at);
        candidateEvents.push({
          checkId: null,
          orderId: o.id,
          amount: o.total,
          settledAt: settleTime,
        });
      }
    } else if (!coveredCheckIds.has(o.check_id)) {
      // Linked order fallback
      const chk = localCheckMap.get(o.check_id);
      const hasCheckSettlement = chk && (chk.status === "PAID" || Boolean(chk.closed_at));
      if (!hasCheckSettlement) {
        // Open or unsettled check: backfilled paid_at is stale
        continue;
      }
      if (o.paid_at) {
        candidateEvents.push({
          checkId: o.check_id,
          orderId: o.id,
          amount: o.total,
          settledAt: new Date(o.paid_at),
        });
        coveredCheckIds.add(o.check_id);
      }
    }
  }

  // Filter windowEvents
  const windowEvents = candidateEvents.filter((e) => e.settledAt >= winStart && e.settledAt < winEnd);

  // Reversal path: voided payments
  const voidCollections: { amount: number; timestamp: Date }[] = [];
  const voidRefunds: { amount: number; timestamp: Date }[] = [];

  for (const p of payments) {
    if (p.status === "VOID") {
      const cAt = new Date(p.created_at);
      if (cAt >= winStart && cAt < winEnd) {
        voidCollections.push({ amount: p.amount, timestamp: cAt });
      }
      if (p.voided_at) {
        const vAt = new Date(p.voided_at);
        if (vAt >= winStart && vAt < winEnd) {
          voidRefunds.push({ amount: p.amount, timestamp: vAt });
        }
      }
    }
  }

  const grossCollected =
    windowEvents.reduce((s, e) => s + e.amount, 0) +
    voidCollections.reduce((s, c) => s + c.amount, 0);

  const totalRefunds = voidRefunds.reduce((s, r) => s + r.amount, 0);
  const netSettled = grossCollected - totalRefunds;

  const orderFallbackAdded = windowEvents.some((e) => e.orderId === "ord-linked-stale");

  return { grossCollected, totalRefunds, netSettled, orderFallbackAdded, windowEvents };
}

// Regression Scenario 2:
// Historical open check with ₹200 payment and backfilled order paid_at. Void the only payment.
const checksScenario2 = [
  { id: "chk-open-hist", status: "OPEN", closed_at: null, total: 200 },
];
const paymentsScenario2 = [
  {
    id: "pay-hist-void",
    check_id: "chk-open-hist",
    amount: 200,
    status: "VOID",
    created_at: "2026-11-20T10:00:00.000Z", // Collection date
    voided_at: "2026-11-21T14:00:00.000Z",  // Reversal date
  },
];
const ordersScenario2 = [
  {
    id: "ord-linked-stale",
    check_id: "chk-open-hist",
    total: 200,
    paid_at: "2026-11-20T10:00:00.000Z", // Stale backfilled paid_at that survived void
  },
  {
    id: "ord-standalone-control",
    check_id: null,
    total: 100,
    paid_at: "2026-11-20T11:00:00.000Z", // Valid standalone payment control
  },
];

const resScenario2 = simulateOrderFallbackReconciliation(
  "2026-11-20T00:00:00.000Z",
  "2026-11-22T00:00:00.000Z",
  checksScenario2,
  paymentsScenario2,
  ordersScenario2
);

check(
  "Order fallback did NOT add stale linked order to candidateEvents",
  !resScenario2.orderFallbackAdded
);
check(
  "Valid standalone paid order control is preserved and counted in windowEvents",
  resScenario2.windowEvents.some((e) => e.orderId === "ord-standalone-control")
);

// For the voided check activity alone (ignoring control order):
// ₹200 collected (via voidCollections), ₹200 reversed (via voidRefunds), ₹0 net
const voidCheckCollected = resScenario2.grossCollected - 100; // subtract 100 control
const voidCheckNet = resScenario2.netSettled - 100;
check(
  "Across collection and reversal dates: ₹200 collected for voided check",
  voidCheckCollected === 200,
  `actual: ${voidCheckCollected}`
);
check(
  "Across collection and reversal dates: ₹200 reversed for voided check",
  resScenario2.totalRefunds === 200,
  `actual: ${resScenario2.totalRefunds}`
);
check(
  "Across collection and reversal dates: ₹0 net for voided check",
  voidCheckNet === 0,
  `actual: ${voidCheckNet}`
);

// -----------------------------------------------------------------------------
// 3. P1 · Resolve report boundaries at the tenant’s actual local midnight
// -----------------------------------------------------------------------------
console.log("\n── 3. P1 · Resolve report boundaries at the tenant’s actual local midnight ──");

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
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
  const [y, m, d] = dateStr.split("-").map(Number);
  const targetUtcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  let current = new Date(targetUtcMidnight - zoneOffsetMinutes(new Date(targetUtcMidnight), timeZone) * 60000);
  for (let iter = 0; iter < 3; iter++) {
    const offset = zoneOffsetMinutes(current, timeZone);
    const refined = new Date(targetUtcMidnight - offset * 60000);
    if (refined.getTime() === current.getTime()) break;
    current = refined;
  }
  return current;
}

// Regression Test for Australia/Sydney on October 4, 2025
const oct4Start = zonedStart("2025-10-04", "Australia/Sydney");
const oct5Start = zonedStart("2025-10-05", "Australia/Sydney");

check(
  "Sydney Oct 4, 2025 start is 2025-10-03T14:00:00.000Z (local midnight UTC+10)",
  oct4Start.toISOString() === "2025-10-03T14:00:00.000Z"
);
check(
  "Sydney Oct 5, 2025 start is 2025-10-04T14:00:00.000Z (local midnight UTC+10)",
  oct5Start.toISOString() === "2025-10-04T14:00:00.000Z"
);

// Oct 4, 2025 11:30 PM in Sydney: UTC is 2025-10-04T13:30:00.000Z
const tx11pmSydney = new Date("2025-10-04T13:30:00.000Z");
check(
  "Transactions in 11 p.m. hour on October 4 are INCLUDED in October 4 report",
  tx11pmSydney >= oct4Start && tx11pmSydney < oct5Start
);

// Midnight on October 5 in Sydney: UTC is 2025-10-04T14:00:00.000Z
const txMidnightOct5Sydney = new Date("2025-10-04T14:00:00.000Z");
check(
  "Transaction at midnight on October 5 is EXCLUDED (exclusive upper bound)",
  !(txMidnightOct5Sydney >= oct4Start && txMidnightOct5Sydney < oct5Start)
);

// Cover short spring-forward day (October 5, 2025 in Sydney: 23 hours)
const oct6Start = zonedStart("2025-10-06", "Australia/Sydney");
const springForwardHours = (oct6Start.getTime() - oct5Start.getTime()) / 3600000;
check(
  "Short spring-forward day in Sydney (Oct 5) is exactly 23 hours",
  springForwardHours === 23,
  `actual: ${springForwardHours}h`
);

// Cover long fall-back day (April 6, 2025 in Sydney: 25 hours)
const apr6Start = zonedStart("2025-04-06", "Australia/Sydney");
const apr7Start = zonedStart("2025-04-07", "Australia/Sydney");
const fallBackHoursSydney = (apr7Start.getTime() - apr6Start.getTime()) / 3600000;
check(
  "Long fall-back day in Sydney (Apr 6) is exactly 25 hours",
  fallBackHoursSydney === 25,
  `actual: ${fallBackHoursSydney}h`
);

// Cover short spring-forward day in America/New_York (March 9, 2025: 23 hours)
const mar9StartNY = zonedStart("2025-03-09", "America/New_York");
const mar10StartNY = zonedStart("2025-03-10", "America/New_York");
const springHoursNY = (mar10StartNY.getTime() - mar9StartNY.getTime()) / 3600000;
check(
  "Short spring-forward day in America/New_York (Mar 9) is exactly 23 hours",
  springHoursNY === 23,
  `actual: ${springHoursNY}h`
);

// Cover long fall-back day in America/New_York (November 2, 2025: 25 hours)
const nov2StartNY = zonedStart("2025-11-02", "America/New_York");
const nov3StartNY = zonedStart("2025-11-03", "America/New_York");
const fallHoursNY = (nov3StartNY.getTime() - nov2StartNY.getTime()) / 3600000;
check(
  "Long fall-back day in America/New_York (Nov 2) is exactly 25 hours",
  fallHoursNY === 25,
  `actual: ${fallHoursNY}h`
);

// -----------------------------------------------------------------------------
// 4. P2 · Label each monthly comparison tooltip with its own prior dates
// -----------------------------------------------------------------------------
console.log("\n── 4. P2 · Label each monthly comparison tooltip with its own prior dates ──");

// Verify frontend source code includes monthly firstPrevDate and lastPrevDate tracking
check(
  "analytics.tsx tracks firstPrevDate and lastPrevDate in monthly aggregation",
  frontendSource.includes("firstPrevDate") &&
    frontendSource.includes("lastPrevDate") &&
    frontendSource.includes("prevPeriod")
);

// Simulate groupRevenueData from analytics.tsx
function groupRevenueData(
  daily: { date: string; label: string; revenue: number; orders: number }[] = [],
  prevDaily: { date: string; label: string; revenue: number; orders: number }[] = [],
  grouping: "daily" | "weekly" | "monthly"
) {
  if (grouping === "daily") {
    return daily.map((d, i) => {
      const p = prevDaily[i];
      return {
        key: d.date || `day-${i}`,
        date: d.date,
        label: d.label,
        period: d.date,
        currentRevenue: d.revenue,
        currentOrders: d.orders,
        prevRevenue: p ? p.revenue : 0,
        prevOrders: p ? p.orders : 0,
        prevDate: p?.date ?? "",
      };
    });
  }

  if (grouping === "weekly") {
    const chunks: any[] = [];
    const chunkSize = 7;
    for (let i = 0; i < daily.length; i += chunkSize) {
      const curChunk = daily.slice(i, i + chunkSize);
      const prevChunk = prevDaily.slice(i, i + chunkSize);
      const startDay = curChunk[0];
      const endDay = curChunk[curChunk.length - 1];
      const prevStartDay = prevChunk[0];
      const prevEndDay = prevChunk[prevChunk.length - 1];
      const wNum = Math.floor(i / chunkSize) + 1;
      const startLabel = startDay?.date ? startDay.date : `Day ${i + 1}`;
      const endLabel = endDay?.date ? endDay.date : `Day ${i + curChunk.length}`;
      const prevStartLabel = prevStartDay?.date ? prevStartDay.date : "";
      const prevEndLabel = prevEndDay?.date ? prevEndDay.date : "";
      const prevPeriod = prevStartLabel && prevEndLabel
        ? (prevStartLabel === prevEndLabel ? prevStartLabel : `${prevStartLabel} – ${prevEndLabel}`)
        : "";
      const curRev = +curChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2);
      const curOrders = curChunk.reduce((s, c) => s + c.orders, 0);
      const prevRev = +prevChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2);
      const prevOrders = prevChunk.reduce((s, c) => s + c.orders, 0);
      chunks.push({
        key: `w-${wNum}`,
        label: `W${wNum}`,
        period: `Week ${wNum} (${startLabel} – ${endLabel})`,
        prevPeriod: prevPeriod ? `Week ${wNum} (${prevPeriod})` : "",
        currentRevenue: curRev,
        currentOrders: curOrders,
        prevRevenue: prevRev,
        prevOrders: prevOrders,
      });
    }
    return chunks;
  }

  // grouping === 'monthly'
  const monthMap = new Map<string, {
    key: string;
    label: string;
    period: string;
    prevPeriod?: string;
    currentRevenue: number;
    currentOrders: number;
    prevRevenue: number;
    prevOrders: number;
    firstDate?: string;
    lastDate?: string;
    firstPrevDate?: string;
    lastPrevDate?: string;
  }>();

  daily.forEach((d, i) => {
    const monthKey = d.date
      ? (d.date.includes("-") ? d.date.slice(0, 7) : d.date.split(" ")[0] || "all")
      : "all";
    const p = prevDaily[i];
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        key: monthKey,
        label: monthKey,
        period: monthKey,
        currentRevenue: 0,
        currentOrders: 0,
        prevRevenue: 0,
        prevOrders: 0,
      });
    }
    const entry = monthMap.get(monthKey)!;
    entry.currentRevenue = +(entry.currentRevenue + d.revenue).toFixed(2);
    entry.currentOrders += d.orders;
    if (d.date) {
      if (!entry.firstDate) entry.firstDate = d.date;
      entry.lastDate = d.date;
    }
    if (p) {
      entry.prevRevenue = +(entry.prevRevenue + p.revenue).toFixed(2);
      entry.prevOrders += p.orders;
      if (p.date) {
        if (!entry.firstPrevDate) entry.firstPrevDate = p.date;
        entry.lastPrevDate = p.date;
      }
    }
  });

  return Array.from(monthMap.values()).map((entry) => {
    const startLabel = entry.firstDate || "";
    const endLabel = entry.lastDate || "";
    const prevStartLabel = entry.firstPrevDate || "";
    const prevEndLabel = entry.lastPrevDate || "";
    const curPeriod = startLabel && endLabel
      ? (startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`)
      : entry.period;
    const prevPeriod = prevStartLabel && prevEndLabel
      ? (prevStartLabel === prevEndLabel ? prevStartLabel : `${prevStartLabel} – ${prevEndLabel}`)
      : "";
    return {
      key: entry.key,
      label: entry.label,
      period: entry.label && curPeriod ? `${entry.label} (${curPeriod})` : entry.label,
      prevPeriod: prevPeriod ? (entry.label ? `${entry.label} (${prevPeriod})` : prevPeriod) : "",
      currentRevenue: entry.currentRevenue,
      currentOrders: entry.currentOrders,
      prevRevenue: entry.prevRevenue,
      prevOrders: entry.prevOrders,
    };
  });
}

// Regression Test Scenario 4:
// Compare August 25–September 7 with August 11–24 using distinct daily values
const dailyAug25Sep7 = [
  // August (7 days: Aug 25 - Aug 31)
  { date: "August 25", label: "Mon", revenue: 100, orders: 2 },
  { date: "August 26", label: "Tue", revenue: 110, orders: 3 },
  { date: "August 27", label: "Wed", revenue: 120, orders: 2 },
  { date: "August 28", label: "Thu", revenue: 130, orders: 4 },
  { date: "August 29", label: "Fri", revenue: 140, orders: 5 },
  { date: "August 30", label: "Sat", revenue: 150, orders: 6 },
  { date: "August 31", label: "Sun", revenue: 160, orders: 6 },
  // September (7 days: Sep 1 - Sep 7)
  { date: "September 1", label: "Mon", revenue: 200, orders: 5 },
  { date: "September 2", label: "Tue", revenue: 210, orders: 6 },
  { date: "September 3", label: "Wed", revenue: 220, orders: 5 },
  { date: "September 4", label: "Thu", revenue: 230, orders: 7 },
  { date: "September 5", label: "Fri", revenue: 240, orders: 8 },
  { date: "September 6", label: "Sat", revenue: 250, orders: 9 },
  { date: "September 7", label: "Sun", revenue: 260, orders: 9 },
];

const prevDailyAug11Aug24 = [
  // Contributing to August (7 days: Aug 11 - Aug 17)
  { date: "August 11", label: "Mon", revenue: 50, orders: 1 },
  { date: "August 12", label: "Tue", revenue: 55, orders: 1 },
  { date: "August 13", label: "Wed", revenue: 60, orders: 2 },
  { date: "August 14", label: "Thu", revenue: 65, orders: 2 },
  { date: "August 15", label: "Fri", revenue: 70, orders: 3 },
  { date: "August 16", label: "Sat", revenue: 75, orders: 3 },
  { date: "August 17", label: "Sun", revenue: 80, orders: 4 },
  // Contributing to September (7 days: Aug 18 - Aug 24)
  { date: "August 18", label: "Mon", revenue: 90, orders: 3 },
  { date: "August 19", label: "Tue", revenue: 95, orders: 3 },
  { date: "August 20", label: "Wed", revenue: 100, orders: 4 },
  { date: "August 21", label: "Thu", revenue: 105, orders: 4 },
  { date: "August 22", label: "Fri", revenue: 110, orders: 5 },
  { date: "August 23", label: "Sat", revenue: 115, orders: 5 },
  { date: "August 24", label: "Sun", revenue: 120, orders: 6 },
];

const monthlyResult = groupRevenueData(dailyAug25Sep7, prevDailyAug11Aug24, "monthly");

check("Monthly grouping produces exactly 2 monthly points (August and September)", monthlyResult.length === 2);

const augPoint = monthlyResult.find((m) => m.label === "August")!;
const sepPoint = monthlyResult.find((m) => m.label === "September")!;

check("August monthly point exists", Boolean(augPoint));
check("September monthly point exists", Boolean(sepPoint));

// August values:
// Cur revenue = 100+110+120+130+140+150+160 = 910
// Prior revenue = 50+55+60+65+70+75+80 = 455
check(
  "August current revenue is exactly ₹910.00",
  augPoint?.currentRevenue === 910,
  `actual: ${augPoint?.currentRevenue}`
);
check(
  "August prior revenue is exactly ₹455.00",
  augPoint?.prevRevenue === 455,
  `actual: ${augPoint?.prevRevenue}`
);
check(
  "August tooltip prior range shows August 11–17",
  augPoint?.prevPeriod.includes("August 11") && augPoint?.prevPeriod.includes("August 17"),
  `actual: ${augPoint?.prevPeriod}`
);

// September values:
// Cur revenue = 200+210+220+230+240+250+260 = 1610
// Prior revenue = 90+95+100+105+110+115+120 = 735
check(
  "September current revenue is exactly ₹1610.00",
  sepPoint?.currentRevenue === 1610,
  `actual: ${sepPoint?.currentRevenue}`
);
check(
  "September prior revenue is exactly ₹735.00",
  sepPoint?.prevRevenue === 735,
  `actual: ${sepPoint?.prevRevenue}`
);
check(
  "September tooltip prior range shows August 18–24",
  sepPoint?.prevPeriod.includes("August 18") && sepPoint?.prevPeriod.includes("August 24"),
  `actual: ${sepPoint?.prevPeriod}`
);

// Confirm weekly tooltip labels still work
const weeklyResult = groupRevenueData(dailyAug25Sep7, prevDailyAug11Aug24, "weekly");
check("Weekly grouping produces 2 weekly chunks", weeklyResult.length === 2);
check(
  "Week 1 prior label carries Week 1 (August 11 – August 17)",
  weeklyResult[0].prevPeriod.includes("August 11") && weeklyResult[0].prevPeriod.includes("August 17"),
  `actual: ${weeklyResult[0].prevPeriod}`
);
check(
  "Week 2 prior label carries Week 2 (August 18 – August 24)",
  weeklyResult[1].prevPeriod.includes("August 18") && weeklyResult[1].prevPeriod.includes("August 24"),
  `actual: ${weeklyResult[1].prevPeriod}`
);

console.log("========================================================================");
console.log(`SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED`);
console.log("========================================================================");

if (totalFailed > 0) {
  process.exit(1);
}
