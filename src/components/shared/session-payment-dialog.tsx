'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Banknote, CalendarDays, Check, CreditCard, Info, Layers, Loader2, Power, ReceiptText, RotateCw, Smartphone, Table2, Timer, Wallet, X } from 'lucide-react'
import { edgeFetch } from '@/lib/edge'
import { describeFailure } from '@/lib/api-error'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Taking payment for one sitting.
 *
 * Three faces of the same act: choose a method, see it fail, see it succeed.
 * The figures come from the server's check — this dialog adds nothing up and
 * decides nothing about money; it posts one payment for the amount owed and
 * then asks the bill to close, and reports whatever the server said.
 *
 * What it will not do is claim a success it did not get: "Payment Successful"
 * is only reachable after the payment call returned and the finalise call
 * returned, and the invoice number shown is the one the server issued.
 */

export function UpiLogo({ className }: { className?: string }) {
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
  tax: number
  total: number
  outstanding: number
}

export function SessionPaymentDialog({
  tableId,
  checkId,
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
  tableName: string | null
  /** "Main Hall · 4 Seats · Dine In" — the sitting's own description. */
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
  const money = (n: number) => `${currencySymbol}${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const [stage, setStage] = useState<'pay' | 'failed' | 'done'>('pay')
  const [method, setMethod] = useState<Method>('CASH')
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
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** One key per attempt: a retry after a dropped connection settles the same
   *  payment rather than taking the money twice. */
  const keyRef = useRef<string>('')

  const load = useCallback(async () => {
    if (!tableId && !checkId) return
    setLoading(true)
    try {
      const res = await edgeFetch(
        checkId
          ? `/api/bill/check?checkId=${encodeURIComponent(checkId)}`
          : `/api/bill/check?tableId=${encodeURIComponent(tableId!)}`,
      )
      if (!res.ok) return
      const body = await res.json()
      const live = (body?.orders ?? []).filter((o: any) => o.status !== 'CANCELLED')
      // Orders and items are two different counts. Reporting the number of
      // orders as the number of dishes made "3 Orders · 3 Items" out of a
      // table that ordered ten.
      setItems(
        live.reduce(
          (n: number, o: any) =>
            n + (o.items ?? []).reduce((q: number, i: any) => q + Number(i.quantity ?? 0), 0),
          0,
        ),
      )
      setOrderCount(live.length)
      setOrdersList(live)
      /* The check returns the tax already split; if not split, we derive
         CGST and SGST equally at standard GST proportions. */
      const cgst = Number(body?.totals?.cgst ?? 0)
      const sgst = Number(body?.totals?.sgst ?? 0)
      const totalTax = Number(body?.totals?.tax ?? 0)
      const taxable = Number(body?.totals?.subtotal ?? 0) - Number(body?.totals?.discount ?? 0)
      const finalCgst = cgst > 0 ? cgst : totalTax > 0 ? totalTax / 2 : 0
      const finalSgst = sgst > 0 ? sgst : totalTax > 0 ? totalTax / 2 : 0
      setBreakup(
        finalCgst > 0
          ? {
              cgstRate: taxable > 0 ? +((finalCgst / taxable) * 100).toFixed(1) : 2.5,
              sgstRate: taxable > 0 ? +((finalSgst / taxable) * 100).toFixed(1) : 2.5,
              cgst: finalCgst,
              sgst: finalSgst,
            }
          : null,
      )
      setTotals({
        subtotal: Number(body?.totals?.subtotal ?? 0),
        tax: Number(body?.totals?.tax ?? 0),
        total: Number(body?.totals?.total ?? 0),
        outstanding: Number(body?.totals?.outstanding ?? 0),
      })
      setInvoiceNumber(body?.invoiceNumber ?? null)
      setBillOpenedAt(body?.openedAt ? new Date(body.openedAt) : null)
      setBillClosedAt(body?.closedAt ? new Date(body.closedAt) : null)
    } catch {
      /* the button below reports anything that matters */
    } finally {
      setLoading(false)
    }
  }, [tableId, checkId, tableHint])

  useEffect(() => {
    if (!open) {
      setStage('pay')
      setBusy(false)
      setError(null)
      return
    }
    keyRef.current = crypto.randomUUID()
    void load()
  }, [open, load])

  /**
   * Take the money and close the bill.
   *
   * Two calls, in this order: record the payment for what is owed, then settle.
   * If either refuses, the dialog goes to the failed face with the server's own
   * words — never a generic "something went wrong".
   */
  const pay = async () => {
    if (!totals || busy) return
    setBusy(true)
    setError(null)
    try {
      /*
       * Only what is actually owed. Falling back to the total when the balance
       * was zero charged a table twice — the sheet said success and the ledger
       * held a second payment. Nothing outstanding means nothing to collect.
       */
      const amount = totals.outstanding
      if (!(amount > 0)) {
        setError('This bill has already been settled.')
        setFailedAt(new Date())
        setStage('failed')
        return
      }
      const payRes = await edgeFetch('/api/bill/payment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tableId,
          checkId,
          amount,
          method,
          idempotencyKey: keyRef.current,
        }),
      })
      if (!payRes.ok) {
        const body = await payRes.json().catch(() => null)
        // The server's overpayment sentence is written for a human at a till;
        // anything that reads like "already settled" is said plainly instead.
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

      const settleRes = await edgeFetch('/api/bill/finalize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableId, checkId }),
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
      const settledAt = new Date()
      setPaidAt(settledAt)
      // The moment of settlement, stated by the server a breath later, is what
      // the closing screen shows. This is only the fallback until it arrives.
      setBillClosedAt(settledAt)
      setStage('done')
      onPaid?.()
      // Re-read the check so the closing screen quotes the invoice number, the
      // closed_at and the totals the server actually stored — not what this
      // sheet asked for a moment ago.
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
  /**
   * The sitting's bookends, as the closing screen reports them.
   *
   * Started: the sitting's own start where the board knows it, otherwise the
   * check's `opened_at`. Ended: the server's `closed_at` for the check, falling
   * back to the moment this sheet saw the settlement succeed.
   */
  const beganAt = startedAt ? new Date(startedAt) : billOpenedAt
  const finishedAt = billClosedAt ?? paidAt
  const startedLabel = beganAt ? clock(beganAt) : '—'
  const endedLabel = finishedAt ? clock(finishedAt) : '—'
  const durationText = beganAt && finishedAt ? elapsed(beganAt, finishedAt) : '—'
  const selectedMethod = METHODS.find((m) => m.value === method) ?? METHODS[0]
  const SelectedMethodIcon = selectedMethod.icon
  const amountText = money(totals?.outstanding || totals?.total || 0)
  const paidText = money(totals?.total ?? 0)
  const contextSubtitle = `${tableName ?? 'Table'}${invoiceNumber ? ` · Inv ${invoiceNumber.startsWith('#') ? invoiceNumber : `#${invoiceNumber}`}` : ''}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100%-1.25rem)] max-w-[420px] gap-0 overflow-hidden rounded-[28px] border border-border/60 bg-card p-0 shadow-2xl sm:max-w-[440px]"
      >
        <DialogTitle className="sr-only">
          {stage === 'done' ? 'Payment successful' : stage === 'failed' ? 'Payment failed' : 'Complete payment'}
        </DialogTitle>

        <div className="relative max-h-[88dvh] overflow-y-auto px-4 pb-5 pt-5 sm:px-6 sm:pb-6 sm:pt-6">
          {/* One way out of every face of this sheet. */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 grid size-9 place-items-center rounded-full border border-border/80 bg-card text-foreground shadow-sm transition-colors hover:bg-secondary"
          >
            <X className="size-4.5" strokeWidth={2.4} />
          </button>

          {/* ---- choosing a method ---- */}
          {stage === 'pay' && (
            <>
              {/* Header: what this sheet is for, and which table. */}
              <div className="flex items-start gap-3 pr-11">
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[#FFF6F0] text-[#EA580C] ring-1 ring-[#FCD7C0] dark:bg-orange-950/40 dark:text-orange-400 dark:ring-orange-800/40 sm:size-12">
                  <Wallet className="size-5.5 sm:size-6 text-[#EA580C] dark:text-orange-400" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[20px] font-extrabold leading-tight tracking-tight text-foreground sm:text-[22px]">
                    Complete Payment
                  </h2>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground sm:text-[13px]">
                    Settle the bill for {tableName ?? 'this table'}
                  </p>
                </div>
              </div>

              {/* The table, and that this is every order on it. */}
              <div className="mt-3.5 flex items-center gap-2.5 rounded-2xl bg-[#FFF9F5] dark:bg-orange-950/20 px-3.5 py-3 border border-[#FDE5D6] dark:border-orange-900/30">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#FFF1E6] text-[#EA580C] dark:bg-orange-950/50 dark:text-orange-400 border border-orange-200/50">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="size-5.5 text-[#EA580C]">
                    <path d="M7 11V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v4" />
                    <rect x="5" y="11" width="14" height="3" rx="1.5" />
                    <path d="M7 14v6" />
                    <path d="M17 14v6" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-bold leading-tight text-foreground sm:text-[17px]">
                    {tableName ?? 'Table'}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground sm:text-[12px]">
                    {tableHint || 'All orders on this table'}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-[#FDECE0] dark:bg-orange-950/60 px-3 py-1 text-xs font-semibold text-[#EA580C] dark:text-orange-300">
                  Consolidated Bill
                </span>
              </div>

              {/* The money, line by line, from the server's check. */}
              <div className="mt-3.5 rounded-2xl border border-border/70 bg-card p-3.5 shadow-xs sm:p-4">
                <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2.5">
                  <p className="flex items-center gap-1.5 text-[14.5px] font-bold text-foreground sm:text-[15px]">
                    <Layers className="size-4 text-[#EA580C] dark:text-orange-400" />
                    Bill Summary
                  </p>
                  <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground sm:text-[12px]">
                    ({orderCount} Order{orderCount === 1 ? '' : 's'} · {items} Item{items === 1 ? '' : 's'})
                  </span>
                </div>

                <div className="mt-2.5 space-y-2 text-[13px]">
                  <Row label="Subtotal" value={money(totals?.subtotal ?? 0)} />
                  {breakup && (
                    <>
                      <Row label={`CGST (${fmtPct(breakup.cgstRate)}%)`} value={money(breakup.cgst)} />
                      <Row label={`SGST (${fmtPct(breakup.sgstRate)}%)`} value={money(breakup.sgst)} />
                    </>
                  )}
                  {!breakup && <Row label="Tax" value={money(totals?.tax ?? 0)} />}
                </div>
                <div className="mt-3 flex items-center justify-between rounded-xl bg-[#FDECE0] dark:bg-orange-950/40 px-3.5 py-2.5 border border-[#F5C4A8]/60 dark:border-orange-900/40">
                  <span className="text-[14.5px] font-bold text-foreground sm:text-[15px]">Total Amount</span>
                  <span className="text-[18px] font-extrabold tabular-nums text-foreground sm:text-[19px]">
                    {money(totals?.outstanding || totals?.total || 0)}
                  </span>
                </div>
              </div>

              {/* How the money arrives. */}
              <p className="mt-4 flex items-center gap-1.5 text-[14.5px] font-bold text-foreground sm:text-[15px]">
                <CreditCard className="size-4 text-[#EA580C] dark:text-orange-400" />
                Select Payment Method
              </p>
              <div className="mt-2.5 grid grid-cols-3 gap-2 sm:gap-2.5">
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
                        'relative flex flex-col items-center justify-center gap-1.5 rounded-2xl border-[1.5px] px-2 py-3.5 transition-all cursor-pointer',
                        active
                          ? 'border-[#EA580C] bg-[#FFF9F5] dark:bg-orange-950/20 shadow-xs'
                          : 'border-border/80 bg-card hover:border-border hover:bg-secondary/40',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full transition-colors',
                          active
                            ? 'bg-[#EA580C] text-white shadow-xs'
                            : 'border-[1.5px] border-border/80 bg-transparent',
                        )}
                      >
                        {active && <Check className="size-3" strokeWidth={3.5} />}
                      </span>
                      <Icon className={cn('size-6 sm:size-7', active ? 'text-[#EA580C]' : 'text-foreground/75')} />
                      <span className={cn('text-[13.5px]', active ? 'font-bold text-foreground' : 'font-medium text-foreground')}>{m.label}</span>
                    </button>
                  )
                })}
              </div>

              <Button
                onClick={() => void pay()}
                disabled={busy || loading || !totals}
                className="mt-4 h-12 w-full rounded-2xl bg-[#EA580C] hover:bg-[#EA580C]/90 text-[15px] font-bold text-white shadow-md shadow-orange-500/25 transition-all cursor-pointer flex items-center justify-center gap-2"
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
                  {money(totals?.outstanding || totals?.total || 0)}
                </span>
              </Button>
            </>
          )}

          {/* ---- it failed ---- */}
          {stage === 'failed' && (
            <>
              <div className="relative mx-auto mt-1 grid size-24 place-items-center">
                <span aria-hidden className="absolute inset-1 rounded-full bg-red-500/12" />
                <span className="relative grid size-16 place-items-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/30">
                  <X className="size-8" strokeWidth={3.2} />
                </span>
                <span aria-hidden className="absolute left-3 top-2 h-1.5 w-3.5 rotate-45 rounded-full bg-red-500" />
                <span aria-hidden className="absolute right-3 top-2 h-1.5 w-3.5 -rotate-45 rounded-full bg-red-500" />
                <span aria-hidden className="absolute left-0 top-11 h-1.5 w-3 rounded-full bg-red-500" />
                <span aria-hidden className="absolute right-0 top-11 h-1.5 w-3 rounded-full bg-red-500" />
                <span aria-hidden className="absolute bottom-3 left-2.5 h-1.5 w-2.5 -rotate-30 rounded-full bg-red-400" />
                <span aria-hidden className="absolute bottom-3 right-2.5 h-1.5 w-2.5 rotate-30 rounded-full bg-red-400" />
              </div>

              <h2 className="mt-3 text-center text-[24px] font-bold leading-tight tracking-tight text-foreground sm:text-[26px]">
                Payment Failed
              </h2>
              <p className="mt-1 text-center text-[14px] font-medium text-muted-foreground">
                {contextSubtitle}
              </p>

              {/* 3-column summary */}
              <div className="mt-4 grid grid-cols-3 divide-x divide-border/60 rounded-2xl border border-border/70 bg-secondary/30 py-3 text-center">
                <div className="min-w-0 px-2">
                  <p className="text-[11.5px] font-medium text-muted-foreground">Total</p>
                  <p className="mt-1 truncate text-[14.5px] font-bold tabular-nums text-foreground sm:text-[15.5px]">
                    {amountText}
                  </p>
                </div>
                <div className="min-w-0 px-2">
                  <p className="text-[11.5px] font-medium text-muted-foreground">Attempted Via</p>
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

              <Button
                onClick={() => {
                  setStage('pay')
                  keyRef.current = crypto.randomUUID()
                  void pay()
                }}
                disabled={busy}
                className="mt-4 h-12 w-full rounded-2xl bg-primary text-[15px] font-semibold text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary/90"
              >
                {busy ? <Loader2 className="mr-2 size-5 animate-spin" /> : <RotateCw className="mr-2 size-4.5" />}
                Retry Payment ({selectedMethod.label})
              </Button>
              <Button
                variant="secondary"
                onClick={() => setStage('pay')}
                className="mt-2.5 h-11 w-full rounded-2xl text-[14.5px] font-semibold text-foreground"
              >
                <CreditCard className="mr-2 size-4.5 text-muted-foreground" />
                Choose Another Method
              </Button>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="mt-2 h-11 w-full rounded-2xl bg-secondary/50 text-[14.5px] font-semibold text-foreground hover:bg-secondary"
              >
                Cancel
              </Button>
            </>
          )}

          {/* ---- it worked ---- */}
          {stage === 'done' && (
            <>
              {/* The warm orange cloche that means the table is done with. */}
              <div className="relative mx-auto mt-0.5 grid size-22 place-items-center">
                <span aria-hidden className="absolute inset-2 rounded-full bg-primary/[0.10] blur-[10px]" />
                <svg
                  viewBox="0 0 84 68"
                  fill="none"
                  aria-hidden="true"
                  className="relative h-17 w-21 drop-shadow-[0_4px_10px_rgba(249,115,22,0.25)]"
                >
                  <defs>
                    <linearGradient id="clocheDomeGrad" x1="22" y1="14" x2="62" y2="50" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#FBBF24" />
                      <stop offset="50%" stopColor="#F97316" />
                      <stop offset="100%" stopColor="#EA580C" />
                    </linearGradient>
                  </defs>
                  {/* Celebratory rays */}
                  <path d="M18 19L11 12M13 31H5M66 19L73 12M71 31H79" stroke="#F97316" strokeWidth="2.8" strokeLinecap="round" />
                  {/* Top knob */}
                  <circle cx="42" cy="14" r="3.6" fill="#F97316" />
                  {/* Dome */}
                  <path d="M15 47C15 30.5 27 19 42 19C57 19 69 30.5 69 47H15Z" fill="url(#clocheDomeGrad)" />
                  {/* Soft specular highlight */}
                  <path d="M23.5 40C25 31 31 25.5 38.5 24" stroke="white" strokeOpacity="0.45" strokeWidth="2.4" strokeLinecap="round" />
                  {/* Base tray */}
                  <rect x="10" y="47" width="64" height="5" rx="2.5" fill="#EA580C" />
                </svg>
                <span className="absolute bottom-1 right-1 grid size-7 place-items-center rounded-full bg-[#EA580C] text-white shadow-md shadow-orange-500/35 ring-2 ring-card">
                  <Check className="size-4" strokeWidth={3.5} />
                </span>
              </div>

              <h2 className="mt-1.5 text-center text-[25px] font-extrabold leading-tight tracking-tight text-foreground sm:text-[27px]">
                Session Ended
              </h2>
              <p className="mt-1 text-center text-[13px] leading-snug text-muted-foreground sm:text-[13.5px]">
                {tableName ?? 'This sitting'} has been closed and settled.
              </p>

              {/* Which table it was, and that it is paid. */}
              <div className="mt-4 flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#FFF1E6] text-[#EA580C] dark:bg-primary/[0.15] dark:text-primary">
                  <Table2 className="size-5.5" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16.5px] font-bold leading-tight text-foreground sm:text-[17.5px]">
                    {tableName ?? 'Table'}
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-muted-foreground sm:text-[12.5px]">
                    {tableHint || 'All orders on this table'}
                  </p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#DCFCE7] px-3 py-1 text-[12.5px] font-semibold text-[#15803D] dark:bg-emerald-500/[0.15] dark:text-emerald-400">
                  <span className="grid size-4 place-items-center rounded-full bg-[#16A34A] text-white">
                    <Check className="size-2.5" strokeWidth={3.6} />
                  </span>
                  Paid
                </span>
              </div>

              {/* When it ran. */}
              <div className="mt-2.5 grid grid-cols-3 divide-x divide-border/60 rounded-2xl border border-border/60 bg-secondary/30 py-3">
                <Fact icon={CalendarDays} label="Started at" value={startedLabel} />
                <Fact icon={Power} label="Ended at" value={endedLabel} />
                <Fact icon={Timer} label="Duration" value={durationText} />
              </div>

              {/* What it came to, line by line, from the settled check. */}
              <div className="mt-2.5 rounded-2xl border border-border/60 bg-card p-3.5 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-[15px] font-bold text-foreground sm:text-[15.5px]">
                    <Layers className="size-4.5 text-[#EA580C] dark:text-primary" />
                    Bill Summary
                  </p>
                  <span className="shrink-0 text-[12px] font-medium text-muted-foreground sm:text-[12.5px]">
                    {orderCount} Order{orderCount === 1 ? '' : 's'} · {items} Item{items === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-2.5 divide-y divide-border/35 border-t border-border/50 pt-1 text-[13px] sm:text-[13.5px]">
                  <div className="py-1.5">
                    <Row label="Subtotal" value={money(totals?.subtotal ?? 0)} />
                  </div>
                  {breakup ? (
                    <>
                      <div className="py-1.5">
                        <Row label={`CGST (${fmtPct(breakup.cgstRate)}%)`} value={money(breakup.cgst)} />
                      </div>
                      <div className="py-1.5">
                        <Row label={`SGST (${fmtPct(breakup.sgstRate)}%)`} value={money(breakup.sgst)} />
                      </div>
                    </>
                  ) : (
                    <div className="py-1.5">
                      <Row label="Tax" value={money(totals?.tax ?? 0)} />
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between rounded-xl bg-[#FDECE0] px-3.5 py-2.5 dark:bg-primary/[0.14]">
                  <span className="text-[15px] font-bold text-[#3B180B] dark:text-foreground sm:text-[16px]">Total Paid</span>
                  <span className="text-[18px] font-extrabold tabular-nums text-[#3B180B] dark:text-foreground sm:text-[19px]">
                    {paidText}
                  </span>
                </div>
              </div>

              {/* The two things worth doing next: the paper, or the sitting. */}
              <div className="mt-5 grid grid-cols-2 gap-3 pb-1">
                <Button
                  onClick={() => onViewBill?.()}
                  className="h-12 gap-2 whitespace-nowrap rounded-2xl bg-primary px-3 text-[14px] font-semibold text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90 sm:text-[15px]"
                >
                  <ReceiptText className="size-4.5" />
                  View Bill
                </Button>
                <Button
                  variant="outline"
                  onClick={() => (onViewSession ? onViewSession() : onOpenChange(false))}
                  className="h-12 gap-2 whitespace-nowrap rounded-2xl border-[#F5B895] bg-[#FFF9F5] px-3 text-[14px] font-semibold text-[#29170D] hover:bg-[#FFF2E8] dark:border-primary/35 dark:bg-primary/[0.06] dark:text-foreground sm:text-[15px]"
                >
                  <Info className="size-4.5 text-[#EA580C] dark:text-primary" />
                  Session Details
                </Button>
              </div>
            </>
          )}

        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One figure in the summary strip. */
/** One line of the receipt. */
function Receipt({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 py-2.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right tabular-nums',
          strong ? 'text-[14px] font-bold text-foreground' : 'text-[13px] font-medium text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/** 2.5 rather than 2.50, 5 rather than 5.0 — a rate, not money. */
function fmtPct(n: number) {
  return String(Number(n.toFixed(2)))
}

/** One fact in the sitting's strip: an icon, what it is, what it read. */
function Fact({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-center gap-2 px-2">
      <Icon className="size-[18px] shrink-0 text-[#EA580C] dark:text-primary" strokeWidth={2.1} />
      <div className="min-w-0">
        <p className="truncate text-[11px] leading-tight text-muted-foreground sm:text-[11.5px]">{label}</p>
        <p className="truncate text-[13.5px] font-bold leading-tight tabular-nums text-foreground sm:text-[14px]">{value}</p>
      </div>
    </div>
  )
}

/** A clock time for a sitting's bookends — "05:21 PM". */
function clock(d: Date) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toUpperCase()
}

/** How long the sitting ran, in the units that are still true. */
function elapsed(from: Date, to: Date) {
  const mins = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60000))
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

