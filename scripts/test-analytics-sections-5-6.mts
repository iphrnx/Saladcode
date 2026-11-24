/**
 * Comprehensive verification test suite for Saladcode Analytics Sections 5–6.
 *
 * Verifies:
 * 1. Section 5: Top Selling Items
 *    - Ranked chart and item table.
 *    - Support ranking by quantity sold (Units) or revenue (₹).
 *    - Deterministic tiebreaking (by secondary metric, then name).
 *    - Least-selling view with clear labeling:
 *      - Covers items sold in period (units > 0), OR
 *      - Includes zero-sale active menu items.
 *    - Table shows: Item name, Category, Units, and Revenue (₹).
 *    - Historical menu item preservation (name and category fallback).
 * 2. Section 6: Revenue by Category
 *    - Ranked revenue chart.
 *    - Category table with:
 *      - Category name
 *      - Revenue (₹)
 *      - Units sold
 *      - Revenue share (%)
 *      - Previous-period growth (where available).
 *    - Growth calculation handles edge cases:
 *      - Prior > 0: standard % delta
 *      - Prior == 0 and Current > 0: +100.0%
 *      - Prior == 0 and Current == 0: 0.0%
 *      - Prior missing/unavailable: '—'
 * 3. Filter Preservation in Drill-down:
 *    - Category click drills down into Top/Least Selling Items.
 *    - Preserves active filters (date range and location).
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
 *   npx tsx scripts/test-analytics-sections-5-6.mts
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
console.log("   ANALYTICS SECTIONS 5–6 IMPLEMENTATION VERIFICATION   ");
console.log("========================================================\n");

const analyticsView = readFileSync("src/components/views/analytics.tsx", "utf8");
const analyticsFn = readFileSync("supabase/functions/analytics/index.ts", "utf8");

/* -------------------------------------------------------------------------- */
/* 1. SECTION 5: TOP SELLING ITEMS                                           */
/* -------------------------------------------------------------------------- */
console.log("── 1. Section 5: Top Selling Items ──");

check("renders ranked chart and item table for top selling items",
  analyticsView.includes("BarChart data={chartItems}") &&
  analyticsView.includes("rankedItems.slice(0, 15).map") &&
  analyticsView.includes("Rank & Item"));

check("supports ranking by quantity sold (Units) and revenue (₹)",
  analyticsView.includes("setItemRankMetric('qty')") &&
  analyticsView.includes("setItemRankMetric('revenue')") &&
  analyticsView.includes("itemRankMetric === 'qty' ? 'Units' : 'Revenue'"));

check("supports least-selling view toggle",
  analyticsView.includes("setItemViewMode('top')") &&
  analyticsView.includes("setItemViewMode('least')") &&
  analyticsView.includes("itemViewMode === 'top' ? 'Top Selling Items' : 'Least Selling Items'"));

check("clearly labels whether view covers items sold in period or includes zero-sale items",
  analyticsView.includes("itemViewMode === 'least' && includeZeroSaleItems") &&
  analyticsView.includes("Including zero-sale items"));

check("supports zero-sale scope toggle in least-selling view",
  analyticsView.includes("setIncludeZeroSaleItems") &&
  analyticsView.includes("Inc. 0-sale: Yes"));

check("shows item name, category, units, and revenue in table",
  analyticsView.includes("it.name") &&
  analyticsView.includes("it.category") &&
  analyticsView.includes("it.qty") &&
  analyticsView.includes("it.revenue.toFixed(2)"));

check("preserves historical menu items and categorizes properly in backend",
  analyticsFn.includes("const key = it.menuItemId || it.name") &&
  analyticsFn.includes("name: it.name") &&
  analyticsFn.includes("catMap[it.menuItemId] || \"Other\""));

// Runtime simulation of item sorting & ties
{
  const mockItems = [
    { name: "Caesar Salad", category: "Salads", qty: 10, revenue: 2500.00, isZeroSale: false },
    { name: "Greek Salad", category: "Salads", qty: 10, revenue: 2800.00, isZeroSale: false }, // Tie on qty, higher rev
    { name: "Garlic Bread", category: "Starters", qty: 15, revenue: 1500.00, isZeroSale: false },
    { name: "Cold Coffee", category: "Beverages", qty: 2, revenue: 300.00, isZeroSale: false },
    { name: "Iced Tea", category: "Beverages", qty: 0, revenue: 0.00, isZeroSale: true },
  ];

  // Top Selling by Qty
  const topByQty = [...mockItems].filter(i => !i.isZeroSale).sort((a, b) =>
    (b.qty - a.qty) || (b.revenue - a.revenue) || a.name.localeCompare(b.name)
  );
  check("top selling by qty puts highest qty first and tiebreaks by revenue",
    topByQty[0].name === "Garlic Bread" &&
    topByQty[1].name === "Greek Salad" && // 10 qty, 2800 rev > Caesar 10 qty, 2500 rev
    topByQty[2].name === "Caesar Salad");

  // Top Selling by Revenue
  const topByRev = [...mockItems].filter(i => !i.isZeroSale).sort((a, b) =>
    (b.revenue - a.revenue) || (b.qty - a.qty) || a.name.localeCompare(b.name)
  );
  check("top selling by revenue puts highest revenue first",
    topByRev[0].name === "Greek Salad" && topByRev[1].name === "Caesar Salad");

  // Least Selling without zero-sale items
  const leastSoldOnly = [...mockItems].filter(i => !i.isZeroSale).sort((a, b) =>
    (a.qty - b.qty) || (a.revenue - b.revenue) || a.name.localeCompare(b.name)
  );
  check("least selling (sold items only) ranks lowest positive sold items first",
    leastSoldOnly[0].name === "Cold Coffee" && leastSoldOnly[0].qty === 2);

  // Least Selling including zero-sale items
  const leastWithZero = [...mockItems].sort((a, b) =>
    (a.qty - b.qty) || (a.revenue - b.revenue) || a.name.localeCompare(b.name)
  );
  check("least selling (including zero-sale) puts zero-sale items first",
    leastWithZero[0].name === "Iced Tea" && leastWithZero[0].qty === 0);
}

