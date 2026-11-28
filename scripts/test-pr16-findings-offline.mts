import fs from 'node:fs'
import path from 'node:path'
import { canCollectEndedCheck, completedOrderForSettlementRetry, sittingBillAmounts } from '../src/lib/sitting-bill'
import { workspaceOrderReadScope } from '../supabase/functions/_shared/order-read-scope.ts'

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
  'Orders renders the shipped allocation output',
  ordersSrc.includes('sittingBillAmounts(check, sessionId, onTheBill)') && ordersSrc.includes('const billTotal = sitting.total'),
)
const sharedCheck = { total: 1070, paid: 620, outstanding: 450, orderCount: 2, orderSessionIds: ['a', 'b'], status: 'OPEN' }
const sittingA = sittingBillAmounts(sharedCheck, 'a', [{ total: 450, paymentStatus: 'UNPAID' }])
const sittingB = sittingBillAmounts(sharedCheck, 'b', [{ total: 620, paymentStatus: 'PAID' }])
assert(
  'historical open shared check preserves each total and leaves allocation unknown',
  sittingA.sharedBill && sittingA.total === 450 && sittingA.paid === null && sittingA.due === null &&
    sittingB.sharedBill && sittingB.total === 620 && sittingB.paid === null && sittingB.due === null,
)
const settled = sittingBillAmounts({ ...sharedCheck, status: 'PAID' }, 'b', [{ total: 620 }])
assert('closed paid shared check uses only this sitting’s total', settled.sharedBill && settled.paid === 620 && settled.due === 0)
const independentCheck = { total: 620, paid: 0, outstanding: 620, orderCount: 1, orderSessionIds: ['x'], status: 'OPEN' }
const independentSitting = sittingBillAmounts(independentCheck, 'x', [{ total: 610, paymentStatus: 'UNPAID' }])
assert(
  'new independent session uses check directly',
  !independentSitting.sharedBill && independentSitting.total === 620 && independentSitting.due === 620,
)
assert('same count does not prove same sitting', sittingBillAmounts(independentCheck, 'y', [{ total: 610 }]).paid === null)
assert('cancelled sitting with no bill does not invent payments', sittingBillAmounts(undefined, 'x', []).paid === 0)

const readOnlyOrders = workspaceOrderReadScope(['orders.view'])
assert('ordinary order reader gets no phone, QR token or dashboard summary', readOnlyOrders.canReadOrders && !readOnlyOrders.canReadSummary && !/customer_phone|qr_token|tables\(\*\)/.test(readOnlyOrders.select))
const cashier = workspaceOrderReadScope(['orders.view', 'payments.collect', 'dashboard.view', 'qr.manage'])
assert('cashier can see contacts and dashboard but no QR token through order projections', cashier.canReadSummary && cashier.select.includes('customer_phone') && !cashier.select.includes('qr_token'))
assert('dashboard or table permissions alone cannot authorize the order summary', !workspaceOrderReadScope(['dashboard.view', 'tables.view']).canReadSummary)
const orderApi = fs.readFileSync(path.resolve('supabase/functions/orders/index.ts'), 'utf8')
const syncApi = orderApi.slice(orderApi.indexOf('async function sync('))
assert('delta uses the same select and skips querying and serializing unauthorized summaries', syncApi.includes('.select(orderScope.select)') && syncApi.includes('orderScope.canReadSummary ? db.rpc') && syncApi.includes('...(orderScope.canReadSummary ? { summary:'))

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
assert('refund Print uses same fetch path as Download, and both return stored bytes', settingsSrc.includes("downloadInvoice(p, 'refund', target, 'print')") && subsSrc.includes('readIssuedRefundPdf(db, tenantId, row)') && !settingsSrc.includes('downloadedRefunds'))
assert(
  'subscriptions API and Billing Settings preserve null amount without substituting full payment',
  subsSrc.includes('row.amount === null || row.amount === undefined ? null : Number(row.amount)') &&
    settingsSrc.includes('Refund amount awaiting verification'),
)

console.log('\n── Ended check collection and persisted settlement recovery ──')
const unpaid = { status: 'OPEN', orderCount: 1, outstanding: 50, invoiceNumber: null }
for (const status of ['OPEN', 'UNSETTLED']) {
  assert(`${status} ended check is collectible`, canCollectEndedCheck({ ...unpaid, status }, true, true, true))
}
for (const status of ['PAID', 'CANCELLED', 'VOID', 'VOIDED']) {
  assert(`${status} check is not collectible`, !canCollectEndedCheck({ ...unpaid, status }, true, true, true))
}
assert('collection requires payment permission', !canCollectEndedCheck(unpaid, false, true, true))
assert('any unserved order blocks collection', !canCollectEndedCheck(unpaid, true, false, true))
assert('all-cancelled check cannot be collected', !canCollectEndedCheck(unpaid, true, true, false))
assert('an already-issued invoice blocks collection', !canCollectEndedCheck({ ...unpaid, invoiceNumber: 'INV-1' }, true, true, true))
assert('zero outstanding is not collectible', !canCollectEndedCheck({ ...unpaid, outstanding: 0 }, true, true, true))
const persistedOrder = { id: 'already-committed', status: 'COMPLETED' }
assert('persisted completed order can retry an active session after refresh', completedOrderForSettlementRetry('sitting', 'ACTIVE', 'OPEN', [persistedOrder]) === persistedOrder)
assert('persisted completed order can retry an ended session with a still-open check', completedOrderForSettlementRetry('sitting', 'ENDED', 'OPEN', [persistedOrder]) === persistedOrder)
assert('a served sibling ticket in this same session keeps it open', !completedOrderForSettlementRetry('sitting', 'ACTIVE', 'OPEN', [persistedOrder, { id: 'still-serving', status: 'SERVED' }]))
assert('a settled ended session does not offer retry', !completedOrderForSettlementRetry('sitting', 'ENDED', 'PAID', [persistedOrder]))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
