'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banknote, CalendarDays, Check, CreditCard, Info, Layers, Loader2, Power, ReceiptText, RotateCw, Table2, Timer, Wallet, X } from 'lucide-react'
import { edgeFetch } from '@/lib/edge'
import { describeFailure } from '@/lib/api-error'
import { formatCurrency } from '@/lib/constants'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function UpiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn('size-6 sm:size-7', className)} aria-hidden="true">
      <path d="M12 3.5L5 19.5H10.5L14.5 9L12 3.5Z" fill="#EA580C" />
      <path d="M14.5 9L10.5 19.5H19L14.5 9Z" fill="#16A34A" />
    </svg>
  )
}

type Method = 'CASH' | 'UPI' | 'CARD'

const METHODS: { value: Method; label: string; icon: any }[] = [
  { value: 'CASH', label: 'Cash', icon: Banknote },
  { value: 'UPI', label: 'UPI', icon: UpiLogo },
  { value: 'CARD', label: 'Card', icon: CreditCard },
]

type Totals = {
  subtotal: number
  discount?: number
  tax: number
  serviceCharge?: number
  serviceRate?: number
  roundOff?: number
  total: number
  outstanding: number
}

export function SessionPaymentDialog({
  tableId,
  checkId,
  sessionId,
  tableName,
  tableHint,
  currencySymbol = '₹',
  open,
  onOpenChange,
  onPaid,
  onViewSession,
  onViewBill,
  startedAt,
}: {
  tableId: string | null
  checkId: string | null
  sessionId?: string | null
  tableName: string | null
  /** "Main Hall · Dine In" — the sitting's own description. */
  tableHint?: string
  currencySymbol?: string
  open: boolean
  onOpenChange: (v: boolean) => void
  /** Fired after a successful settle, so the board can refresh. */
  onPaid?: () => void
  /** "View Session Details" on the receipt screen. */
  onViewSession?: () => void
  /** "View Bill" on the receipt — opens the printable bill. */
  onViewBill?: () => void
  /** When the sitting began. The check's own `opened_at` is the fallback, so
   *  the duration on the closing screen is never invented. */
  startedAt?: string | null
}) {
  const money = (n: number) => formatCurrency(n, currencySymbol)

  const [stage, setStage] = useState<'pay' | 'failed' | 'done'>('pay')
  const [method, setMethod] = useState<Method>('CASH')
  const [tender, setTender] = useState<number | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [items, setItems] = useState(0)
  const [orderCount, setOrderCount] = useState(0)
  const [ordersList, setOrdersList] = useState<any[]>([])
  const [breakup, setBreakup] = useState<{
    cgstRate: number; sgstRate: number; cgst: number; sgst: number
  } | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState<string | null>(null)
  const [paidAt, setPaidAt] = useState<Date | null>(null)
  /** The bill's own bookends, from the server — the closing screen quotes these
   *  rather than the clock on this device. */
  const [billOpenedAt, setBillOpenedAt] = useState<Date | null>(null)
  const [billClosedAt, setBillClosedAt] = useState<Date | null>(null)
  const [failedAt, setFailedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** One key per attempt: a retry after a dropped connection settles the same
   *  payment rather than taking the money twice. */
  const keyRef = useRef<string>('')

  const load = useCallback(async () => {
    if (!tableId && !checkId && !sessionId) return
    setLoading(true)
    try {
      const q = new URLSearchParams()
      if (sessionId) q.set('sessionId', sessionId)
      if (checkId) q.set('checkId', checkId)
      if (tableId) q.set('tableId', tableId)

      const res = await edgeFetch(`/api/bill/check?${q.toString()}`)
      if (!res.ok) return
      const body = await res.json()
      const live = (body?.orders ?? []).filter((o: any) => o.status !== 'CANCELLED')
      setItems(
        live.reduce(
          (n: number, o: any) =>
            n + (o.items ?? []).reduce((q: number, i: any) => q + Number(i.quantity ?? 0), 0),
          0,
        ),
      )
      setOrderCount(live.length)
      setOrdersList(live)

      const subtotal = Number(body?.totals?.subtotal ?? 0)
      const discount = Number(body?.totals?.discount ?? 0)
      const totalTax = Number(body?.totals?.tax ?? 0)
      const serviceCharge = Number(body?.totals?.serviceCharge ?? 0)
      const total = Number(body?.totals?.total ?? 0)
      const outstanding = Number(body?.totals?.outstanding ?? 0)
      const serviceRate = Number(body?.totals?.serviceRate ?? body?.serviceRate ?? (subtotal > 0 && serviceCharge > 0 ? Math.round((serviceCharge / subtotal) * 100) : 0))
      const roundOff = Number(body?.totals?.roundOff ?? body?.roundOff ?? 0)

      /* The check returns the tax already split; if not split, we derive
         CGST and SGST deterministically in integer paise. */
      const gstTotalPaise = Math.round(totalTax * 100)
      const cgstPaise = Math.ceil(gstTotalPaise / 2)
      const sgstPaise = gstTotalPaise - cgstPaise
      const cgst = Number(body?.totals?.cgst ?? +(cgstPaise / 100).toFixed(2))
      const sgst = Number(body?.totals?.sgst ?? +(sgstPaise / 100).toFixed(2))
      const taxable = Math.max(0, subtotal - discount)
      const taxRate = Number(body?.taxRate ?? body?.totals?.taxRate ?? (taxable > 0 ? +((totalTax / taxable) * 100).toFixed(1) : 5))

      setBreakup({
        cgstRate: +(taxRate / 2).toFixed(1),
        sgstRate: +(taxRate / 2).toFixed(1),
        cgst,
        sgst,
      })

      setTotals({
        subtotal,
        discount,
        tax: totalTax,
        serviceCharge,
        serviceRate,
        roundOff,
        total,
        outstanding,
      })

      const invNum = body?.invoiceNumber ?? body?.check?.invoice_number ?? null
      setInvoiceNumber(invNum)
      setBillOpenedAt(body?.openedAt ? new Date(body.openedAt) : null)
      setBillClosedAt(body?.closedAt ? new Date(body.closedAt) : null)

      // If check is already settled (status === 'PAID'), transition directly to 'done'
      if (
        body?.status === 'PAID' ||
        body?.check?.status === 'PAID' ||
        (invNum && Number(body?.totals?.outstanding ?? 0) === 0 && Number(body?.totals?.total ?? 0) > 0)
      ) {
        setPaidAt(body?.closedAt ? new Date(body.closedAt) : new Date())
        setStage('done')
        onPaid?.()
      }
    } catch {
      /* the button below reports anything that matters */
    } finally {
      setLoading(false)
    }
  }, [tableId, checkId, sessionId, tableHint, onPaid])

  useEffect(() => {
    if (!open) {
      setStage('pay')
      setBusy(false)
      setError(null)
      setTotals(null)
      setTender(null)
      return
    }
    setLoading(true)
    setTotals(null)
    setTender(null)
    keyRef.current = crypto.randomUUID()
    void load()
  }, [open, load])

  /**
   * Take the money and close the bill.
   *
   * For Cash: Atomic single-flight PostgreSQL transaction via /api/bill/settle-cash.
   * For already-settled checks (Due = ₹0): Returns existing settlement and invoice idempotently.
   */
  const pay = async () => {
    if (!totals || busy) return
    setBusy(true)
    setError(null)
    try {
      // 1. If check is already settled (Due = 0 and has total > 0 or invoice):
      // Idempotently return the existing settlement and invoice without throwing an error
      if (totals.outstanding <= 0 && (invoiceNumber || totals.total > 0)) {
        const settleRes = await edgeFetch('/api/bill/finalize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tableId,
            checkId,
            sessionId,
          }),
        })
        if (settleRes.ok) {
          const settled = await settleRes.json().catch(() => null)
          setInvoiceNumber(
            settled?.invoiceNumber ?? settled?.check?.invoiceNumber ?? invoiceNumber ?? null,
          )
          const settledAt = settled?.closedAt ? new Date(settled.closedAt) : new Date()
          setPaidAt(settledAt)
          setBillClosedAt(settledAt)
          setStage('done')
          onPaid?.()
          try {
            if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
              const bc = new BroadcastChannel('the_salad_orders_sync')
              const inv = settled?.invoiceNumber ?? settled?.check?.invoiceNumber ?? invoiceNumber ?? null
              bc.postMessage({ type: 'CHECK_UPDATED', checkId, tableId, sessionId, status: 'PAID', invoiceNumber: inv, reason: 'FINALISED' })
              if (sessionId) {
                bc.postMessage({ type: 'SESSION_ENDED', checkId, tableId, sessionId, status: 'ENDED', endedAt: settledAt.toISOString(), invoiceNumber: inv })
              }
              bc.close()
            }
          } catch {}
          void load()
          return
        }
      }

      // 2. Production Cash payment: execute atomic single-transaction settlement
      if (method === 'CASH') {
        const cashRes = await edgeFetch('/api/bill/settle-cash', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tableId,
            checkId,
            sessionId,
            idempotencyKey: keyRef.current,
          }),
        })

        if (!cashRes.ok) {
          const body = await cashRes.json().catch(() => null)
          const raw = String(body?.error ?? '')
          setError(raw || 'The cash payment could not be recorded.')
          setFailedAt(new Date())
          setStage('failed')
          return
        }

        const settled = await cashRes.json().catch(() => null)
        const invNum = settled?.invoiceNumber ?? settled?.check?.invoiceNumber ?? null
        setInvoiceNumber(invNum)
        const settledAt = settled?.closedAt ? new Date(settled.closedAt) : new Date()
        setPaidAt(settledAt)
        setBillClosedAt(settledAt)
        setStage('done')
        onPaid?.()
        try {
          if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
            const bc = new BroadcastChannel('the_salad_orders_sync')
            bc.postMessage({ type: 'CHECK_UPDATED', checkId, tableId, sessionId, status: 'PAID', invoiceNumber: invNum, reason: 'FINALISED' })
            if (sessionId) {
              bc.postMessage({ type: 'SESSION_ENDED', checkId, tableId, sessionId, status: 'ENDED', endedAt: settledAt.toISOString(), invoiceNumber: invNum })
            }
            bc.close()
          }
        } catch {}
        void load()
        return
      }

      // 3. Multi-tender fallback for UPI / Card
      const amount = totals.outstanding
      if (amount > 0) {
        const payRes = await edgeFetch('/api/bill/payment', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tableId,
            checkId,
            sessionId,
            amount,
            method,
            idempotencyKey: keyRef.current,
          }),
        })
        if (!payRes.ok) {
          const body = await payRes.json().catch(() => null)
          const raw = String(body?.error ?? '')
          setError(
            /still due on this table|already settled/i.test(raw)
              ? 'This bill was settled a moment ago. Nothing more is owed on it.'
              : raw || 'The payment could not be recorded.',
          )
          setFailedAt(new Date())
          setStage('failed')
          return
        }

        setTotals((prev) =>
          prev
            ? {
                ...prev,
                outstanding: 0,
              }
            : prev,
        )
      }

      const settleRes = await edgeFetch('/api/bill/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableId, checkId, sessionId }),
      })
      if (!settleRes.ok) {
        const body = await settleRes.json().catch(() => null)
        setError(body?.error ?? 'The payment was taken, but the bill could not be closed.')
        setFailedAt(new Date())
        setStage('failed')
        return
      }

      const settled = await settleRes.json().catch(() => null)
      setInvoiceNumber(
        settled?.invoiceNumber ?? settled?.check?.invoiceNumber ?? settled?.invoice?.number ?? null,
      )
      const settledAt = settled?.closedAt ? new Date(settled.closedAt) : new Date()
      setPaidAt(settledAt)
      setBillClosedAt(settledAt)
      setStage('done')
      onPaid?.()
      try {
        if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
          const bc = new BroadcastChannel('the_salad_orders_sync')
          const inv = settled?.invoiceNumber ?? settled?.check?.invoiceNumber ?? settled?.invoice?.number ?? null
          bc.postMessage({ type: 'CHECK_UPDATED', checkId, tableId, sessionId, status: 'PAID', invoiceNumber: inv, reason: 'FINALISED' })
          if (sessionId) {
            bc.postMessage({ type: 'SESSION_ENDED', checkId, tableId, sessionId, status: 'ENDED', endedAt: settledAt.toISOString(), invoiceNumber: inv })
          }
          bc.close()
        }
      } catch {}
      void load()
    } catch (e) {
      setError(describeFailure(e, 'the payment').message)
      setFailedAt(new Date())
      setStage('failed')
    } finally {
      setBusy(false)
    }
  }

  const failedAtLabel = failedAt
    ? `Today, ${failedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '—'
  const beganAt = startedAt ? new Date(startedAt) : billOpenedAt
  const finishedAt = billClosedAt ?? paidAt
  const startedLabel = beganAt ? clock(beganAt) : '—'
  const endedLabel = finishedAt ? clock(finishedAt) : '—'
  const durationText = beganAt && finishedAt ? elapsed(beganAt, finishedAt) : '—'
  const selectedMethod = METHODS.find((m) => m.value === method) ?? METHODS[0]
  const SelectedMethodIcon = selectedMethod.icon
  const amountToPay = totals ? (totals.outstanding > 0 ? totals.outstanding : totals.total) : 0
  const amountText = money(amountToPay)
  const paidText = money(totals?.total ?? 0)
  const contextSubtitle = `${tableName ?? 'Table'}${invoiceNumber ? ` · Inv ${invoiceNumber.startsWith('#') ? invoiceNumber : `#${invoiceNumber}`}` : ''}`

  // Clean table hint: drop "4 Seats" so metadata does not clip
  const cleanHint = useMemo(() => {
    if (!tableHint) return 'All orders in this session'
    return tableHint
      .replace(/·\s*\d+\s*Seats\s*(·|$)/i, '· ')
      .replace(/·\s*$/, '')
      .trim() || 'All orders in this session'
  }, [tableHint])

  // Quick tender chips for Cash
  const tenderOptions = useMemo(() => {
    if (!amountToPay || amountToPay <= 0) return []
    const chips: { label: string; value: number }[] = [
      { label: 'Exact', value: amountToPay },
    ]
    const roundedUp = Math.ceil(amountToPay)
    if (roundedUp > amountToPay && !chips.some((c) => c.value === roundedUp)) {
      chips.push({ label: money(roundedUp), value: roundedUp })
    }
    const benchmarks = [100, 200, 500, 1000, 2000]
    for (const b of benchmarks) {
      if (b > amountToPay && chips.length < 4) {
        chips.push({ label: `₹${b}`, value: b })
      }
    }
    return chips
  }, [amountToPay, currencySymbol])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100%-1.25rem)] max-w-[420px] max-h-[90dvh] flex flex-col gap-0 overflow-hidden rounded-[28px] border border-border/60 bg-card p-0 shadow-2xl sm:max-w-[440px]"
      >
        <DialogTitle className="sr-only">
          {stage === 'done' ? 'Payment successful' : stage === 'failed' ? 'Payment failed' : 'Complete payment'}
        </DialogTitle>

        {/* Pinned Header */}
        <div className="relative shrink-0 border-b border-border/40 px-4 pt-4 pb-3 sm:px-6">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 grid size-9 place-items-center rounded-full border border-border/80 bg-card text-foreground shadow-sm transition-colors hover:bg-secondary cursor-pointer"
          >
            <X className="size-4.5" strokeWidth={2.4} />
          </button>

          {stage === 'pay' && (
            <div className="flex items-start gap-3 pr-11">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20 sm:size-12">
                <Wallet className="size-5.5 sm:size-6 text-primary" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[20px] font-extrabold leading-tight tracking-tight text-foreground sm:text-[22px]">
                  Complete Payment
                </h2>
                <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground sm:text-[13px]">
                  Settle the bill for {tableName ?? 'this session'}
                </p>
              </div>
            </div>
          )}

          {stage === 'done' && (
            <div className="text-center pr-9">
              <h2 className="text-[20px] font-extrabold leading-tight tracking-tight text-foreground sm:text-[22px]">
                Payment Successful
              </h2>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {tableName ?? 'This session'} has been closed and settled.
              </p>
            </div>
          )}

          {stage === 'failed' && (
            <div className="text-center pr-9">
              <h2 className="text-[20px] font-extrabold leading-tight tracking-tight text-destructive sm:text-[22px]">
                Payment Failed
              </h2>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {contextSubtitle}
              </p>
            </div>
          )}
        </div>

        {/* Scrollable Middle Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 sm:px-6 scrollbar-thin">
          {/* ---- choosing a method ---- */}
          {stage === 'pay' && (
            <>
              {/* Session / Table Banner */}
              <div className="flex items-center gap-2.5 rounded-2xl bg-primary/[0.04] px-3.5 py-3 border border-primary/20">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                  <Table2 className="size-5.5 text-primary" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-bold leading-tight text-foreground sm:text-[17px]">
                    {tableName ?? 'Session'}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground sm:text-[12px]">
                    {cleanHint}
                  </p>
                </div>
                {/* Consolidated Bill / Session Bill */}
                <span aria-label="Consolidated Bill" className="shrink-0 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  Session Bill
                </span>
              </div>

              {/* Bill Summary */}
              {loading || !totals ? (
                <div className="mt-3.5 space-y-3 rounded-2xl border border-border/70 bg-card p-3.5 sm:p-4">
                  <div className="flex items-center justify-between pb-2 border-b border-border/40">
                    <div className="h-4 w-28 bg-muted animate-pulse rounded" />
                    <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  </div>
                  <div className="space-y-2.5 pt-1">
                    <div className="flex justify-between">
                      <div className="h-3.5 w-16 bg-muted animate-pulse rounded" />
                      <div className="h-3.5 w-14 bg-muted animate-pulse rounded" />
                    </div>
                    <div className="flex justify-between">
                      <div className="h-3.5 w-20 bg-muted animate-pulse rounded" />
                      <div className="h-3.5 w-12 bg-muted animate-pulse rounded" />
                    </div>
                    <div className="flex justify-between">
                      <div className="h-3.5 w-20 bg-muted animate-pulse rounded" />
                      <div className="h-3.5 w-12 bg-muted animate-pulse rounded" />
                    </div>
                  </div>
                  <div className="h-10 w-full bg-muted/60 animate-pulse rounded-xl mt-3" />
                </div>
              ) : (
                <div className="mt-3.5 rounded-2xl border border-border/70 bg-card p-3.5 shadow-xs sm:p-4">
                  <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2.5">
                    <p className="flex items-center gap-1.5 text-[14.5px] font-bold text-foreground sm:text-[15px]">
                      <Layers className="size-4 text-primary" />
                      Bill Summary
                    </p>
                    <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground sm:text-[12px]">
                      ({orderCount} Order{orderCount === 1 ? '' : 's'} · {items} Item{items === 1 ? '' : 's'})
                    </span>
                  </div>

                  <div className="mt-2.5 space-y-2 text-[13px]">
                    <Row label="Subtotal" value={money(totals.subtotal)} />
                    {totals.discount !== undefined && totals.discount > 0 && (
                      <Row label="Discount" value={`−${money(totals.discount)}`} />
                    )}
                    {breakup ? (
                      <>
                        <Row label={`CGST (${fmtPct(breakup.cgstRate)}%)`} value={money(breakup.cgst)} />
                        <Row label={`SGST (${fmtPct(breakup.sgstRate)}%)`} value={money(breakup.sgst)} />
                      </>
                    ) : (
                      <Row label="GST" value={money(totals.tax)} />
                    )}
                    {totals.serviceCharge !== undefined && totals.serviceCharge > 0 && (
                      <Row
                        label={`Service Charge (${totals.serviceRate ? `${totals.serviceRate}%` : '2%'})`}
                        value={money(totals.serviceCharge)}
                      />
                    )}
                    {totals.roundOff !== undefined && totals.roundOff !== 0 && (
                      <Row
                        label="Round Off"
                        value={`${totals.roundOff > 0 ? '+' : ''}${money(totals.roundOff)}`}
                      />
                    )}
                  </div>
                  <div className="mt-3 flex items-center justify-between rounded-xl bg-primary/10 px-3.5 py-2.5 border border-primary/20">
                    <span className="text-[14.5px] font-bold text-foreground sm:text-[15px]">Total Amount</span>
                    <span className="text-[18px] font-extrabold tabular-nums text-foreground sm:text-[19px]">
                      {money(totals.outstanding > 0 ? totals.outstanding : totals.total)}
                    </span>
                  </div>
                </div>
              )}

              {/* Payment Methods */}
              <p className="mt-3.5 flex items-center gap-1.5 text-[14px] font-bold text-foreground sm:text-[14.5px]">
                <CreditCard className="size-4 text-primary" />
                Select Payment Method
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2 sm:gap-2.5">
                {METHODS.map((m) => {
                  const active = method === m.value
                  const Icon = m.icon
                  return (
                    <button
                      type="button"
                      key={m.value}
                      onClick={() => setMethod(m.value)}
                      aria-pressed={active}
                      className={cn(
                        'relative flex flex-col items-center justify-center gap-1.5 rounded-2xl border-[1.5px] px-2 py-3 transition-all cursor-pointer',
                        active
                          ? 'border-primary bg-primary/[0.06] shadow-xs'
                          : 'border-border/80 bg-card hover:border-border hover:bg-secondary/40',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute right-2 top-2 grid size-4.5 place-items-center rounded-full transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground shadow-xs'
                            : 'border-[1.5px] border-border/80 bg-transparent',
                        )}
                      >
                        {active && <Check className="size-3" strokeWidth={3.5} />}
                      </span>
                      <Icon className={cn('size-5.5 sm:size-6', active ? 'text-primary' : 'text-foreground/75')} />
                      <span className={cn('text-[13px]', active ? 'font-bold text-foreground' : 'font-medium text-foreground')}>{m.label}</span>
                    </button>
                  )
                })}
              </div>

              {/* Quick tender chips for Cash checkout polish */}
              {method === 'CASH' && totals && tenderOptions.length > 0 && (
                <div className="mt-3 rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                  <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground mb-2">
                    <span>Quick Tender / Change:</span>
                    {tender !== null && tender > amountToPay && (
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">
                        Change: {money(tender - amountToPay)}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {tenderOptions.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => setTender(opt.value)}
                        className={cn(
                          'px-2.5 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer',
                          tender === opt.value
                            ? 'bg-primary text-primary-foreground shadow-xs'
                            : 'bg-secondary/50 border border-border/70 hover:bg-secondary text-foreground',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ---- it failed ---- */}
          {stage === 'failed' && (
            <div className="py-2">
              <div className="relative mx-auto mt-1 grid size-20 place-items-center">
                <span aria-hidden className="absolute inset-1 rounded-full bg-red-500/12" />
                <span className="relative grid size-14 place-items-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/30">
                  <X className="size-7" strokeWidth={3.2} />
                </span>
              </div>

              {/* 3-column summary */}
              <div className="mt-4 grid grid-cols-3 divide-x divide-border/60 rounded-2xl border border-border/70 bg-secondary/30 py-3 text-center">
                <div className="min-w-0 px-2">
                  <p className="text-[11.5px] font-medium text-muted-foreground">Total</p>
                  <p className="mt-1 truncate text-[14.5px] font-bold tabular-nums text-foreground sm:text-[15.5px]">
                    {amountText}
                  </p>
                </div>
                <div className="min-w-0 px-2">
                  <p className="text-[11.5px] font-medium text-muted-foreground">Method</p>
                  <p className="mt-1 inline-flex max-w-full items-center justify-center gap-1.5 text-[14px] font-bold text-foreground sm:text-[15px]">
                    <SelectedMethodIcon className="size-4 shrink-0 text-primary" />
                    <span className="truncate">{selectedMethod.label}</span>
                  </p>
                </div>
                <div className="min-w-0 px-2">
                  <p className="text-[11.5px] font-medium text-muted-foreground">Status</p>
                  <span className="mt-1 inline-flex items-center rounded-full bg-red-500/12 px-2.5 py-0.5 text-[12px] font-bold text-red-600 dark:text-red-400">
                    Failed
                  </span>
                </div>
              </div>

              {/* Error banner */}
              <div className="mt-3.5 flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/[0.06] px-3.5 py-3">
                <Info className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-red-700 dark:text-red-400">
                    {error || `Your ${selectedMethod.label} payment could not be completed.`}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                    Please try again or choose another payment method.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ---- it worked ---- */}
          {stage === 'done' && (
            <div className="py-2">
              {/* Cloche graphic */}
              <div className="relative mx-auto mt-0.5 grid size-20 place-items-center">
                <span aria-hidden className="absolute inset-2 rounded-full bg-primary/[0.10] blur-[10px]" />
                <svg
                  viewBox="0 0 84 68"
                  fill="none"
                  aria-hidden="true"
                  className="relative h-15 w-18 drop-shadow-[0_4px_10px_rgba(249,115,22,0.25)]"
                >
                  <defs>
                    <linearGradient id="clocheDomeGrad" x1="22" y1="14" x2="62" y2="50" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#FBBF24" />
                      <stop offset="50%" stopColor="#F97316" />
                      <stop offset="100%" stopColor="#EA580C" />
                    </linearGradient>
                  </defs>
                  <path d="M18 19L11 12M13 31H5M66 19L73 12M71 31H79" stroke="#F97316" strokeWidth="2.8" strokeLinecap="round" />
                  <circle cx="42" cy="14" r="3.6" fill="#F97316" />
                  <path d="M15 47C15 30.5 27 19 42 19C57 19 69 30.5 69 47H15Z" fill="url(#clocheDomeGrad)" />
                  <path d="M23.5 40C25 31 31 25.5 38.5 24" stroke="white" strokeOpacity="0.45" strokeWidth="2.4" strokeLinecap="round" />
                  <rect x="10" y="47" width="64" height="5" rx="2.5" fill="#f97316" />
                </svg>
                <span className="absolute bottom-1 right-1 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-md shadow-primary/35 ring-2 ring-card">
                  <Check className="size-3.5" strokeWidth={3.5} />
                </span>
              </div>

              {/* Invoice Banner */}
              {invoiceNumber && (
                <div className="mt-3 flex items-center justify-between rounded-2xl border border-emerald-300/80 bg-emerald-50/80 px-4 py-2.5 dark:border-emerald-800 dark:bg-emerald-950/40">
                  <div className="flex items-center gap-2">
                    <ReceiptText className="size-4 text-emerald-700 dark:text-emerald-400" />
                    <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider">
                      Invoice
                    </span>
                  </div>
                  <span className="font-mono text-sm font-extrabold text-emerald-900 dark:text-emerald-200">
                    {invoiceNumber}
                  </span>
                </div>
              )}

              {/* Table details */}
              <div className="mt-3 flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-2.5 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Table2 className="size-5" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-bold leading-tight text-foreground sm:text-[17px]">
                    {tableName ?? 'Session'}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground">
                    {cleanHint}
                  </p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#DCFCE7] px-2.5 py-0.5 text-xs font-semibold text-[#15803D] dark:bg-emerald-500/[0.15] dark:text-emerald-400">
                  <span className="grid size-3.5 place-items-center rounded-full bg-[#16A34A] text-white">
                    <Check className="size-2" strokeWidth={3.6} />
                  </span>
                  Paid
                </span>
              </div>

              {/* When it ran: compact duration formatting */}
              <div className="mt-2.5 grid grid-cols-3 divide-x divide-border/60 rounded-2xl border border-border/60 bg-secondary/30 py-2.5">
                <Fact icon={CalendarDays} label="Started at" value={startedLabel} />
                <Fact icon={Power} label="Ended at" value={endedLabel} />
                <Fact icon={Timer} label="Duration" value={durationText} />
              </div>

              {/* Bill Summary in Payment Successful */}
              <div className="mt-2.5 rounded-2xl border border-border/60 bg-card p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2">
                  <p className="flex items-center gap-1.5 text-[14px] font-bold text-foreground">
                    <Layers className="size-4 text-primary" />
                    Bill Summary
                  </p>
                  <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground">
                    {orderCount} Order{orderCount === 1 ? '' : 's'} · {items} Item{items === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-2 space-y-1.5 text-[12.5px] sm:text-[13px]">
                  <Row label="Subtotal" value={money(totals?.subtotal ?? 0)} />
                  {totals?.discount !== undefined && totals.discount > 0 && (
                    <Row label="Discount" value={`−${money(totals.discount)}`} />
                  )}
                  {breakup ? (
                    <>
                      <Row label={`CGST (${fmtPct(breakup.cgstRate)}%)`} value={money(breakup.cgst)} />
                      <Row label={`SGST (${fmtPct(breakup.sgstRate)}%)`} value={money(breakup.sgst)} />
                    </>
                  ) : (
                    <Row label="GST" value={money(totals?.tax ?? 0)} />
                  )}
                  {totals?.serviceCharge !== undefined && totals.serviceCharge > 0 && (
                    <Row
                      label={`Service Charge (${totals.serviceRate ? `${totals.serviceRate}%` : '2%'})`}
                      value={money(totals.serviceCharge)}
                    />
                  )}
                  {totals?.roundOff !== undefined && totals.roundOff !== 0 && (
                    <Row
                      label="Round Off"
                      value={`${totals.roundOff > 0 ? '+' : ''}${money(totals.roundOff)}`}
                    />
                  )}
                </div>
                <div className="mt-2.5 flex items-center justify-between rounded-xl bg-primary/10 px-3.5 py-2">
                  <span className="text-[14.5px] font-bold text-foreground">Total Paid</span>
                  <span className="text-[17px] font-extrabold tabular-nums text-foreground">
                    {paidText}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Pinned Footer Action Buttons */}
        <div className="shrink-0 border-t border-border/40 bg-card px-4 py-3 sm:px-6">
          {stage === 'pay' && (
            <Button
              onClick={() => void pay()}
              disabled={busy || loading || !totals || totals.total <= 0}
              className="h-12 w-full rounded-2xl bg-primary hover:bg-primary/90 text-[15px] font-bold text-primary-foreground shadow-md shadow-primary/25 transition-all cursor-pointer flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? (
                <Loader2 className="mr-2 size-5 animate-spin" />
              ) : (
                <span className="grid size-5.5 place-items-center rounded-full bg-white/20 text-white">
                  <Check className="size-3.5" strokeWidth={3.5} />
                </span>
              )}
              Complete Payment
              <span className="ml-2 font-extrabold tabular-nums">
                {amountText}
              </span>
            </Button>
          )}

          {stage === 'done' && (
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => onViewBill?.()}
                className="h-11 gap-2 whitespace-nowrap rounded-xl bg-primary px-3 text-[14px] font-semibold text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90 cursor-pointer"
              >
                <ReceiptText className="size-4" />
                View Bill
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (onViewSession) onViewSession()
                  else onOpenChange(false)
                }}
                className="h-11 gap-2 whitespace-nowrap rounded-xl border border-border bg-card px-3 text-[14px] font-semibold text-foreground hover:bg-secondary cursor-pointer"
              >
                Done
              </Button>
            </div>
          )}

          {stage === 'failed' && (
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => {
                  setStage('pay')
                  if ((totals?.outstanding ?? 0) > 0) {
                    keyRef.current = crypto.randomUUID()
                  }
                  void pay()
                }}
                disabled={busy}
                className="h-11 w-full rounded-xl bg-primary text-[14.5px] font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary/90 cursor-pointer"
              >
                {busy ? <Loader2 className="mr-2 size-4.5 animate-spin" /> : <RotateCw className="mr-2 size-4" />}
                Retry Payment ({selectedMethod.label})
              </Button>
              <Button
                variant="outline"
                onClick={() => setStage('pay')}
                className="h-10 w-full rounded-xl text-[14px] font-semibold text-foreground hover:bg-secondary cursor-pointer"
              >
                <CreditCard className="mr-2 size-4 text-muted-foreground" />
                Choose Another Method
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function fmtPct(n: number) {
  return String(Number(n.toFixed(2)))
}

function Fact({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-1.5 px-1.5">
      <Icon className="size-4 shrink-0 text-primary" strokeWidth={2.1} />
      <div className="min-w-0">
        <p className="truncate text-[10.5px] leading-tight text-muted-foreground">{label}</p>
        <p className="truncate text-[12.5px] font-bold leading-tight tabular-nums text-foreground">{value}</p>
      </div>
    </div>
  )
}

function clock(d: Date) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toUpperCase()
}

/** How long the sitting ran: compact duration formatting (e.g. "14h 17m", "45m") */
function elapsed(from: Date, to: Date) {
  const mins = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}
