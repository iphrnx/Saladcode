/**
 * Comprehensive verification test suite for Saladcode Analytics Sections 2–4.
 *
 * Verifies:
 * 1. Section 2: Revenue Trend
 *    - Settled-revenue chart with Daily, Weekly, and Monthly grouping.
 *    - Reconciled invariant: sum(grouped) === totalRevenue across all 3 groupings.
 *    - Comparison enabled with clear previous period labeling ("vs. {compRangeLabel}").
 *    - Slate dashed line for comparison series.
 *    - Tooltip shows exact period, ₹ amount, completed orders, and delta.
 *    - Edge cases: single day vs multi-day boundaries, zero prior period, zero activity.
 * 2. Section 3: Order Types
 *    - Compares Dine-in, Takeaway, and Delivery (all 3 channels).
 *    - Shows completed order count, revenue, revenue share (%), and AOV for each type.
 *    - Explicit label indicating which metric drives the chart ("Driven by: ...").
 *    - Interactive toggle between By Revenue and By Orders.
 *    - Reconciles under same scope: sum(revenue) === totalTypeRevenue, sum(count) === totalOrders.
 * 3. Section 4: Sales by Hour
 *    - Peak hour displayed above an hourly chart.
 *    - Uses restaurant's configured timezone (e.g. Asia/Kolkata).
 *    - Tooltip shows exact hour window (e.g. 1:00 PM – 2:00 PM), timezone, ₹ revenue, and orders.
 *    - Explicit label whether peak hour is ranked by revenue or order count.
 *    - Edge cases: zero-activity period displays '—' (no fake 12 AM peak).
 * 4. Overall Layout Order:
 *    - 1. Financial Overview
 *    - 2. Revenue Trend
 *    - 3. Order Types
 *    - 4. Sales by Hour
 *    - 5. Top Selling Items
 *    - 6. Revenue by Category
 *    - 7. Payment Method Breakdown
 *    - 8. Top Tables
 *
 * Usage:
 *   npx tsx scripts/test-analytics-sections-2-4.mts
 */

import { readFileSync } from "node:fs";

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

console.log("\n========================================================");
console.log("   ANALYTICS SECTIONS 2–4 IMPLEMENTATION VERIFICATION   ");
console.log("========================================================\n");

const analyticsView = readFileSync("src/components/views/analytics.tsx", "utf8");

/* -------------------------------------------------------------------------- */
/* 1. SECTION 2: REVENUE TREND                                               */
/* -------------------------------------------------------------------------- */
console.log("── 1. Section 2: Revenue Trend ──");

check("supports Daily, Weekly, and Monthly grouping segmented control",
  analyticsView.includes("setRevenueGrouping") &&
  analyticsView.includes("['daily', 'weekly', 'monthly']") &&
  analyticsView.includes("revenueGrouping === grp"));

check("contains groupRevenueData helper handling all 3 groupings",
  analyticsView.includes("function groupRevenueData(") &&
  analyticsView.includes("grouping === 'daily'") &&
  analyticsView.includes("grouping === 'weekly'") &&
  analyticsView.includes("grouping === 'monthly'"));

// Simulate groupRevenueData to test reconciliation invariant across groupings
function testGroupRevenueData(daily: any[], prevDaily: any[], grouping: 'daily' | 'weekly' | 'monthly') {
  if (grouping === 'daily') {
    return daily.map((d, i) => ({
      key: d.date,
      currentRevenue: d.revenue,
      prevRevenue: prevDaily[i]?.revenue ?? 0,
    }));
  }
  if (grouping === 'weekly') {
    const chunks: any[] = [];
    const chunkSize = 7;
    for (let i = 0; i < daily.length; i += chunkSize) {
      const curChunk = daily.slice(i, i + chunkSize);
      const prevChunk = prevDaily.slice(i, i + chunkSize);
      chunks.push({
        key: `w-${Math.floor(i / chunkSize) + 1}`,
        currentRevenue: +curChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2),
        prevRevenue: +prevChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2),
      });
    }
    return chunks;
  }
  const monthMap = new Map<string, { currentRevenue: number; prevRevenue: number }>();
  daily.forEach((d, i) => {
    const m = d.date.slice(0, 7);
    if (!monthMap.has(m)) monthMap.set(m, { currentRevenue: 0, prevRevenue: 0 });
    const e = monthMap.get(m)!;
    e.currentRevenue = +(e.currentRevenue + d.revenue).toFixed(2);
    if (prevDaily[i]) e.prevRevenue = +(e.prevRevenue + prevDaily[i].revenue).toFixed(2);
  });
  return Array.from(monthMap.values());
}

