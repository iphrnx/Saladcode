export type EndedCheckPaymentMethod = 'CASH' | 'UPI' | 'CARD'

export function createEndedCheckAttempt(checkId: string, sessionId: string, method: EndedCheckPaymentMethod, amount: number) {
  return { checkId, sessionId, endedSessionId: sessionId, method, amount, idempotencyKey: crypto.randomUUID() } as const
}

export type EndedCheckAttempt = ReturnType<typeof createEndedCheckAttempt>

export async function sendEndedCheckPayment(fetchBill: (path: string, init: RequestInit) => Promise<Response>, attempt: EndedCheckAttempt) {
  const res = await fetchBill(attempt.method === 'CASH' ? '/api/bill/settle-cash' : '/api/bill/payment', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(attempt),
  })
  const receipt = await res.json().catch(() => null)
  if (!res.ok) throw new Error(receipt?.error || 'The payment could not be confirmed.')
  if (receipt?.status !== 'PAID' || receipt.checkId !== attempt.checkId || receipt.sessionId !== attempt.sessionId ||
      receipt.paymentMethod !== attempt.method || !receipt.paymentId || !receipt.invoiceNumber || !receipt.closedAt ||
      !Number.isFinite(receipt.paid) || !Number.isFinite(receipt.total) || receipt.outstanding !== 0) {
    throw new Error('The payment could not be confirmed.')
  }
  return receipt
}
