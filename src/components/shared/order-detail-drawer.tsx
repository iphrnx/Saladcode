'use client'

import { Check, ChefHat, FilePenLine, Info, Loader2, Pencil, ReceiptText, Utensils, XCircle } from 'lucide-react'
import type { Order } from '@/components/app/data-context'
import { StatusBadge } from '@/components/shared/badges'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

/**
 * One order, in full.
 *
 * The row on the board says what a table ordered; this says everything about a
 * single ticket — where it is in the kitchen, every dish with its portion and
 * price, and what that order alone comes to. The sitting's bill is elsewhere on
 * purpose: this total is the order's, and a note at the foot says so.
 */

const STEPS = ['PENDING', 'PREPARING', 'READY', 'SERVED'] as const

export function OrderDetailDrawer({
  order,
  open,
  onOpenChange,
  currencySymbol = '₹',
  dishImages,
  canPrepare,
  canReady = false,
  canServe = false,
  canAccept = false,
  accepting = false,
  onAccept,
  onReject,
  onUpdate,
  onBack,
}: {
  order: Order | null
  open: boolean
  onOpenChange: (v: boolean) => void
  currencySymbol?: string
  dishImages: Record<string, string>
  /** Permission for the forward step. */
  canPrepare: boolean
  canReady?: boolean
  canServe?: boolean
  canAccept?: boolean
  accepting?: boolean
  onAccept?: () => void
  onReject?: () => void
  onUpdate: (status: string) => void
  /** Back arrow — returns to the sitting's other orders. */
  onBack?: () => void
}) {
  if (!order) return null
  const money = (n: number) =>
    `${currencySymbol}${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  const cancelled = order.status === 'CANCELLED'
  const done = order.status === 'COMPLETED'
  const isHeld = order.status === 'PENDING_ACTIVATION'
  const stepIndex = STEPS.indexOf(order.status as (typeof STEPS)[number])
  const nextStep =
    order.status === 'PENDING'
      ? { status: 'PREPARING', label: 'Start Preparing', allowed: canPrepare }
      : order.status === 'PREPARING'
        ? { status: 'READY', label: 'Mark Ready', allowed: canReady }
        : order.status === 'READY'
          ? { status: 'SERVED', label: 'Mark Served', allowed: canServe }
          : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex max-h-[92dvh] w-full max-w-[460px] flex-col gap-0 overflow-hidden rounded-t-3xl border-0 p-0 sm:rounded-3xl">
        <DialogTitle className="sr-only">Order #{order.orderNumber} details</DialogTitle>

        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-4">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/[0.08] text-foreground transition-colors hover:bg-primary/15"
            >
              <span className="text-[17px] leading-none">‹</span>
            </button>
          )}
          <h2 className="text-[19px] font-bold tracking-tight">Order Details</h2>
          <button
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="ml-auto grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin px-4 pb-3">
          {/* The order, and its journey */}
          <div className="rounded-2xl border border-border p-3">
            <div className="flex items-start gap-2.5">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <ReceiptText className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[17px] font-bold leading-tight">
                  Order #{order.orderNumber}
                </p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {order.table ? `${order.table.name} · ${order.table.area}` : order.orderType}
                </p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {when(order.createdAt)}
                </p>
              </div>
              <StatusBadge status={order.status} className="mt-1 shrink-0" />
            </div>

            {/* Timeline: what has happened, and what has not yet. */}
            {!cancelled && (
              <div className="mt-4 flex items-start">
                {STEPS.map((step, i) => {
                  const reached = done || (stepIndex >= 0 && i <= stepIndex)
                  const current = !done && i === stepIndex
                  return (
                    <div key={step} className="flex min-w-0 flex-1 flex-col items-center">
                      <div className="flex w-full items-center">
                        <span
                          className={cn(
                            'h-px flex-1',
                            i === 0 ? 'bg-transparent' : reached ? 'bg-primary' : 'bg-border',
                          )}
                        />
                        <span
                          className={cn(
                            'grid size-6 shrink-0 place-items-center rounded-full border-2',
                            current
                              ? 'border-primary bg-primary text-primary-foreground'
                              : reached
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-card',
                          )}
                        >
                          {reached && <span className="text-[11px] leading-none">✓</span>}
                        </span>
                        <span
                          className={cn(
                            'h-px flex-1',
                            i === STEPS.length - 1 ? 'bg-transparent' : i < (done ? STEPS.length : stepIndex) ? 'bg-primary' : 'bg-border',
                          )}
                        />
                      </div>
                      <span
                        className={cn(
                          'mt-1.5 truncate text-[11px]',
                          current ? 'font-semibold text-primary' : reached ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {step.charAt(0) + step.slice(1).toLowerCase()}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* The dishes */}
          <div className="mt-3 rounded-2xl border border-border p-3">
            <p className="flex items-center gap-1.5 text-[14px] font-bold">
              <FilePenLine className="size-4 text-primary" />
              Items ({order.items.length})
            </p>
            <div className="mt-2 divide-y divide-border/60">
              {order.items.map((it) => (
                <div key={it.id} className="flex items-center gap-2.5 py-2">
                  <Dish src={dishImages[it.menuItemId]} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="truncate text-[13px] font-semibold">{it.name}</p>
                    <p className="truncate text-[11.5px] text-muted-foreground">
                      {it.portion || 'Regular'}
                      {it.notes && <span className="italic"> · {it.notes}</span>}
                    </p>
                  </div>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                    ×{it.quantity}
                  </span>
                  <span className="w-[70px] shrink-0 text-right text-[13px] font-bold tabular-nums">
                    {money(it.price * it.quantity)}
                  </span>
                </div>
              ))}
              {order.items.length === 0 && (
                <p className="py-2 text-[12px] text-muted-foreground">No items</p>
              )}
            </div>
          </div>

          {/* What this order alone is worth */}
          <div className="mt-3 rounded-2xl border border-border p-3">
            <p className="flex items-center gap-1.5 text-[14px] font-bold">
              <Utensils className="size-4 text-primary" />
              Order Summary
            </p>
            <div className="mt-2 space-y-1.5 text-[12.5px]">
              <Line label="Subtotal" value={money(order.itemsTotal - order.discount)} />
              {order.discount > 0 && <Line label="Discount" value={`− ${money(order.discount)}`} />}
              <Line label="GST" value={money(order.tax)} />
              {order.serviceCharge > 0 && (
                <Line label="Service" value={money(order.serviceCharge)} />
              )}
            </div>
            <div className="mt-2 flex items-center justify-between rounded-xl bg-primary/[0.08] px-3 py-2">
              <span className="text-[14px] font-bold">Order Total</span>
              <span className="text-[16px] font-bold tabular-nums text-foreground">
                {money(order.total)}
              </span>
            </div>
          </div>

          <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-primary/[0.06] px-3 py-2 text-[11.5px] leading-snug text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0 text-primary" />
            Payment is done at table level (all orders combined).
          </p>
        </div>

        {/* Fixed foot: Accept/Reject for held QR orders, kitchen progression, or terminal status */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          {isHeld ? (
            canAccept ? (
              <>
                <button
                  type="button"
                  onClick={() => onReject?.()}
                  disabled={accepting}
                  className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-card text-[13.5px] font-semibold text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
                >
                  <XCircle className="size-4" />
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => onAccept?.()}
                  disabled={accepting}
                  className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary text-[13.5px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {accepting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  Accept Order
                </button>
              </>
            ) : (
              <p className="w-full text-center text-[12.5px] text-muted-foreground">
                Awaiting floor acceptance
              </p>
            )
          ) : nextStep ? (
            /* Kitchen progression — there is a forward step to take */
            <>
              <button
                disabled
                title="Editing a placed order is not available yet"
                className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border bg-card text-[13.5px] font-semibold text-muted-foreground opacity-60"
              >
                <Pencil className="size-4" />
                Edit Order
              </button>
              <button
                onClick={() => onUpdate(nextStep.status)}
                disabled={!nextStep.allowed}
                title={!nextStep.allowed ? "You don't have permission for this step" : undefined}
                className={cn(
                  'flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-[13.5px] font-semibold transition-colors',
                  nextStep.allowed
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-secondary text-muted-foreground',
                )}
              >
                <ChefHat className="size-4" />
                {nextStep.label}
              </button>
            </>
          ) : (
            /* Terminal state — order is Served, Completed, or Cancelled. No action buttons. */
            <div className="flex w-full items-center justify-center gap-2 rounded-xl bg-secondary/60 py-2.5 text-[12.5px] text-muted-foreground">
              {cancelled ? (
                <XCircle className="size-4 shrink-0" />
              ) : (
                <Check className="size-4 shrink-0 text-emerald-600" />
              )}
              <span>
                {cancelled
                  ? 'This order was cancelled'
                  : done
                    ? 'Order completed · Payment handled at table level'
                    : 'Order served · Payment handled at table level'}
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Dish({ src }: { src?: string | null }) {
  if (src) return <img src={src} alt="" loading="lazy" className="size-11 shrink-0 rounded-lg object-cover" />
  return (
    <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary/70">
      <Utensils className="size-4" />
    </span>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function when(iso: string) {
  const d = new Date(iso)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay
    ? `${time} · Today`
    : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`
}