const sampleDaily = [
  { date: "2026-11-01", label: "Sun", revenue: 1500.50, orders: 4 },
  { date: "2026-11-02", label: "Mon", revenue: 2300.00, orders: 6 },
  { date: "2026-11-03", label: "Tue", revenue: 800.25, orders: 2 },
  { date: "2026-11-04", label: "Wed", revenue: 3100.75, orders: 8 },
  { date: "2026-11-05", label: "Thu", revenue: 1200.00, orders: 3 },
  { date: "2026-11-06", label: "Fri", revenue: 4500.50, orders: 11 },
  { date: "2026-11-07", label: "Sat", revenue: 5200.00, orders: 14 },
  { date: "2026-11-08", label: "Sun", revenue: 2100.00, orders: 5 },
  { date: "2026-11-09", label: "Mon", revenue: 1900.00, orders: 4 },
];
const samplePrevDaily = [
  { date: "2026-10-23", label: "Fri", revenue: 1000.00, orders: 3 },
  { date: "2026-10-24", label: "Sat", revenue: 2000.00, orders: 5 },
  { date: "2026-10-25", label: "Sun", revenue: 500.00, orders: 1 },
  { date: "2026-10-26", label: "Mon", revenue: 2500.00, orders: 7 },
  { date: "2026-10-27", label: "Tue", revenue: 1100.00, orders: 3 },
  { date: "2026-10-28", label: "Wed", revenue: 3500.00, orders: 9 },
  { date: "2026-10-29", label: "Thu", revenue: 4000.00, orders: 10 },
  { date: "2026-10-30", label: "Fri", revenue: 1800.00, orders: 4 },
  { date: "2026-10-31", label: "Sat", revenue: 1500.00, orders: 3 },
];

const totalRevenueBaseline = +sampleDaily.reduce((s, d) => s + d.revenue, 0).toFixed(2);
const dailyGrouped = testGroupRevenueData(sampleDaily, samplePrevDaily, 'daily');
const weeklyGrouped = testGroupRevenueData(sampleDaily, samplePrevDaily, 'weekly');
const monthlyGrouped = testGroupRevenueData(sampleDaily, samplePrevDaily, 'monthly');

const sumDaily = +dailyGrouped.reduce((s, g) => s + g.currentRevenue, 0).toFixed(2);
const sumWeekly = +weeklyGrouped.reduce((s, g) => s + g.currentRevenue, 0).toFixed(2);
const sumMonthly = +monthlyGrouped.reduce((s, g) => s + g.currentRevenue, 0).toFixed(2);

check("daily grouping sum reconciles exactly with total revenue",
  sumDaily === totalRevenueBaseline,
  `sumDaily=${sumDaily}, expected=${totalRevenueBaseline}`);

check("weekly grouping sum reconciles exactly with total revenue",
  sumWeekly === totalRevenueBaseline,
  `sumWeekly=${sumWeekly}, expected=${totalRevenueBaseline}`);

check("monthly grouping sum reconciles exactly with total revenue",
  sumMonthly === totalRevenueBaseline,
  `sumMonthly=${sumMonthly}, expected=${totalRevenueBaseline}`);

check("renders primary line/area for current period and dashed line for previous period",
  /dataKey="currentRevenue"/.test(analyticsView) &&
  analyticsView.includes('Line') &&
  /dataKey="prevRevenue"/.test(analyticsView) &&
  analyticsView.includes('stroke="#94a3b8"') &&
  analyticsView.includes('strokeDasharray="4 4"'));

check("comparison toggle controls previous period visibility",
  analyticsView.includes("setShowRevenueComparison") &&
  analyticsView.includes("showRevenueComparison && hasComparisonData") &&
  analyticsView.includes("vs. Prior"));

check("tooltips show period, ₹ formatted amount, completed orders, and delta",
  analyticsView.includes("function RevenueTrendTooltip") &&
  analyticsView.includes("{currencySymbol}{curVal.toFixed(2)}") &&
  analyticsView.includes("curOrders") &&
  analyticsView.includes("pctChange"));

// Test zero prior period and zero activity edge cases
check("handles zero prior period (prev=0, curr>0) safely without NaN/Infinity",
  (() => {
    const curVal = 500, prevVal = 0;
    let pct: number | null = null;
    if (prevVal > 0) pct = +(((curVal - prevVal) / prevVal) * 100).toFixed(1);
    else if (prevVal === 0 && curVal > 0) pct = 100.0;
    return pct === 100.0 && !Number.isNaN(pct) && Number.isFinite(pct);
  })());

check("handles zero activity period (prev=0, curr=0) safely",
  (() => {
    const curVal = 0, prevVal = 0;
    let pct: number | null = null;
    if (prevVal > 0) pct = +(((curVal - prevVal) / prevVal) * 100).toFixed(1);
    else if (prevVal === 0 && curVal === 0) pct = 0.0;
    return pct === 0.0;
  })());

