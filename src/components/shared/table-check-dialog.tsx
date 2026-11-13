'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Receipt, IndianRupee, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { edgeFetch } from '@/lib/edge'
import { describeFailure, failIfNotOk } from '@/lib/api-error'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * The table's bill: every accepted order on the sitting, one total, one
 * invoice.
 *
 * It reads the server's check — it does not add anything up itself. The
 * numbers on this screen and the numbers in the database are the same numbers,
 * which is the whole point of having a check at all.
 */
type CheckPayload = {
  checkId: string
  status: 'OPEN' | 'PAID' | 'VOID'
  invoiceNumber: string | null
  invoiceDate: string | null
  gstin: string | null
  orderCount: number
  totals: {
    subtotal: number
    discount: number
    tax: number
    serviceCharge: number
    total: number
    paid: number
    refunded?: number
    outstanding: number
    cgst: number
    sgst: number
  }
  orders: Array<{
    id: string
    orderNumber: number
    status: string
    total: number
    items: Array<{ id: string; name: string; portion: string | null; quantity: number; total: number }>
  }>
  payments: Array<{ id: string; amount: number; method: string; status?: string; createdAt: string }>
}

export function TableCheckDialog({
  tableId,
  tableName,
  open,
  onOpenChange,
  currencySymbol = '₹',
  onSettled,
  canCollect = true,
  checkId,
}: {
  tableId: string | null
  tableName?: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  currencySymbol?: string
  onSettled?: () => void
  /**
   * Whether this viewer may take money. The payment controls are hidden, not
   * disabled, for a role without `payments.collect`: a control that answers 403
   * is a control that should not have been offered. The bill itself stays
   * readable — viewing a bill and settling it are different keys.
   */
  canCollect?: boolean
  /**
   * The sitting's own check.
   *
   * A table can hold two sittings in one day, and a lookup by table answers
   * with the newest — so a card for the earlier sitting opened the later one's
   * bill, quoting food that party never ordered. When the caller knows which
   * check its card belongs to, it says so and the lookup cannot drift.
   */
  checkId?: string | null
}) {
  const [data, setData] = useState<CheckPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<'pay' | 'settle' | null>(null)

  const money = (n: number) => `${currencySymbol}${Number(n).toLocaleString('en-IN')}`

  const load = useCallback(async () => {
    if (!tableId && !checkId) return
    setLoading(true)
    setError(null)
    try {
      const res = await edgeFetch(
        checkId
          ? `/api/bill/check?checkId=${encodeURIComponent(checkId)}`
          : `/api/bill/check?tableId=${encodeURIComponent(tableId!)}`,
      )
      if (res.status === 404) {
        setData(null)
        setError('No open bill for this table yet.')
        return
      }
      await failIfNotOk(res, 'the table bill')
      const body = await res.json()
      // Only a check-shaped payload is rendered. Anything else gets the empty
      // state: a dialog that crashes the page behind it is worse than one that
      // says it has nothing to show.
      if (!body || typeof body !== 'object' || !body.checkId) {
        setData(null)
        setError('No open bill for this table yet.')
        return
      }
      setData(body)
    } catch (e) {
      setError(describeFailure(e, 'the table bill').message)
    } finally {
      setLoading(false)
    }
  }, [tableId, checkId])

  useEffect(() => {
    if (open && (tableId || checkId)) void load()
  }, [open, tableId, checkId, load])

  // One in-flight payment per dialog: the key travels with the request so a
  // retry after a dropped connection settles the same payment, not a second one.
  const [payKey, setPayKey] = useState<string | null>(null)
  useEffect(() => {
    if (open) setPayKey(crypto.randomUUID())
  }, [open, tableId])

  // The whole POS sits behind this dialog, so a payload missing a field
  // must degrade to zero rather than take the screen down with it.
  const outstanding = data?.totals?.outstanding ?? 0
  const canSettle = Boolean(data && data.status === 'OPEN' && outstanding <= 0 && (data.totals?.total ?? 0) > 0)

  const addPayment = async () => {
    if (!data || !tableId) return
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount greater than zero')
      return
    }
    setBusy('pay')
    try {
      const res = await edgeFetch('/api/bill/payment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tableId,
          amount: value,
          idempotencyKey: payKey ?? undefined,
        }),
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => null)
        toast.error(body?.error ?? 'That amount does not fit this bill')
        return
      }
      await failIfNotOk(res, 'the payment')
      toast.success(`${money(value)} recorded`)
      setAmount('')
      setPayKey(crypto.randomUUID())
      await load()
    } catch (e) {
      toast.error(describeFailure(e, 'the payment').message)
    } finally {
      setBusy(null)
    }
  }

  const settle = async () => {
    if (!data || !tableId) return
    setBusy('settle')
    try {
      const res = await edgeFetch('/api/bill/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableId }),
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => null)
        toast.error(body?.error ?? 'This bill cannot be closed yet')
        return
      }
      await failIfNotOk(res, 'the bill')
      const body = await res.json().catch(() => null)
      toast.success(body?.invoiceNumber ? `Settled · ${body.invoiceNumber}` : 'Bill settled')
      await load()
      onSettled?.()
    } catch (e) {
      toast.error(describeFailure(e, 'the bill').message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Table bill</DialogTitle>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{tableName ?? 'Table'} · Bill</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {data?.invoiceNumber
                ? `Invoice ${data.invoiceNumber}`
                : loading
                  ? 'Loading…'
                  : `${data?.orderCount ?? 0} order${data?.orderCount === 1 ? '' : 's'}`}
            </p>
          </div>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
              data?.status === 'PAID'
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {data?.status === 'PAID' ? 'Settled' : 'Open'}
          </span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-5 py-4">
          {error && !data ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{error}</p>
          ) : loading && !data ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : data ? (
            <>
              <div className="space-y-3">
                {data.orders.map((o) => (
                  <div key={o.id} className="rounded-xl border border-border bg-secondary/20 px-3 py-2.5">
                    <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1 font-medium">
                        <Receipt className="size-3" />#{o.orderNumber}
                      </span>
                      <span>{o.status}</span>
                    </div>
                    {o.items.map((i) => (
                      <div key={i.id} className="flex items-baseline justify-between gap-2 text-[12px]">
                        <span className="min-w-0 truncate">
                          {i.quantity} × {i.name}
                          {i.portion ? ` (${i.portion})` : ''}
                        </span>
                        <span className="shrink-0 tabular-nums">{money(i.total)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div className="mt-3 space-y-1 border-t border-border pt-3 text-[12px]">
                <Row label="Subtotal" value={money(data.totals?.subtotal)} />
                {data.totals?.discount > 0 && <Row label="Discount" value={`− ${money(data.totals?.discount)}`} />}
                <Row label={`GST (CGST ${money(data.totals?.cgst)} · SGST ${money(data.totals?.sgst)})`} value={money(data.totals?.tax)} />
                {data.totals?.serviceCharge > 0 && <Row label="Service charge" value={money(data.totals?.serviceCharge)} />}
                <div className="flex items-baseline justify-between pt-1 text-sm font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{money(data.totals?.total)}</span>
                </div>
                {data.totals?.paid > 0 && <Row label="Paid" value={money(data.totals?.paid)} />}
                {(data.totals?.refunded ?? 0) > 0 && (
                  <Row label="Refunded" value={`− ${money(data.totals?.refunded ?? 0)}`} />
                )}
                {data.status === 'OPEN' && data.totals?.outstanding > 0 && (
                  <div className="flex items-baseline justify-between text-sm font-semibold text-[#ea580c]">
                    <span>Outstanding</span>
                    <span className="tabular-nums">{money(data.totals?.outstanding)}</span>
                  </div>
                )}
              </div>

              {data.payments.length > 0 && (
                <div className="mt-3 border-t border-border pt-2">
                  {data.payments.map((p) => (
                    <div
                      key={p.id}
                      className={cn(
                        'flex items-center justify-between text-[11px]',
                        p.status === 'VOID' ? 'text-muted-foreground line-through' : 'text-muted-foreground',
                      )}
                    >
                      <span>
                        {p.method}
                        {' · '}
                        {new Date(p.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        {p.status === 'VOID' ? ' · refunded' : ''}
                      </span>
                      <span className="tabular-nums">{money(p.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>

        {data?.status === 'OPEN' && canCollect && (
          <div className="border-t border-border px-5 py-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <IndianRupee className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={outstanding > 0 ? String(outstanding) : 'Amount'}
                  inputMode="decimal"
                  className="h-9 pl-7 text-[13px]"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                onClick={addPayment}
                disabled={busy !== null}
              >
                {busy === 'pay' ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                Cash
              </Button>
              <Button
                size="sm"
                className="h-9 bg-[#f97316] text-white hover:bg-[#ea580c]"
                onClick={settle}
                disabled={!canSettle || busy !== null}
                title={canSettle ? 'Close the bill and issue the invoice' : 'Settle the balance first'}
              >
                {busy === 'settle' ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1.5 size-3.5" />
                )}
                Settle
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-foreground">{value}</span>
    </div>
  )
}
