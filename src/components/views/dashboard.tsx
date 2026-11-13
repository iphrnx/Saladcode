'use client'

import { useMemo, useState, useRef, useEffect, useCallback } from 'react'
import { useApp } from '@/components/app/data-context'
import { useT } from '@/lib/i18n'
import { useStore } from '@/lib/store'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk, describeFailure } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { TableCheckDialog } from '@/components/shared/table-check-dialog'
import { AccessDenied } from '@/components/shared/access-denied'
import { hasPermission, hasEffectivePermission } from '@/lib/permissions'
import { sortTables } from '@/lib/table-order'
import { cn } from '@/lib/utils'
import { normalizePortions, type MenuPortion } from '@/lib/portions'
import { orderQueue, startOrderQueue, type QueueEntry } from '@/lib/order-queue'
import { persistPosCart, restorePosCart, clearPosCart } from '@/lib/pos-cart'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { StatusBadge, OrderTypeBadge, Tag } from '@/components/shared/badges'
import { Search, Plus, Minus, Trash2, ShoppingBag, X, Check, CreditCard, Ticket, Clock, LogOut, Loader2, Receipt } from 'lucide-react'
import { toast } from 'sonner'

export function DashboardView() {
  const tr = useT()
  const { data, refresh, sessionRevision } = useApp()
  const { denied, handleLoad, handleAction } = useAccessDenied()
  const { cart, addToCart, updateCartQty, removeFromCart, setCartNotes, clearCart, hydrateCart, subtractCartLines, orderType, setOrderType, selectedTableId, setSelectedTableId, promoCode, setPromoCode } = useStore()
  const [activeCat, setActiveCat] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [lastOrder, setLastOrder] = useState<any>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [appliedPromo, setAppliedPromo] = useState<any | null>(null)
  const [promoError, setPromoError] = useState('')
  const [promoChecking, setPromoChecking] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([])
  // Mirrors "a checkout is in flight" synchronously — see submitOrder.
  const submittingRef = useRef(false)
  const [offline, setOffline] = useState(false)

  // scroll-collapse effect: when the menu is scrolled, the restaurant header
  // (name/tagline/stats) collapses to give the category pills + cards more room
  const scrollRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        // collapse when scrolled past 40px down; expand when back at top
        setCollapsed(el.scrollTop > 40)
        ticking = false
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const tenantId = data?.tenant?.id
  const userId = data?.currentUser?.id
  // Checkout, promos and ending a table session are all writes the server
  // guards on the granular order keys; the buttons are disabled rather than
  // hidden so the cashier still sees the till, just not the action.
  const perms = data?.permissions ?? []
  const canCheckout = hasEffectivePermission(perms, 'orders.create')
  // Taking money is its own key: a waiter can accept a table and serve it
  // without ever being able to settle a bill.
  const canCollect = hasEffectivePermission(perms, 'payments.collect')
  const canPromo = hasEffectivePermission(perms, 'orders.discount')
  // Ending a table session frees the table — its own key now, separate from
  // table CRUD and from the order book.
  const canEndSessions = hasEffectivePermission(perms, 'table-sessions.manage')

  // ── Order queue: the checkout pipeline ──────────────────────────────────
  // Every submit is snapshotted here with an idempotency key; the queue
  // submits, retries with backoff, reconciles after uncertain failures, and
  // survives refreshes. This component only reacts to it.
  useEffect(() => {
    if (!tenantId || !userId) return
    const q = orderQueue(tenantId, userId, {
      onConfirmed: (order, entry) => {
        setLastOrder(order)
        subtractCartLines(entry.payload.items ?? [])
        setPromoCode('')
        setAppliedPromo(null)
        setPromoError('')
        if (order.promoApplied === false && order.promoReason) {
          // The server is the authority on promos, and it can still decline a
          // code the cashier had already applied. Say so, or the customer is
          // charged full price on a total they were shown discounted.
          toast.error(`Promo not applied: ${order.promoReason}`, {
            description: `Order #${order.orderNumber} placed at full price.`,
            duration: 8000,
          })
        } else {
          toast.success(`Order #${order.orderNumber} placed!`)
        }
        refresh()
        setCartOpen(false)
      },
      onChange: (entries) => {
        setQueueEntries(entries)
        submittingRef.current = entries.some(
          (e) => e.state === 'pending' || e.state === 'submitting',
        )
      },
    })
    setQueueEntries(q.load())
    const stop = startOrderQueue(tenantId, userId, {})
    const onOn = () => setOffline(false)
    const onOff = () => setOffline(true)
    window.addEventListener('online', onOn)
    window.addEventListener('offline', onOff)
    setOffline(!window.navigator.onLine)
    return () => {
      stop()
      window.removeEventListener('online', onOn)
      window.removeEventListener('offline', onOff)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, userId])

  // ── POS cart persistence: restore once, save on every change ────────────
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!tenantId || !userId || hydratedRef.current) return
    hydratedRef.current = true
    if (cart.length === 0) {
      const snapshot = restorePosCart(tenantId, userId)
      if (snapshot?.cart?.length) hydrateCart(snapshot)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, userId, cart.length])

  useEffect(() => {
    if (!tenantId || !userId) return
    persistPosCart(tenantId, userId, {
      cart,
      orderType,
      selectedTableId,
      promoCode,
    })
    if (cart.length === 0) clearPosCart(tenantId, userId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, orderType, selectedTableId, promoCode, tenantId, userId])

  const queueBusy = queueEntries.some((e) => e.state === 'pending' || e.state === 'submitting')
  const failedEntries = queueEntries.filter((e) => e.state === 'failed')

  const menuItems = data?.menuItems ?? []
  const categories = data?.categories ?? []
  // "Table 10" belongs after "Table 9", not after "Table 1".
  const tables = useMemo(() => sortTables(data?.tables ?? []), [data?.tables])
  const tenant = data?.tenant

  /* Hidden items (available=false) are managed in the Menu view but must never
     appear on the POS board — staff cannot sell what is not on the menu. The
     diner menu filters them server-side and place_order rejects them, so this
     closes the one surface that still rendered them. */
  const visibleMenuItems = useMemo(
    () => menuItems.filter((m) => m.available),
    [menuItems],
  )

  const filtered = useMemo(() => {
    return visibleMenuItems.filter((m) => {
      if (activeCat !== 'all' && m.categoryId !== activeCat) return false
      if (search && !m.name.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [visibleMenuItems, activeCat, search])

  const subtotal = cart.reduce((s, c) => s + c.price * c.quantity, 0)
  const taxRate = tenant?.taxRate ?? 8
  const serviceRate = tenant?.serviceCharge ?? 0

  // Discount from the applied promo.
  //
  // The server decides whether a code applies; this only mirrors the
  // arithmetic so the total on screen keeps up with the cart. The rule set
  // matches the server's evaluatePromo() exactly, including max_discount
  // capping fixed-amount codes as well as percentages.
  let discount = 0
  if (appliedPromo && subtotal >= appliedPromo.minOrder) {
    discount = appliedPromo.type === 'PERCENTAGE'
      ? (subtotal * appliedPromo.value) / 100
      : appliedPromo.value
    if (appliedPromo.maxDiscount > 0) discount = Math.min(discount, appliedPromo.maxDiscount)
    discount = Math.min(discount, subtotal) // never go negative
  }
  const taxableAmount = Math.max(0, subtotal - discount)
  const tax = +((taxableAmount) * taxRate / 100).toFixed(2)
  const service = +((subtotal) * serviceRate / 100).toFixed(2)
  const total = +(subtotal - discount + tax + service).toFixed(2)

  // Validate the promo code against the server.
  //
  // The server is the authority: it owns expiry, usage limits and the minimum
  // order, and it runs the same evaluation the order goes through — so the
  // total the cashier sees is the total that gets charged. The old version
  // checked the bootstrap-cached list, which went stale as soon as a promo was
  // used, and the server only re-checked two of the four rules.
  const applyPromo = async () => {
    setPromoError('')
    const code = promoCode.trim()
    if (!code) {
      setAppliedPromo(null)
      return
    }
    setPromoChecking(true)
    try {
      const res = await edgeFetch('/api/promos/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant?.id ?? '' },
        body: JSON.stringify({ code, total: subtotal }),
      })
      await failIfNotOk(res, 'the promo code')
      const result = await res.json()

      if (!result.applied) {
        setAppliedPromo(null)
        setPromoError(result.reason || tr('pos.promoInvalid'))
        toast.error(result.reason || tr('pos.promoInvalid'))
        return
      }

      setAppliedPromo(result.promo)
      setPromoCode(result.code || code)
      toast.success(`Promo "${result.code}" applied`, {
        description: result.promo.type === 'PERCENTAGE'
          ? `${result.promo.value}% off${result.promo.maxDiscount > 0 ? ` (max ${tenant?.currencySymbol}${result.promo.maxDiscount})` : ''}`
          : `${tenant?.currencySymbol}${result.promo.value} off`,
      })
    } catch (err) {
      // A rejected code is a 200 with `applied:false` (handled above); anything
      // that lands here is a permission, server or network failure, so it must
      // not be reported as "Promo invalid".
      setAppliedPromo(null)
      setPromoError(describeFailure(err, 'the promo code').message)
      handleAction(err, 'the promo code')
    } finally {
      setPromoChecking(false)
    }
  }

  const removePromo = () => {
    setAppliedPromo(null)
    setPromoCode('')
    setPromoError('')
  }

  // ----- Open table sessions -------------------------------------------------
  // The POS is where staff actually work, so this is where a table's open
  // session belongs — including the ones that need closing by hand: a diner who
  // scanned and never ordered, or whose order never got marked complete.
  // (Sessions with no order also expire on their own: two minutes after the
  // diner's page closes for good, or after 30 silent minutes — migrations
  // 0041 and 0058.)
  const [sessions, setSessions] = useState<any[]>([])
  /** Bills with money still due — including sittings that already ended. */
  const [pendingBills, setPendingBills] = useState<any[]>([])
  const [endingTable, setEndingTable] = useState<string | null>(null)
  /** The session whose accept/decline request is in flight. */
  const [activatingSession, setActivatingSession] = useState<string | null>(null)
  /** The table whose consolidated bill is open. */
  const [billTable, setBillTable] = useState<{ id: string; name: string } | null>(null)

  // A repeating poll: only the first load may take over the screen. After that,
  // a failure leaves the previous list in place rather than blanking a page
  // that already loaded.
  const sessionsLoadedOnce = useRef(false)
  const loadSessions = useCallback(async () => {
    if (!tenant?.id) return
    try {
      const res = await edgeFetch('/api/table-session/active', { headers: { 'x-tenant-id': tenant?.id ?? '' } })
      await failIfNotOk(res, 'the table sessions')
      const json = await res.json()
      // The endpoint answers { sessions, pendingBills }; the old bare array is
      // still accepted so a cached bundle cannot blank the floor.
      if (Array.isArray(json)) {
        setSessions(json)
      } else {
        setSessions(Array.isArray(json?.sessions) ? json.sessions : [])
        setPendingBills(Array.isArray(json?.pendingBills) ? json.pendingBills : [])
      }
      sessionsLoadedOnce.current = true
    } catch (err) {
      if (!sessionsLoadedOnce.current) handleLoad(err, 'the table sessions')
    }
  }, [tenant, handleLoad])

  useEffect(() => {
    loadSessions()
    // The poll is the safety net; sessionRevision is the live path, bumped the
    // moment a session ends so the card disappears without a reload.
    const t = setInterval(loadSessions, 30000)
    return () => clearInterval(t)
  }, [loadSessions, sessionRevision])

  /**
   * Accept a table so its held orders reach the kitchen.
   *
   * The same permission that ends a session: this is a floor action. The
   * server re-checks every held line against the menu before releasing, and
   * answers 409 with the dish names if the cart went stale — which is why the
   * failure is shown, not swallowed.
   */
  const activateTable = async (sessionId: string, accept: boolean, tableName?: string) => {
    setActivatingSession(sessionId)
    try {
      const res = await edgeFetch(
        accept ? '/api/table-session/approve' : '/api/table-session/refuse',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tenant-id': tenant?.id ?? '' },
          body: JSON.stringify({ sessionId }),
        },
      )
      await failIfNotOk(res, 'the table')
      const body = await res.json().catch(() => null)
      toast.success(
        accept
          ? `${tableName ?? 'Table'} accepted${body?.released ? ` · ${body.released} order${body.released === 1 ? '' : 's'} sent to the kitchen` : ''}`
          : `${tableName ?? 'Table'} declined`,
      )
      await loadSessions()
    } catch (err) {
      handleAction(err, 'the table')
    } finally {
      setActivatingSession(null)
    }
  }

  /**
   * The floor, as five states.
   *
   * The board used to render only tables that had a session, so a free table
   * simply was not there and a closed-but-unpaid one only existed in a
   * separate strip. One list, keyed by table, is what lets a card move
   * Idle → Waiting → Active → Payment Due → Closed in place.
   */
  const floor = useMemo(() => {
    type State = 'idle' | 'waiting' | 'active' | 'payment-due' | 'closed'
    const byTable = new Map<string, any>()

    for (const group of sessions) {
      const live = (group.sessions || []).filter((s: any) => s.status === 'ACTIVE')
      const pending = live.find((s: any) => s.activationStatus === 'PENDING')
      const active = live.find((s: any) => s.activationStatus === 'ACTIVE')
      const allEnded = (group.sessions || []).length > 0 && live.length === 0
      const due = Number(group.check?.outstanding ?? 0) > 0

      const state: State = pending
        ? 'waiting'
        : active
          ? (due ? 'payment-due' : 'active')
          : allEnded
            ? (due ? 'payment-due' : 'closed')
            : 'idle'

      byTable.set(group.tableId, {
        tableId: group.tableId,
        label: group.table?.name || 'Table',
        area: group.table?.area ?? '',
        seats: group.table?.seats ?? null,
        sessions: group.sessions || [],
        liveSessions: live,
        pendingSession: pending ?? null,
        check: group.check ?? null,
        state,
        orderCount: live.reduce((n: number, s: any) => n + (s._count?.orders ?? 0), 0),
        heldCount: live.reduce((n: number, s: any) => n + (s._count?.held ?? 0), 0),
        openedAt: (group.sessions || [])[0]?.createdAt ?? null,
      })
    }

    // A bill with money due but no live session — the sitting ended unpaid.
    for (const bill of pendingBills) {
      const existing = byTable.get(bill.tableId)
      const check = {
        total: bill.total,
        paid: bill.paid,
        outstanding: bill.outstanding,
        status: bill.status,
      }
      if (existing) {
        existing.check = existing.check ?? check
        if (Number(existing.check?.outstanding ?? 0) > 0) existing.state = 'payment-due'
      } else {
        byTable.set(bill.tableId, {
          tableId: bill.tableId,
          label: bill.tableName || 'Table',
          area: bill.area ?? '',
          seats: null,
          sessions: [],
          liveSessions: [],
          pendingSession: null,
          check,
          state: 'payment-due' as State,
          orderCount: 0,
          heldCount: 0,
          openedAt: bill.openedAt ?? null,
        })
      }
    }

    // Free tables: on the board, because a floor you cannot see is a floor you
    // cannot seat.
    for (const t of tables) {
      if (byTable.has(t.id)) continue
      byTable.set(t.id, {
        tableId: t.id,
        label: t.name,
        area: t.area ?? '',
        seats: t.seats ?? null,
        sessions: [],
        liveSessions: [],
        pendingSession: null,
        check: null,
        state: 'idle' as State,
        orderCount: 0,
        heldCount: 0,
        openedAt: null,
      })
    }

    const order: Record<State, number> = { waiting: 0, 'payment-due': 1, active: 2, idle: 3, closed: 4 }
    return [...byTable.values()].sort(
      (a, b) => order[a.state as State] - order[b.state as State] || a.label.localeCompare(b.label),
    )
  }, [sessions, pendingBills, tables])

  const endSession = async (tableId: string, tableName?: string, force = false) => {
    setEndingTable(tableId)
    try {
      const res = await edgeFetch('/api/table-session/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant?.id ?? '' },
        body: JSON.stringify({ tableId, force }),
      })
      if (res.status === 409) {
        // The server refuses to close a table with open or unpaid orders. The
        // override is a second, deliberate click — never the default, and
        // never something a stale screen can trigger by accident.
        const body = await res.json().catch(() => null)
        if (body?.code === 'outstanding') {
          toast.error(body.error, {
            duration: 8000,
            action: {
              label: 'Close anyway',
              onClick: () => void endSession(tableId, tableName, true),
            },
          })
          return
        }
      }
      await failIfNotOk(res, 'the table session')
      const body = await res.json().catch(() => null)
      const stillOwed = body?.settlement?.action === 'unsettled';
      toast.success(`Session ended${tableName ? ` for ${tableName}` : ''}`, {
        description: stillOwed
          ? `${tenant?.currencySymbol ?? '₹'}${Number(body?.settlement?.outstanding ?? 0).toLocaleString('en-IN')} is still due — the bill is waiting in "Awaiting payment".`
          : 'The diner must scan the QR code again to order.',
      })
      // The prompt the cashier needs, at the moment they need it.
      if (stillOwed && canCollect) setBillTable({ id: tableId, name: tableName ?? 'Table' })
      await loadSessions()
    } catch (err) {
      handleAction(err, 'the table session')
    } finally {
      setEndingTable(null)
    }
  }

/**
 * The state a table card is in, as three words.
 *
 * Same anatomy for all three — a dot and a label — so the row of cards reads
 * as one set. Pending is the only one in the accent colour, because it is the
 * only one asking for something.
 */
type FloorState = 'idle' | 'waiting' | 'active' | 'payment-due' | 'closed'

const STATE_COPY: Record<FloorState, { label: string; style: string }> = {
  idle: { label: 'Idle', style: 'bg-secondary text-muted-foreground' },
  waiting: { label: 'Waiting', style: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  active: { label: 'Active', style: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  'payment-due': { label: 'Payment Due', style: 'bg-[#f97316]/15 text-[#c2410c] dark:text-[#fdba74]' },
  closed: { label: 'Closed', style: 'bg-secondary text-muted-foreground' },
}

function SessionStateBadge({ state }: { state: FloorState }) {
  const copy = STATE_COPY[state] ?? STATE_COPY.idle
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', copy.style)}>
      <span className="size-1.5 rounded-full bg-current" />
      {copy.label}
    </span>
  )
}

  /** How long a table has been open — the oldest session is the stale one. */
  const sessionAge = (group: any) => {
    const times = (group.sessions || []).map((s: any) => new Date(s.createdAt).getTime()).filter(Boolean)
    if (!times.length) return ''
    const mins = Math.max(0, Math.round((Date.now() - Math.min(...times)) / 60000))
    if (mins < 60) return `${mins} min`
    return `${Math.floor(mins / 60)}h ${mins % 60}m`
  }



  // per-category counts for the pills
  const catCount = (catId: string) =>
    catId === 'all'
      ? visibleMenuItems.length
      : visibleMenuItems.filter((m) => m.categoryId === catId).length

  if (!data || !tenant) return null
  // Only the sessions poll above can deny, and only on its first load.
  if (denied) return <AccessDenied failure={denied} onRetry={loadSessions} />

  const submitOrder = async () => {
    if (cart.length === 0) {
      toast.error('Cart is empty')
      return
    }
    if (orderType === 'DINE_IN' && !selectedTableId) {
      toast.error('Please select a table')
      return
    }
    if (orderType !== 'DINE_IN' && !customerName.trim()) {
      toast.error('Please enter customer name')
      return
    }
    // Snapshot the checkout into the persistent queue and hand it the
    // idempotency key. Online, it confirms in a moment; offline, it keeps the
    // order safe and retries until it lands. The cart is only cleared by the
    // confirmation itself — never optimistically, never on failure.
    // Synchronous double-click guard: the button's disabled state is React
    // state, but two clicks can land in one frame. The ref closes the window.
    if (submittingRef.current) return
    submittingRef.current = true
    const items = cart.map((c) => ({
      menuItemId: c.menuItemId,
      portionId: c.portionId || undefined,
      portion: c.portion || undefined,
      quantity: c.quantity,
      notes: c.notes,
    }))
    orderQueue(tenant.id, data.currentUser.id, {}).enqueue(
      'pos',
      {
        tableId: orderType === 'DINE_IN' ? selectedTableId : null,
        orderType,
        items,
        promoCode: promoCode || undefined,
        customerName: orderType !== 'DINE_IN' ? customerName : undefined,
        customerPhone: orderType !== 'DINE_IN' ? customerPhone : undefined,
        servedById: data.currentUser.id,
      },
      items.length,
      { 'x-tenant-id': tenant.id },
    )
    setCustomerName('')
    setCustomerPhone('')
    setCartOpen(false)
  }

  const q = tenantId && userId ? orderQueue(tenantId, userId, {}) : null

  return (
    <div className="flex h-full min-h-0">
      {/* Menu area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Order queue status — the cashier always knows where their order
            stands: sending, waiting for the network, or needing attention. */}
        {(queueBusy || failedEntries.length > 0) && (
          <div className="fixed bottom-3 left-3 z-50 max-w-[calc(100vw-1.5rem)] space-y-1.5">
            {queueBusy && (
              <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-[11px] font-medium text-muted-foreground shadow-lg backdrop-blur">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                {offline
                  ? tr('pos.queue.offline')
                  : tr('pos.queue.sending')}
              </div>
            )}
            {failedEntries.map((e) => (
              <div
                key={e.key}
                className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-background/95 px-3 py-1.5 text-[11px] shadow-lg backdrop-blur"
              >
                <span className="font-medium text-destructive">
                  {tr('pos.queue.failed')}
                </span>
                <button
                  className="rounded-full bg-primary px-2 py-0.5 font-semibold text-white"
                  onClick={() => q?.retry(e.key)}
                >
                  {tr('common.retry')}
                </button>
                <button
                  className="rounded-full border border-border px-2 py-0.5 text-muted-foreground"
                  onClick={() => {
                    void q?.dismiss(e.key).then((r) => {
                      if (r === 'confirmed') toast.success('Order actually went through')
                      else if (r === 'uncertain')
                        toast.error('Still no answer — kept the order pending')
                    })
                  }}
                >
                  {tr('common.dismiss')}
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Restaurant header — collapses on scroll to give menu cards more room */}
        <div className={cn(
          'relative px-3.5 md:px-6 overflow-hidden transition-all duration-200 ease-out',
          collapsed ? 'pt-2 pb-2' : 'pt-5 md:pt-6 pb-4'
        )}>
          <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-transparent pointer-events-none" />
          <div className="absolute -top-20 -right-20 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
          <div className="relative flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 shrink-0">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                OPEN
              </span>
              <div className="min-w-0">
                <h2 className={cn(
                  'font-bold tracking-tight truncate transition-all duration-300',
                  collapsed ? 'text-lg' : 'text-2xl md:text-3xl'
                )}>{tenant.name}</h2>
                <div className={cn('overflow-hidden transition-all duration-300', collapsed ? 'max-h-0 opacity-0' : 'max-h-6 opacity-100')}>
                  <p className="text-sm text-muted-foreground truncate">{tenant.tagline} · {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</p>
                </div>
              </div>
            </div>
            {/* Quick stats — hide when collapsed */}
            <div className={cn(
              'flex items-center gap-2 transition-all duration-300',
              collapsed ? 'opacity-0 scale-90 pointer-events-none' : 'opacity-100 scale-100'
            )}>
              <div className="rounded-xl bg-secondary/40 border border-border px-3 py-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{tr('pos.today')}</p>
                <p className="text-sm font-bold">{tenant.currencySymbol}{(data?.summary.revenue ?? 0).toFixed(0)}</p>
              </div>
              <div className="rounded-xl bg-secondary/40 border border-border px-3 py-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{tr('pos.active')}</p>
                <p className="text-sm font-bold">{data?.summary.activeOrders ?? 0}</p>
              </div>
            </div>
          </div>
          {/* Search — shrinks when collapsed */}
          <div className={cn(
            'relative flex items-center gap-2 bg-secondary/50 border border-border rounded-xl px-3.5 transition-all duration-300 w-full focus-within:border-primary/40 focus-within:shadow-glow-primary',
            collapsed ? 'mt-0 py-1.5' : 'mt-4 py-2.5'
          )}>
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr('pos.search')}
              className="bg-transparent outline-none text-sm h-8 flex-1 placeholder:text-muted-foreground min-w-0"
            />
            {search && <button onClick={() => setSearch('')} className="shrink-0"><X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" /></button>}
          </div>
        </div>

        {/* Category pills — horizontal scrollable row */}
        <div className="px-3.5 md:px-6 pb-3">
          <div className="w-full overflow-x-auto scrollbar-thin -mx-1 px-1">
            <div className="flex gap-2 w-max pb-1">
              <CategoryPill active={activeCat === 'all'} onClick={() => setActiveCat('all')} icon="🍴" label={tr('pos.all')} count={visibleMenuItems.length} />
              {categories.map((c) => (
                <CategoryPill
                  key={c.id}
                  active={activeCat === c.id}
                  onClick={() => setActiveCat(c.id)}
                  icon={c.icon || '🍴'}
                  label={c.name}
                  count={catCount(c.id)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Menu grid */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pb-4 md:pb-6 min-h-0">
          {/* `auto-rows-fr` sizes every row to the tallest card in the grid, so
              a row whose dishes are all short ends at the same height as the
              row with a portion selector in it. Combined with the bottom
              anchor on the price, the price line sits at the same baseline in
              every card — the grid reads as a table instead of a patchwork. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 auto-rows-fr gap-3 md:gap-4 pt-2">
            {filtered.map((item) => (
              <MenuCard
                key={item.id}
                item={item}
                currencySymbol={tenant.currencySymbol}
                inCart={cart.filter((c) => c.menuItemId === item.id).reduce((s, c) => s + c.quantity, 0)}
                onAdd={() => addToCart({ menuItemId: item.id, name: item.name, price: item.price, image: item.image })}
                onAddPortion={(portion) =>
                  addToCart({
                    menuItemId: item.id,
                    name: item.name,
                    portionId: portion.id,
                    portion: portion.name,
                    price: portion.price,
                    image: item.image,
                  })
                }
              />
            ))}
            {filtered.length === 0 && (
              <div className="col-span-full py-16 text-center text-muted-foreground">
                <p className="text-sm">{tr('pos.noItems')}</p>
              </div>
            )}
          </div>

          {/* Bills still owed, including sittings that already ended.
              A table that closes unpaid used to disappear from this screen and
              take its balance with it. */}
          {pendingBills.length > 0 && canCollect && (
            <div className="mt-8">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Awaiting payment
                </h3>
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  {pendingBills.length}
                </span>
              </div>
              <div className="flex gap-3 overflow-x-auto scrollbar-thin pb-2">
                {pendingBills.map((b) => (
                  <button
                    key={b.checkId}
                    type="button"
                    onClick={() => setBillTable({ id: b.tableId, name: b.tableName })}
                    data-pending-bill
                    className="w-56 shrink-0 rounded-2xl border border-amber-500/40 bg-card p-3.5 text-left transition-colors hover:border-amber-500/70"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-semibold">{b.tableName}</p>
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                        {b.status === 'UNSETTLED' ? 'closed · due' : 'open'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {b.area ? `${b.area} · ` : ''}{tenant.currencySymbol}
                      {Number(b.outstanding).toLocaleString('en-IN')} due
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {tenant.currencySymbol}{Number(b.paid).toLocaleString('en-IN')} of{' '}
                      {tenant.currencySymbol}{Number(b.total).toLocaleString('en-IN')} paid
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Open table sessions */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                {tr('pos.sessions')}
              </h3>
              {sessions.length > 0 && (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {sessions.length}
                </span>
              )}
            </div>

            {sessions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {tr('pos.noSessions')}
              </p>
            ) : (
              <div className="flex gap-3 overflow-x-auto scrollbar-thin pb-2">
                {floor.map((group) => {
                  const liveSessions = group.liveSessions
                  const pending = group.pendingSession
                  const state = group.state as 'idle' | 'waiting' | 'active' | 'payment-due' | 'closed'
                  const orderCount = group.orderCount
                  const heldCount = group.heldCount
                  const label = group.label

                  return (
                    <div
                      key={group.tableId}
                      data-session-state={state}
                      className={cn(
                        'flex w-64 shrink-0 flex-col rounded-2xl border bg-card p-4',
                        state === 'waiting'
                          ? 'border-amber-500/40'
                          : state === 'payment-due'
                            ? 'border-[#f97316]/45'
                            : state === 'closed'
                              ? 'border-border/70 opacity-70'
                              : state === 'idle'
                                ? 'border-border/60 border-dashed'
                                : 'border-border',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{label}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {group.table?.area}
                            {group.table?.seats ? ` · ${group.table.seats} seats` : ''}
                          </p>
                        </div>
                        <SessionStateBadge state={state} />
                      </div>

                      {/* The running bill, when there is one. A card that
                          only counts orders hides the number the cashier
                          actually needs. */}
                      {group.check && group.check.total > 0 && (
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {tenant.currencySymbol}
                            {Number(group.check.total).toLocaleString('en-IN')}
                          </span>
                          {group.check.outstanding > 0
                            ? ` due · ${tenant.currencySymbol}${Number(group.check.paid).toLocaleString('en-IN')} paid`
                            : ' · settled'}
                        </p>
                      )}

                      <div className="mt-2.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="size-3" />
                          {state === 'closed' ? 'closed' : sessionAge(group)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Receipt className="size-3" />
                          {orderCount === 0
                            ? heldCount > 0
                              ? `${heldCount} held`
                              : tr('pos.noOrderYet')
                            : `${orderCount} order${orderCount === 1 ? '' : 's'}`}
                        </span>
                      </div>

                      {pending && (
                        <div className="mt-2.5 rounded-xl border border-amber-500/25 bg-amber-50/70 p-2.5 dark:bg-amber-500/10">
                          <p className="text-[11px] font-semibold text-amber-900 dark:text-amber-200">
                            Awaiting Acceptance
                          </p>
                          <p className="mt-0.5 text-[10.5px] leading-snug text-amber-800/90 dark:text-amber-300/80">
                            Their order is saved and held — not in the kitchen yet.
                          </p>
                          <div className="mt-2 flex gap-1.5">
                            <Button
                              size="sm"
                              className="h-7 flex-1 bg-[#f97316] px-2 text-[11.5px] font-semibold text-white hover:bg-[#ea580c]"
                              onClick={() => activateTable(pending.id, true, label)}
                              disabled={!canEndSessions || activatingSession === pending.id}
                            >
                              {activatingSession === pending.id ? (
                                <Loader2 className="mr-1 size-3.5 animate-spin" />
                              ) : (
                                <Check className="mr-1 size-3.5" />
                              )}
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 flex-1 px-2 text-[11.5px]"
                              onClick={() => activateTable(pending.id, false, label)}
                              disabled={!canEndSessions || activatingSession === pending.id}
                            >
                              Reject
                            </Button>
                          </div>
                        </div>
                      )}

                      {(state === 'active' || state === 'payment-due' || state === 'closed') && (
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            'mb-1.5 h-8 w-full text-xs',
                            state === 'payment-due' && 'border-[#f97316]/45 bg-[#f97316]/5 text-[#c2410c] hover:bg-[#f97316]/10 dark:text-[#fdba74]',
                          )}
                          onClick={() => setBillTable({ id: group.tableId, name: label })}
                          disabled={!canEndSessions}
                        >
                          <Receipt className="mr-1.5 size-3.5" />
                          Table bill
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => endSession(group.tableId, label)}
                        disabled={endingTable === group.tableId || !canEndSessions || state === 'closed' || state === 'idle'}
                        title={!canEndSessions ? 'You do not have permission to manage the floor' : undefined}
                        className="mt-auto h-8 w-full text-xs"
                      >
                        <LogOut className="mr-1.5 size-3.5" />
                        {endingTable === group.tableId ? 'Ending…' : tr('pos.endSession')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <TableCheckDialog
        tableId={billTable?.id ?? null}
        tableName={billTable?.name ?? null}
        open={billTable !== null}
        onOpenChange={(v) => !v && setBillTable(null)}
        currencySymbol={tenant.currencySymbol}
        onSettled={loadSessions}
      />

      {/* Cart panel — desktop */}
      <div className="hidden lg:flex w-[380px] xl:w-[400px] shrink-0 border-l border-border bg-card flex-col">
        <CartPanel
          tables={tables}
          orderType={orderType}
          setOrderType={setOrderType}
          selectedTableId={selectedTableId}
          setSelectedTableId={setSelectedTableId}
          customerName={customerName}
          setCustomerName={setCustomerName}
          customerPhone={customerPhone}
          setCustomerPhone={setCustomerPhone}
          cart={cart}
          addToCart={addToCart}
          updateCartQty={updateCartQty}
          removeFromCart={removeFromCart}
          setCartNotes={setCartNotes}
          subtotal={subtotal}
          discount={discount}
          tax={tax}
          service={service}
          total={total}
          promoCode={promoCode}
          setPromoCode={setPromoCode}
          appliedPromo={appliedPromo}
          promoError={promoError}
          promoChecking={promoChecking}
          onApplyPromo={applyPromo}
          onRemovePromo={removePromo}
          onSubmit={submitOrder}
          submitting={queueBusy}
          canCheckout={canCheckout}
          canPromo={canPromo}
          currencySymbol={tenant.currencySymbol}
          taxRate={tenant.taxRate}
          serviceRate={tenant.serviceCharge}
        />
      </div>

      {/* Cart trigger — mobile */}
      {cart.length > 0 && (
        <button
          onClick={() => setCartOpen(true)}
          className="lg:hidden fixed bottom-24 right-4 z-40 flex items-center gap-2 rounded-full bg-gradient-to-r from-primary to-primary-hover text-white px-5 py-3 shadow-elevated ring-1 ring-white/20"
        >
          <ShoppingBag className="h-5 w-5" />
          <span className="text-sm font-semibold">{cart.length} items</span>
          <span className="text-sm font-bold">{tenant.currencySymbol}{total.toFixed(2)}</span>
        </button>
      )}

      <Sheet open={cartOpen} onOpenChange={setCartOpen}>
        <SheetContent side="right" className="w-full sm:w-[420px] p-0 bg-card overflow-hidden flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-2 shrink-0 border-b border-border">
            <SheetTitle>{tr('pos.cart')}</SheetTitle>
          </SheetHeader>
          <CartPanel
            embedded
            tables={tables}
            orderType={orderType}
            setOrderType={setOrderType}
            selectedTableId={selectedTableId}
            setSelectedTableId={setSelectedTableId}
            customerName={customerName}
            setCustomerName={setCustomerName}
            customerPhone={customerPhone}
            setCustomerPhone={setCustomerPhone}
            cart={cart}
            addToCart={addToCart}
            updateCartQty={updateCartQty}
            removeFromCart={removeFromCart}
            setCartNotes={setCartNotes}
            subtotal={subtotal}
            discount={discount}
            tax={tax}
            service={service}
            total={total}
            promoCode={promoCode}
            setPromoCode={setPromoCode}
            appliedPromo={appliedPromo}
            promoError={promoError}
            promoChecking={promoChecking}
            onApplyPromo={applyPromo}
            onRemovePromo={removePromo}
            onSubmit={submitOrder}
            submitting={queueBusy}
            canCheckout={canCheckout}
            canPromo={canPromo}
            currencySymbol={tenant.currencySymbol}
            taxRate={tenant.taxRate}
            serviceRate={tenant.serviceCharge}
          />
        </SheetContent>
      </Sheet>

      {/* Success modal */}
      {lastOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setLastOrder(null)}>
          <div className="bg-card rounded-3xl p-8 max-w-sm w-full text-center" onClick={(e) => e.stopPropagation()}>
            <div className="w-16 h-16 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-4">
              <Check className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-bold mb-1">Order Placed!</h3>
            <p className="text-sm text-muted-foreground mb-1">Order #{lastOrder.orderNumber}</p>
            <p className="text-2xl font-bold mb-4">{tenant.currencySymbol}{lastOrder.total.toFixed(2)}</p>
            <Button className="w-full" onClick={() => setLastOrder(null)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  )
}

function CategoryPill({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: string; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium transition-premium border',
        active
          ? 'bg-gradient-to-r from-primary to-primary-hover text-white border-transparent shadow-glow-primary'
          : 'bg-secondary/40 text-muted-foreground border-border hover:text-foreground hover:bg-secondary hover:border-primary/30'
      )}
    >
      <span className={cn('text-sm transition-transform group-hover:scale-110', active && 'drop-shadow')}>{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
      <span className={cn(
        'text-[10px] rounded-full px-1 py-0.5 font-semibold leading-none',
        active ? 'bg-white/20 text-white' : 'bg-secondary text-muted-foreground'
      )}>{count}</span>
    </button>
  )
}

function MenuCard({
  item,
  inCart,
  onAdd,
  onAddPortion,
  currencySymbol = '₹',
}: {
  item: any
  inCart: number
  onAdd: () => void
  /** Dishes sold per portion: select a portion, then add that portion. */
  onAddPortion: (portion: MenuPortion) => void
  currencySymbol?: string
}) {
  const tags = item.tags ? item.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : []
  const portions = useMemo(() => normalizePortions(item.portions), [item.portions])
  const [selectedPortionId, setSelectedPortionId] = useState<string>(() => portions[0]?.id ?? '')
  const activePortion =
    portions.find((p) => p.id === selectedPortionId) ?? portions[0] ?? null
  const displayPrice = activePortion ? activePortion.price : Number(item.price || 0)

  const handleTriggerAdd = () => {
    if (activePortion) {
      onAddPortion(activePortion)
    } else {
      onAdd()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleTriggerAdd}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleTriggerAdd()
        }
      }}
      // `pos-card-edge` is a phone-only light orange edge (see globals.css): the
      // desktop card is left with exactly the classes it had.
      className="group relative card-premium pos-card-edge rounded-2xl border border-border p-2.5 text-left transition-premium hover:border-primary/45 hover:-translate-y-0.5 hover:shadow-elevated flex flex-col cursor-pointer select-none"
    >
      {inCart > 0 && (
        <span className="absolute -top-1.5 -right-1.5 z-10 bg-gradient-to-br from-primary to-primary-hover text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center shadow-glow-primary ring-2 ring-background">
          {inCart}
        </span>
      )}

      {/* Compact circular thumbnail.
          A notch smaller than it was (56px on a laptop, 48px on a phone, from
          80/64): the picture was the tallest block on the card, so this is
          where most of the height comes off, and it still reads at a glance. */}
      <div className="relative w-12 h-12 sm:w-14 sm:h-14 mx-auto mb-1.5 shrink-0">
        {item.image ? (
          <img
            src={item.image}
            alt={item.name}
            className="w-full h-full rounded-full object-cover ring-1 ring-white/5 transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full rounded-full bg-secondary flex items-center justify-center text-xl sm:text-2xl">
            {item.category?.icon || '🍽️'}
          </div>
        )}
        <div className="absolute inset-0 rounded-full ring-1 ring-inset ring-white/5 pointer-events-none" />
        {item.rating > 0 && (
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5 rounded-full bg-background/90 backdrop-blur border border-border px-1.5 py-px text-[9px] font-medium leading-none">
            <span className="text-amber-400">★</span>
            <span>{item.rating.toFixed(1)}</span>
          </div>
        )}
      </div>

      {/* Name, tag, description.
          The name holds a fixed two-line slot on every card, so the
          description, the time row and the price below it all start at the
          same height whether the dish is called "Tea" or "Chilli Garlic
          Noodles". That is what makes the grid scannable: the eye can drop
          straight down a column instead of re-finding each field per card.

          The tag floats at the top-right of that slot, exactly where it was.
          Two things about the cap, both measured rather than assumed:

          The tag and the cap cannot share an element. `line-clamp` needs
          `display:-webkit-box`, and Safari treats the children of that box as
          stacked items — the badge stretched to the full card width and sat on
          its own line above the name (WebKit 26, checked directly). So the cap
          is a plain max-height on the <h4> that holds the float, which both
          engines honour: the badge stays a badge, and only the first line is
          shortened by it.

          And the cap cannot sit on a child of the float either. A clamped
          child is a block formatting context, and a BFC beside a float shrinks
          to avoid it — the name wrapped at 82px of a 153px card instead of
          running full width under the badge, which is what made "Crispy Crunch
          Burger" spill onto a third line. As the float's parent, the <h4> has
          its own box untouched by its own descendant float, so lines two and
          beyond get the whole width. `break-words` is the last-resort break
          for a token wider than the whole card. */}
      <div className="flex flex-1 min-w-0 flex-col">
        <h4 className="text-[13px] font-semibold leading-tight break-words min-h-[2.5em] max-h-[2.5em] overflow-hidden">
          {tags[0] && (
            // The float's own box is one line tall (16px against a 16.25px
            // line), so it shortens the first line only. At its natural 17px it
            // also clipped the second line's width, which pushed "Crispy Crunch
            // Burger" onto a third line that the cap then cut. The badge inside
            // is free to be a hair taller than its float box.
            <span className="float-right ml-1.5 h-4">
              <Tag label={tags[0]} className="px-1 text-[9px] leading-none" />
            </span>
          )}
          {item.name}
        </h4>
        {/* The description gets the slack, so a card without one leaves the
            room here rather than pushing the price out of line. */}
        <div className="flex-1 min-h-0 pt-0.5">
          {item.description && (
            <p className="text-[12px] leading-tight text-muted-foreground line-clamp-2 sm:text-[11px]">
              {item.description}
            </p>
          )}
        </div>
      </div>

      {/* Time & calories — deliberately outside the flexible area, so this row
          sits at the same height on every card in the grid. */}
      <p className="mt-1 flex items-center gap-1 text-[11px] leading-tight text-muted-foreground sm:text-[10px]">
        <span className="opacity-60">⏱</span>
        <span>{item.prepTime} min</span>
        {item.calories ? (
          <>
            <span className="opacity-40">·</span>
            <span className="opacity-60">🔥</span>
            <span>{item.calories} cal</span>
          </>
        ) : null}
      </p>

      {/* Compact segmented portion selector.
          The strip keeps its height on every card, with or without portions:
          a dish sold by portion draws the selector here, a plain dish leaves
          the same 22px empty. That is what makes the price line land on one
          baseline across the whole grid instead of stepping down on the cards
          that happen to have chips. */}
      <div className="mt-1.5 h-[22px]">
        {portions.length > 0 && activePortion && (
          <div
            className="grid h-full grid-flow-col auto-cols-fr gap-1 rounded-lg bg-secondary/60 p-0.5"
            role="group"
            aria-label={`Portion options for ${item.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            {portions.map((p) => {
              const selected = p.id === activePortion.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedPortionId(p.id)
                  }}
                  className={cn(
                    'rounded-md px-1.5 py-1 text-[10px] font-semibold leading-none transition-all truncate',
                    selected
                      ? 'bg-primary text-primary-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {p.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Price only — card tap handles add with selected portion */}
      <div className="mt-auto pt-1 flex items-center justify-between gap-2">
        <span className="font-bold text-sm sm:text-base text-gradient-primary leading-none">
          {currencySymbol}{displayPrice.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

interface CartPanelProps {
  embedded?: boolean
  tables: any[]
  orderType: string
  setOrderType: (t: any) => void
  selectedTableId: string | null
  setSelectedTableId: (id: string | null) => void
  customerName: string
  setCustomerName: (v: string) => void
  customerPhone: string
  setCustomerPhone: (v: string) => void
  cart: any[]
  addToCart: (item: any, qty?: number) => void
  updateCartQty: (id: string, qty: number, portion?: string | null, portionId?: string | null) => void
  removeFromCart: (id: string, portion?: string | null, portionId?: string | null) => void
  setCartNotes: (id: string, notes: string, portion?: string | null, portionId?: string | null) => void
  subtotal: number
  discount: number
  tax: number
  service: number
  total: number
  promoCode: string
  setPromoCode: (c: string) => void
  appliedPromo: any | null
  promoError: string
  promoChecking: boolean
  onApplyPromo: () => void
  onRemovePromo: () => void
  onSubmit: () => void
  submitting: boolean
  /** The caller may create an order — gates checkout. */
  canCheckout: boolean
  /** The caller may apply a promo / authorised discount. */
  canPromo: boolean
  currencySymbol: string
  taxRate: number
  serviceRate: number
}

function CartPanel(p: CartPanelProps) {
  const tr = useT()
  const { embedded } = p
  return (
    <div className={cn('flex flex-col h-full min-h-0 flex-1', embedded && 'overflow-hidden')}>
      {/* Order type + table/customer */}
      <div className="shrink-0 px-3 py-2.5 space-y-2 border-b border-border">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary/50 p-0.5 border border-border">
          {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const).map((t) => (
            <button
              key={t}
              onClick={() => p.setOrderType(t)}
              className={cn(
                'rounded-md py-1.5 text-[11px] font-semibold transition-premium',
                p.orderType === t
                  ? 'bg-gradient-to-r from-primary to-primary-hover text-white shadow-glow-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              )}
            >
              {t === 'DINE_IN' ? `🍽️ ${tr('pos.dineIn')}` : t === 'TAKEAWAY' ? `🥡 ${tr('pos.takeaway')}` : `🛵 ${tr('pos.delivery')}`}
            </button>
          ))}
        </div>
        {p.orderType === 'DINE_IN' ? (
          <Select value={p.selectedTableId || ''} onValueChange={(v) => p.setSelectedTableId(v)}>
            <SelectTrigger className="bg-secondary/50 border-0 h-9">
              <SelectValue placeholder={tr('pos.selectTable')} />
            </SelectTrigger>
            <SelectContent>
              {p.tables.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name} · {t.seats} seats · {t.area}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={p.customerName}
              onChange={(e) => p.setCustomerName(e.target.value)}
              placeholder="Customer name"
              className="bg-secondary/50 border-border text-sm h-9"
            />
            <Input
              value={p.customerPhone}
              onChange={(e) => p.setCustomerPhone(e.target.value)}
              placeholder="Phone"
              className="bg-secondary/50 border-border text-sm h-9"
            />
          </div>
        )}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 min-h-0">
        {p.cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-3">
              <ShoppingBag className="h-7 w-7 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{tr('pos.cartEmpty')}</p>
            <p className="text-xs text-muted-foreground mt-1">{tr('pos.cartHint')}</p>
          </div>
        ) : (
          <div className="space-y-3 py-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span>Item</span>
              <span>Qty · Price</span>
            </div>
            <Separator />
            {p.cart.map((c) => (
              <div key={`${c.menuItemId}::${c.portion ?? ''}`} className="rounded-xl bg-secondary/30 p-3">
                <div className="flex items-start gap-3">
                  <div className="w-12 h-12 rounded-full overflow-hidden shrink-0 bg-secondary">
                    {c.image ? <img src={c.image} alt={c.name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center">🍽️</div>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start gap-2">
                      <p className="text-sm font-medium leading-tight line-clamp-1">
                        {c.name}
                        {c.portion && (
                          <span className="ml-1.5 rounded bg-primary/10 border border-primary/20 px-1 py-px text-[10px] font-semibold text-primary align-middle">
                            {c.portion}
                          </span>
                        )}
                      </p>
                      <p className="text-sm font-semibold whitespace-nowrap">{p.currencySymbol}{(c.price * c.quantity).toFixed(2)}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{p.currencySymbol}{c.price.toFixed(2)} each</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <div className="flex items-center bg-secondary rounded-lg">
                    <button onClick={() => p.updateCartQty(c.menuItemId, c.quantity - 1, c.portion, c.portionId)} className="p-1.5 hover:text-primary">
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <span className="px-2 text-sm font-semibold min-w-[1.5rem] text-center">{c.quantity}</span>
                    <button onClick={() => p.updateCartQty(c.menuItemId, c.quantity + 1, c.portion, c.portionId)} className="p-1.5 hover:text-primary">
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input
                    value={c.notes || ''}
                    onChange={(e) => p.setCartNotes(c.menuItemId, e.target.value, c.portion, c.portionId)}
                    placeholder="Order Note…"
                    className="flex-1 bg-secondary/60 rounded-lg px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
                  />
                  <button onClick={() => p.removeFromCart(c.menuItemId, c.portion, c.portionId)} className="p-1.5 text-destructive/70 hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Promo + totals */}
      <div className="shrink-0 border-t border-border px-3 py-2.5 space-y-2">
        {p.appliedPromo ? (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-primary/10 border border-primary/20 px-2.5 py-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <Ticket className="h-3.5 w-3.5 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-primary truncate">{p.appliedPromo.code}</p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {p.appliedPromo.type === 'PERCENTAGE' ? `${p.appliedPromo.value}% off` : `${p.currencySymbol}${p.appliedPromo.value} off`}
                </p>
              </div>
            </div>
            <button onClick={p.onRemovePromo} className="text-muted-foreground hover:text-destructive shrink-0">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              value={p.promoCode}
              onChange={(e) => { p.setPromoCode(e.target.value.toUpperCase()); if (p.promoError) { /* clear handled in parent */ } }}
              onKeyDown={(e) => { if (e.key === 'Enter' && p.canPromo) p.onApplyPromo() }}
              placeholder={tr('pos.promo')}
              disabled={!p.canPromo}
              className="flex-1 bg-secondary/60 rounded-lg px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground uppercase min-w-0"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={p.onApplyPromo}
              disabled={p.promoChecking || !p.canPromo}
              title={!p.canPromo ? "You don't have permission to apply discounts" : undefined}
              className="h-8"
            >
              {p.promoChecking ? 'Checking…' : tr('pos.apply')}
            </Button>
          </div>
        )}
        {p.promoError && !p.appliedPromo && (
          <p className="text-xs text-destructive">{p.promoError}</p>
        )}
        <div className="space-y-1 text-xs">
          <Row label={tr('pos.subtotal')} value={`${p.currencySymbol}${p.subtotal.toFixed(2)}`} />
          {p.discount > 0 && (
            <Row label={`Discount`} value={`−${p.currencySymbol}${p.discount.toFixed(2)}`} muted className="text-primary" />
          )}
          <Row label={`${tr('pos.tax')} (${p.taxRate}%)`} value={`${p.currencySymbol}${p.tax.toFixed(2)}`} muted />
          <Row label={`${tr('pos.service')} (${p.serviceRate}%)`} value={`${p.currencySymbol}${p.service.toFixed(2)}`} muted />
        </div>
        <Separator />
        <div className="flex justify-between items-center">
          <span className="text-xs font-medium text-muted-foreground">{tr('pos.total')}</span>
          <span className="text-2xl font-bold tracking-tight text-gradient-primary">{p.currencySymbol}{p.total.toFixed(2)}</span>
        </div>
        <Button
          onClick={p.onSubmit}
          disabled={p.submitting || p.cart.length === 0 || !p.canCheckout}
          title={!p.canCheckout ? "You don't have permission to create orders" : undefined}
          className="w-full h-10 text-sm font-semibold bg-gradient-to-r from-primary to-primary-hover hover:shadow-glow-primary transition-premium border-0"
        >
          {p.submitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Placing order…</>
          ) : (
            <><CreditCard className="h-4 w-4 mr-2" /> {tr('pos.checkout')} · {p.currencySymbol}{p.total.toFixed(2)}</>
          )}
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value, muted, className }: { label: string; value: string; muted?: boolean; className?: string }) {
  return (
    <div className="flex justify-between">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`${muted ? 'text-muted-foreground' : 'font-medium'} ${className || ''}`}>{value}</span>
    </div>
  )
}