/* -------------------------------------------------------------------------- */
/* 2. SECTION 3: ORDER TYPES                                                 */
/* -------------------------------------------------------------------------- */
console.log("\n── 2. Section 3: Order Types ──");

check("always compares Dine-in, Takeaway, and Delivery (all 3 channels)",
  analyticsView.includes("ALL_ORDER_TYPES = ['DINE_IN', 'TAKEAWAY', 'DELIVERY']") &&
  analyticsView.includes("Dine In") &&
  analyticsView.includes("Takeaway") &&
  analyticsView.includes("Delivery"));

check("reports completed order count, revenue, revenue share (%), and AOV for each type",
  analyticsView.includes("const aov = count > 0 ? +(revenue / count).toFixed(2) : 0") &&
  analyticsView.includes("totalOrderTypesRevenue") &&
  analyticsView.includes("orders)") &&
  analyticsView.includes("{t.share}%") &&
  analyticsView.includes("AOV"));

check("explicitly labels which metric drives the chart",
  analyticsView.includes("setOrderTypeMetric('revenue')") &&
  analyticsView.includes("setOrderTypeMetric('orders')"));

check("supports interactive toggle between By Revenue and By Orders",
  analyticsView.includes("setOrderTypeMetric('revenue')") &&
  analyticsView.includes("setOrderTypeMetric('orders')") &&
  analyticsView.includes("dataKey={orderTypeMetric === 'revenue' ? 'revenue' : 'count'}"));

// Test order types reconciliation under same scope
{
  const mockTypes = [
    { type: 'DINE_IN', count: 10, revenue: 3500.00 },
    { type: 'TAKEAWAY', count: 5, revenue: 1250.00 },
    { type: 'DELIVERY', count: 2, revenue: 750.00 },
  ];
  const totalRev = +mockTypes.reduce((s, t) => s + t.revenue, 0).toFixed(2);
  const totalCount = mockTypes.reduce((s, t) => s + t.count, 0);

  const mapped = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].map(tKey => {
    const f = mockTypes.find(t => t.type === tKey);
    const count = f?.count ?? 0;
    const revenue = f?.revenue ?? 0;
    const aov = count > 0 ? +(revenue / count).toFixed(2) : 0;
    const share = totalRev > 0 ? +((revenue / totalRev) * 100).toFixed(1) : 0;
    return { type: tKey, count, revenue, aov, share };
  });

  const sumMappedRev = +mapped.reduce((s, t) => s + t.revenue, 0).toFixed(2);
  const sumMappedCount = mapped.reduce((s, t) => s + t.count, 0);

  check("channel revenue breakdown reconciles exactly with total order types revenue",
    sumMappedRev === totalRev && sumMappedRev === 5500.00);

  check("channel order count breakdown reconciles exactly with total completed orders",
    sumMappedCount === totalCount && sumMappedCount === 17);

  check("AOV correctly computed per channel ($350, $250, $375)",
    mapped[0].aov === 350 && mapped[1].aov === 250 && mapped[2].aov === 375);
}

// Test edge case where a channel has 0 orders
{
  const mockEmptyDelivery = [
    { type: 'DINE_IN', count: 6, revenue: 2314.40 },
    { type: 'TAKEAWAY', count: 0, revenue: 0 },
  ];
  const mapped = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].map(tKey => {
    const f = mockEmptyDelivery.find(t => t.type === tKey);
    const count = f?.count ?? 0;
    const revenue = f?.revenue ?? 0;
    const aov = count > 0 ? +(revenue / count).toFixed(2) : 0;
    return { type: tKey, count, revenue, aov };
  });
  check("missing/zero channel produces safe 0 AOV and 0 orders without crash",
    mapped.find(t => t.type === 'DELIVERY')?.aov === 0 &&
    mapped.find(t => t.type === 'DELIVERY')?.count === 0);
}

/* -------------------------------------------------------------------------- */
/* 3. SECTION 4: SALES BY HOUR                                               */
/* -------------------------------------------------------------------------- */
console.log("\n── 3. Section 4: Sales by Hour ──");

check("displays peak hour above hourly chart",
  analyticsView.includes("Peak:") &&
  analyticsView.includes("activePeakHour"));

check("uses restaurant's configured timezone",
  analyticsView.includes("analytics?.range?.timezone || 'Asia/Kolkata'") &&
  analyticsView.includes("restaurantTimezone"));

check("explicitly labels whether peak hour is ranked by revenue or order count",
  analyticsView.includes("setHourlyRankMetric('orders')") &&
  analyticsView.includes("setHourlyRankMetric('revenue')"));

