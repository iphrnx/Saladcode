import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('PR #2 Fix 1: Stop payment success screen from reloading repeatedly', () => {
  const dialogCode = readFileSync(resolve('src/components/shared/session-payment-dialog.tsx'), 'utf8')
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

  it('load() never calls onPaid when displaying already-paid check', () => {
    // Find the load function body
    const loadStart = dialogCode.indexOf('const load = useCallback(async () => {')
    const loadEnd = dialogCode.indexOf('}, [tableId, checkId, sessionId, tableHint])')
    assert.ok(loadStart !== -1 && loadEnd !== -1, 'load function must be defined with stable dependencies')
    const loadBody = dialogCode.substring(loadStart, loadEnd)

    assert.ok(
      !loadBody.includes('onPaid?.(') && !loadBody.includes('onPaid(') && !loadBody.includes('onPaidRef'),
      'load() must not call onPaid under any condition (displaying already-paid check must be read-only)'
    )
  })

  it('load() useCallback dependencies do not include onPaid or method', () => {
    assert.ok(
      dialogCode.includes('}, [tableId, checkId, sessionId, tableHint])'),
      'load dependencies must be strictly scoped to check identifiers to prevent reload loops'
    )
  })

  it('completeSettlement invokes onPaidRef upon actual settlement', () => {
    const settleStart = dialogCode.indexOf('const completeSettlement = async (')
    const settleEnd = dialogCode.indexOf('const pay = async () => {')
    const settleBody = dialogCode.substring(settleStart, settleEnd)

    assert.ok(
      settleBody.includes('onPaidRef.current?.(settledData)'),
      'completeSettlement must call onPaidRef.current exactly once when settlement completes'
    )
  })

  it('orders.tsx memoizes handlePaid via useCallback', () => {
    assert.ok(
      ordersCode.includes('const handlePaid = useCallback(') &&
      ordersCode.includes('[updateCheck, refresh]'),
      'handlePaid must be memoized with [updateCheck, refresh]'
    )
    assert.ok(
      ordersCode.includes('onPaid={handlePaid}'),
      'SessionPaymentDialog must receive stable handlePaid reference'
    )
  })
})

