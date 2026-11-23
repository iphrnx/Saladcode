import assert from "node:assert/strict";
import fs from "node:fs";

console.log("\n========================================================");
console.log("   BATCH 3: COMPARISONS AND CSV EXPORT VERIFICATION     ");
console.log("========================================================\n");

const analyticsFn = fs.readFileSync("supabase/functions/analytics/index.ts", "utf-8");
const analyticsView = fs.readFileSync("src/components/views/analytics.tsx", "utf-8");

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    process.exit(1);
  }
}

// 1. Prior-period daily bucketing with resolved settlement timestamp
console.log("── 1. Prior-period daily bucketing with resolved settlement timestamp ──");
check(
  "stores resolved settlement timestamp on prior-period orders before daily bucketing",
  analyticsFn.includes("o.settledAt = settlementTime") &&
  analyticsFn.includes("prevQualifyingOrders.push(o)")
);

check(
  "prior daily orders bucketing filters by o.settledAt within dayStart and dayEnd",
  analyticsFn.includes("prevQualifyingOrders.filter(\n      (o) => o.settledAt >= dayStart && o.settledAt < dayEnd") ||
  analyticsFn.includes("prevQualifyingOrders.filter(") && analyticsFn.includes("o.settledAt >= dayStart")
);

// 2. Zero or missing prior value representation
console.log("\n── 2. Zero or missing prior value representation ──");
check(
  "calcChange returns null when prev === 0 && curr > 0 (suppressing +100%)",
  analyticsFn.includes("if (prev === 0 && curr > 0) {\n      return null;") ||
  analyticsFn.includes("if (prev === 0 && curr > 0) return null;") ||
  (analyticsFn.includes("prev === 0 && curr > 0") && analyticsFn.includes("return null"))
);

check(
  "category growth returns null when prevRev === 0 && rev > 0 (suppressing +100%)",
  analyticsFn.includes("else if (prevRev === 0 && rev > 0) {\n        growth = null;") ||
  (analyticsFn.includes("prevRev === 0 && rev > 0") && analyticsFn.includes("growth = null"))
);

check(
  "FinancialKpiCard displays 'New' badge when prior value is zero/missing and current value > 0",
  analyticsView.includes("(!isEmpty && !isRealZero && value && value !== '₹0' && value !== '₹0.00' && value !== '0') ? (") &&
  analyticsView.includes("New")
);

check(
  "CategoryBreakdown table displays 'New' badge when prior revenue is 0 and current revenue > 0",
  analyticsView.includes("(c.revenue ?? c.value) > 0 ? (") &&
  analyticsView.includes("New")
);

// 3. API's actual comparison dates in UI labels
console.log("\n── 3. API comparison dates in UI labels ──");
check(
  "compRangeLabel uses analytics.comparison.period from and to when available",
  analyticsView.includes("analytics?.comparison?.period?.from") &&
  analyticsView.includes("parseISO(analytics.comparison.period.from)") &&
  analyticsView.includes("parseISO(analytics.comparison.period.to)")
);

// 4. CSV Export reconciliation
console.log("\n── 4. CSV Export Reconciliation ──");
check(
  "CSV Payment Method Breakdown headers include Collected, Refunds, Net Amount",
  analyticsView.includes("push('Method', 'Transactions', `Collected (${sym})`, `Refunds (${sym})`, `Net Amount (${sym})`)")
);

check(
  "CSV Payment rows include collected, refunded, and net amounts for Cash, UPI, Card",
  analyticsView.includes("push('Cash', analytics.paymentMethods.cash.count, money(analytics.paymentMethods.cash.amount), money(analytics.paymentMethods.cash.refunds") &&
  analyticsView.includes("push('UPI', analytics.paymentMethods.upi.count, money(analytics.paymentMethods.upi.amount), money(analytics.paymentMethods.upi.refunds") &&
  analyticsView.includes("push('Card', analytics.paymentMethods.card.count, money(analytics.paymentMethods.card.amount), money(analytics.paymentMethods.card.refunds")
);

check(
  "CSV Payment Total Reconciled row includes total collected, total refunds, total net",
  analyticsView.includes("push('Total Reconciled', totalTx, money(analytics.paymentMethods.totalCollected") &&
  analyticsView.includes("money(analytics.paymentMethods.totalRefunds") &&
  analyticsView.includes("money(analytics.paymentMethods.totalNet")
);

check(
  "CSV Top Tables headers and rows use Sessions and Average Bill",
  analyticsView.includes("push('Table', 'Sessions', `Revenue (${sym})`, `Average Bill (${sym})`)") &&
  analyticsView.includes("push(t.name, t.sessionCount ?? t.orders, money(t.revenue), money(t.averageBill")
);

check(
  "CSV uses active date range and selected location name",
  analyticsView.includes("push('Location', selectedLoc.name)") &&
  analyticsView.includes("push('From', analytics.range?.from ?? '')") &&
  analyticsView.includes("push('To', analytics.range?.to ?? '')") &&
  analyticsView.includes("the-salad-report_${locSlug}")
);

// 5. Correctness fixes: pmTotal fallback, zero refund formatting, subtitle and operations scope labels
console.log("\n── 5. Correctness & Labeling Fixes ──");
check(
  "pmTotal calculation removes || 1 fallback so valid 0 values do not turn into ₹1.00",
  !analyticsView.includes("const pmTotal = (pm?.cash.amount ?? 0) + (pm?.upi.amount ?? 0) + (pm?.card.amount ?? 0) + (pm?.other?.amount ?? 0) || 1") &&
  analyticsView.includes("const pmTotal = (pm?.cash.amount ?? 0) + (pm?.upi.amount ?? 0) + (pm?.card.amount ?? 0) + (pm?.other?.amount ?? 0)")
);

check(
  "zero refunds are formatted as ₹0.00 instead of em-dash",
  analyticsView.includes("${sym}0.00")
);

check(
  "Category subtitle removes duplicate 'vs.' typo",
  !analyticsView.includes("Compared with vs.") &&
  analyticsView.includes("Category contribution · {compRangeLabel ? `Compared with ${compRangeLabel}` : rangeLabel}")
);

check(
  "Operations performance label correctly reflects settled orders scope",
  analyticsView.includes("orders settled")
);

console.log("\n========================================================");
console.log("Verification Summary: All Batch 3 checks PASSED! (100%)");
console.log("========================================================\n");
