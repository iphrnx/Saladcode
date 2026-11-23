/**
 * Responsive regression tests for Restrofi Orders Session Card (PR #10)
 *
 * Verifies layout rules, responsive geometry math at 320px, 375px, 390px, 768px,
 * and 3-column desktop widths, and static component contracts.
 *
 * Run with:
 *   npx tsx scripts/test-ordercard-responsive-regressions.mts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  reconcileOrderExpansion,
  toggleOrderExpansion,
  type OrderExpansion,
} from '../src/components/views/order-expansion'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✔ ${name}`)
    passed++
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`)
    failed++
  }
}

console.log('🧪 Starting Orders Session Card Responsive Regression Suite...\n')

const ordersSrc = fs.readFileSync(path.resolve('src/components/views/orders.tsx'), 'utf8')

// ── 1. Order Header Responsive Layout Contracts ───────────────────────────
console.log('▶ 1. Order Header Responsive Layout & Wrapping Contracts...')

test('OrderRow header has flex-wrap to avoid clipping on narrow viewports', () => {
  assert.ok(
    ordersSrc.includes('flex min-h-9 flex-wrap items-center justify-between gap-x-1.5 gap-y-1 py-0.5'),
    'OrderRow header must allow flex-wrap on narrow viewports',
  )
})

test('OrderRow timestamp uses min-w-0 and truncate for responsive breathing room', () => {
  assert.ok(
    ordersSrc.includes('className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground font-medium"'),
    'Timestamp container must allow shrinking with min-w-0',
  )
  assert.ok(
    ordersSrc.includes('<span className="truncate">{formatOrderRelativeTime(order.createdAt, timeZone, now)}</span>'),
    'Timestamp label must truncate cleanly on tight widths',
  )
})

test('OrderRow accessible full timestamp is preserved in title attribute', () => {
  assert.ok(
    ordersSrc.includes('title={orderWhen(order.createdAt, { timeZone, now })}'),
    'Full accessible timestamp must be preserved in title',
  )
})

test('OrderRow status badge handles long labels like "Awaiting Acceptance" with max-w-full and truncate', () => {
  assert.ok(
    ordersSrc.includes('statusLabel = order.status === \'PENDING_ACTIVATION\' ? \'Awaiting Acceptance\''),
    'Must handle PENDING_ACTIVATION as Awaiting Acceptance',
  )
  assert.ok(
    ordersSrc.includes('max-w-full shrink-0 items-center gap-1 sm:gap-1.5 rounded-full px-2 sm:px-2.5 py-0.5 text-xs font-semibold border transition-colors'),
    'Status badge must be capped to max-w-full with responsive padding',
  )
  assert.ok(
    ordersSrc.includes('<span className="truncate">{statusLabel}</span>'),
    'Status label must truncate gracefully if viewport is constrained',
  )
})

// ── 2. Collapsed Order Preview Thumbnail Contracts ─────────────────────────
console.log('\n▶ 2. Collapsed Order Preview Thumbnail & Name Space Contracts...')

test('DishThumb uses responsive size (size-9 sm:size-10 / 36-40px)', () => {
  assert.ok(
    ordersSrc.includes('relative grid size-9 sm:size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-orange-50/70'),
    'DishThumb must use size-9 sm:size-10 (36px to 40px) instead of bloated 48px',
  )
})

test('Collapsed preview shows max 2 thumbnails on <400px and 1024px-1279px, and 3rd thumbnail on wider', () => {
  assert.ok(
    ordersSrc.includes('className="hidden min-[400px]:grid lg:hidden xl:grid"'),
    '3rd thumbnail must adapt on narrow viewports and 3-column desktop to preserve space for item names',
  )
})

test('Badge count responsive calculation adapts between viewports', () => {
  assert.ok(
    ordersSrc.includes('<span className="min-[400px]:hidden lg:inline xl:hidden">+{order.items.length - 2}</span>'),
    'On <400px and lg:hidden, badge must show +N based on 2 visible thumbnails',
  )
  assert.ok(
    ordersSrc.includes('<span className="hidden min-[400px]:inline lg:hidden xl:inline">+{order.items.length - 3}</span>'),
    'On wider viewports, badge must show +N based on 3 visible thumbnails',
  )
  assert.ok(
    ordersSrc.includes('order.items.length === 3'),
    'When items count is exactly 3, +1 badge is shown only when 3rd thumbnail is hidden',
  )
})

test('Item names preview has flex-1, min-w-0, and line-clamp-2', () => {
  assert.ok(
    ordersSrc.includes('span className="min-w-0 flex-1 pl-1 sm:pl-1.5"'),
    'Preview names wrapper must have flex-1 and min-w-0',
  )
  assert.ok(
    ordersSrc.includes('className="line-clamp-2 text-xs sm:text-[12.5px] leading-snug font-medium text-foreground/80"'),
    'Preview names must be line-clamp-2 with readable font size',
  )
})

// ── 3. Four-Column Session Information Strip Contracts ─────────────────────
console.log('\n▶ 3. Four-Column Session Strip Contracts...')

test('Session information strip uses grid-cols-4 with divider lines', () => {
  assert.ok(
    ordersSrc.includes('grid grid-cols-4 divide-x divide-orange-200/50 dark:divide-border/50 rounded-xl sm:rounded-2xl'),
    'Strip must be grid-cols-4 with divider lines',
  )
})

test('Session stats support compact count on narrow viewports (<350px) and full labels on wider', () => {
  assert.ok(
    ordersSrc.includes('<span className="hidden min-[350px]:inline"> {suffix}</span>'),
    'Orders and Items count suffixes must collapse cleanly below 350px',
  )
  assert.ok(
    ordersSrc.includes('title={title}'),
    'Each stat must provide full accessible title tooltip',
  )
})

// ── 4. Order Expansion Logic Invariance ────────────────────────────────────
console.log('\n▶ 4. Order Expansion Logic Preservation...')

test('Order expansion helper behavior: single expands, multiple starts collapsed', () => {
  const o1 = { id: 'order-1', status: 'PENDING' }
  const o2 = { id: 'order-2', status: 'PREPARING' }

  // 1 valid order -> automatically expanded
  const single = reconcileOrderExpansion(null, [o1])
  assert.equal(single.openId, 'order-1')

  // 2 valid orders -> starts collapsed (openId null)
  const multiple = reconcileOrderExpansion(single, [o1, o2])
  assert.equal(multiple.openId, null)

  // Toggle order-1 -> opens order-1
  const opened = toggleOrderExpansion(multiple, 'order-1')
  assert.equal(opened.openId, 'order-1')

  // Toggle order-1 again -> collapses order-1
  const closed = toggleOrderExpansion(opened, 'order-1')
  assert.equal(closed.openId, null)
})

// ── 5. Viewport Geometry Calculations (320px, 375px, 390px, 768px, 1024px, 1280px) ─
console.log('\n▶ 5. Viewport Geometry Assertions...')

interface ViewportConfig {
  name: string
  width: number
  outerPadding: number
  gridGap: number
  columns: number
  cardPadding: number
  buttonPadding: number
}

// In Restrofi app-shell, main is full-width (Sidebar is a slide-out sheet).
// Breakpoints for sitting board: grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3
const VIEWPORTS: ViewportConfig[] = [
  { name: 'Mobile 320px (iPhone SE)', width: 320, outerPadding: 14 * 2, gridGap: 16, columns: 1, cardPadding: 28, buttonPadding: 20 },
  { name: 'Mobile 375px (iPhone 11/SE2)', width: 375, outerPadding: 14 * 2, gridGap: 16, columns: 1, cardPadding: 28, buttonPadding: 20 },
  { name: 'Mobile 390px (iPhone 14/15)', width: 390, outerPadding: 14 * 2, gridGap: 16, columns: 1, cardPadding: 28, buttonPadding: 20 },
  { name: 'Tablet 768px (iPad Mini - 2 cols)', width: 768, outerPadding: 24 * 2, gridGap: 20, columns: 2, cardPadding: 32, buttonPadding: 24 },
  { name: 'Desktop 1024px (Small Laptop - 3 cols)', width: 1024, outerPadding: 24 * 2, gridGap: 20, columns: 3, cardPadding: 32, buttonPadding: 24 },
  { name: 'Desktop 1280px (Standard - 3 cols)', width: 1280, outerPadding: 24 * 2, gridGap: 20, columns: 3, cardPadding: 32, buttonPadding: 24 },
]

for (const vp of VIEWPORTS) {
  test(`Viewport ${vp.name}: adequate text space in collapsed preview`, () => {
    const availableWidth = vp.width - vp.outerPadding
    const cardWidth = (availableWidth - (vp.columns - 1) * vp.gridGap) / vp.columns
    const cardInnerWidth = cardWidth - vp.cardPadding
    const rowInnerWidth = cardInnerWidth - vp.buttonPadding

    // Thumbnail size is 36px on mobile, 40px on tablet/desktop
    const thumbSize = vp.width >= 640 ? 40 : 36
    const gap = 8

    // Visible thumbnails: 2 on <400px and 1024-1279px (3 cols), 3 on wider
    const visibleThumbs = (vp.width < 400 || (vp.width >= 1024 && vp.width < 1280)) ? 2 : 3
    const badgeSize = thumbSize

    // Total width of thumbnails + badge
    const thumbsTotalWidth = visibleThumbs * thumbSize + (visibleThumbs - 1) * gap + gap + badgeSize
    const remainingForText = rowInnerWidth - thumbsTotalWidth - 10

    // Ensure there is at least 95px remaining for item names preview even at worst-case 320px
    assert.ok(
      remainingForText >= 95,
      `Expected remainingForText >= 95px, got ${remainingForText.toFixed(1)}px on ${vp.name}`,
    )
  })

  test(`Viewport ${vp.name}: four-column strip column width >= 60px`, () => {
    const availableWidth = vp.width - vp.outerPadding
    const cardWidth = (availableWidth - (vp.columns - 1) * vp.gridGap) / vp.columns
    const cardInnerWidth = cardWidth - vp.cardPadding
    const colWidth = cardInnerWidth / 4

    assert.ok(
      colWidth >= 60,
      `Expected colWidth >= 60px, got ${colWidth.toFixed(1)}px on ${vp.name}`,
    )
  })
}

console.log(`\nResults: ${passed} passed, ${failed} failed of ${passed + failed} checks.`)

if (failed > 0) {
  process.exit(1)
}
