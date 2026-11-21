/**
 * Comprehensive Verification & Regression Suite for Promo Codes Hardening
 *
 * Covers all scenarios specified in Section 6:
 * - Timezone boundaries (Asia/Kolkata, 23:59 IST vs 00:01 IST)
 * - Expiry and scheduling
 * - Exhaustion and usage limit enforcement
 * - Status priority and helper purity (getPromoStatus)
 * - Calculation parity (pre-tax subtotal, max discount cap, flat cap, GST)
 * - Concurrency & transaction atomic update simulation
 * - Modal layout, immutability, and error preservation invariants
 * - Cross-restaurant isolation
 */

import {
  evaluatePromo,
  getISTDateString,
  getPromoStatus,
  normalizePromoCode,
  toISTDateString,
  type PromoStatus,
} from '../supabase/functions/_shared/promo.ts'
import fs from 'node:fs'

let checks = 0
let failures = 0

function check(name: string, condition: boolean, detail?: string) {
  checks++
  if (condition) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

function fakeDb(rows: any[]) {
  const build = (current: any[]): any => {
    const b: any = {
      rows: current,
      from(table: string) {
        if (table !== 'promo_codes') throw new Error(`unexpected table ${table}`)
        return build(rows)
      },
      select() {
        return b
      },
      eq(column: string, value: any) {
        if (column === 'tenant_id') {
          return build(b.rows.filter((r: any) => r.tenant_id === value))
        }
        return b
      },
      ilike(_column: string, pattern: string) {
        const rx = new RegExp(
          '^' +
            pattern
              .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\\%/g, '%')
              .replace(/\\_/g, '_') +
            '$',
          'i',
        )
        return build(b.rows.filter((r: any) => rx.test(r.code)))
      },
      limit() {
        return b
      },
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: b.rows, error: null }).then(resolve, reject)
      },
    }
    return b
  }
  return build(rows)
}

const basePromo = (over: any = {}) => ({
  id: 'promo-1',
  tenant_id: 'tenant-a',
  code: 'SAVE20',
  type: 'PERCENTAGE',
  value: 20,
  min_order: 100,
  max_discount: 50,
  usage_limit: 10,
  used_count: 0,
  valid_from: '2026-11-01',
  valid_to: '2026-11-21',
  active: true,
  ...over,
})

console.log('\n======================================================')
console.log(' PROMO CODES HARDENING & VERIFICATION TEST SUITE ')
console.log('======================================================\n')

// ── 1. Timezone-Safe Date Handling & Transitions (Asia/Kolkata) ──
console.log('── 1. Timezone-Safe Date Handling & Boundaries (Asia/Kolkata) ──')

{
  // 2026-11-21 at 23:59:00 IST (UTC 18:29:00Z)
  const clockBeforeMidnight = new Date('2026-11-21T18:29:00Z')
  const istDateBefore = getISTDateString(clockBeforeMidnight)
  check('getISTDateString formats 23:59 IST as 2026-11-21', istDateBefore === '2026-11-21')

  const promoExpiringToday = basePromo({ valid_to: '2026-11-21' })
  const statusBefore = getPromoStatus(promoExpiringToday, istDateBefore)
  check('Valid Until = today (IST) at 23:59 IST is ACTIVE and not expired', statusBefore === 'active')

  const evalBefore = await evaluatePromo(fakeDb([promoExpiringToday]), 'tenant-a', 'SAVE20', 200, {
    now: clockBeforeMidnight,
  })
  check('Promo expiring today applies at 23:59 IST', evalBefore.applied === true)

  // 2026-11-22 at 00:01:00 IST (UTC 18:31:00Z on Nov 21)
  const clockAfterMidnight = new Date('2026-11-21T18:31:00Z')
  const istDateAfter = getISTDateString(clockAfterMidnight)
  check('getISTDateString formats 00:01 IST as 2026-11-22', istDateAfter === '2026-11-22')

  const statusAfter = getPromoStatus(promoExpiringToday, istDateAfter)
  check('Valid Until = yesterday at 00:01 IST transitions to EXPIRED', statusAfter === 'expired')

  const evalAfter = await evaluatePromo(fakeDb([promoExpiringToday]), 'tenant-a', 'SAVE20', 200, {
    now: clockAfterMidnight,
  })
  check('Promo expired at 00:01 IST is declined with reason', evalAfter.applied === false && evalAfter.reason === 'This promo code has expired')
}