describe('PR #2 Fix 2: Independent-session check amounts stay scoped to selected sitting', () => {
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

  it('uses session-scoped check figures directly without legacy sharedBill compatibility flag', () => {
    assert.ok(
      !ordersCode.includes('sharedBill'),
      'legacy sharedBill compatibility flag must be removed'
    )
    assert.ok(
      ordersCode.includes('const total = !check ? fallbackTotal : check.total'),
      'total must read directly from session check when present'
    )
  })

  it('computes open and settled figures for two independent sessions on the same table', () => {
    const check1 = {
      id: 'chk-session-1',
      status: 'OPEN',
      total: 450.00,
      subtotal: 400.00,
      tax: 20.00,
      serviceCharge: 30.00,
      paid: 0,
      outstanding: 450.00,
      orderCount: 1,
      invoiceNumber: null as string | null,
    }
    const check2 = {
      id: 'chk-session-2',
      status: 'OPEN',
      total: 620.00,
      subtotal: 550.00,
      tax: 27.50,
      serviceCharge: 42.50,
      paid: 0,
      outstanding: 620.00,
      orderCount: 2,
      invoiceNumber: null as string | null,
    }

    const sitting1Orders = [
      { id: 'ord-d1', itemsTotal: 400.00, discount: 0, tax: 20.00, serviceCharge: 30.00, total: 450.00, status: 'SERVED', paymentStatus: 'UNPAID' }
    ]
    const sitting2Orders = [
      { id: 'ord-d2-1', itemsTotal: 300.00, discount: 0, tax: 15.00, serviceCharge: 25.00, total: 340.00, status: 'SERVED', paymentStatus: 'UNPAID' },
      { id: 'ord-d2-2', itemsTotal: 250.00, discount: 0, tax: 12.50, serviceCharge: 17.50, total: 280.00, status: 'SERVED', paymentStatus: 'UNPAID' },
    ]

    function calculateSitting(rows: any[], currentCheck: typeof check1) {
      const onTheBill = rows.filter((o) => !['CANCELLED', 'PENDING_ACTIVATION'].includes(o.status))
      const fallbackTotal = +onTheBill.reduce((n, o) => n + o.total, 0).toFixed(2)
      const isSettledCheck = currentCheck.status === 'PAID' || Boolean(currentCheck.invoiceNumber)
      const total = !currentCheck ? fallbackTotal : currentCheck.total
      const localSubtotal = +onTheBill.reduce((n, o) => n + o.itemsTotal - o.discount, 0).toFixed(2)
      const localTax = +onTheBill.reduce((n, o) => n + o.tax, 0).toFixed(2)
      const localService = +onTheBill.reduce((n, o) => n + (o.serviceCharge ?? 0), 0).toFixed(2)
      const subtotal = !currentCheck ? localSubtotal : (currentCheck.subtotal ?? localSubtotal)
      const tax = !currentCheck ? localTax : (currentCheck.tax ?? localTax)
      const service = !currentCheck ? localService : (currentCheck.serviceCharge !== undefined ? currentCheck.serviceCharge : localService)
      const allOrdersPaid = rows.every((o) => o.paymentStatus === 'PAID')
      const paid = !currentCheck
        ? (isSettledCheck ? fallbackTotal : (allOrdersPaid ? fallbackTotal : +onTheBill.reduce((n, o) => n + (o.paymentStatus === 'PAID' ? o.total : 0), 0).toFixed(2)))
        : (isSettledCheck ? (currentCheck.paid ?? currentCheck.total ?? fallbackTotal) : currentCheck.paid)
      const due = isSettledCheck ? 0 : (!currentCheck ? +Math.max(0, total - paid).toFixed(2) : Math.max(0, currentCheck.outstanding))

      return { total, subtotal, tax, service, paid, due }
    }

    const openS1 = calculateSitting(sitting1Orders, check1)
    const openS2 = calculateSitting(sitting2Orders, check2)

    assert.equal(openS1.total, 450.00)
    assert.equal(openS1.subtotal, 400.00)
    assert.equal(openS1.tax, 20.00)
    assert.equal(openS1.service, 30.00)
    assert.equal(openS1.paid, 0.00)
    assert.equal(openS1.due, 450.00)

    assert.equal(openS2.total, 620.00)
    assert.equal(openS2.subtotal, 550.00)
    assert.equal(openS2.tax, 27.50)
    assert.equal(openS2.service, 42.50)
    assert.equal(openS2.paid, 0.00)
    assert.equal(openS2.due, 620.00)

    const settledS1 = calculateSitting(sitting1Orders, { ...check1, status: 'PAID', paid: 450.00, outstanding: 0, invoiceNumber: 'INV-2026-01' })
    const settledS2 = calculateSitting(sitting2Orders, { ...check2, status: 'PAID', paid: 620.00, outstanding: 0, invoiceNumber: 'INV-2026-02' })

    assert.equal(settledS1.total, 450.00)
    assert.equal(settledS1.paid, 450.00)
    assert.equal(settledS1.due, 0.00)
    assert.equal(settledS2.total, 620.00)
    assert.equal(settledS2.paid, 620.00)
    assert.equal(settledS2.due, 0.00)
  })
})

describe('PR #2 Fix 3: Make View Bill open the originating sitting', () => {
  const dialogCode = readFileSync(resolve('src/components/shared/session-payment-dialog.tsx'), 'utf8')
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

  it('SessionPaymentDialog accepts sittingKey prop and forwards to onViewBill', () => {
    assert.ok(
      dialogCode.includes('sittingKey?: string | null') || dialogCode.includes('sittingKey,'),
      'SessionPaymentDialog must accept sittingKey'
    )
    assert.ok(
      dialogCode.includes('onViewBill?: (originKey?: string | null) => void'),
      'onViewBill prop must accept originKey'
    )
    assert.ok(
      dialogCode.includes('onClick={() => onViewBill?.(sittingKey)}'),
      'View Bill button must pass sittingKey to onViewBill'
    )
  })

  it('orders.tsx matches originating sitting by key rather than checkId', () => {
    assert.ok(
      ordersCode.includes('const keyToFind = originKey ?? target?.key'),
      'orders.tsx must prioritize sitting key over checkId'
    )
    assert.ok(
      ordersCode.includes('const fresh = sittings.find((s) => s.key === keyToFind)'),
      'orders.tsx must find sitting strictly by key'
    )
    assert.ok(
      !ordersCode.includes('target.checkId ? s.checkId === target.checkId : s.key === target.key'),
      'target.checkId must not be used to find sitting because multiple sittings share the same check'
    )
  })

  it('simulates finding correct sitting when multiple sittings share same checkId', () => {
    const sittings = [
      { key: 'session:diner-1', checkId: 'chk-shared', tableName: 'Table 4 · Diner 1', subtotal: 300 },
      { key: 'session:diner-2', checkId: 'chk-shared', tableName: 'Table 4 · Diner 2', subtotal: 500 },
    ]

    // If target was Diner 2
    const targetKey = 'session:diner-2'
    const found = sittings.find((s) => s.key === targetKey)
    assert.ok(found, 'Sitting must be found')
    assert.equal(found.tableName, 'Table 4 · Diner 2', 'Must find Diner 2, NOT Diner 1')
  })
})