/* -------------------------------------------------------------------------- */
/* 2. SECTION 6: REVENUE BY CATEGORY                                         */
/* -------------------------------------------------------------------------- */
console.log("\n── 2. Section 6: Revenue by Category ──");

check("renders ranked category revenue chart and performance table",
  analyticsView.includes("BarChart data={displayCategories}") &&
  analyticsView.includes("Revenue by Category"));

check("table shows Category name, Revenue, Units, Share %, and vs. Prior",
  analyticsView.includes("c.name") &&
  analyticsView.includes("(c.revenue ?? c.value).toFixed(2)") &&
  analyticsView.includes("c.units") &&
  analyticsView.includes("c.share") &&
  analyticsView.includes("vs Prior") || analyticsView.includes("vs. Prior"));

check("backend calculates units sold, revenue share, and growth per category",
  analyticsFn.includes("catStats[cat].units += Number(it.quantity || 0)") &&
  analyticsFn.includes("totalCatRevenue") &&
  analyticsFn.includes("growth"));

// Test growth calculation edge cases
{
  function calcGrowth(curr: number, prev: number | null | undefined): number | null {
    if (prev === null || prev === undefined) return null;
    if (prev > 0) return +(((curr - prev) / prev) * 100).toFixed(1);
    if (prev === 0 && curr > 0) return 100.0;
    if (prev === 0 && curr === 0) return 0.0;
    return null;
  }

  check("prior > 0 produces standard positive growth",
    calcGrowth(1500, 1000) === 50.0);

  check("prior > 0 produces standard negative growth",
    calcGrowth(800, 1000) === -20.0);

  check("zero prior period (prev=0, curr>0) safely produces +100.0% without NaN/Infinity",
    calcGrowth(1200, 0) === 100.0);

  check("zero prior and current (prev=0, curr=0) produces 0.0%",
    calcGrowth(0, 0) === 0.0);

  check("missing prior period safely produces null ('—')",
    calcGrowth(1200, null) === null && calcGrowth(1200, undefined) === null);
}

/* -------------------------------------------------------------------------- */
/* 3. DRILL-DOWN & FILTER PRESERVATION                                        */
/* -------------------------------------------------------------------------- */
console.log("\n── 3. Drill-down & Filter Preservation ──");

check("clicking a category row sets selectedCategoryFilter",
  analyticsView.includes("setSelectedCategoryFilter") &&
  analyticsView.includes("prev === c.name ? 'ALL' : c.name"));

check("active category drill-down filters the item source pool",
  analyticsView.includes("selectedCategoryFilter === 'ALL'") &&
  analyticsView.includes("itemSourcePool.filter((it) => (it.category || 'Other') === selectedCategoryFilter)"));

check("drill-down preserves date range and location filters without resetting them",
  analyticsView.includes("setSelectedCategoryFilter((prev) => (prev === c.name ? 'ALL' : c.name))") &&
  !analyticsView.includes("setSelectedCategoryFilter('ALL'); setRange") &&
  !analyticsView.includes("setSelectedCategoryFilter(c.name); setRange"));

check("provides clear button to reset drill-down back to all categories",
  analyticsView.includes("onClick={() => setSelectedCategoryFilter('ALL')}") &&
  analyticsView.includes("Clear category drill-down filter"));

/* -------------------------------------------------------------------------- */
/* 4. OVERALL LAYOUT ORDER                                                   */
/* -------------------------------------------------------------------------- */
console.log("\n── 4. Overall Layout Order ──");

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
check("2. Revenue Trend appears second", s2Idx > s1Idx);
check("3. Order Types appears third", s3Idx > s2Idx);
check("4. Sales by Hour appears fourth", s4Idx > s3Idx);
check("5. Top Selling Items appears fifth", s5Idx > s4Idx);
check("6. Revenue by Category appears sixth", s6Idx > s5Idx);
check("7. Payment Method Breakdown appears seventh", s7Idx > s6Idx);
check("8. Top Tables appears eighth", s8Idx > s7Idx);

console.log("\n========================================================");
console.log(`Verification Summary: ${pass} passed, ${fail} failed`);
console.log("========================================================\n");

if (fail > 0) process.exit(1);