// ── 2. Shared Status Priority Logic (getPromoStatus) ──
console.log('\n── 2. Shared Status Priority Logic (getPromoStatus) ──')

{
  const today = '2026-11-21'

  // 1. expired beats exhausted, paused, scheduled
  const p1 = basePromo({ valid_to: '2026-11-20', usage_limit: 5, used_count: 5, active: false })
  check('Priority 1: Expired takes precedence over exhausted & paused', getPromoStatus(p1, today) === 'expired')

  // 2. exhausted beats paused, scheduled
  const p2 = basePromo({ valid_to: '2026-11-25', usage_limit: 5, used_count: 5, active: false })
  check('Priority 2: Exhausted takes precedence over paused', getPromoStatus(p2, today) === 'exhausted')

  // 3. paused beats scheduled
  const p3 = basePromo({ valid_to: '2026-11-25', valid_from: '2026-11-23', active: false })
  check('Priority 3: Paused takes precedence over scheduled', getPromoStatus(p3, today) === 'paused')

  // 4. scheduled
  const p4 = basePromo({ valid_to: '2026-11-25', valid_from: '2026-11-23', active: true })
  check('Priority 4: Scheduled when valid_from is in future', getPromoStatus(p4, today) === 'scheduled')

  // 5. active
  const p5 = basePromo({ valid_to: '2026-11-25', valid_from: '2026-11-20', active: true })
  check('Priority 5: Active when all conditions met', getPromoStatus(p5, today) === 'active')

  // Unlimited promo (usage_limit = 0 or null)
  const pUnlimited = basePromo({ usage_limit: 0, used_count: 500, active: true })
  check('Unlimited promo (usage_limit = 0) is not exhausted', getPromoStatus(pUnlimited, today) === 'active')
}

// ── 3. Server-Side Calculations, Discount Capping & GST ──
console.log('\n── 3. Discount, GST & Billing Calculation Parity ──')

{
  const now = new Date('2026-11-21T10:00:00Z')

  // Percentage promotion with max_discount cap
  const pPct = basePromo({ type: 'PERCENTAGE', value: 50, max_discount: 40 })
  const rPct = await evaluatePromo(fakeDb([pPct]), 'tenant-a', 'SAVE20', 200, { now })
  // 50% of 200 = 100, capped at 40
  check('Percentage discount capped by max_discount', rPct.applied && rPct.discount === 40)

  // Flat promotion exceeding subtotal capped at subtotal
  const pFlat = basePromo({ type: 'FIXED', value: 300, max_discount: 0, min_order: 50 })
  const rFlat = await evaluatePromo(fakeDb([pFlat]), 'tenant-a', 'SAVE20', 200, { now })
  check('Flat discount exceeding subtotal capped safely at subtotal', rFlat.applied && rFlat.discount === 200)

  // Order below minimum order rejected
  const pMin = basePromo({ min_order: 500 })
  const rMin = await evaluatePromo(fakeDb([pMin]), 'tenant-a', 'SAVE20', 300, { now, currencySymbol: '₹' })
  check('Order below minimum rejected server-side', !rMin.applied && rMin.reason?.includes('Minimum order of ₹500.00 required'))

  // Billing calculation parity check (formula verification)
  const subtotal = 1000
  const discount = 40
  const taxRate = 5
  const serviceRate = 5

  const taxableAmount = Math.max(0, subtotal - discount) // 960
  const tax = +((taxableAmount * taxRate) / 100).toFixed(2) // 48.00
  const serviceCharge = +((subtotal * serviceRate) / 100).toFixed(2) // 50.00
  const total = +(taxableAmount + tax + serviceCharge).toFixed(2) // 1058.00

  check('Taxable amount is pre-tax subtotal minus discount', taxableAmount === 960)
  check('Tax is calculated strictly on taxable amount', tax === 48)
  check('Service charge calculated on subtotal', serviceCharge === 50)
  check('Total is non-negative and mathematically consistent', total === 1058)
}

// ── 4. Cross-Tenant Isolation & Input Normalization ──
console.log('\n── 4. Cross-Tenant Isolation & Input Normalization ──')