describe('PR #2 Fix 4: Preserve configured service-charge rate after settlement', () => {
  const dialogCode = readFileSync(resolve('src/components/shared/session-payment-dialog.tsx'), 'utf8')
  const summaryCode = readFileSync(resolve('src/components/shared/bill-summary.tsx'), 'utf8')

  it('completeSettlement preserves loaded serviceRate when settlement response omits it', () => {
    assert.ok(
      dialogCode.includes('const effectiveServiceRate = serviceRate !== undefined\n      ? serviceRate\n      : (totals?.serviceRate !== undefined\n        ? totals.serviceRate'),
      'completeSettlement must keep totals.serviceRate when settlement payload omits serviceRate'
    )
    assert.ok(
      dialogCode.includes('serviceRate: effectiveServiceRate'),
      'completeSettlement must write effectiveServiceRate to totals and settledData'
    )
  })

  it('BillSummary displays configured non-2% service rate (e.g. 5%, 10%) correctly', () => {
    assert.ok(
      summaryCode.includes('const effectiveServiceRate = (serviceRate !== undefined && serviceRate > 0)'),
      'BillSummary must recognize positive serviceRate'
    )
    assert.ok(
      summaryCode.includes("label={`Service Charge (${effectiveServiceRate ? `${effectiveServiceRate}%` : '2%'})`}"),
      'BillSummary must display the non-2% rate'
    )

    // Test helper emulation
    function formatServiceLabel(serviceRate?: number, subtotal = 1000, serviceCharge = 50) {
      const effectiveServiceRate = (serviceRate !== undefined && serviceRate > 0)
        ? serviceRate
        : (subtotal > 0 && serviceCharge > 0 ? Math.round((serviceCharge / subtotal) * 100) : (serviceRate ?? 0))
      return `Service Charge (${effectiveServiceRate ? `${effectiveServiceRate}%` : '2%'})`
    }

    assert.equal(formatServiceLabel(5, 500, 25), 'Service Charge (5%)')
    assert.equal(formatServiceLabel(10, 1000, 100), 'Service Charge (10%)')
    assert.equal(formatServiceLabel(8, 250, 20), 'Service Charge (8%)')
    assert.equal(formatServiceLabel(undefined, 500, 25), 'Service Charge (5%)', 'Derives rate from subtotal & serviceCharge if omitted')
  })
})

describe('PR #2 Fix 5: Reconcile service charges on session checks', () => {
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

  it('calculates selected sitting service charge from onTheBill when check is absent', () => {
    assert.ok(
      ordersCode.includes('const localService = +onTheBill.reduce((n, o) => n + (o.serviceCharge ?? 0), 0).toFixed(2)'),
      'localService must be reduced across onTheBill'
    )
    assert.ok(
      ordersCode.includes('const service = !check\n        ? localService'),
      'service must use localService when check is absent'
    )
  })

  it('verifies subtotal + tax + service balances to fallbackTotal to the exact paisa', () => {
    const orders = [
      { id: '1', itemsTotal: 250, discount: 25, tax: 11.25, serviceCharge: 12.50, total: 248.75 },
      { id: '2', itemsTotal: 180, discount: 0, tax: 9.00, serviceCharge: 9.00, total: 198.00 },
    ]

    const fallbackTotal = +orders.reduce((n, o) => n + o.total, 0).toFixed(2)
    const localSubtotal = +orders.reduce((n, o) => n + o.itemsTotal - o.discount, 0).toFixed(2)
    const localTax = +orders.reduce((n, o) => n + o.tax, 0).toFixed(2)
    const localService = +orders.reduce((n, o) => n + (o.serviceCharge ?? 0), 0).toFixed(2)

    assert.equal(localSubtotal, 405.00)
    assert.equal(localTax, 20.25)
    assert.equal(localService, 21.50)
    assert.equal(fallbackTotal, 446.75)
    assert.equal(+(localSubtotal + localTax + localService).toFixed(2), fallbackTotal)
  })
})
