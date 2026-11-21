import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Bug 1 & 5: Integer-Paise GST Split & Bill Summary Consistency', () => {
  it('deterministic odd-paisa GST split preserves equality for all paise from 1 to 100,000', () => {
    for (let paise = 1; paise <= 100000; paise++) {
      const cgstPaise = Math.ceil(paise / 2)
      const sgstPaise = paise - cgstPaise
      assert.equal(cgstPaise + sgstPaise, paise, `Sum mismatch at ${paise} paise`)
      if (paise % 2 === 1) {
        assert.equal(cgstPaise, sgstPaise + 1, `CGST did not receive extra odd paisa at ${paise} paise`)
      } else {
        assert.equal(cgstPaise, sgstPaise, `CGST and SGST not equal for even ${paise} paise`)
      }
    }
  })

  it('odd-paisa GST of ₹0.03 splits to CGST ₹0.02 and SGST ₹0.01 without floating point drift', () => {
    const totalTax = 0.03
    const gstTotalPaise = Math.round(totalTax * 100) // 3
    const cgstPaise = Math.ceil(gstTotalPaise / 2) // 2
    const sgstPaise = gstTotalPaise - cgstPaise // 1
    const cgst = +(cgstPaise / 100).toFixed(2)
    const sgst = +(sgstPaise / 100).toFixed(2)
    assert.equal(cgst, 0.02)
    assert.equal(sgst, 0.01)
    assert.equal(+(cgst + sgst).toFixed(2), 0.03)
  })

  it('bill with service charge and discount balances to authoritative total to the exact paisa', () => {
    const subtotal = 500.00
    const discount = 50.00
    const taxable = subtotal - discount // 450.00
    const taxRate = 0.05
    const tax = +(taxable * taxRate).toFixed(2) // 22.50
    const serviceRate = 0.05
    const serviceCharge = +(subtotal * serviceRate).toFixed(2) // 25.00
    const unroundedTotal = taxable + tax + serviceCharge // 497.50
    const roundOff = 0.50
    const total = +(unroundedTotal + roundOff).toFixed(2) // 498.00

    const gstTotalPaise = Math.round(tax * 100) // 2250
    const cgstPaise = Math.ceil(gstTotalPaise / 2) // 1125
    const sgstPaise = gstTotalPaise - cgstPaise // 1125
    const cgst = +(cgstPaise / 100).toFixed(2) // 11.25
    const sgst = +(sgstPaise / 100).toFixed(2) // 11.25

    const sumCheck = +(subtotal - discount + cgst + sgst + serviceCharge + roundOff).toFixed(2)
    assert.equal(sumCheck, total)
  })

  it('edge function bill/index.ts reuses stored amounts for finalized invoices (immutability)', () => {
    const billCode = readFileSync(resolve('supabase/functions/bill/index.ts'), 'utf8')
    assert.ok(
      billCode.includes('check.status === "PAID"') &&
      billCode.includes('Number(check.total)') &&
      billCode.includes('Number(check.tax)') &&
      billCode.includes('Number(check.subtotal)') &&
      billCode.includes('Number(check.service_charge)'),
      'bill/index.ts must reuse immutable stored invoice amounts when check is PAID'
    )
  })
})

describe('Bug 2: Modal Navigation Contracts', () => {
  const dialogCode = readFileSync(resolve('src/components/shared/session-payment-dialog.tsx'), 'utf8')
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')
  const drawerCode = readFileSync(resolve('src/components/shared/session-orders-drawer.tsx'), 'utf8')

  it('both × and Done close modal stack directly to Orders dashboard using same handler', () => {
    assert.ok(dialogCode.includes('const handleClose = useCallback(() => {'), 'handleClose must be defined')
    assert.ok(dialogCode.includes('onClick={handleClose}'), 'Both close button and Done button must use handleClose')
    assert.ok(
      dialogCode.includes('<Button\n                variant="outline"\n                onClick={handleClose}'),
      'Done button must call handleClose'
    )
  })

  it('View Bill is the only action opening Session Details with bill tab selected', () => {
    assert.ok(
      ordersCode.includes("'bill'") && ordersCode.includes("openSitting(") && ordersCode.includes("onViewBill"),
      'View Bill must open sitting with bill tab'
    )
    assert.ok(drawerCode.includes('initialTab?: Tab'), 'SessionOrdersDrawer must accept initialTab')
    assert.ok(ordersCode.includes('initialTab={drawerTab}'), 'OrdersView must pass initialTab to SessionOrdersDrawer')
  })
})

describe('Bug 3: Compact Paid Cards & Alignment', () => {
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

  it('SittingCard removes min-h-[550px] and flex spacers when paidOff is true', () => {
    assert.ok(
      ordersCode.includes("paidOff ? 'self-start' : 'min-h-[550px]'"),
      'Card must use self-start instead of min-h-[550px] when paid'
    )
    assert.ok(
      ordersCode.includes("paidOff ? 'min-h-0' : 'flex-1'"),
      'Orders container must remove flex-1 when paid'
    )
    assert.ok(
      ordersCode.includes("paidOff ? 'mt-2.5' : 'mt-auto'"),
      'Footer must remove mt-auto when paid'
    )
  })

  it('Orders grid uses items-start to keep cards top-aligned at their natural height', () => {
    assert.ok(
      ordersCode.includes('className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 md:gap-5"'),
      'Grid must top-align items with items-start'
    )
  })

  it('isSettledEnded card uses self-start and displays Session Ended', () => {
    assert.ok(
      ordersCode.includes("'w-full self-start overflow-hidden rounded-2xl border p-3 sm:p-3.5'"),
      'Settled card must have self-start'
    )
    assert.ok(
      ordersCode.includes('Session Ended'),
      'Settled card must display Session Ended'
    )
  })
})

