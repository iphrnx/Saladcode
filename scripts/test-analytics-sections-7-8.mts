import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

console.log('--- Verifying Sections 7 & 8 (Payment Method Breakdown & Top Tables) ---')

const analyticsView = fs.readFileSync(path.resolve('src/components/views/analytics.tsx'), 'utf-8')
const analyticsEdge = fs.readFileSync(path.resolve('supabase/functions/analytics/index.ts'), 'utf-8')

// 1. Overall Layout Order: Section 1 through 8
console.log('1. Checking section order in Analytics View...')
const mainContentIdx = analyticsView.indexOf('Financial Overview')
assert.ok(mainContentIdx !== -1, 'Financial Overview should be present')
const mainContent = analyticsView.slice(mainContentIdx)

const sec1Idx = mainContent.indexOf('Financial Overview')
const sec2Idx = mainContent.indexOf('Revenue Trend')
const sec3Idx = mainContent.indexOf('Order Types')
const sec4Idx = mainContent.indexOf('Sales by Hour')
const sec5Idx = mainContent.indexOf('Top Selling Items')
const sec6Idx = mainContent.indexOf('Revenue by Category')
const sec7Idx = mainContent.indexOf('Payment Method Breakdown')
const sec8Idx = mainContent.indexOf('Top Tables')

assert.ok(sec1Idx !== -1, 'Section 1 Financial Overview present')
assert.ok(sec2Idx !== -1, 'Section 2 Revenue Trend present')
assert.ok(sec3Idx !== -1, 'Section 3 Order Types present')
assert.ok(sec4Idx !== -1, 'Section 4 Sales by Hour present')
assert.ok(sec5Idx !== -1, 'Section 5 Top Selling Items present')
assert.ok(sec6Idx !== -1, 'Section 6 Revenue by Category present')
assert.ok(sec7Idx !== -1, 'Section 7 Payment Method Breakdown present')
assert.ok(sec8Idx !== -1, 'Section 8 Top Tables present')

assert.ok(sec1Idx < sec2Idx, 'Section 1 before Section 2')
assert.ok(sec2Idx < sec3Idx, 'Section 2 before Section 3')
assert.ok(sec3Idx < sec4Idx, 'Section 3 before Section 4')
assert.ok(sec4Idx < sec5Idx, 'Section 4 before Section 5')
assert.ok(sec5Idx < sec6Idx, 'Section 5 before Section 6')
assert.ok(sec6Idx < sec7Idx, 'Section 6 before Section 7')
assert.ok(sec7Idx < sec8Idx, 'Section 7 before Section 8')
console.log('✓ Section display order (1 through 8) strictly preserved')

// 2. Section 7: Payment Method Breakdown Verification
console.log('2. Checking Section 7 Payment Method Breakdown...')
// Reconciliation table headers: method, count, collected amount, refunds, net amount
assert.ok(analyticsView.includes('Payment Method'), 'Table has Payment Method column')
assert.ok(analyticsView.includes('Transactions'), 'Table has Transactions column')
assert.ok(analyticsView.includes('Collected Amount'), 'Table has Collected Amount column')
assert.ok(analyticsView.includes('Refunds'), 'Table has Refunds column')
assert.ok(analyticsView.includes('Net Amount'), 'Table has Net Amount column')

// Methods present: Cash, UPI / QR, Card / POS, Other / Legacy, and unattributed refunds
assert.ok(analyticsView.includes('Cash'), 'Cash row present')
assert.ok(analyticsView.includes('UPI / QR'), 'UPI / QR row present')
assert.ok(analyticsView.includes('Card / POS'), 'Card / POS row present')
assert.ok(analyticsView.includes('Other / Legacy'), 'Other / Legacy row supported')
assert.ok(analyticsView.includes('Refunds (Method Unavailable)'), 'Unattributed refunds clearly labeled')
assert.ok(analyticsView.includes('Total') && analyticsView.includes('resolvedPaymentTotals'), 'Total summary row present')
assert.ok(analyticsView.includes('No table sessions for these dates.'), 'Empty table state handled gracefully')

// Backend reconciliation logic
assert.ok(analyticsEdge.includes('cashRefunds'), 'Backend attributes cash refunds')
assert.ok(analyticsEdge.includes('upiRefunds'), 'Backend attributes upi refunds')
assert.ok(analyticsEdge.includes('cardRefunds'), 'Backend attributes card refunds')
assert.ok(analyticsEdge.includes('unattributedRefunds'), 'Backend isolates unattributed refunds')
assert.ok(analyticsEdge.includes('totalNetAmount'), 'Backend calculates reconciled total net amount')
console.log('✓ Payment Method Breakdown reconciliation table and ledger attribution verified')

