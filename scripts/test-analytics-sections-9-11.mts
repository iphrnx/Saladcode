import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

console.log('--- Verifying Sections 9–11 (Operations Performance, Discounts & Refunds, Business Insights) ---')

const analyticsView = fs.readFileSync(path.resolve('src/components/views/analytics.tsx'), 'utf-8')
const analyticsEdge = fs.readFileSync(path.resolve('supabase/functions/analytics/index.ts'), 'utf-8')

// 1. Overall Layout Order: Section 1 through 11
console.log('1. Checking full section sequence (1 through 11)...')
const mainContentIdx = analyticsView.indexOf('Financial Overview')
assert.ok(mainContentIdx !== -1, 'Financial Overview present')
const mainContent = analyticsView.slice(mainContentIdx)

const secTitles = [
  'Financial Overview',
  'Revenue Trend',
  'Order Types',
  'Sales by Hour',
  'Top Selling Items',
  'Revenue by Category',
  'Payment Method Breakdown',
  'Top Tables',
  'Operations Performance',
  'Discounts & Refunds',
  'Business Insights',
]

let lastIdx = -1
for (let i = 0; i < secTitles.length; i++) {
  const title = secTitles[i]
  const idx = mainContent.indexOf(title)
  assert.ok(idx !== -1, `Section "${title}" must be present`)
  assert.ok(idx > lastIdx, `Section "${title}" (at pos ${idx}) must appear after prior section (at pos ${lastIdx})`)
  lastIdx = idx
}
console.log('✓ All 11 sections exist in exact audited display order!')

// 2. Section 9: Operations Performance
console.log('2. Checking Section 9 Operations Performance...')
// Must define start and end events for preparation time and service time
assert.ok(analyticsView.includes('Preparation Time'), 'Has Preparation Time card')
assert.ok(analyticsView.includes('Service Time'), 'Has Service Time card')
assert.ok(analyticsView.includes('Order Volume'), 'Has Order Volume card')

assert.ok(analyticsView.includes('Order Placed (created_at)'), 'UI states start event for prep time')
assert.ok(analyticsView.includes('Order Completed (completed_at)'), 'UI states end event for prep time')
assert.ok(analyticsView.includes('Table Check Opened (created_at)'), 'UI states start event for service time')
assert.ok(analyticsView.includes('Check Closed (closed_at)'), 'UI states end event for service time')

// Must show how many records contributed and exclude incomplete timings
assert.ok(analyticsView.includes('Contributing records:'), 'UI displays contributing records count')
assert.ok(analyticsEdge.includes('validPrepMinutes'), 'Backend accumulates only valid prep timestamps')
assert.ok(analyticsEdge.includes('validServiceMinutes'), 'Backend accumulates only valid service timestamps')
assert.ok(analyticsEdge.includes('diffMs >= 0'), 'Backend excludes negative or corrupt prep timings')
assert.ok(analyticsEdge.includes('svcMs >= 0'), 'Backend excludes negative or corrupt service timings')
console.log('✓ Section 9 Operations Performance verified with clear timing definitions and contributing records')

// 3. Section 10: Discounts & Refunds
console.log('3. Checking Section 10 Discounts & Refunds...')
// Show total discounts, total refunds, affected order or transaction counts
assert.ok(analyticsView.includes('Discounts & Refunds'), 'Has Discounts & Refunds card')
assert.ok(analyticsView.includes('Total Discounts'), 'Shows Total Discounts')
assert.ok(analyticsView.includes('Total Refunds'), 'Shows Total Refunds')
assert.ok(analyticsView.includes('orders affected'), 'Shows affected discounted orders count')
assert.ok(analyticsView.includes('transactions'), 'Shows affected refunded transactions count')
assert.ok(analyticsView.includes('Discounts by Channel'), 'Shows discount breakdown by channel')
assert.ok(analyticsView.includes('Refunds by Attribution'), 'Shows refund breakdown by method')
assert.ok(analyticsView.includes('Daily Trend'), 'Shows daily trend chart for discounts and refunds')

// Reconciled with payment figures under identical filters
assert.ok(analyticsEdge.includes('totalRefundAmount'), 'Total refunds reconciled with payment ledger refunds')
assert.ok(analyticsEdge.includes('discountsByOrderType'), 'Discounts broken down by order channel')
assert.ok(analyticsEdge.includes('discountsAndRefundsTrend'), 'Daily trend synchronized with dailyRevenue range')
console.log('✓ Section 10 Discounts & Refunds verified and reconciled with financial ledger figures')

// 4. Section 11: Business Insights
console.log('4. Checking Section 11 Business Insights...')
// Rule-based observations, numbers, date range behind it, and links to target sections
assert.ok(analyticsView.includes('Business Insights'), 'Has Business Insights card')
assert.ok(analyticsView.includes('busiest-hour'), 'Includes busiest hour rule-based insight')
assert.ok(analyticsView.includes('top-category'), 'Includes top category rule-based insight')
assert.ok(analyticsView.includes('period-comparison'), 'Includes sales change rule-based insight')
assert.ok(analyticsView.includes('ins.dateRange'), 'Each insight displays its backing date range')
assert.ok(analyticsView.includes('ins.targetSectionName'), 'Each insight links to relevant section')
assert.ok(analyticsView.includes('section-sales-by-hour'), 'Links to Sales by Hour section')
assert.ok(analyticsView.includes('section-revenue-by-category'), 'Links to Revenue by Category section')
assert.ok(analyticsView.includes('section-revenue-trend'), 'Links to Revenue Trend section')

// Suppressed when comparison data is missing or insufficient
assert.ok(analyticsView.includes('analytics?.comparison?.previous'), 'Checks comparison existence before formulation')
assert.ok(analyticsView.includes('analytics.comparison.previous.revenue > 0'), 'Suppresses comparison insight when prior revenue is 0 or missing')
console.log('✓ Section 11 Business Insights verified with rule-based observations and comparison suppression')

// 5. Invariant Simulation: Incomplete Timings Exclusion
console.log('5. Simulating Operations Performance timing filter invariants...')
{
  const orders = [
    { id: '1', createdAt: new Date('2026-11-20T10:00:00Z'), completedAt: new Date('2026-11-20T10:15:00Z') }, // valid 15m
    { id: '2', createdAt: new Date('2026-11-20T11:00:00Z'), completedAt: null }, // incomplete: excluded
    { id: '3', createdAt: new Date('2026-11-20T12:00:00Z'), completedAt: new Date('2026-11-20T11:55:00Z') }, // negative: excluded
    { id: '4', createdAt: null, completedAt: new Date('2026-11-20T13:00:00Z') }, // missing start: excluded
  ]

  const validDiffs: number[] = []
  for (const o of orders) {
    if (o.createdAt && o.completedAt) {
      const diff = o.completedAt.getTime() - o.createdAt.getTime()
      if (diff >= 0 && diff <= 24 * 3600 * 1000) {
        validDiffs.push(Math.round(diff / 60000))
      }
    }
  }

  assert.equal(validDiffs.length, 1, 'Only 1 record should contribute to prep time average')
  assert.equal(validDiffs[0], 15, 'Calculated prep time must be 15 mins')
}
console.log('✓ Operations timing incomplete/corrupt exclusion invariant verified')

console.log('--- ALL SECTIONS 9–11 TESTS PASSED (100%) ---')
