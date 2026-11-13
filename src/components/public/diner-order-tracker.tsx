'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Receipt, Check, ChefHat, Bell, Utensils, X } from 'lucide-react'
import { edgeFetch } from '@/lib/edge'
import { cn } from '@/lib/utils'

/**
 * The diner's own order tracker.
 *
 * A compact icon in the menu header with a count of the diner's live orders.
 * Tapping it opens a small glass panel listing them with their live status.
 *
 * Two deliberate choices:
 *
 *   * It only ever shows orders from THIS session. The endpoint is pinned to
 *     the session token, so another diner at the same table is not visible
 *     here — their orders are on the shared bill, not on this list.
 *   * It is read-only. Nothing here can change an order's state; the kitchen
 *     does that, and the list follows.
 */
export type TrackedOrder = {
  id: string
  orderNumber: number
  status: string
  total: number
  createdAt: string
  items: Array<{ name: string; quantity: number; portion: string | null; total: number; status: string }>
}

const STEPS = ['PENDING', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'] as const

const STEP_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  PREPARING: 'Preparing',
  READY: 'Ready',
  SERVED: 'Served',
  COMPLETED: 'Completed',
  PENDING_ACTIVATION: 'Waiting for the restaurant',
  CANCELLED: 'Cancelled',
}

function stepIndex(status: string): number {
  if (status === 'PENDING_ACTIVATION') return 0
  const i = STEPS.indexOf(status as (typeof STEPS)[number])
  return i < 0 ? 0 : i
}

/** What the diner is told when a status lands, in their words. */
const STATUS_ANNOUNCE: Record<string, { text: string; glyph: string }> = {
  PENDING: { text: 'Order accepted', glyph: '✓' },
  PREPARING: { text: 'Preparing', glyph: '👨‍🍳' },
  READY: { text: 'Ready', glyph: '✓' },
  SERVED: { text: 'Served', glyph: '🍽' },
  COMPLETED: { text: 'Completed', glyph: '✓' },
  CANCELLED: { text: 'Rejected', glyph: '✕' },
  PENDING_ACTIVATION: { text: 'Waiting for the restaurant', glyph: '⏳' },
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  if (status === 'PREPARING') return <ChefHat className={className} />
  if (status === 'READY') return <Bell className={className} />
  if (status === 'SERVED') return <Utensils className={className} />
  if (status === 'COMPLETED') return <Check className={className} />
  return <Receipt className={className} />
}