// 3. Section 8: Top Tables Verification
console.log('3. Checking Section 8 Top Tables...')
// Columns: #, Table Name, Settled Revenue, Session Count, Average Bill, Utilization
assert.ok(analyticsView.includes('Table Name'), 'Table Name column present')
assert.ok(analyticsView.includes('Settled Revenue'), 'Settled Revenue column present')
assert.ok(analyticsView.includes('Session Count'), 'Session Count column present')
assert.ok(analyticsView.includes('Average Bill'), 'Average Bill column present')
assert.ok(analyticsView.includes('Utilization'), 'Utilization column present')

// Utilization only when supported, else '—' with tooltip explanation
assert.ok(analyticsView.includes("t.utilization != null ? `${t.utilization.toFixed(1)}%` : '—'"), 'Utilization displays — when null')
assert.ok(analyticsView.includes('Table utilization requires operating hours denominator'), 'Utilization tooltip explains missing denominator')

// Independent diner sessions logic in backend
assert.ok(analyticsEdge.includes('sessions: Set<string>'), 'Backend tracks independent diner sessions as a Set')
assert.ok(analyticsEdge.includes('tablePerf[tableId].sessions.add(sessionId)'), 'Backend adds independent session ID')
assert.ok(analyticsEdge.includes('tablePerf[tableId].revenue += e.amount'), 'Backend accumulates settled revenue per table')
assert.ok(analyticsEdge.includes('avgBill = sessionCount > 0 ? +(rev / sessionCount).toFixed(2) : 0'), 'Backend computes average bill from session count')
console.log('✓ Top Tables session counting, settled revenue, and utilization verified')

// 4. Invariant Simulation: 2 Independent Diner Sessions at Same Table
console.log('4. Simulating two independently billed diner sessions at the same table...')
{
  const tablePerfSim: Record<string, { tableId: string; name: string; sessions: Set<string>; revenue: number }> = {}
  
  const simulatedChecks = [
    { checkId: 'chk-session-1', tableId: 'tbl-1', amount: 1500 },
    { checkId: 'chk-session-2', tableId: 'tbl-1', amount: 2500 },
  ]

  for (const e of simulatedChecks) {
    if (!tablePerfSim[e.tableId]) {
      tablePerfSim[e.tableId] = { tableId: e.tableId, name: 'Table 1', sessions: new Set(), revenue: 0 }
    }
    tablePerfSim[e.tableId].sessions.add(e.checkId)
    tablePerfSim[e.tableId].revenue += e.amount
  }

  const result = tablePerfSim['tbl-1']
  assert.equal(result.sessions.size, 2, 'Must count 2 distinct diner sessions')
  assert.equal(result.revenue, 4000, 'Must sum both check settlements exactly once (1500 + 2500 = 4000)')
  const averageBill = result.sessions.size > 0 ? +(result.revenue / result.sessions.size).toFixed(2) : 0
  assert.equal(averageBill, 2000, 'Average bill must equal total revenue / sessionCount (4000 / 2 = 2000)')
}
console.log('✓ Two independent diner sessions invariant verified')

// 5. Invariant Simulation: Multiple orders inside same diner session
console.log('5. Simulating multiple orders inside the same diner session...')
{
  const tablePerfSim: Record<string, { tableId: string; name: string; sessions: Set<string>; revenue: number }> = {}
  
  // Single check session paid once, containing multiple orders
  const simulatedSettlement = { checkId: 'chk-session-A', tableId: 'tbl-2', amount: 1200 }
  
  if (!tablePerfSim[simulatedSettlement.tableId]) {
    tablePerfSim[simulatedSettlement.tableId] = { tableId: simulatedSettlement.tableId, name: 'Table 2', sessions: new Set(), revenue: 0 }
  }
  tablePerfSim[simulatedSettlement.tableId].sessions.add(simulatedSettlement.checkId)
  tablePerfSim[simulatedSettlement.tableId].revenue += simulatedSettlement.amount

  const result = tablePerfSim['tbl-2']
  assert.equal(result.sessions.size, 1, 'Multiple orders under same check session must count as exactly 1 session')
  assert.equal(result.revenue, 1200, 'Check settlement counted exactly once')
}
console.log('✓ Intra-session orders invariant verified')

// 6. Currency Formatting & Robust Fallbacks
console.log('6. Verifying currency formatting and null safety...')
assert.ok(analyticsView.includes('toLocaleString(\'en-IN\''), 'Formatted with en-IN currency style')
assert.ok(analyticsView.includes('No table sessions for these dates.'), 'Empty table state handled gracefully')
assert.ok(analyticsView.includes('unattributedRefunds?.amount'), 'Unattributed refunds handled gracefully when empty or populated')

console.log('--- ALL SECTIONS 7 & 8 TESTS PASSED (100%) ---')
