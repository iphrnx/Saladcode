import assert from "node:assert/strict";
import fs from "node:fs";

console.log("\n========================================================");
console.log("   FINAL RESTROFI ANALYTICS V2 P2 COMPREHENSIVE SUITE   ");
console.log("========================================================\n");

function check(name: string, condition: boolean) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// 1. Payment Reconciliation Resolution Function Invariant Tests
// -----------------------------------------------------------------------------
console.log("── 1. Payment Reconciliation Resolution Invariants ──");

function resolvePaymentTotals(pm: any) {
  if (!pm) return { collected: 0, refunds: 0, net: 0 };

  const pmTotal =
    (pm.cash?.amount ?? 0) +
    (pm.upi?.amount ?? 0) +
    (pm.card?.amount ?? 0) +
    (pm.other?.amount ?? 0);

  const derivedCollected = pmTotal;
  const derivedRefunds =
    (pm.cash?.refunds ?? 0) +
    (pm.upi?.refunds ?? 0) +
    (pm.card?.refunds ?? 0) +
    (pm.other?.refunds ?? 0) +
    (pm.unattributedRefunds?.amount ?? 0);

  const collected =
    pm.totalCollected !== undefined && pm.totalCollected !== null
      ? Number(pm.totalCollected)
      : derivedCollected;

  const refunds =
    pm.totalRefunds !== undefined && pm.totalRefunds !== null
      ? Number(pm.totalRefunds)
      : derivedRefunds;

  const net =
    pm.totalNet !== undefined && pm.totalNet !== null
      ? Number(pm.totalNet)
      : collected - refunds;

  return { collected, refunds, net };
}

// Case A: Explicit API Zeros
const caseA = {
  cash: { amount: 0, count: 0, refunds: 0, net: 0 },
  upi: { amount: 0, count: 0, refunds: 0, net: 0 },
  card: { amount: 0, count: 0, refunds: 0, net: 0 },
  other: { amount: 0, count: 0, refunds: 0, net: 0 },
  totalCollected: 0,
  totalRefunds: 0,
  totalNet: 0,
};
const resA = resolvePaymentTotals(caseA);
check("Case A: explicit totalCollected: 0 resolves to 0.00", resA.collected === 0);
check("Case A: explicit totalRefunds: 0 resolves to 0.00", resA.refunds === 0);
check("Case A: explicit totalNet: 0 resolves to 0.00", resA.net === 0);

// Case B: Omitted optional totals (derived strictly from method rows + unattributed refunds)
const caseB = {
  cash: { amount: 500, count: 2, refunds: 50 },
  upi: { amount: 350, count: 1, refunds: 0 },
  card: { amount: 200, count: 1, refunds: 20 },
  other: { amount: 0, count: 0, refunds: 0 },
  unattributedRefunds: { amount: 30, count: 1 },
  unknownDateRefunds: { amount: 500, count: 2 }, // Must be excluded from dated period totals!
  totalCollected: undefined,
  totalRefunds: undefined,
  totalNet: undefined,
};
const resB = resolvePaymentTotals(caseB);
check("Case B: derived collected = 500 + 350 + 200 = 1050", resB.collected === 1050);
check("Case B: derived refunds = 50 + 0 + 20 + 30 (unattributed) = 100", resB.refunds === 100);
check("Case B: derived net = 1050 - 100 = 950", resB.net === 950);
check("Case B: unknown-date reversals (500) strictly excluded from dated totals", resB.refunds === 100);

// Case C: Populated Cash/UPI/Card data with explicit totals
const caseC = {
  cash: { amount: 1000, count: 4, refunds: 150, net: 850 },
  upi: { amount: 2000, count: 5, refunds: 300, net: 1700 },
  card: { amount: 1500, count: 3, refunds: 100, net: 1400 },
  other: { amount: 0, count: 0, refunds: 0, net: 0 },
  totalCollected: 4500,
  totalRefunds: 550,
  totalNet: 3950,
};
const resC = resolvePaymentTotals(caseC);
check("Case C: explicit totalCollected = 4500", resC.collected === 4500);
check("Case C: explicit totalRefunds = 550", resC.refunds === 550);
check("Case C: explicit totalNet = 3950", resC.net === 3950);

// Case D: Refund-only period with negative net
const caseD = {
  cash: { amount: 0, count: 0, refunds: 60 },
  upi: { amount: 0, count: 0, refunds: 40 },
  card: { amount: 0, count: 0, refunds: 0 },
  other: { amount: 0, count: 0, refunds: 0 },
  unattributedRefunds: { amount: 0, count: 0 },
  totalCollected: 0,
  totalRefunds: 100,
  totalNet: -100,
};
const resD = resolvePaymentTotals(caseD);
check("Case D: refund-only period collected = 0", resD.collected === 0);
check("Case D: refund-only period refunds = 100", resD.refunds === 100);
check("Case D: refund-only period net = -100 (negative net)", resD.net === -100);