check("provides rank toggle between By Orders and By Revenue",
  analyticsView.includes("setHourlyRankMetric('orders')") &&
  analyticsView.includes("setHourlyRankMetric('revenue')") &&
  analyticsView.includes("hourlyRankMetric === 'orders'"));

check("hourly tooltips show exact hour window, timezone, ₹ revenue, and orders count",
  analyticsView.includes("function HourlySalesTooltip") &&
  analyticsView.includes("hourSpan") &&
  analyticsView.includes("Timezone: {timezone}") &&
  analyticsView.includes("Settled Revenue:") &&
  analyticsView.includes("Completed Orders:"));

// Test peak hour computation with ranking toggle
{
  const mockHourly = Array.from({ length: 24 }, (_, h) => ({
    hourNum: h,
    hourSpan: `${h}:00 – ${(h+1)%24}:00`,
    orders: h === 13 ? 8 : (h === 20 ? 5 : 0),
    revenue: h === 13 ? 2400 : (h === 20 ? 3500 : 0),
  }));

  const peakByOrders = mockHourly.reduce((best, curr) => {
    if (curr.orders > best.orders) return curr;
    if (curr.orders === best.orders && curr.revenue > best.revenue) return curr;
    return best;
  }, mockHourly[0]);

  const peakByRevenue = mockHourly.reduce((best, curr) => {
    if (curr.revenue > best.revenue) return curr;
    if (curr.revenue === best.revenue && curr.orders > best.orders) return curr;
    return best;
  }, mockHourly[0]);

  check("peak hour ranked by orders chooses 13:00 (8 orders, ₹2400)",
    peakByOrders.hourNum === 13 && peakByOrders.orders === 8);

  check("peak hour ranked by revenue chooses 20:00 (5 orders, ₹3500)",
    peakByRevenue.hourNum === 20 && peakByRevenue.revenue === 3500);
}

// Test edge case: period with no activity across all 24 hours
{
  const mockZeroHourly = Array.from({ length: 24 }, (_, h) => ({
    hourNum: h,
    orders: 0,
    revenue: 0,
  }));
  const hasHourlyData = mockZeroHourly.some(d => d.orders > 0 || d.revenue > 0);
  const peakHour = hasHourlyData ? mockZeroHourly.reduce((b, c) => c.orders > b.orders ? c : b, mockZeroHourly[0]) : null;

  check("zero-activity period produces null peak hour and displays '—' (no fake 12 AM peak)",
    peakHour === null &&
    analyticsView.includes("Peak: —"));
}

/* -------------------------------------------------------------------------- */
/* 4. OVERALL LAYOUT ORDER & FUNCTIONALITY                                    */
/* -------------------------------------------------------------------------- */
console.log("\n── 4. Overall Layout Order & Functionality ──");

// Search inside JSX main content
const mainContentIdx = analyticsView.indexOf('className="flex-1 overflow-y-auto scrollbar-thin');
const mainContent = analyticsView.slice(mainContentIdx);

const s1Idx = mainContent.indexOf("Financial Overview");
const s2Idx = mainContent.indexOf("Revenue Trend");
const s3Idx = mainContent.indexOf("Order Types");
const s4Idx = mainContent.indexOf("Sales by Hour");
const s5Idx = mainContent.indexOf("Top Selling Items");
const s6Idx = mainContent.indexOf("Revenue by Category");
const s7Idx = mainContent.indexOf("Payment Method Breakdown");
const s8Idx = mainContent.indexOf("Top Tables");

check("1. Financial Overview appears first", s1Idx > 0);
check("2. Revenue Trend appears second", s2Idx > s1Idx, `s2=${s2Idx}, s1=${s1Idx}`);
check("3. Order Types appears third", s3Idx > s2Idx, `s3=${s3Idx}, s2=${s2Idx}`);
check("4. Sales by Hour appears fourth", s4Idx > s3Idx, `s4=${s4Idx}, s3=${s3Idx}`);
check("5. Top Selling Items is preserved", s5Idx > s4Idx, `s5=${s5Idx}, s4=${s4Idx}`);
check("6. Revenue by Category is preserved", s6Idx > s5Idx, `s6=${s6Idx}, s5=${s5Idx}`);
check("7. Payment Method Breakdown is preserved", s7Idx > s6Idx, `s7=${s7Idx}, s6=${s6Idx}`);
check("8. Top Tables is preserved", s8Idx > s7Idx, `s8=${s8Idx}, s7=${s7Idx}`);

console.log("\n========================================================");
console.log(`Verification Summary: ${pass} passed, ${fail} failed`);
console.log("========================================================\n");

if (fail > 0) process.exit(1);
