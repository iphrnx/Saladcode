'use client'

import { useEffect, useState } from 'react'
import {
  Activity,
  CalendarDays,
  Check,
  ChevronDown,
  CreditCard,
  Download,
  FileText,
  Flag,
  Layers,
  Play,
  Plus,
  Power,
  Printer,
  Receipt,
  ReceiptText,
  ShoppingBag,
  Timer,
  Truck,
  Utensils,
  Wallet,
  X,
} from 'lucide-react'
import type { Order } from '@/components/app/data-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type Tab = 'orders' | 'bill' | 'activity'

const ORDER_TYPE_LABELS: Record<string, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
}

export function SessionOrdersDrawer({
  open,
  onOpenChange,
  tableName,
  area,
  seats,
  orderType,
  startedAt,
  endedAt,
  state,
  orders,
  currencySymbol = '₹',
  dishImages,
  bill,
  activity,
  focusOrderId = null,
  canPay = false,
  invoiceNumber,
  paymentMethod,
  paidAt,
  onCompletePay,
  onPrintBill,
  onDownloadBill,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  tableName: string
  area?: string | null
  seats?: number | null
  orderType?: string | null
  startedAt?: string | null
  endedAt?: string | null
  state: 'Active' | 'Ended'
  orders: Order[]
  currencySymbol?: string
  dishImages: Record<string, string>
  bill: {
    subtotal: number
    tax: number
    service: number
    total: number
    paid: number
    due: number
    sharedBill: boolean
    awaiting: boolean
  }
  canPay?: boolean
  invoiceNumber?: string | null
  paymentMethod?: string | null
  paidAt?: string | null
  onCompletePay?: () => void
  onSessionDetails?: () => void
  onPrintBill?: () => void
  onDownloadBill?: () => void
  activity: { id: string; label: string; at: string }[]
  focusOrderId?: string | null
}) {
  const [tab, setTab] = useState<Tab>('orders')
  const [openOrders, setOpenOrders] = useState<string[]>(() =>
    focusOrderId ? [focusOrderId] : orders.length === 1 ? [orders[0].id] : [],
  )

  const money = (n: number) =>
    `${currencySymbol}${Number(n ?? 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`

  const [wasOpen, setWasOpen] = useState(open)
  const [lastFocus, setLastFocus] = useState<string | null>(focusOrderId)
  if (open !== wasOpen || focusOrderId !== lastFocus) {
    setWasOpen(open)
    setLastFocus(focusOrderId)
    if (open) {
      setTab('orders')
      setOpenOrders(focusOrderId ? [focusOrderId] : orders.length === 1 ? [orders[0].id] : [])
    }
  }

  useEffect(() => {
    if (!open || !focusOrderId) return
    const t = window.setTimeout(() => {
      document
        .querySelector(`[data-drawer-order="${focusOrderId}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 120)
    return () => window.clearTimeout(t)
  }, [open, focusOrderId])

  const typeLabel = orderType ? (ORDER_TYPE_LABELS[orderType] || orderType) : 'Dine In'
  const isTakeaway = orderType === 'TAKEAWAY'
  const isDelivery = orderType === 'DELIVERY'
  const defaultArea = isTakeaway || isDelivery ? null : 'Main Hall'
  const metaSubtitle = [area || defaultArea, seats ? `${seats} Seats` : null, typeLabel]
    .filter(Boolean)
    .join(' • ')

  const totalQty = orders.reduce(
    (sum, o) => sum + o.items.reduce((acc, it) => acc + (it.quantity || 1), 0),
    0,
  )

  const firstOrderTime = orders[0]?.createdAt
  const lastOrderTime = orders[orders.length - 1]?.completedAt || orders[orders.length - 1]?.createdAt
  const effectiveStartedAt = startedAt || firstOrderTime
  const effectiveEndedAt = endedAt || (state === 'Ended' ? lastOrderTime : null)

  const paidAmount = bill.paid > 0 ? bill.paid : bill.total
  const halfTax = bill.tax > 0 ? bill.tax / 2 : 0
  const taxRatePct = bill.subtotal > 0 && bill.tax > 0 ? (bill.tax / bill.subtotal) * 100 : 5
  const halfRatePct = (taxRatePct / 2).toFixed(1).replace(/\.0$/, '')

  const headerSubtitle =
    tab === 'bill'
      ? `${tableName} • Bill Summary`
      : tab === 'activity'
        ? `${tableName} • Activity`
        : `Complete information for ${tableName}`

  // Build chronological activity timeline
  const timelineEvents: {
    id: string
    title: string
    subtitle: string
    time: string
    type: 'start' | 'order_placed' | 'all_served' | 'payment' | 'ended'
  }[] = []

  // 1. Session Started
  if (effectiveStartedAt) {
    timelineEvents.push({
      id: 'session-start',
      title: 'Session Started',
      subtitle: `${tableName} opened (${typeLabel})`,
      time: formatTime(effectiveStartedAt),
      type: 'start',
    })
  }

  // 2. Orders Placed (chronological)
  const sortedOrders = [...orders].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  for (const o of sortedOrders) {
    const oQty = o.items.reduce((acc, it) => acc + (it.quantity || 1), 0)
    const oPreview =
      o.items
        .map((it) => `${it.name}${o.items.length > 1 || it.quantity > 1 ? ` ×${it.quantity}` : ''}`)
        .join(', ') || 'No items'
    timelineEvents.push({
      id: `order-${o.id}`,
      title: `Order Placed • #${o.orderNumber}`,
      subtitle: `${oQty} item${oQty === 1 ? '' : 's'} (${oPreview})`,
      time: formatTime(o.createdAt),
      type: 'order_placed',
    })
  }

  // 3. All Orders Served
  const allServedOrDone =
    orders.length > 0 &&
    orders.every((o) => o.status === 'SERVED' || o.status === 'COMPLETED' || o.status === 'CANCELLED')
  if (allServedOrDone || state === 'Ended') {
    const lastServedTime =
      orders[orders.length - 1]?.completedAt ||
      orders[orders.length - 1]?.createdAt ||
      effectiveEndedAt
    timelineEvents.push({
      id: 'all-served',
      title: 'All Orders Served',
      subtitle: `All ${orders.length} order${orders.length === 1 ? '' : 's'} marked as Served`,
      time: formatTime(lastServedTime),
      type: 'all_served',
    })
  }

  // 4. Payment Completed
  if (state === 'Ended' || bill.paid > 0 || bill.due <= 0) {
    const payMethodStr = formatPaymentMethod(paymentMethod || orders[0]?.paymentMethod)
    const invStr = formatInvoiceNumber(invoiceNumber, orders[0]?.orderNumber)
    timelineEvents.push({
      id: 'payment-completed',
      title: 'Payment Completed',
      subtitle: `Paid ${money(paidAmount)} via ${payMethodStr} (${invStr})`,
      time: formatTime(effectiveEndedAt || orders[orders.length - 1]?.completedAt),
      type: 'payment',
    })
  }

  // 5. Session Ended
  if (state === 'Ended') {
    timelineEvents.push({
      id: 'session-ended',
      title: 'Session Ended',
      subtitle: `${tableName} closed and settled`,
      time: formatTime(effectiveEndedAt || orders[orders.length - 1]?.completedAt),
      type: 'ended',
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100%-1.25rem)] max-w-[560px] gap-0 overflow-hidden rounded-[28px] border border-border/80 bg-white p-0 shadow-2xl dark:bg-card"
      >
        <DialogTitle className="sr-only">Session Details for {tableName}</DialogTitle>

        <div className="relative max-h-[90dvh] overflow-y-auto p-4 sm:p-6 scrollbar-thin">
          {/* Circular Close Button */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="absolute right-4 top-4 z-10 flex size-9 items-center justify-center rounded-full border border-border/70 bg-white text-foreground shadow-xs transition-colors hover:bg-secondary dark:bg-card cursor-pointer"
          >
            <X className="size-4" />
          </button>

          {/* Centered Modal Header */}
          <div className="pt-1 pb-3 text-center">
            <h2 className="text-[22px] sm:text-[24px] font-extrabold tracking-tight text-foreground">
              Session Details
            </h2>
            <p className="mt-0.5 text-[13px] font-medium text-muted-foreground">
              {headerSubtitle}
            </p>
          </div>

          {/* Context Card */}
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] p-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
                {isTakeaway ? (
                  <ShoppingBag className="size-5" />
                ) : isDelivery ? (
                  <Truck className="size-5" />
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="size-5.5 text-primary">
                    <path d="M7 11V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v4" />
                    <rect x="5" y="11" width="14" height="3" rx="1.5" />
                    <path d="M7 14v6" />
                    <path d="M17 14v6" />
                  </svg>
                )}
              </div>
              <div className="min-w-0">
                <h3 className="truncate text-[16.5px] font-extrabold tracking-tight text-foreground">
                  {tableName}
                </h3>
                <p className="truncate text-[12.5px] font-medium text-muted-foreground">
                  {metaSubtitle}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#C6F0D4] bg-[#E8F8EE] px-3.5 py-1 text-[13px] font-bold text-[#16A34A] shadow-xs dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400">
              <span className="flex size-4 items-center justify-center rounded-full bg-[#16A34A] text-white dark:bg-emerald-500">
                <Check className="size-2.5 stroke-[3]" />
              </span>
              <span>{state === 'Ended' || bill.due <= 0 ? 'Paid' : 'Active'}</span>
            </div>
          </div>

          {/* 3-Cell Timing Strip */}
          <div className="mt-3 grid grid-cols-3 divide-x divide-border/60 rounded-xl border border-border/60 bg-[#FAF9F7] p-2.5 text-center dark:border-border/40 dark:bg-secondary/20">
            <div className="flex items-center justify-center gap-2.5 px-2">
              <CalendarDays className="size-4.5 text-primary shrink-0" strokeWidth={2.2} />
              <div className="text-left">
                <p className="text-[11px] sm:text-[11.5px] font-medium text-muted-foreground leading-tight">Started at</p>
                <p className="text-[13px] sm:text-[14px] font-extrabold tabular-nums text-foreground leading-snug">
                  {formatTime(effectiveStartedAt)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-center gap-2.5 px-2">
              <Power className="size-4.5 text-primary shrink-0" strokeWidth={2.2} />
              <div className="text-left">
                <p className="text-[11px] sm:text-[11.5px] font-medium text-muted-foreground leading-tight">Ended at</p>
                <p className="text-[13px] sm:text-[14px] font-extrabold tabular-nums text-foreground leading-snug">
                  {effectiveEndedAt ? formatTime(effectiveEndedAt) : state === 'Active' ? 'Active' : '—'}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-center gap-2.5 px-2">
              <Timer className="size-4.5 text-primary shrink-0" strokeWidth={2.2} />
              <div className="text-left">
                <p className="text-[11px] sm:text-[11.5px] font-medium text-muted-foreground leading-tight">Duration</p>
                <p className="text-[13px] sm:text-[14px] font-extrabold tabular-nums text-foreground leading-snug">
                  {calculateDuration(effectiveStartedAt, effectiveEndedAt)}
                </p>
              </div>
            </div>
          </div>

          {/* Navigation Tabs (Segmented Pills) */}
          <div role="tablist" className="mt-3.5 grid grid-cols-3 gap-2">
            <button
              role="tab"
              aria-selected={tab === 'orders'}
              onClick={() => setTab('orders')}
              className={cn(
                'flex items-center justify-center gap-2 rounded-xl py-2 px-2.5 text-[13px] font-bold transition-all cursor-pointer',
                tab === 'orders'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              <Layers className={cn('size-4 shrink-0', tab === 'orders' ? 'text-primary-foreground' : 'text-muted-foreground')} />
              <span className="truncate">Orders ({orders.length})</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'bill'}
              onClick={() => setTab('bill')}
              className={cn(
                'flex items-center justify-center gap-2 rounded-xl py-2 px-2.5 text-[13px] font-bold transition-all cursor-pointer',
                tab === 'bill'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              <FileText className={cn('size-4 shrink-0', tab === 'bill' ? 'text-primary-foreground' : 'text-muted-foreground')} />
              <span className="truncate">Bill Summary</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'activity'}
              onClick={() => setTab('activity')}
              className={cn(
                'flex items-center justify-center gap-2 rounded-xl py-2 px-2.5 text-[13px] font-bold transition-all cursor-pointer',
                tab === 'activity'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              <Activity className={cn('size-4 shrink-0', tab === 'activity' ? 'text-primary-foreground' : 'text-muted-foreground')} />
              <span className="truncate">Activity</span>
            </button>
          </div>

          {/* Tab Content Body */}
          <div className="mt-3">
            {tab === 'orders' && (
              <div className="space-y-2">
                {orders.map((order) => {
                  const expanded = openOrders.includes(order.id)
                  const isServed = order.status === 'SERVED' || order.status === 'COMPLETED'
                  const itemsPreview =
                    order.items
                      .map(
                        (it) =>
                          `${it.quantity} × ${it.name}${
                            it.portion && it.portion !== 'Regular' ? ` (${it.portion})` : ''
                          }`,
                      )
                      .join(', ') || 'No items'

                  return (
                    <div
                      key={order.id}
                      data-drawer-order={order.id}
                      className={cn(
                        'overflow-hidden rounded-xl border transition-colors',
                        expanded
                          ? 'border-primary/40 bg-primary/[0.04]'
                          : 'border-border/70 bg-card hover:border-primary/30',
                      )}
                    >
                      <button
                        onClick={() =>
                          setOpenOrders((prev) =>
                            prev.includes(order.id)
                              ? prev.filter((id) => id !== order.id)
                              : [...prev, order.id],
                          )
                        }
                        aria-expanded={expanded}
                        className="block w-full p-3 text-left transition-colors cursor-pointer"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0 rounded-md bg-primary/10 px-2 py-0.5 text-[12px] font-extrabold text-primary">
                              #{order.orderNumber}
                            </span>
                            <span className="truncate text-[12.5px] font-medium text-muted-foreground tabular-nums">
                              {formatTime(order.createdAt)}
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-2">
                            <span
                              className={cn(
                                'flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-bold',
                                isServed
                                  ? 'border border-[#C6F0D4] bg-[#E8F8EE] text-[#16A34A] dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-400'
                                  : 'bg-secondary text-muted-foreground',
                              )}
                            >
                              {isServed && <Check className="size-2.5 stroke-[3]" />}
                              <span>
                                {order.status === 'SERVED'
                                  ? 'Served'
                                  : order.status === 'COMPLETED'
                                    ? 'Completed'
                                    : order.status}
                              </span>
                            </span>

                            <span className="text-[14px] font-extrabold text-foreground tabular-nums">
                              {money(order.total)}
                            </span>

                            <ChevronDown
                              className={cn(
                                'size-4 text-muted-foreground transition-transform duration-200',
                                expanded && 'rotate-180',
                              )}
                            />
                          </div>
                        </div>

                        {/* Line Item Preview */}
                        <p className="mt-1.5 truncate text-[12.5px] font-medium text-muted-foreground">
                          {itemsPreview}
                        </p>
                      </button>

                      {/* Accordion Detail Breakdown */}
                      <div
                        className={cn(
                          'grid transition-[grid-template-rows] duration-200 ease-out',
                          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
                        )}
                      >
                        <div className="min-h-0 overflow-hidden">
                          <div className="border-t border-border/60 bg-muted/20 px-3 py-2 divide-y divide-border/40">
                            {order.items.map((it) => (
                              <div key={it.id} className="flex items-center gap-2.5 py-2 first:pt-1 last:pb-1">
                                <Dish src={dishImages[it.menuItemId]} />
                                <div className="min-w-0 flex-1 leading-tight">
                                  <p className="truncate text-[13px] font-semibold text-foreground">{it.name}</p>
                                  <p className="truncate text-[11.5px] text-muted-foreground">
                                    {it.portion || 'Full'}
                                  </p>
                                </div>
                                <span className="shrink-0 text-[12px] font-semibold text-muted-foreground tabular-nums">
                                  ×{it.quantity}
                                </span>
                                <span className="w-[72px] shrink-0 text-right text-[13px] font-bold text-foreground tabular-nums">
                                  {money(it.price * it.quantity)}
                                </span>
                              </div>
                            ))}
                            {order.items.length === 0 && (
                              <p className="py-2 text-[12px] text-muted-foreground">No items</p>
                            )}
                            <div className="flex items-center justify-between pt-2">
                              <span className="text-[12px] font-semibold text-muted-foreground">Order Total</span>
                              <span className="text-[13.5px] font-extrabold text-foreground tabular-nums">
                                {money(order.total)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {tab === 'bill' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
                {/* Left Column: Charges */}
                <div className="flex flex-col justify-between rounded-2xl border border-primary/20 bg-primary/[0.04] p-3.5 sm:p-4">
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <Layers className="size-4.5 text-primary" />
                      <h4 className="text-[15px] font-bold text-foreground">Charges</h4>
                    </div>

                    <div className="space-y-2 py-0.5">
                      <div className="flex items-center justify-between text-[13px]">
                        <span className="font-medium text-foreground">Subtotal</span>
                        <span className="font-bold tabular-nums text-foreground">{money(bill.subtotal)}</span>
                      </div>

                      {bill.tax > 0 ? (
                        <>
                          <div className="flex items-center justify-between text-[13px]">
                            <span className="font-medium text-foreground">CGST ({halfRatePct}%)</span>
                            <span className="font-bold tabular-nums text-foreground">{money(halfTax)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[13px]">
                            <span className="font-medium text-foreground">SGST ({halfRatePct}%)</span>
                            <span className="font-bold tabular-nums text-foreground">{money(halfTax)}</span>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center justify-between text-[13px]">
                          <span className="font-medium text-foreground">Tax</span>
                          <span className="font-bold tabular-nums text-foreground">{money(0)}</span>
                        </div>
                      )}

                      {bill.service > 0 && (
                        <div className="flex items-center justify-between text-[13px]">
                          <span className="font-medium text-foreground">Service Charge</span>
                          <span className="font-bold tabular-nums text-foreground">{money(bill.service)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between rounded-xl bg-primary/10 px-3.5 py-2.5">
                    <span className="text-[14.5px] sm:text-[15px] font-black text-primary">
                      Total Paid
                    </span>
                    <span className="text-[16.5px] sm:text-[17px] font-black tabular-nums text-foreground">
                      {money(paidAmount)}
                    </span>
                  </div>
                </div>

                {/* Right Column: 3 Info Cards */}
                <div className="flex flex-col gap-2.5 sm:gap-3">
                  {/* Payment Method */}
                  <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
                      <Wallet className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11.5px] font-medium text-muted-foreground">Payment Method</p>
                      <p className="truncate text-[14px] font-bold text-foreground">
                        {formatPaymentMethod(paymentMethod || orders[0]?.paymentMethod)}
                      </p>
                    </div>
                  </div>

                  {/* Invoice No. */}
                  <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
                      <ReceiptText className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11.5px] font-medium text-muted-foreground">Invoice No.</p>
                      <p className="truncate text-[14px] font-bold text-foreground">
                        {formatInvoiceNumber(invoiceNumber, orders[0]?.orderNumber)}
                      </p>
                    </div>
                  </div>

                  {/* Paid At */}
                  <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-xs">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
                      <CalendarDays className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11.5px] font-medium text-muted-foreground">Paid At</p>
                      <p className="truncate text-[13px] sm:text-[13.5px] font-bold tabular-nums text-foreground">
                        {formatFullDateTime(paidAt || effectiveEndedAt || orders[orders.length - 1]?.completedAt || orders[0]?.createdAt)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'activity' && (
              <div className="rounded-2xl border border-border/70 bg-card p-3.5 sm:p-4.5 dark:border-border/40 mt-1">
                <div className="relative">
                  {timelineEvents.map((evt, idx) => {
                    const isLast = idx === timelineEvents.length - 1
                    return (
                      <div key={evt.id} className="relative flex items-start gap-3.5 pb-4 last:pb-0">
                        {/* Continuous connecting line */}
                        {!isLast && (
                          <div
                            className="absolute left-4 top-8 -bottom-0.5 w-0.5 -translate-x-1/2 bg-primary/30"
                            aria-hidden="true"
                          />
                        )}

                        {/* Circular Icon Badge */}
                        <div className="relative z-10 shrink-0">
                          {evt.type === 'start' ? (
                            <div className="flex size-8 items-center justify-center rounded-full border-[1.5px] border-emerald-400 bg-emerald-50 text-emerald-600 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                              <Play className="size-3.5 fill-current ml-0.5" />
                            </div>
                          ) : evt.type === 'order_placed' ? (
                            <div className="flex size-8 items-center justify-center rounded-full border-[1.5px] border-primary/50 bg-primary/10 text-primary">
                              <Plus className="size-4" strokeWidth={2.4} />
                            </div>
                          ) : evt.type === 'all_served' ? (
                            <div className="flex size-8 items-center justify-center rounded-full border-[1.5px] border-primary/50 bg-primary/10 text-primary">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
                                <path d="M18 11a6 6 0 0 0-12 0" />
                                <path d="M4 14h16" />
                                <path d="M12 5V3" />
                              </svg>
                            </div>
                          ) : evt.type === 'payment' ? (
                            <div className="flex size-8 items-center justify-center rounded-full border-[1.5px] border-emerald-400 bg-emerald-50 text-emerald-600 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                              <CreditCard className="size-4" strokeWidth={2.2} />
                            </div>
                          ) : (
                            <div className="flex size-8 items-center justify-center rounded-full border-[1.5px] border-primary/50 bg-primary/10 text-primary">
                              <Flag className="size-4" strokeWidth={2.2} />
                            </div>
                          )}
                        </div>

                        {/* Title, Subtitle, Time */}
                        <div className="flex min-w-0 flex-1 items-start justify-between gap-2 pt-0.5">
                          <div className="min-w-0">
                            <h5 className="truncate text-[13.5px] font-bold text-foreground leading-tight">
                              {evt.title}
                            </h5>
                            <p className="truncate text-[12px] font-medium text-muted-foreground mt-0.5 leading-snug">
                              {evt.subtitle}
                            </p>
                          </div>
                          <span className="shrink-0 text-[12px] font-medium text-muted-foreground tabular-nums">
                            {evt.time}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Bottom Summary Banner (visible on Orders tab) */}
          {tab === 'orders' && (
            orders.length > 1 ? (
              <div className="mt-3.5 flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] p-3.5">
                <div className="flex items-center gap-2 font-bold text-foreground">
                  <Layers className="size-4.5 text-primary shrink-0" />
                  <span className="text-[13px] sm:text-[13.5px]">
                    {orders.length} Order{orders.length === 1 ? '' : 's'} • {totalQty} Item{totalQty === 1 ? '' : 's'}
                  </span>
                </div>

                <div className="h-5 w-px bg-primary/20" />

                <div className="flex items-baseline gap-2 text-foreground">
                  <span className="text-[13px] font-bold text-primary">
                    Total Paid
                  </span>
                  <span className="text-[17px] sm:text-[18px] font-black text-foreground tabular-nums">
                    {money(paidAmount)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-3.5 flex items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/[0.04] px-3.5 py-2.5">
                <div className="flex items-baseline gap-1.5 text-[12.5px] font-bold text-foreground">
                  <span className="text-muted-foreground font-semibold">TOTAL</span>
                  <span className="tabular-nums font-black">{money(orders[0]?.total ?? bill.total)}</span>
                </div>
                <div className="flex items-baseline gap-1.5 text-[12.5px] font-bold text-foreground">
                  <span className="text-muted-foreground font-semibold">DUE</span>
                  <span className="tabular-nums font-black text-[#16A34A]">{money(bill.due)}</span>
                </div>
                <span className="rounded-full border border-[#C6F0D4] bg-[#E8F8EE] px-2.5 py-0.5 text-[11px] font-bold text-[#16A34A]">
                  {state === 'Ended' || bill.due <= 0 ? 'Paid' : 'Active'}
                </span>
              </div>
            )
          )}

          {/* Footer Action Buttons */}
          <div className="mt-3.5 grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={onPrintBill}
              className="h-11 rounded-xl border border-border bg-card text-foreground hover:bg-secondary font-bold text-[13.5px] flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Printer className="size-4.5 text-primary shrink-0" />
              <span>Print Bill</span>
            </Button>
            <Button
              type="button"
              onClick={onDownloadBill}
              className="h-11 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-[13.5px] flex items-center justify-center gap-2 shadow-sm transition-colors cursor-pointer"
            >
              <Download className="size-4.5 text-primary-foreground shrink-0" />
              <span>Download Bill (PDF)</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Dish({ src }: { src?: string | null }) {
  if (src) {
    return <img src={src} alt="" loading="lazy" className="size-8 shrink-0 rounded-lg object-cover" />
  }
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary border border-primary/20">
      <Utensils className="size-3.5" />
    </span>
  )
}

function formatTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatFullDateTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const day = d.getDate()
  const month = d.toLocaleDateString('en-US', { month: 'short' })
  const year = d.getFullYear()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${day} ${month} ${year}, ${time}`
}

function formatPaymentMethod(m?: string | null): string {
  if (!m) return 'Cash'
  const upper = m.toUpperCase()
  if (upper === 'CASH') return 'Cash'
  if (upper === 'CARD') return 'Card'
  if (upper === 'UPI') return 'UPI'
  if (upper === 'WALLET') return 'Wallet'
  return m
}

function formatInvoiceNumber(inv?: string | null, orderNum?: number): string {
  if (inv && inv.trim()) return inv
  if (orderNum) return `INV-${String(orderNum).padStart(6, '0')}`
  return 'INV-000123'
}

function calculateDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return '—'
  const start = new Date(startIso).getTime()
  if (isNaN(start)) return '—'
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const mins = Math.max(0, Math.floor((end - start) / 60000))
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

function when(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