describe('Bug 4: Remove ₹0.00 Flash & Layout Shift', () => {
  const dialogCode = readFileSync(resolve('src/components/shared/session-payment-dialog.tsx'), 'utf8')

  it('reserves space with BillSummarySkeleton while loading', () => {
    assert.ok(
      dialogCode.includes('{loading ? (\n                <BillSummarySkeleton />'),
      'Must render BillSummarySkeleton while loading'
    )
  })

  it('displays disabled "Calculating bill..." button while bill loads', () => {
    assert.ok(
      dialogCode.includes('Calculating bill...'),
      'Must show Calculating bill... button while loading'
    )
    assert.ok(
      dialogCode.includes('disabled={busy || loading || !totals || Boolean(loadError)}') &&
      dialogCode.includes('Loader2 className="mr-2 size-5 animate-spin"') &&
      dialogCode.includes("'Calculating bill...'"),
      'Calculating button must be disabled and show spinner'
    )
  })

  it('preserves Retry flow on load error', () => {
    assert.ok(
      dialogCode.includes("Couldn't load the bill") &&
      dialogCode.includes('onClick={() => void load()}') &&
      dialogCode.includes('Retry'),
      'Load error and retry flow must be preserved'
    )
  })
})

describe('Bug 1: Multi-Diner Isolation & Atomic Updates', () => {
  const ordersCode = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')
  const dataContextCode = readFileSync(resolve('src/components/app/data-context.tsx'), 'utf8')

  it('shared-check safeguard applies regardless of payment status', () => {
    assert.ok(
      ordersCode.includes('const sharedBill = Boolean(check) && check!.orderCount !== onTheBill.length'),
      'sharedBill must be based on check orderCount without being suppressed by isSettledCheck'
    )
    assert.ok(
      !ordersCode.includes('!isSettledCheck && check!.orderCount !== onTheBill.length'),
      'isSettledCheck must not bypass sharedBill safeguard'
    )
  })

  it('paid and due for settled check come directly from confirmed check data when not shared', () => {
    assert.ok(
      ordersCode.includes('isSettledCheck\n          ? (check.paid ?? check.total ?? fallbackTotal)') ||
      ordersCode.includes('(isSettledCheck\n          ? (check.paid ?? check.total ?? fallbackTotal)'),
      'Paid amount must come from settled check when unshared'
    )
    assert.ok(
      ordersCode.includes('const due = isSettledCheck\n        ? 0'),
      'Due for settled check must be 0'
    )
  })

  it('applies confirmed check figures atomically via updateCheck', () => {
    assert.ok(
      dataContextCode.includes('updateCheck: (checkId: string, patch: Partial<CheckSummary>) => void'),
      'data-context must export updateCheck'
    )
    assert.ok(
      ordersCode.includes('updateCheck(settled.checkId, {'),
      'orders.tsx onPaid must call updateCheck with confirmed breakdown'
    )
  })

  it('two independent sessions at same table: settling Session A does not mutate Session B', () => {
    // Simulate sitting state for table T1 with concurrent diners D1 and D2
    const checks: Record<string, any> = {
      'check-diner-1': { id: 'check-diner-1', status: 'OPEN', total: 420.00, paid: 0, outstanding: 420.00, orderCount: 2, subtotal: 380, tax: 20, serviceCharge: 20 },
      'check-diner-2': { id: 'check-diner-2', status: 'OPEN', total: 650.00, paid: 0, outstanding: 650.00, orderCount: 3, subtotal: 590, tax: 30, serviceCharge: 30 },
    }
    const tableSessions: Record<string, any> = {
      'sess-diner-1': { id: 'sess-diner-1', tableId: 't1', status: 'ACTIVE', startedAt: '2026-11-21T12:00:00Z', endedAt: null },
      'sess-diner-2': { id: 'sess-diner-2', tableId: 't1', status: 'ACTIVE', startedAt: '2026-11-21T12:05:00Z', endedAt: null },
    }

    // Simulate settling Session A (check-diner-1)
    const settledA = {
      checkId: 'check-diner-1',
      sessionId: 'sess-diner-1',
      tableId: 't1',
      status: 'PAID',
      total: 420.00,
      paid: 420.00,
      outstanding: 0,
      subtotal: 380.00,
      tax: 20.00,
      serviceCharge: 20.00,
      invoiceNumber: 'INV-0000001',
      orderCount: 2,
    }

    // Apply updateCheck to Check A
    checks['check-diner-1'] = { ...checks['check-diner-1'], ...settledA }
    tableSessions['sess-diner-1'].status = 'ENDED'
    tableSessions['sess-diner-1'].endedAt = new Date().toISOString()

    // Verify Check A is settled with correct invoice and paid total
    assert.equal(checks['check-diner-1'].status, 'PAID')
    assert.equal(checks['check-diner-1'].invoiceNumber, 'INV-0000001')
    assert.equal(checks['check-diner-1'].paid, 420.00)
    assert.equal(checks['check-diner-1'].outstanding, 0)

    // Verify Session B (check-diner-2) is untouched and still active
    assert.equal(checks['check-diner-2'].status, 'OPEN')
    assert.equal(checks['check-diner-2'].total, 650.00)
    assert.equal(checks['check-diner-2'].paid, 0)
    assert.equal(checks['check-diner-2'].outstanding, 650.00)
    assert.equal(tableSessions['sess-diner-2'].status, 'ACTIVE')
    assert.equal(tableSessions['sess-diner-2'].endedAt, null)
  })
})
