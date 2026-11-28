type BillOrder = { total: number; paymentStatus?: string | null }
type BillCheck = {
  orderCount: number
  orderSessionIds?: ReadonlyArray<string | null>
  status: string
  invoiceNumber?: string | null
  total: number
  paid: number
  outstanding: number
}

export function canCollectEndedCheck(
  check: Pick<BillCheck, 'status' | 'orderCount' | 'invoiceNumber' | 'outstanding'> | undefined,
  hasPayPermission: boolean,
  allServed: boolean,
  hasServedOrder: boolean,
) {
  return Boolean(hasPayPermission && allServed && hasServedOrder && check &&
    ['OPEN', 'UNSETTLED'].includes(check.status) && !check.invoiceNumber &&
    check.orderCount > 0 && check.outstanding > 0)
}

/** A persisted completion plus a still-open session (or bill) survives refresh. */
export function completedOrderForSettlementRetry<T extends { status: string }>(
  sessionId: string | null,
  sessionStatus: string | undefined,
  checkStatus: string | undefined,
  orders: readonly T[],
): T | undefined {
  if (!sessionId || (sessionStatus !== 'ACTIVE' && !(sessionStatus === 'ENDED' && checkStatus === 'OPEN')) ||
      !orders.every((o) => ['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status))) return undefined
  return orders.find((o) => o.status === 'COMPLETED')
}

/** A check spanning multiple visits cannot allocate partial payments by sitting. */
export function sittingBillAmounts(
  check: BillCheck | undefined,
  sessionId: string | null,
  onTheBill: readonly BillOrder[],
) {
  const isSettledCheck = check?.status === 'PAID' || Boolean(check?.invoiceNumber)
  const sharedBill = Boolean(check && (
    check.orderCount !== onTheBill.length || !sessionId ||
    check.orderSessionIds?.length !== 1 || check.orderSessionIds[0] !== sessionId
  ))
  const localTotal = +onTheBill.reduce((n, o) => n + o.total, 0).toFixed(2)
  if (check && !sharedBill) {
    return { sharedBill, isSettledCheck, total: check.total, paid: check.paid, due: isSettledCheck ? 0 : Math.max(0, check.outstanding) }
  }
  const paid = sharedBill
    ? (isSettledCheck ? localTotal : null)
    : +onTheBill.reduce((n, o) => n + (o.paymentStatus === 'PAID' ? o.total : 0), 0).toFixed(2)
  return { sharedBill, isSettledCheck, total: localTotal, paid, due: paid === null ? null : +Math.max(0, localTotal - paid).toFixed(2) }
}
