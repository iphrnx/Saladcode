import fs from 'node:fs'
import path from 'node:path'

let passed = 0
let failed = 0

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Refund email deduplication across upgrade
// ---------------------------------------------------------------------------
console.log('\n── Finding 1: Refund email deduplication ──')
const webhookSrc = fs.readFileSync(
  path.resolve('supabase/functions/razorpay-webhook/index.ts'),
  'utf8',
)
assert(
  'webhook checks existing email_events before queuing',
  webhookSrc.includes('.from("email_events")') &&
    webhookSrc.includes('.in("status", ["pending", "sent", "PENDING", "SENT"])') &&
    webhookSrc.includes('.in("event_key", Array.from(new Set(legacyEmailKeys)))'),
)

function shouldQueueRefundEmail(
  existingRows: Array<{ event_key: string; status: string }>,
  internalRefundId: string | null,
  targetPaymentId: string,
  verifiedRefundId: string | null,
): boolean {
  const emailEventKey = internalRefundId
    ? `payment_refunded:${internalRefundId}`
    : `payment_refunded:${targetPaymentId}:${verifiedRefundId ?? 'doc'}`
  const legacyKeys = new Set([
    emailEventKey,
    ...(verifiedRefundId
      ? [`payment_refunded:${targetPaymentId}:${verifiedRefundId}`]
      : [`payment_refunded:${targetPaymentId}:doc`]),
  ])
  return !existingRows.some(
    (r) => legacyKeys.has(r.event_key) && (r.status === 'pending' || r.status === 'sent'),
  )
}

assert(
  'pre-upgrade sent provider-ID email suppresses post-upgrade internal-ID email',
  shouldQueueRefundEmail(
    [{ event_key: 'payment_refunded:pay_1:rfnd_1', status: 'sent' }],
    'uuid-1',
    'pay_1',
    'rfnd_1',
  ) === false,
)
assert(
  'pre-upgrade failed email allows retry',
  shouldQueueRefundEmail(
    [{ event_key: 'payment_refunded:pay_1:rfnd_1', status: 'failed' }],
    'uuid-1',
    'pay_1',
    'rfnd_1',
  ) === true,
)
assert(
  'second distinct partial refund is not suppressed by first refund',
  shouldQueueRefundEmail(
    [{ event_key: 'payment_refunded:pay_1:rfnd_1', status: 'sent' }],
    'uuid-2',
    'pay_1',
    'rfnd_2',
  ) === true,
)

// ---------------------------------------------------------------------------
// 2. Historical shared-check sitting scoping
// ---------------------------------------------------------------------------
console.log('\n── Finding 2: Historical shared-check totals ──')
const ordersSrc = fs.readFileSync(path.resolve('src/components/views/orders.tsx'), 'utf8')
assert(
  'orders.tsx restores sharedBill scoping in sitting builder and SittingCard',
  ordersSrc.includes('check.orderSessionIds[0] !== sessionId') &&
    ordersSrc.includes('const billTotal = sitting.sharedBill ? sitting.total : (check?.total ?? sitting.total)'),
)

function computeSittingTotals(
  check: { total: number; paid: number; outstanding: number; orderCount: number; status: string },
  onTheBill: Array<{ total: number; paymentStatus: string }>,
) {
  const isSettledCheck = check.status === 'PAID'
  const sharedBill = check.orderCount !== onTheBill.length
  const fallbackTotal = +onTheBill.reduce((n, o) => n + o.total, 0).toFixed(2)
  const total = sharedBill ? fallbackTotal : check.total
  const paid = sharedBill
    ? (isSettledCheck
      ? fallbackTotal
      : +onTheBill.reduce((n, o) => n + (o.paymentStatus === 'PAID' ? o.total : 0), 0).toFixed(2))
    : (isSettledCheck ? check.paid : check.paid)
  const due = isSettledCheck ? 0 : (sharedBill ? +Math.max(0, total - paid).toFixed(2) : Math.max(0, check.outstanding))
  return { sharedBill, total, paid, due }
}

const sharedCheck = { total: 1070, paid: 620, outstanding: 450, orderCount: 2, status: 'OPEN' }
const sittingA = computeSittingTotals(sharedCheck, [{ total: 450, paymentStatus: 'UNPAID' }])
const sittingB = computeSittingTotals(sharedCheck, [{ total: 620, paymentStatus: 'PAID' }])
assert(
  'historical shared check scopes sitting A (450 unpaid) and sitting B (620 paid)',
  sittingA.sharedBill && sittingA.total === 450 && sittingA.paid === 0 && sittingA.due === 450 &&
    sittingB.sharedBill && sittingB.total === 620 && sittingB.paid === 620 && sittingB.due === 0,
)

const independentCheck = { total: 620, paid: 0, outstanding: 620, orderCount: 1, status: 'OPEN' }
const independentSitting = computeSittingTotals(independentCheck, [{ total: 620, paymentStatus: 'UNPAID' }])
assert(
  'new independent session uses check directly',
  !independentSitting.sharedBill && independentSitting.total === 620 && independentSitting.due === 620,
)

// ---------------------------------------------------------------------------
// 3. Pending refund reconciliation & unknown amount preservation
// ---------------------------------------------------------------------------
console.log('\n── Finding 3: Pending refund reconciliation & unknown amounts ──')
const reconMigration = fs.readFileSync(
  path.resolve('supabase/migrations/20261128000003_refund_reconciliation_resolution.sql'),
  'utf8',
)
assert(
  'migration drops NOT NULL on amount and adds resolved_refund_id',
  reconMigration.includes('alter column amount drop not null') &&
    reconMigration.includes('add column if not exists resolved_refund_id uuid') &&
    reconMigration.includes('case when p_refund_amount > 0 then p_refund_amount end') &&
    reconMigration.includes('and webhook_event_id = p_webhook_event_id') &&
    reconMigration.includes('create or replace function public.resolve_pending_refund_reconciliation('),
)
assert(
  'resolution never matches by amount alone',
  !reconMigration.includes('and amount ='),
)

const subsSrc = fs.readFileSync(path.resolve('supabase/functions/subscriptions/index.ts'), 'utf8')
const settingsSrc = fs.readFileSync(path.resolve('src/components/views/settings.tsx'), 'utf8')
assert(
  'subscriptions API and Billing Settings preserve null amount without substituting full payment',
  subsSrc.includes('row.amount === null || row.amount === undefined ? null : Number(row.amount)') &&
    settingsSrc.includes('Refund amount awaiting verification'),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
