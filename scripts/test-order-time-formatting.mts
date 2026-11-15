/**
 * Test suite for order relative timestamp formatting:
 * - Today: #2352 · Today, 02:23 PM
 * - Yesterday: #2352 · Yesterday, 02:23 PM
 * - Older: #2352 · 13 Nov 2026, 02:23 PM
 * - Timezone-aware calculation using restaurant timezone
 * - Midnight automatic flip without reloading
 *
 * Run with:
 *   npx tsx scripts/test-order-time-formatting.mts
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {
  formatOrderRelativeTime,
  msUntilMidnight,
  safeTimeZone,
  DEFAULT_RESTAURANT_TIMEZONE,
} from '../src/lib/order-time'

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

console.log('🧪 Starting Order Relative Time Formatting Verification...\n')

// ── 1. Format Unit Tests ────────────────────────────────────────────────────
console.log('▶ 1. Relative Label Formats (Today, Yesterday, Older)...')

const tz = 'Asia/Kolkata' // UTC+05:30
// Sunday, 15 Nov 2026 18:30:00 IST
const fixedNow = new Date('2026-11-15T18:30:00+05:30').getTime()

test('Today: formats as "Today, hh:mm A"', () => {
  // Order placed at 2:23 PM IST today (08:53 UTC)
  const orderIso = '2026-11-15T08:53:00Z'
  const result = formatOrderRelativeTime(orderIso, tz, fixedNow)
  assert.strictEqual(result, 'Today, 02:23 PM')
})

test('Yesterday: formats as "Yesterday, hh:mm A"', () => {
  // Order placed at 2:23 PM IST yesterday (14 Nov 08:53 UTC)
  const orderIso = '2026-11-14T08:53:00Z'
  const result = formatOrderRelativeTime(orderIso, tz, fixedNow)
  assert.strictEqual(result, 'Yesterday, 02:23 PM')
})

test('Older: formats as "D MMM YYYY, hh:mm A"', () => {
  // Order placed on 13 Nov 2026 at 2:23 PM IST
  const orderIso = '2026-11-13T08:53:00Z'
  const result = formatOrderRelativeTime(orderIso, tz, fixedNow)
  assert.strictEqual(result, '13 Nov 2026, 02:23 PM')
})

test('Null, undefined or invalid dates return fallback "—"', () => {
  assert.strictEqual(formatOrderRelativeTime(null, tz, fixedNow), '—')
  assert.strictEqual(formatOrderRelativeTime(undefined, tz, fixedNow), '—')
  assert.strictEqual(formatOrderRelativeTime('invalid-date', tz, fixedNow), '—')
})

// ── 2. Timezone-Aware Calculations ──────────────────────────────────────────
console.log('\n▶ 2. Restaurant Timezone Boundary Behavior...')

test('Respects restaurant timezone over client timezone', () => {
  // Order placed at 2026-11-15 00:15:00 UTC
  // In UTC: It is Nov 15 (Today)
  // In New York (UTC-5): It is Nov 14 19:15:00 (Yesterday)
  const orderUtc = '2026-11-15T00:15:00Z'
  const nowUtc = new Date('2026-11-15T12:00:00Z').getTime()

  const inUtc = formatOrderRelativeTime(orderUtc, 'UTC', nowUtc)
  assert.strictEqual(inUtc, 'Today, 12:15 AM')

  const inNy = formatOrderRelativeTime(orderUtc, 'America/New_York', nowUtc)
  assert.strictEqual(inNy, 'Yesterday, 07:15 PM')
})

test('Month and leap year boundaries calculate calendar day difference correctly', () => {
  // Nov 1 12:00 IST
  const nov1Now = new Date('2026-11-01T12:00:00+05:30').getTime()
  // Oct 31 16:00 IST (yesterday)
  const oct31Order = '2026-10-31T10:30:00Z'
  const resYesterday = formatOrderRelativeTime(oct31Order, tz, nov1Now)
  assert.strictEqual(resYesterday, 'Yesterday, 04:00 PM')

  // Oct 30 (2 days ago -> older)
  const oct30Order = '2026-10-30T10:30:00Z'
  const resOlder = formatOrderRelativeTime(oct30Order, tz, nov1Now)
  assert.strictEqual(resOlder, '30 Oct 2026, 04:00 PM')
})

test('Invalid timezone strings safely fallback to DEFAULT_RESTAURANT_TIMEZONE', () => {
  assert.strictEqual(safeTimeZone(''), DEFAULT_RESTAURANT_TIMEZONE)
  assert.strictEqual(safeTimeZone('Bogus/Timezone'), DEFAULT_RESTAURANT_TIMEZONE)
  assert.strictEqual(safeTimeZone('America/New_York'), 'America/New_York')
})

// ── 3. Midnight Transition Without Reload ───────────────────────────────────
console.log('\n▶ 3. Midnight Transition & Timer Calculation...')

test('msUntilMidnight calculates remaining time to next 00:00:00 IST', () => {
  // 23:59:00 IST -> 1 minute until midnight
  const oneMinBefore = new Date('2026-11-15T23:59:00+05:30').getTime()
  const ms = msUntilMidnight(tz, oneMinBefore)
  // Should be ~60,500ms (1 min + 500ms safety buffer)
  assert.ok(ms >= 59_000 && ms <= 62_000, `Expected ~60s but got ${ms}ms`)
})

test('Relative date flips automatically at midnight boundary', () => {
  const orderCreatedAt = '2026-11-15T10:00:00+05:30' // Created on Nov 15

  // 1 second before midnight: It is Today
  const justBeforeMidnight = new Date('2026-11-15T23:59:59+05:30').getTime()
  const beforeResult = formatOrderRelativeTime(orderCreatedAt, tz, justBeforeMidnight)
  assert.strictEqual(beforeResult, 'Today, 10:00 AM')

  // 1 second after midnight: It is Yesterday
  const justAfterMidnight = new Date('2026-11-16T00:00:01+05:30').getTime()
  const afterResult = formatOrderRelativeTime(orderCreatedAt, tz, justAfterMidnight)
  assert.strictEqual(afterResult, 'Yesterday, 10:00 AM')

  // 1 day later (Nov 17): It is Older
  const twoDaysLater = new Date('2026-11-17T00:00:01+05:30').getTime()
  const olderResult = formatOrderRelativeTime(orderCreatedAt, tz, twoDaysLater)
  assert.strictEqual(olderResult, '15 Nov 2026, 10:00 AM')
})

// ── 4. Codebase Wiring Verification ─────────────────────────────────────────
console.log('\n▶ 4. Orders Component Integration Verification...')

const ordersSrc = fs.readFileSync(path.resolve('src/components/views/orders.tsx'), 'utf8')
const drawerSrc = fs.readFileSync(path.resolve('src/components/shared/session-orders-drawer.tsx'), 'utf8')

test('orders.tsx imports order-time utilities', () => {
  assert.ok(ordersSrc.includes('from \'@/lib/order-time\''), 'orders.tsx must import order-time')
  assert.ok(ordersSrc.includes('formatOrderRelativeTime'), 'orders.tsx must import formatOrderRelativeTime')
  assert.ok(ordersSrc.includes('msUntilMidnight'), 'orders.tsx must import msUntilMidnight')
})

test('orders.tsx schedules midnight timer in restaurant timezone', () => {
  assert.ok(ordersSrc.includes('const restaurantTimeZone = safeTimeZone(data?.settings?.timezone)'), 'orders.tsx must resolve restaurantTimeZone')
  assert.ok(ordersSrc.includes('scheduleMidnight'), 'orders.tsx must schedule midnight timer')
  assert.ok(ordersSrc.includes('msUntilMidnight(restaurantTimeZone'), 'orders.tsx must compute msUntilMidnight for restaurantTimeZone')
})

test('SittingCard passes timeZone and now to OrderRow', () => {
  assert.ok(ordersSrc.includes('timeZone={restaurantTimeZone}'), 'SittingCard must receive timeZone')
  assert.ok(ordersSrc.includes('timeZone={timeZone}'), 'OrderRow must receive timeZone')
  assert.ok(ordersSrc.includes('now={now}'), 'OrderRow must receive now')
})

test('OrderRow renders #{order.orderNumber} · formatOrderRelativeTime', () => {
  assert.ok(ordersSrc.includes('#{order.orderNumber}</span>'), 'OrderRow must render #{order.orderNumber}')
  assert.ok(ordersSrc.includes('select-none">·</span>'), 'OrderRow must render middle dot separator')
  assert.ok(ordersSrc.includes('formatOrderRelativeTime(order.createdAt, timeZone, now)'), 'OrderRow must format with formatOrderRelativeTime')
})

test('SessionOrdersDrawer supports relative timestamp formatting', () => {
  assert.ok(drawerSrc.includes('from \'@/lib/order-time\''), 'SessionOrdersDrawer must import order-time')
  assert.ok(drawerSrc.includes('formatOrderRelativeTime(order.createdAt, timeZone)'), 'SessionOrdersDrawer must format with formatOrderRelativeTime')
})

console.log(`\nResults: ${passed} passed, ${failed} failed of ${passed + failed} checks.`)

if (failed > 0) {
  process.exit(1)
}