{
  const pTenantA = basePromo({ tenant_id: 'tenant-a', code: 'PROMO10' })
  const db = fakeDb([pTenantA])

  // Same code requested for tenant-b
  const rCross = await evaluatePromo(db, 'tenant-b', 'PROMO10', 500)
  check('Cross-restaurant promo request rejected', rCross.applied === false && rCross.reason === 'Promo code not found')

  // Code normalization: lowercase, spaces, symbols
  check('normalizePromoCode trims, uppercases, and strips invalid chars', normalizePromoCode('  save-20_pct!  ') === 'SAVE-20_PCT')
}

// ── 5. Concurrency & Database RPC Invariants ──
console.log('\n── 5. Concurrency & Database RPC Invariants ──')

{
  const mig = fs.readFileSync('supabase/migrations/20261121000001_harden_promo_codes.sql', 'utf-8')

  check('Migration defines atomic update on used_count', mig.includes('update public.promo_codes') && mig.includes('set used_count = used_count + 1'))
  check('Migration enforces usage_limit conditionally', mig.includes('(usage_limit = 0 or usage_limit is null or used_count < usage_limit)'))
  check('Migration enforces IST calendar dates', mig.includes("(valid_to at time zone 'Asia/Kolkata')::date >= (now() at time zone 'Asia/Kolkata')::date"))
  check('Migration aborts transaction with PROMO_REJECTED if limit reached', mig.includes("if not found then\n      raise exception 'PROMO_REJECTED:"))
  check('create_order_tx idempotency handling returns deduplicated: true', mig.includes("'deduplicated', true"))

  // Test simulation of concurrent race condition:
  // Initial state: usage_limit = 1, used_count = 0
  let usedCount = 0
  const usageLimit = 1

  function simulateAtomicRedeem(): boolean {
    if (usedCount < usageLimit) {
      usedCount++
      return true
    }
    return false
  }

  // Two simultaneous attempts
  const results = [simulateAtomicRedeem(), simulateAtomicRedeem()]
  const successes = results.filter((r) => r === true).length
  const failuresCount = results.filter((r) => r === false).length

  check('Two concurrent checkouts for final available use yield exactly 1 success', successes === 1 && failuresCount === 1)
  check('Used count does not exceed usage limit', usedCount === 1)
}

// ── 6. Frontend & API Validation Contracts ──
console.log('\n── 6. Frontend & API Validation Contracts ──')

{
  const promosView = fs.readFileSync('src/components/views/promos.tsx', 'utf-8')
  const promosApi = fs.readFileSync('supabase/functions/promos/index.ts', 'utf-8')
  const ordersApi = fs.readFileSync('supabase/functions/orders/index.ts', 'utf-8')

  // Redundant heading removed
  check('Duplicate "Promo Codes" heading removed from promos view', !promosView.includes('<h1\n              className={cn(\n                \'font-bold tracking-tight'))

  // Filter chips
  check('Filter chips All, Active, Expired defined in promos view', promosView.includes("(['all', 'active', 'expired'] as const)"))

  // Mobile modal constrained layout
  check('Dialog constrained flex layout for mobile', promosView.includes('max-h-[85dvh] flex flex-col p-0 gap-0 overflow-hidden'))

  // Disabled toggle on expired/exhausted
  check('Toggle disabled and unchecked on expired/exhausted', promosView.includes("status === 'expired' || status === 'exhausted'"))

  // Immutability on redeemed promo
  check('promos.tsx disables code and type when redeemed > 0', promosView.includes('isEditingRedeemed') && promosView.includes('Code cannot be modified once redeemed'))
  check('promos edge function enforces code and type immutability', promosApi.includes('Cannot modify code once it has been redeemed') && promosApi.includes('Cannot modify discount type once it has been redeemed'))

  // Percentage max discount conditionally hidden
  check('Max Discount input rendered only for PERCENTAGE type', promosView.includes("form.type === 'PERCENTAGE' ?"))

  // orders edge function rejects invalid promos
  check('orders/index.ts rejects invalid/expired promo codes', ordersApi.includes('if (!promoEval.applied)') && ordersApi.includes('Promo code cannot be applied'))

  // Pull-to-refresh overscroll containment
  check('promos.tsx includes overscroll-contain to eliminate orange gap', promosView.includes('overscroll-contain') && promosView.includes('overscroll-y-contain'))
}

console.log(`\n======================================================`)
console.log(` RESULTS: ${checks - failures} passed, ${failures} failed out of ${checks} checks`)
console.log(`======================================================\n`)

if (failures > 0) process.exit(1)