export function DinerOrderTracker({
  sessionToken,
  refreshKey,
  currencySymbol = '₹',
}: {
  sessionToken: string | null
  /** Bumped by the menu when a realtime order event arrives. */
  refreshKey?: number
  currencySymbol?: string
}) {
  const [orders, setOrders] = useState<TrackedOrder[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  /**
   * The last status seen for each order.
   *
   * Animation is driven by *change*, not by arrival: a reconnect that
   * re-delivers the same list, a duplicate event, or the first load must all
   * look like nothing happened — because nothing did.
   */
  const seenRef = useRef<Map<string, string>>(new Map())
  const [pop, setPop] = useState(0)
  const [announcement, setAnnouncement] = useState<{ key: number; text: string; glyph: string; fading: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    if (!sessionToken) return
    setLoading(true)
    try {
      const res = await edgeFetch('/api/table-session/orders', {
        headers: { 'x-session-token': sessionToken },
      })
      if (!res.ok) return
      const body = await res.json().catch(() => null)
      if (!Array.isArray(body?.orders)) return

      const next: TrackedOrder[] = body.orders
      const seen = seenRef.current
      const firstLoad = seen.size === 0 && orders.length === 0

      // One announcement, for the most advanced single change. Several orders
      // moving at once is the kitchen working, not five separate events.
      let changed: TrackedOrder | null = null
      for (const o of next) {
        const before = seen.get(o.id)
        if (before !== undefined && before !== o.status && !changed) changed = o
        seen.set(o.id, o.status)
      }

      setOrders(next)

      if (!firstLoad && changed) {
        const copy = STATUS_ANNOUNCE[changed.status]
        if (copy) {
          // A second change inside the toast's life replaces it rather than
          // stacking another one on top.
          if (toastTimer.current) clearTimeout(toastTimer.current)
          if (hideTimer.current) clearTimeout(hideTimer.current)
          setPop((n) => n + 1)
          setAnnouncement({ key: Date.now(), text: copy.text, glyph: copy.glyph, fading: false })
          // Shown for 1s, of which the last 300ms is the fade: it leaves
          // rather than blinking out.
          toastTimer.current = setTimeout(() => {
            setAnnouncement((a) => (a ? { ...a, fading: true } : a))
            hideTimer.current = setTimeout(() => {
              setAnnouncement(null)
              hideTimer.current = null
            }, 300)
            toastTimer.current = null
          }, 800)
        }
      }
    } catch {
      /* the next poll picks it up */
    } finally {
      setLoading(false)
    }
  }, [sessionToken])

  // Load once, then poll — a kitchen update that is missed on the socket is
  // still seen within a few seconds, and the popover is always close to true.
  useEffect(() => {
    if (!sessionToken) return
    void load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [sessionToken, load])

  useEffect(() => {
    if (refreshKey !== undefined) void load()
  }, [refreshKey, load])

  // Timers outlive a render, so they are cleared with the component.
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  // Tapping outside closes it; Escape closes it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const live = orders.filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED')
  const count = live.length

  // Nothing ordered yet: an unobtrusive neutral icon, no badge, no empty panel.
  const hasAnything = orders.length > 0

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={count > 0 ? `${count} active order${count === 1 ? '' : 's'}` : 'Your orders'}
        aria-expanded={open}
        data-order-tracker
        className={cn(
          'relative flex size-9 items-center justify-center rounded-full border transition-all cursor-pointer',
          count > 0
            ? 'border-[#f97316]/40 bg-[#f97316]/10 text-[#ea580c]'
            : 'border-border bg-card/70 text-muted-foreground',
        )}
      >
        {/* Keyed on the change counter: a new status remounts the span and the
            animation replays. The button itself is untouched, so it keeps
            focus, keeps its size, and never shifts the header. */}
        <span key={pop} className={cn('flex size-full items-center justify-center', pop > 0 && 'order-pop')}>
          {loading && count === 0 ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <StatusIcon status={live[0]?.status ?? 'COMPLETED'} className="size-4" />
          )}
        </span>
        {count > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-[#f97316] px-1 text-[9px] font-bold leading-4 text-white shadow-xs">
            {count}
          </span>
        )}
      </button>

      {/* Beside the button, floating: absolutely positioned so it cannot push
          the header around. Announced politely for a screen reader. */}
      {announcement && (
        <div
          key={announcement.key}
          role="status"
          aria-live="polite"
          data-order-toast
          className={cn(
            'order-toast-in pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap',
            'rounded-full border border-[#f97316]/25 bg-white/90 px-2.5 py-1 text-[11px] font-medium text-[#c2410c]',
            'shadow-sm backdrop-blur-md transition-opacity duration-300 dark:border-[#f97316]/30 dark:bg-[#1b1f2a]/90 dark:text-[#fdba74]',
            announcement.fading ? 'opacity-0' : 'opacity-100',
          )}
        >
          <span aria-hidden="true" className="mr-1">{announcement.glyph}</span>
          {announcement.text}
        </div>
      )}

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Your orders"
          data-order-tracker-panel
          className={cn(
            'absolute right-0 top-11 z-50 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl p-3',
            'border border-white/40 bg-white/70 shadow-xl backdrop-blur-xl',
            'dark:border-white/10 dark:bg-[#1b1f2a]/80',
            'animate-in fade-in slide-in-from-top-1 duration-200',
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Your orders
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {!hasAnything ? (
            <p className="px-1 py-4 text-center text-[11.5px] leading-relaxed text-muted-foreground">
              Nothing yet — anything you order will show up here.
            </p>
          ) : (
            <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-0.5">
              {orders.map((o) => {
                const idx = stepIndex(o.status)
                const cancelled = o.status === 'CANCELLED'
                return (
                  <div
                    key={o.id}
                    className="rounded-xl border border-white/50 bg-white/60 px-2.5 py-2 dark:border-white/10 dark:bg-white/5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-foreground">#{o.orderNumber}</span>
                      <span className="text-[11px] font-semibold text-[#ea580c]">
                        {currencySymbol}
                        {Number(o.total).toLocaleString('en-IN')}
                      </span>
                    </div>

                    <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                      {o.items
                        .map((i) => `${i.quantity}× ${i.name}${i.portion ? ` (${i.portion})` : ''}`)
                        .join(', ')}
                    </p>

                    {/* Five steps, filled to the current one. Cancelled says so
                        instead of pretending to be at step one. */}
                    {cancelled ? (
                      <p className="mt-1.5 text-[10.5px] font-medium text-destructive">Cancelled</p>
                    ) : (
                      <>
                        <div className="mt-1.5 flex gap-1">
                          {STEPS.map((s, i) => (
                            <span
                              key={s}
                              className={cn(
                                'h-1 flex-1 rounded-full transition-colors',
                                i <= idx ? 'bg-[#f97316]' : 'bg-black/10 dark:bg-white/15',
                              )}
                            />
                          ))}
                        </div>
                        <p className="mt-1 text-[10.5px] font-medium text-foreground/80">
                          {STEP_LABEL[o.status] ?? o.status}
                        </p>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