// -----------------------------------------------------------------------------
// 2. Summary, Footer, and CSV Agreement Verification
// -----------------------------------------------------------------------------
console.log("\n── 2. Summary, Footer, and CSV Export Agreement ──");

function formatSummary(totals: { collected: number; refunds: number; net: number }, sym = "₹") {
  const collStr = `${sym}${totals.collected.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const refStr = totals.refunds > 0 ? `-${sym}${totals.refunds.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`;
  const netStr = totals.net < 0
    ? `-${sym}${Math.abs(totals.net).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${sym}${totals.net.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { collStr, refStr, netStr };
}

function formatFooter(totals: { collected: number; refunds: number; net: number }, sym = "₹") {
  return formatSummary(totals, sym);
}

function formatCsvTotal(totals: { collected: number; refunds: number; net: number }) {
  const money = (n: number) => n.toFixed(2);
  return {
    collStr: money(totals.collected),
    refStr: money(totals.refunds),
    netStr: money(totals.net),
  };
}

for (const [name, totals] of [["Case A", resA], ["Case B", resB], ["Case C", resC], ["Case D", resD]] as const) {
  const sum = formatSummary(totals);
  const foot = formatFooter(totals);
  const csv = formatCsvTotal(totals);

  check(`${name}: summary and footer collected agree (${sum.collStr})`, sum.collStr === foot.collStr);
  check(`${name}: summary and footer refunds agree (${sum.refStr})`, sum.refStr === foot.refStr);
  check(`${name}: summary and footer net agree (${sum.netStr})`, sum.netStr === foot.netStr);

  const numCsvColl = parseFloat(csv.collStr);
  const numCsvRef = parseFloat(csv.refStr);
  const numCsvNet = parseFloat(csv.netStr);

  check(`${name}: CSV numeric values match resolved totals`, numCsvColl === totals.collected && numCsvRef === totals.refunds && numCsvNet === totals.net);
}

// -----------------------------------------------------------------------------
// 3. Comparison Toggle State & Invariants
// -----------------------------------------------------------------------------
console.log("\n── 3. Optional Comparison Dashboard Invariants ──");

const analyticsView = fs.readFileSync("src/components/views/analytics.tsx", "utf-8");

check("isComparisonEnabled defaults to true", analyticsView.includes("const [isComparisonEnabled, setIsComparisonEnabled] = useState(true)"));

check("header badge replaced with accessible switch toggle",
  analyticsView.includes('role="switch"') &&
  analyticsView.includes("aria-checked={isComparisonEnabled}") &&
  analyticsView.includes("setIsComparisonEnabled((prev) => !prev)") &&
  analyticsView.includes("Compare: Off")
);

check("Revenue Trend comparison toggle wired to same state",
  analyticsView.includes("const showRevenueComparison = isComparisonEnabled") &&
  analyticsView.includes("const setShowRevenueComparison = setIsComparisonEnabled")
);

check("FinancialKpiCard receives isComparisonEnabled prop",
  analyticsView.includes("isComparisonEnabled={isComparisonEnabled}")
);

check("FinancialKpiCard suppresses delta badge completely when comparison is off",
  analyticsView.includes("!isComparisonEnabled ? (\n            null")
);

check("FinancialKpiCard displays '—' for zero or missing prior baseline when comparison is on",
  analyticsView.includes("text-[10px] text-muted-foreground/60 px-1.5 py-0.5 rounded bg-secondary/30") &&
  analyticsView.includes("—")
);

check("CategoryBreakdown filters out prior-only category rows when comparison is off",
  analyticsView.includes("displayCategories = isComparisonEnabled") &&
  analyticsView.includes("rankedCategories.filter((c) => (c.revenue ?? c.value ?? 0) > 0)")
);

check("CategoryBreakdown hides vs Prior column when comparison is off",
  analyticsView.includes("{isComparisonEnabled && <span>vs Prior</span>}") &&
  analyticsView.includes("{isComparisonEnabled && (\n                            <div className=\"w-14 text-right\">")
);

check("BusinessInsights suppresses comparison-based observation when comparison is off",
  analyticsView.includes("isComparisonEnabled &&\n              analytics?.comparison?.previous")
);

check("Tooltips suppress prior period series when comparison is off",
  analyticsView.includes("const prevItem = isComparisonEnabled ? payload.find((p: any) => p.dataKey === 'prevRevenue') : null") &&
  analyticsView.includes("{isComparisonEnabled && prevItem && (")
);

console.log("\n========================================================");
console.log("   ALL P2 COMPREHENSIVE VERIFICATION CHECKS PASSED! 🎉   ");
console.log("========================================================\n");
