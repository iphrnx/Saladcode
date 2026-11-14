'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useApp, type CheckSummary, type Order } from '@/components/app/data-context'
import { reconcileOrderExpansion, toggleOrderExpansion, type OrderExpansion } from './order-expansion'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { TableCheckDialog } from '@/components/shared/table-check-dialog'
import { SessionPaymentDialog } from '@/components/shared/session-payment-dialog'
import { SessionOrdersDrawer } from '@/components/shared/session-orders-drawer'
import { OrderDetailDrawer } from '@/components/shared/order-detail-drawer'
import { BillDialog } from '@/components/shared/bill-dialog'
import { edgeFetch } from '@/lib/edge'
import { describeFailure, failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { hasEffectivePermission } from '@/lib/permissions'
import { ORDER_STATUS, ORDER_STATUS_KEYS } from '@/lib/constants'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StatusBadge, OrderTypeBadge } from '@/components/shared/badges'
import {
  Search,
  Clock,
  TrendingUp,
  ShoppingBag,
  ChefHat,
  CheckCircle2,
  Utensils,
  CreditCard,
  Wallet,
  Banknote,
  Eye,
  Loader2,
  Inbox,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  FileText,
  Trash2,
  XCircle,
  Check,
  Receipt,
  HandPlatter,
  Users,
  Hourglass,
  ShoppingBasket,
  Layers,
  Coins,
  Printer,
  MoreHorizontal,
  Info,
  ClipboardCheck,
  ConciergeBell,
  SlidersHorizontal,
  Table2,
  Clock3,
  ReceiptText,
  LayoutGrid,
  CircleStop,
  CircleAlert,
  CircleCheck,
  Timer,
  Bell,
  CalendarDays,
  Flag,
  Power,
  Truck,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'READY', label: 'Ready' },
  { key: 'SERVED', label: 'Served' },
  { key: 'COMPLETED', label: 'Completed' },
] as const

const TYPE_OPTIONS = [
  { value: 'all', label: 'All Types' },
  { value: 'DINE_IN', label: 'Dine In' },
  { value: 'TAKEAWAY', label: 'Takeaway' },
  { value: 'DELIVERY', label: 'Delivery' },
] as const

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash', icon: Banknote },
  { value: 'CARD', label: 'Card', icon: CreditCard },
  { value: 'WALLET', label: 'Wallet', icon: Wallet },
] as const

/**
 * When an order was placed, in the terms someone reading the board uses:
 * "Today", "Yesterday", then a date.
 *
 * The cards showed a bare time, so 07:31 AM today and 09:44 PM three days ago
 * looked identical — you could not tell how old a ticket was without opening
 * it. Anything older than yesterday gets its date; today and yesterday are
 * named, which is what the person scanning the list is actually asking.
 */
function orderWhen(iso: string, opts: { weekday?: boolean } = {}): string {
  const d = new Date(iso)
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d >= startOfToday) return `Today · ${time}`
  if (d >= startOfYesterday) return `Yesterday · ${time}`

  const date = d.toLocaleDateString(
    [],
    opts.weekday
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short' },
  )
  return `${date} · ${time}`
}

/** One sitting — every order a table wrote before it got up. */
type Sitting = {
  key: string
  sessionId: string | null
  orders: Order[]
  latest: Order
  tableId: string | null
  tableName: string | null
  area: string | null
  seats: number | null
  orderType: string
  startedAt: string
  endedAt: string | null
  state: 'Active' | 'Ended'
  /** Distinct lines on the bill. */
  itemCount: number
  /** Sum of those lines' quantities. */
  qtyCount: number
  /**
   * Orders still to be served: Pending, Preparing or Ready.
   *
   * Scoped to this sitting, and to the states that mean "the kitchen still owes
   * this table food". A served or completed order is not pending; a cancelled
   * one is not owed; a held one was never accepted, so nobody is cooking it.
   */
  pendingToServe: number
  /** Orders this sitting actually served: Served or Completed. */
  served: number
  checkId: string | null
  /** Before tax: item prices less discount. */
  subtotal: number
  tax: number
  /** Service charge: whatever the total carries beyond food and tax. */
  service: number
  /** After tax and service charge. */
  total: number
  paid: number
  due: number
  /** The table's open bill also covers another sitting, so its paid figure is
   *  not this sitting's paid figure. */
  sharedBill: boolean
  /** Nothing is owed because nothing has been accepted yet. */
  awaiting: boolean
  /**
   * Every order that is not cancelled has been served.
   *
   * This is what makes a sitting billable: the kitchen owes the table nothing,
   * so the bill can be settled. Held and cancelled orders do not block it —
   * nothing was cooked and nothing is owed for them.
   */
  allServed: boolean
  /** The sitting's bill is settled: nothing left to collect. */
  paidOff: boolean
}

/**
 * How long a table has been sitting, in the smallest units that are still true.
 *
 * Ticks with the page clock rather than being frozen at render: a card that
 * says "28 min" ten minutes after it loaded is worse than no duration at all.
 */
function sittingDuration(startedAt: string, endedAt: string | null, now: number): string {
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : now
  const mins = Math.max(0, Math.floor((end - start) / 60000))
  if (mins < 1) return '<1 min'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

/** Compact elapsed label for the 4-cell session strip ("12m", "25m", "1h 5m"). */
function shortDuration(startedAt: string, endedAt: string | null, now: number): string {
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : now
  const mins = Math.max(0, Math.floor((end - start) / 60000))
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rest = mins % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export function OrdersView() {
  const t = useT()
  const { data, addOrUpdateOrder, removeOrder, checks, tableSessions, refresh } = useApp()
  /**
   * Dish photos, by menu item id.
   *
   * Order lines carry the menu item's id but not its picture, and the picture is
   * the menu's, not the order's — a dish renamed or re-photographed should not
   * change history, so the id is the join. Absent art falls back to a plate
   * tile rather than a broken image.
   */
  const dishImages = useMemo(() => {
    const map: Record<string, string> = {}
    for (const item of data?.menuItems ?? []) {
      if (item.image) map[item.id] = item.image
    }
    return map
  }, [data?.menuItems])
  const { handleAction } = useAccessDenied()
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [payOrder, setPayOrder] = useState<Order | null>(null)
  const [viewOrder, setViewOrder] = useState<Order | null>(null)
  // The bill action opens the TABLE's check, not the single order: a sitting
  // can be several orders and one payment, and the card is about the table.
  const [billTable, setBillTable] = useState<{ id: string; name: string; checkId: string | null } | null>(null)
  /**
   * The payment modal, opened by Complete & Pay.
   *
   * Separate from `billTable`: that one is the detail sheet ("Session Details"),
   * which shows the bill without taking money. This one is the till.
   */
  const [paySitting, setPaySitting] = useState<Sitting | null>(null)
  /** The drawer: the whole sitting, opened from its card or any of its rows. */
  const [ordersSittingKey, setOrdersSittingKey] = useState<string | null>(null)
  const [fallbackSitting, setFallbackSitting] = useState<Sitting | null>(null)
  /** Which order was pressed, so the drawer can open that one. */
  const [focusOrderId, setFocusOrderId] = useState<string | null>(null)
  /** The single-order drawer opened by pressing an order row. */
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null)
  const [fallbackDetailOrder, setFallbackDetailOrder] = useState<Order | null>(null)
  /**
   * The printable bill.
   *
   * `checkId` is the sitting's own check — the server resolves it by id, so the
   * document can never be another sitting's bill on the same table. An order
   * with no check behind it (a takeaway, or a sitting older than checks) falls
   * back to the single-order bill, which is all that exists for it.
   */
  const [billDoc, setBillDoc] = useState<{
    checkId: string | null
    orderId: string | null
    table: { name: string; seats: number; area: string } | null
    autoPrint: boolean
  } | null>(null)
  const [endingTable, setEndingTable] = useState<string | null>(null)
  /**
   * The clock the durations read.
   *
   * One timer for the whole board, once a minute — not one per card, and not a
   * re-fetch: the sitting's start never changes, only the distance to now.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // Order actions are granular now — each status transition has its own key,
  // plus payments and cancellation. The server enforces the same rule
  // independently; these booleans only keep the controls off screens where
  // the call would be refused anyway. The legacy `orders.manage` catch-all is
  // honoured here exactly as the server honours it, so a pre-migration custom
  // role keeps every button it had.
  const perms = data?.permissions ?? []
  const canPrepare = hasEffectivePermission(perms, 'orders.prepare')
  const canReady = hasEffectivePermission(perms, 'orders.ready')
  const canServe = hasEffectivePermission(perms, 'orders.serve')
  const canComplete = hasEffectivePermission(perms, 'orders.complete')
  const canCollectPay = hasEffectivePermission(perms, 'payments.collect')
  const canCancel = hasEffectivePermission(perms, 'orders.cancel')
  // Accepting or refusing a held order is a floor decision: nothing was cooked
  // and nothing was charged, so it needs the floor key, not `orders.cancel`.
  const canAcceptHeld = hasEffectivePermission(perms, 'table-sessions.manage')
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH')
  const [busy, setBusy] = useState<string | null>(null)
  // `busy` is React state, so two clicks in the same tick both read null and
  // both fire. The ref is checked and set synchronously — it is the real
  // guard; the state only drives the spinner.
  const busyRef = useRef<string | null>(null)
  // The whole view is the scroll container. The title, the status tabs, the
  // search row and the cards move together, so the tabs scroll up and away with
  // the content instead of sitting above it — and because there is no second
  // scrolling pane, a card can never be painted under the chrome: there is no
  // boundary left for it to cross.
  const scrollRef = useRef<HTMLDivElement>(null)

  // `PENDING_ACTIVATION` orders are shown here now: "Start Preparing" on one
  // accepts the table first (agent), which is the same decision the POS Accept
  // button makes. They are labelled "Waiting for table" so nobody mistakes one
  // for work that has been accepted, and the status tabs keep them under
  // All/Pending rather than inventing a sixth tab.
  const orders = data?.orders ?? []
  const tenant = data?.tenant
  const summary = data?.summary
  // A check can cover several sessions. Its order count confirms the board has the full check.
  const checkServing = useMemo(() => {
    const byCheck = new Map<string, { orderCount: number; allServed: boolean }>()
    for (const order of data?.orders ?? []) {
      if (!order.checkId || order.status === 'CANCELLED') continue
      const progress = byCheck.get(order.checkId) ?? { orderCount: 0, allServed: true }
      if (order.status !== 'PENDING_ACTIVATION') progress.orderCount++
      progress.allServed &&= ['SERVED', 'COMPLETED'].includes(order.status)
      byCheck.set(order.checkId, progress)
    }
    return byCheck
  }, [data?.orders])
  const cs = tenant?.currencySymbol ?? '$'

  /**
   * One card per sitting.
   *
   * Grouped by `tableSessionId` and never by table: two parties at the same
   * table are two bills, and merging them would put one table's food on the
   * other's card. An order with no session — a takeaway, a delivery, an order
   * written before sessions existed — is a sitting of one, keyed by its own id,
   * so it keeps a card and never gets folded into a table's bill.
   *
   * The money is the server's: `checks[checkId]` is the sitting's own check,
   * summed by the backend from the orders that are actually on it. The local
   * sum below is only the fallback for a sitting the server has no check row
   * for — the same fallback that was here before, not a second opinion.
   */
  const sittings = useMemo<Sitting[]>(() => {
    const buckets = new Map<string, Order[]>()
    for (const o of orders) {
      const key = o.tableSessionId ? `session:${o.tableSessionId}` : `order:${o.id}`
      const list = buckets.get(key)
      if (list) list.push(o)
      else buckets.set(key, [o])
    }

    const out: Sitting[] = []
    for (const [key, list] of buckets) {
      const rows = [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      const latest = rows[rows.length - 1]
      const sessionId = latest.tableSessionId ?? null
      const sitting = sessionId ? tableSessions[sessionId] : undefined
      const checkId = rows.find((o) => o.checkId)?.checkId ?? null
      const check = checkId ? checks[checkId] : undefined
      const onTheBill = rows.filter(
        (o) => !['CANCELLED', 'PENDING_ACTIVATION'].includes(o.status),
      )
      const fallbackTotal = +onTheBill.reduce((n, o) => n + o.total, 0).toFixed(2)
      /**
       * Whether the server's check for this sitting is only this sitting.
       *
       * A table's bill stays open while anyone is still seated at it, so a
       * sequel sitting that landed on the same table can share the earlier
       * one's check (and its payments). When the counts disagree, the check
       * quotes food that is not on this card: the card must show this sitting's
       * own total, and must not claim to know how much of the shared money was
       * paid for it.
       */
      const sharedBill = Boolean(check) && check!.orderCount !== onTheBill.length
      const total = !check || sharedBill ? fallbackTotal : check.total
      const paid = !check || sharedBill
        ? +onTheBill.reduce((n, o) => n + (o.paymentStatus === 'PAID' ? o.total : 0), 0).toFixed(2)
        : check.paid
      // Pre-tax and tax, from the same source as the total. When the check is
      // this sitting's own these are the server's sums; when it is shared (or
      // absent) they are this sitting's own orders, so the three figures still
      // add up to the total shown next to them.
      const localSubtotal = +onTheBill
        .reduce((n, o) => n + o.itemsTotal - o.discount, 0)
        .toFixed(2)
      const localTax = +onTheBill.reduce((n, o) => n + o.tax, 0).toFixed(2)
      const subtotal = !check || sharedBill ? localSubtotal : (check.subtotal ?? localSubtotal)
      const tax = !check || sharedBill ? localTax : (check.tax ?? localTax)
      // Whatever the total carries beyond food and tax is service charge. Shown
      // separately so the three figures on the card add up to the fourth, which
      // is the whole point of labelling them.
      const service = +Math.max(0, total - subtotal - tax).toFixed(2)
      const due = !check || sharedBill
        ? +Math.max(0, total - paid).toFixed(2)
        : Math.max(0, check.outstanding)
      // A sitting with a row is Active or Ended because the server says so. One
      // without a row (an order written before sessions existed, or a takeaway)
      // is open while any of its orders is, which is all that can be said.
      // Sittings in PENDING (e.g. awaiting activation) are active, not ended.
      const state: 'Active' | 'Ended' = sitting
        ? (sitting.status !== 'ENDED' && !sitting.endedAt) ? 'Active' : 'Ended'
        : rows.some((o) => !['COMPLETED', 'CANCELLED'].includes(o.status))
          ? 'Active'
          : 'Ended'
      // When it ended. The server's `ended_at` is the truth; without it the last
      // order's own timestamps are the closest honest answer, and a live sitting
      // has no end at all. Without this an ended card kept counting up.
      const endedAt = sitting?.endedAt
        ?? (state === 'Ended'
          ? latest.completedAt ?? latest.updatedAt ?? latest.createdAt
          : null)
      out.push({
        key,
        sessionId,
        orders: rows,
        latest,
        tableId: latest.tableId ?? null,
        tableName: latest.table?.name ?? null,
        area: latest.table?.area ?? null,
        seats: latest.table?.seats ?? null,
        orderType: latest.orderType,
        startedAt: sitting?.startedAt ?? rows[0].createdAt,
        endedAt,
        state,
        itemCount: onTheBill.reduce((n, o) => n + o.items.length, 0),
        qtyCount: onTheBill.reduce(
          (n, o) => n + o.items.reduce((q, it) => q + it.quantity, 0),
          0,
        ),
        pendingToServe: rows.filter((o) =>
          ['PENDING', 'PREPARING', 'READY'].includes(o.status),
        ).length,
        served: rows.filter((o) => ['SERVED', 'COMPLETED'].includes(o.status)).length,
        checkId,
        subtotal,
        tax,
        service,
        total,
        paid,
        due,
        sharedBill,
        awaiting: total <= 0,
        // The server's own rule (finalize_table_check refuses while any order is
        // PENDING_ACTIVATION, PENDING, PREPARING or READY), stated once here so
        // the button and the till cannot disagree.
        allServed: rows.every((o) =>
          ['SERVED', 'COMPLETED', 'CANCELLED'].includes(o.status),
        ),
        paidOff: check?.status === 'PAID',
      })
    }
    return out
  }, [orders, checks, tableSessions])

  const ordersSitting = useMemo(() => {
    if (!ordersSittingKey) return null
    return sittings.find((s) => s.key === ordersSittingKey) ?? fallbackSitting
  }, [sittings, ordersSittingKey, fallbackSitting])

  const detailOrder = useMemo(() => {
    if (!detailOrderId) return null
    return orders.find((o) => o.id === detailOrderId) ?? fallbackDetailOrder
  }, [orders, detailOrderId, fallbackDetailOrder])

  const openOrderDetail = useCallback((order: Order | null) => {
    if (!order) {
      setDetailOrderId(null)
      setFallbackDetailOrder(null)
    } else {
      setFallbackDetailOrder(order)
      setDetailOrderId(order.id)
    }
  }, [])

  const openSitting = useCallback((sitting: Sitting | null) => {
    if (!sitting) {
      setOrdersSittingKey(null)
      setFallbackSitting(null)
    } else {
      setFallbackSitting(sitting)
      setOrdersSittingKey(sitting.key)
    }
  }, [])

  /**
   * Which cards the filters leave on screen.
   *
   * A sitting matches when any of its orders does — and then the whole sitting
   * is shown. Hiding the order that did not match would print a card whose
   * rows do not add up to the total it quotes from the server, which is the
   * one thing this page must never do.
   */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sittings
      .filter((s) => {
        if (typeFilter !== 'all' && s.orderType !== typeFilter) return false
        if (
          statusFilter !== 'all' &&
          !s.orders.some(
            (o) => (o.status === 'PENDING_ACTIVATION' ? 'PENDING' : o.status) === statusFilter,
          )
        ) {
          return false
        }
        if (
          q &&
          !s.orders.some(
            (o) =>
              String(o.orderNumber).includes(q) ||
              (o.customerName || '').toLowerCase().includes(q),
          )
        ) {
          return false
        }
        return true
      })
      .sort(
        (a, b) => new Date(b.latest.createdAt).getTime() - new Date(a.latest.createdAt).getTime(),
      )
  }, [sittings, statusFilter, typeFilter, search])

  /**
   * The board a role gets.
   *
   * The sitting card is a **billing** view: one table, one bill, one place to
   * settle. That belongs to the roles that can settle — Owner, Manager,
   * Cashier — and it is decided by that capability rather than by the role's
   * name, so a custom role lands on the board its keys can actually work.
   *
   * Everybody else works the pass: a waiter carries one tray and a cook reads
   * one ticket, and both need every line of that order in front of them. They
   * keep the per-order card, which never hides an item behind an expander.
   */
  const sittingBoard = canComplete || canCollectPay

  /** Per-order filtering, for the per-order board. Same rules as before. */
  const visibleOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders
      .filter((o) => {
        const viewStatus = o.status === 'PENDING_ACTIVATION' ? 'PENDING' : o.status
        if (statusFilter !== 'all' && viewStatus !== statusFilter) return false
        if (typeFilter !== 'all' && o.orderType !== typeFilter) return false
        if (q) {
          const match =
            String(o.orderNumber).includes(q) ||
            (o.customerName || '').toLowerCase().includes(q)
          if (!match) return false
        }
        return true
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [orders, statusFilter, typeFilter, search])

  // (scrollRef is the whole-view scroll container, declared above)
  if (!data || !tenant) return <p role="status" className="px-4 py-6 text-sm text-muted-foreground">Loading orders…</p>

  /**
   * Accept or refuse one held order.
   *
   * Accepting releases the whole table (the server runs the same table-wide
   * RPC the POS uses) and leaves this order Pending — cooking is a separate
   * press. Refusing cancels only this order and touches nothing else.
   *
   * One id in flight at a time: a second tap while the first is in flight is
   * the same decision being made twice.
   */
  const decideHeld = async (order: Order, decision: 'accept' | 'reject') => {
    if (acceptingId) return
    setAcceptingId(order.id)
    try {
      const res = await edgeFetch(`/api/orders/${order.id}/${decision}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant.id },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast.error(body?.error ?? `The order could not be ${decision === 'accept' ? 'accepted' : 'rejected'}.`)
        return
      }
      const body = await res.json().catch(() => null)
      const updatedOrder = body?.order ?? (body?.id ? body : null)
      if (updatedOrder) {
        addOrUpdateOrder(updatedOrder, false, { force: true })
        if (detailOrderId === order.id) setFallbackDetailOrder(updatedOrder)
      } else {
        refresh()
      }
      toast.success(
        decision === 'accept'
          ? `Order #${order.orderNumber} accepted`
          : `Order #${order.orderNumber} rejected`,
      )
    } catch (err) {
      toast.error(describeFailure(err, 'the order').message)
    } finally {
      setAcceptingId(null)
    }
  }

  const updateStatus = async (order: Order, status: string, method?: string) => {
    // One transition at a time per screen — a second tap while the first is in
    // flight would race the server's status machine.
    if (busy) return
    if (busyRef.current) return
    busyRef.current = order.id + status
    setBusy(order.id + status)
    // Optimistic: the card moves now and the button stops spinning as soon as
    // the server confirms — not after a whole-app reload, which is what the
    // old `await refresh()` made the cashier watch. The payment fields ride
    // along when this tap is the "Paid & Complete" one, because that dialog is
    // where payment is recorded — the server never assumes it.
    const optimisticUpdatedOrder: Order = {
      ...order,
      status,
      updatedAt: new Date().toISOString(),
      ...(method ? { paymentMethod: method, paymentStatus: 'PAID' } : {}),
    }
    addOrUpdateOrder(optimisticUpdatedOrder, false, { force: true })
    if (detailOrderId === order.id) {
      setFallbackDetailOrder(optimisticUpdatedOrder)
    }
    try {
      const res = await edgeFetch(`/api/orders/${order.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-tenant-id': tenant.id,
        },
        body: JSON.stringify({
          status,
          ...(method ? { paymentMethod: method, paymentStatus: 'PAID' } : {}),
        }),
      })
      await failIfNotOk(res, 'the order')
      const confirmed = await res.json()
      // The authoritative row replaces the optimistic one.
      addOrUpdateOrder(confirmed, false, { force: true })
      if (detailOrderId === order.id) {
        setFallbackDetailOrder(confirmed)
      }
      toast.success(`Order #${order.orderNumber} → ${capitalize(status.toLowerCase())}`)

      // When an order is completed, end the table session for that table
      if (status === 'COMPLETED' && order.tableId) {
        // 1. Broadcast immediately across browser tabs for zero-delay instant session end
        try {
          if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
            const bc = new BroadcastChannel('the_salad_orders_sync')
            bc.postMessage({
              type: 'SESSION_ENDED',
              tenantId: tenant.id,
              tableId: order.tableId,
              orderId: order.id,
              status: 'COMPLETED',
              timestamp: new Date().toISOString(),
            })
            bc.close()
          }
        } catch {}

        // 2. The backend already ended it. Marking an order COMPLETED ends the
        //    table's session inside the orders function, in that same request,
        //    and publishes the same SESSION_ENDED event — so the extra call to
        //    /api/table-session/end that used to sit here was doing nothing the
        //    server had not already done. It is gone, which also means the
        //    kitchen no longer needs permission to end a table session: the
        //    broadcast above is for the other tabs on this browser, and the
        //    server's event covers the rest.
      }
    } catch (e) {
      // Roll back the optimistic move — the card returns to the status the
      // database actually holds, and the next sync keeps it there.
      addOrUpdateOrder(order, false, { force: true })
      if (detailOrderId === order.id) {
        setFallbackDetailOrder(order)
      }
      handleAction(e, 'the order')
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const handlePay = async () => {
    if (!payOrder) return
    await updateStatus(payOrder, 'COMPLETED', paymentMethod)
    setPayOrder(null)
    setPaymentMethod('CASH')
  }

  /**
   * Close a sitting from the board.
   *
   * The server refuses to close a table that still owes money or still has food
   * on the pass, and answers 409 with what is outstanding — the same refusal the
   * floor board gets. "Close anyway" is a second, explicit click, never the
   * default, and it is the only path that passes `force`.
   *
   * Named by session id as well as table: two sittings can share a table, and
   * ending by table alone would close the other party's sitting too.
   */
  const endSitting = async (sitting: Sitting, force = false) => {
    if (!sitting.tableId || endingTable) return
    const target = sitting.tableId
    setEndingTable(target)
    try {
      const res = await edgeFetch('/api/table-session/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant!.id },
        body: JSON.stringify({
          tableId: sitting.tableId,
          ...(sitting.sessionId ? { sessionId: sitting.sessionId } : {}),
          force,
        }),
      })
      if (res.status === 409) {
        const body = await res.json().catch(() => null)
        if (body?.code === 'outstanding') {
          toast.error(body.error, {
            duration: 8000,
            action: { label: 'Close anyway', onClick: () => void endSitting(sitting, true) },
          })
          return
        }
      }
      await failIfNotOk(res, 'the table session')
      toast.success(`Session ended${sitting.tableName ? ` for ${sitting.tableName}` : ''}`)

      if (data?.settings?.auto_bill_print === 'true') {
        setBillDoc({
          checkId: sitting.checkId,
          orderId: sitting.latest.id,
          table: sitting.tableId
            ? {
                name: sitting.tableName ?? 'Table',
                seats: sitting.seats ?? 0,
                area: sitting.area ?? '',
              }
            : null,
          autoPrint: true,
        })
      }
    } catch (e) {
      handleAction(e, 'the table session')
    } finally {
      setEndingTable(null)
    }
  }

  const activeCount = orders.filter((o) =>
    ['PENDING', 'PREPARING', 'READY', 'SERVED'].includes(o.status)
  ).length

  return (
    <div
      ref={scrollRef}
      data-orders-scroll
      className="h-full overflow-y-auto scrollbar-thin pb-4 md:pb-6"
    >
      {/* Header. It scrolls with everything else now, so the shrink-on-scroll
          is gone: it saved no space once the header itself leaves the screen,
          and it moved the cards every time it toggled. */}
      <div className="px-3.5 pt-3 pb-2 md:px-6 md:pt-6 md:pb-2.5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-lg font-bold tracking-tight md:text-2xl">
              {sittingBoard && <ChefHat aria-hidden className="size-5 text-orange-600 md:size-6" />}
              Orders
            </h2>
            <p className="text-sm text-muted-foreground">
              {sittingBoard ? 'Live orders from your restaurant' : t('orders.title')}
            </p>
          </div>
          <div className={cn("flex flex-wrap gap-2", sittingBoard && "hidden md:flex")}>
            <StatChip icon={ShoppingBag} label="Active" value={String(activeCount)} accent />
            <StatChip
              icon={TrendingUp}
              label="Revenue"
              value={`${cs}${(summary?.revenue ?? 0).toFixed(2)}`}
            />
            <StatChip
              icon={Inbox}
              label="Today"
              value={String(summary?.ordersToday ?? 0)}
            />
          </div>
        </div>
      </div>

      {/* Filters — sticky at top on mobile, tablet & desktop */}
      <div
        data-orders-filters
        className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b border-border/40 shadow-xs px-3.5 pt-2 pb-2.5 md:px-6 md:pt-2 md:pb-3 transition-shadow"
      >
        <div className={sittingBoard ? "space-y-2 md:space-y-3" : "space-y-2.5"}>
          <div
            data-orders-tabs
            className={cn("-mx-0.5 flex items-center overflow-x-auto overscroll-x-contain scrollbar-thin px-0.5 py-0.5", sittingBoard ? "gap-0.5 sm:gap-1" : "gap-1.5")}
          >
            {STATUS_TABS.map((tab) => {
              const active = statusFilter === tab.key
              const count =
                tab.key === 'all'
                  ? orders.length
                  : orders.filter(
                      (o) => (o.status === 'PENDING_ACTIVATION' ? 'PENDING' : o.status) === tab.key,
                    ).length
              return (
                <button
                  key={tab.key}
                  data-active={active}
                  onClick={() => setStatusFilter(tab.key)}
                  className={cn(
                    'flex shrink-0 items-center rounded-full border border-border/70 py-1.5 font-semibold whitespace-nowrap transition-colors md:px-3.5 md:text-xs',
                    sittingBoard ? 'gap-0.5 px-1.5 text-[11px] sm:gap-1 sm:px-2' : 'gap-1.5 px-3 text-[11.5px]',
                    active
                      ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                      : 'bg-card text-foreground/85 shadow-xs hover:bg-secondary/60',
                  )}
                >
                  {tab.label}
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-center tabular-nums',
                      sittingBoard ? 'min-w-[1.1rem] text-[9.5px] font-semibold md:text-[10px]' : 'min-w-5 text-[10px] font-bold',
                      active ? 'bg-white/20 text-white' : 'bg-orange-500/10 text-orange-700 dark:text-orange-300'
                    )}
                  >
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border/70 bg-card px-3.5 py-1.5 shadow-xs md:py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground md:h-4 md:w-4" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('orders.search')}
                aria-label={t('orders.search')}
                className="h-6 min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground md:h-7 md:text-sm"
              />
              {search && (
                <button onClick={() => setSearch('')} className="shrink-0">
                  <span className="text-[10.5px] text-muted-foreground hover:text-foreground md:text-xs">Clear</span>
                </button>
              )}
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className={cn("h-9.5 shrink-0 rounded-full border border-border/70 bg-card shadow-xs md:h-11 md:text-sm", sittingBoard ? "px-2.5 text-[11px] md:px-3" : "w-[112px] px-3 text-[11.5px] font-medium md:w-[156px] md:px-3.5")}>
                {sittingBoard && <SlidersHorizontal aria-hidden className="size-3.5 shrink-0" />}
                <SelectValue placeholder="Order type" />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Cards grid — one card per sitting for the billing roles, one per order
          for the pass. Three across once there is room for three readable
          cards, two on a tablet, one on a phone; the breakpoints are the widths
          a card can hold its own contents at, not round numbers. */}
      <div data-orders-list className="px-3.5 md:px-6 pt-3 md:pt-4">
        {(sittingBoard ? filtered.length : visibleOrders.length) === 0 ? (
          <EmptyState
            icon={Inbox}
            title={t('orders.noOrders')}
            description="Adjust your filters or check back later."
          />
        ) : sittingBoard ? (
          <div
            data-sitting-board
            className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 md:gap-5"
          >
            {filtered.map((sitting) => (
              <SittingCard
                key={sitting.key}
                sitting={sitting}
                currencySymbol={cs}
                check={sitting.checkId ? checks[sitting.checkId] : undefined}
                checkCanSettle={!sitting.checkId || (
                  checkServing.get(sitting.checkId)?.allServed === true &&
                  checkServing.get(sitting.checkId)?.orderCount === checks[sitting.checkId]?.orderCount
                )}
                dishImages={dishImages}
                now={now}
                canComplete={canComplete}
                canCollectPay={canCollectPay}
                canEndSession={hasEffectivePermission(perms, 'table-sessions.manage')}
                ending={endingTable === sitting.tableId}
                onView={(order) => setViewOrder(order)}
                onOpenOrder={(order) => openOrderDetail(order)}
                onOpenOrders={(target) => {
                  setFocusOrderId(null)
                  openSitting(target)
                }}
                onCompletePay={(target) => setPaySitting(target)}
                onBill={(target, autoPrint) =>
                  setBillDoc({
                    checkId: target.checkId,
                    orderId: target.latest.id,
                    table: target.tableId
                      ? {
                          name: target.tableName ?? 'Table',
                          seats: target.seats ?? 0,
                          area: target.area ?? '',
                        }
                      : null,
                    autoPrint,
                  })
                }
                onEndSession={(target) => void endSitting(target)}
                onPay={(order) => {
                  setPayOrder(order)
                  setPaymentMethod('CASH')
                }}
              />
            ))}
          </div>
        ) : (
          <div data-order-board className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 md:gap-4 xl:grid-cols-3">
            {visibleOrders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                currencySymbol={cs}
                onView={() => setViewOrder(order)}
                onViewBill={() =>
                  order.tableId
                    ? setBillTable({
                        id: order.tableId,
                        name: order.table?.name ?? 'Table',
                        checkId: order.checkId ?? null,
                      })
                    : setBillDoc({
                        checkId: order.checkId ?? null,
                        orderId: order.id,
                        table: null,
                        autoPrint: false,
                      })
                }
                canPrepare={canPrepare}
                canReady={canReady}
                canServe={canServe}
                canComplete={canComplete}
                canCollectPay={canCollectPay}
                canCancel={canCancel}
                busy={busy === order.id + (actionForStatus(order.status)?.nextStatus || '')}
                onUpdate={(next) => void updateStatus(order, next)}
                onPay={() => {
                  setPayOrder(order)
                  setPaymentMethod('CASH')
                }}
                canAccept={canAcceptHeld}
                accepting={acceptingId === order.id}
                onAccept={() => void decideHeld(order, 'accept')}
                onReject={() => void decideHeld(order, 'reject')}
              />
            ))}
          </div>
        )}
      </div>

      {/* Payment dialog (single-order / Takeaway / Delivery fallback) */}
      <Dialog open={!!payOrder} onOpenChange={(o) => !o && setPayOrder(null)}>
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100%-1.25rem)] max-w-[420px] gap-0 overflow-hidden rounded-[28px] border border-border/60 bg-card p-0 shadow-2xl sm:max-w-[440px]"
        >
          <DialogTitle className="sr-only">{t('orders.complete')}</DialogTitle>
          <DialogDescription className="sr-only">
            {payOrder ? `Order #${payOrder.orderNumber} · ${cs}${payOrder.total.toFixed(2)}` : ''}
          </DialogDescription>

          {payOrder && (
            <div className="relative max-h-[88dvh] overflow-y-auto px-4 pb-5 pt-5 sm:px-6 sm:pb-6 sm:pt-6">
              <button
                type="button"
                onClick={() => setPayOrder(null)}
                aria-label="Close"
                className="absolute right-4 top-4 z-10 grid size-9 place-items-center rounded-full border border-border/80 bg-card text-foreground shadow-sm transition-colors hover:bg-secondary"
              >
                <X className="size-4.5" strokeWidth={2.4} />
              </button>

              {/* Header */}
              <div className="flex items-start gap-3 pr-11">
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20 sm:size-12">
                  <Wallet className="size-5.5 sm:size-6 text-primary" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[20px] font-extrabold leading-tight tracking-tight text-foreground sm:text-[22px]">
                    Complete &amp; Pay
                  </h2>
                  <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground sm:text-[13px]">
                    Settle the bill for Order #{payOrder.orderNumber}
                  </p>
                </div>
              </div>

              {/* Order context banner */}
              <div className="mt-3.5 flex items-center gap-2.5 rounded-2xl bg-primary/[0.04] px-3.5 py-3 border border-primary/20">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                  {payOrder.orderType === 'DELIVERY' ? (
                    <Truck className="size-5" />
                  ) : payOrder.orderType === 'TAKEAWAY' ? (
                    <ShoppingBag className="size-5" />
                  ) : (
                    <Table2 className="size-5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-bold leading-tight text-foreground sm:text-[17px]">
                    {payOrder.customerName || `Order #${payOrder.orderNumber}`}
                  </p>
                  <p className="truncate text-[11.5px] text-muted-foreground sm:text-[12px]">
                    #{payOrder.orderNumber}
                    {payOrder.customerPhone ? ` · ${payOrder.customerPhone}` : ''}
                    {payOrder.table?.name ? ` · ${payOrder.table.name}` : ''}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  {payOrder.orderType === 'DELIVERY'
                    ? 'Delivery'
                    : payOrder.orderType === 'TAKEAWAY'
                      ? 'Takeaway'
                      : 'Single Order'}
                </span>
              </div>

              {/* Bill Summary card */}
              <div className="mt-3.5 rounded-2xl border border-border/70 bg-card p-3.5 shadow-xs sm:p-4">
                <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2.5">
                  <p className="flex items-center gap-1.5 text-[14.5px] font-bold text-foreground sm:text-[15px]">
                    <Layers className="size-4 text-primary" />
                    Bill Summary
                  </p>
                  <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground sm:text-[12px]">
                    (1 Order · {payOrder.items.reduce((q, it) => q + it.quantity, 0)} Items)
                  </span>
                </div>

                {payOrder.items.length > 0 && (
                  <div className="mt-2.5 max-h-36 space-y-1.5 overflow-y-auto border-b border-border/40 pb-2.5 scrollbar-thin">
                    {payOrder.items.map((it) => (
                      <div key={it.id} className="space-y-0.5">
                        <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                          <span className="min-w-0 truncate text-foreground">
                            <span className="font-semibold text-muted-foreground">{it.quantity}× </span>
                            {it.name}
                            {it.portion && (
                              <span className="ml-1.5 rounded border border-primary/20 bg-primary/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-primary">
                                {it.portion}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-bold tabular-nums text-foreground">
                            {cs}
                            {(it.price * it.quantity).toFixed(2)}
                          </span>
                        </div>
                        {it.notes && (
                          <p className="text-[11px] text-muted-foreground pl-4 italic">
                            {it.notes}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-2.5 space-y-2 text-[13px]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {cs}
                      {payOrder.itemsTotal.toFixed(2)}
                    </span>
                  </div>
                  {payOrder.discount > 0 && (
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">Discount</span>
                      <span className="font-semibold tabular-nums text-foreground">
                        −{cs}
                        {payOrder.discount.toFixed(2)}
                      </span>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground">Tax</span>
                    <span className="font-semibold tabular-nums text-foreground">
                      {cs}
                      {payOrder.tax.toFixed(2)}
                    </span>
                  </div>
                  {payOrder.serviceCharge > 0 && (
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-muted-foreground">Service</span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {cs}
                        {payOrder.serviceCharge.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="mt-3 flex items-center justify-between rounded-xl bg-primary/10 px-3.5 py-2.5 border border-primary/20">
                  <span className="text-[14.5px] font-bold text-foreground sm:text-[15px]">Total Amount</span>
                  <span className="text-[18px] font-extrabold tabular-nums text-foreground sm:text-[19px]">
                    {cs}
                    {payOrder.total.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Payment method */}
              <p className="mt-4 flex items-center gap-1.5 text-[14.5px] font-bold text-foreground sm:text-[15px]">
                <CreditCard className="size-4 text-primary" />
                Select Payment Method
              </p>
              <div className="mt-2.5 grid grid-cols-3 gap-2 sm:gap-2.5">
                {PAYMENT_METHODS.map((m) => {
                  const active = paymentMethod === m.value
                  const Icon = m.icon
                  return (
                    <button
                      type="button"
                      key={m.value}
                      onClick={() => setPaymentMethod(m.value)}
                      aria-pressed={active}
                      className={cn(
                        'relative flex flex-col items-center justify-center gap-1.5 rounded-2xl border-[1.5px] px-2 py-3.5 transition-all cursor-pointer',
                        active
                          ? 'border-primary bg-primary/[0.06] shadow-xs'
                          : 'border-border/80 bg-card hover:border-border hover:bg-secondary/40',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full transition-colors',
                          active ? 'bg-primary text-primary-foreground shadow-xs' : 'border-[1.5px] border-border/80 bg-transparent',
                        )}
                      >
                        {active && <Check className="size-3" strokeWidth={3.5} />}
                      </span>
                      <Icon className={cn('size-6 sm:size-7', active ? 'text-primary' : 'text-muted-foreground')} />
                      <span className={cn('text-[13.5px]', active ? 'font-bold text-foreground' : 'font-medium text-foreground')}>{m.label}</span>
                    </button>
                  )
                })}
              </div>

              <Button
                onClick={handlePay}
                disabled={busy === payOrder.id + 'COMPLETED'}
                className="mt-4 h-12 w-full rounded-2xl bg-primary hover:bg-primary/90 text-[15px] font-bold text-primary-foreground shadow-md shadow-primary/25 transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                {busy === payOrder.id + 'COMPLETED' ? (
                  <>
                    <Loader2 className="mr-2 size-5 animate-spin" /> Processing…
                  </>
                ) : (
                  <>
                    <span className="grid size-5.5 place-items-center rounded-full bg-white/20 text-white">
                      <Check className="size-3.5" strokeWidth={3.5} />
                    </span>
                    Complete Payment
                    <span className="ml-2 font-extrabold tabular-nums">
                      {cs}
                      {payOrder.total.toFixed(2)}
                    </span>
                  </>
                )}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Order details dialog */}
      <Dialog open={!!viewOrder} onOpenChange={(o) => !o && setViewOrder(null)}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto scrollbar-thin">
          {viewOrder && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center justify-between gap-2 pr-6">
                  <span>Order #{viewOrder.orderNumber}</span>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={viewOrder.status} />
                    <OrderTypeBadge type={viewOrder.orderType} />
                  </div>
                </DialogTitle>
                <DialogDescription>
                  {orderWhen(viewOrder.createdAt, { weekday: true })}
                  {viewOrder.completedAt && (
                    <span className="text-muted-foreground"> · Completed {new Date(viewOrder.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                </DialogDescription>
              </DialogHeader>

              {/* Customer / table info */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-secondary/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Type</p>
                  <p className="font-medium">
                    {viewOrder.orderType === 'DINE_IN' ? '🍽️ Dine In' : viewOrder.orderType === 'TAKEAWAY' ? '🥡 Takeaway' : '🛵 Delivery'}
                  </p>
                </div>
                <div className="rounded-xl bg-secondary/40 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {viewOrder.orderType === 'DINE_IN' ? 'Table' : 'Customer'}
                  </p>
                  <p className="font-medium truncate">
                    {viewOrder.orderType === 'DINE_IN'
                      ? (viewOrder.table?.name || '—')
                      : (viewOrder.customerName || viewOrder.customerPhone || '—')}
                  </p>
                </div>
                {viewOrder.customerPhone && viewOrder.orderType !== 'DINE_IN' && (
                  <div className="rounded-xl bg-secondary/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Phone</p>
                    <p className="font-medium truncate">{viewOrder.customerPhone}</p>
                  </div>
                )}
                {viewOrder.servedBy && (
                  <div className="rounded-xl bg-secondary/40 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Served by</p>
                    <p className="font-medium truncate">{viewOrder.servedBy.name}</p>
                  </div>
                )}
              </div>

              {/* Items */}
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Items ({viewOrder.items.length})</p>
                <Separator />
                {viewOrder.items.map((it) => (
                  <div key={it.id} className="flex justify-between text-sm py-1">
                    <span className="min-w-0">
                      <span className="text-muted-foreground font-medium">{it.quantity}× </span>
                      {it.name}
                      {it.portion && (
                        <span className="ml-1.5 rounded bg-primary/10 border border-primary/20 px-1 py-px text-[10px] font-semibold text-primary align-middle">
                          {it.portion}
                        </span>
                      )}
                      {it.notes && <span className="block text-xs text-muted-foreground italic pl-5">“{it.notes}”</span>}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap ml-2">{cs}{(it.price * it.quantity).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              {viewOrder.notes && (
                <div className="rounded-xl bg-secondary/30 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Order Note</p>
                  <p className="text-sm italic">“{viewOrder.notes}”</p>
                </div>
              )}

              {/* Totals */}
              <Separator />
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{cs}{viewOrder.itemsTotal.toFixed(2)}</span></div>
                {viewOrder.discount > 0 && (
                  <div className="flex justify-between text-primary"><span>Discount {viewOrder.promoCode ? `(${viewOrder.promoCode})` : ''}</span><span>−{cs}{viewOrder.discount.toFixed(2)}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>{cs}{viewOrder.tax.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Service</span><span>{cs}{viewOrder.serviceCharge.toFixed(2)}</span></div>
                <Separator />
                <div className="flex justify-between text-base font-bold"><span>Order Total</span><span className="text-gradient-primary">{cs}{viewOrder.total.toFixed(2)}</span></div>
              </div>

              {/* Payment */}
              <div className="flex items-center justify-between rounded-xl bg-secondary/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Payment</span>
                <div className="flex items-center gap-2">
                  <PaymentPill status={viewOrder.paymentStatus} method={viewOrder.paymentMethod} />
                </div>
              </div>

              {viewOrder.promoCode && (
                <p className="text-xs text-muted-foreground text-center">Promo code <span className="font-mono font-semibold text-primary">{viewOrder.promoCode}</span> applied</p>
              )}

              <DialogFooter>
                <Button variant="secondary" onClick={() => setViewOrder(null)} className="w-full">Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Bill dialog */}
      <TableCheckDialog
        tableId={billTable?.id ?? null}
        tableName={billTable?.name ?? null}
        checkId={billTable?.checkId ?? null}
        open={billTable !== null}
        onOpenChange={(v) => !v && setBillTable(null)}
        currencySymbol={cs}
        canCollect={canCollectPay}
      />

      <OrderDetailDrawer
        order={detailOrder}
        open={detailOrder !== null}
        onOpenChange={(v) => !v && openOrderDetail(null)}
        currencySymbol={cs}
        dishImages={dishImages}
        canPrepare={canPrepare}
        canReady={canReady}
        canServe={canServe}
        canAccept={canAcceptHeld}
        accepting={detailOrder ? acceptingId === detailOrder.id : false}
        busy={detailOrder ? Boolean(busy && busy.startsWith(detailOrder.id)) : false}
        onAccept={() => detailOrder && void decideHeld(detailOrder, 'accept')}
        onReject={() => detailOrder && void decideHeld(detailOrder, 'reject')}
        onUpdate={(next) => detailOrder && void updateStatus(detailOrder, next)}
        onBack={() => {
          const sitting = sittings.find((x) => x.orders.some((o) => o.id === detailOrder?.id))
          const id = detailOrder?.id
          openOrderDetail(null)
          if (sitting) {
            setFocusOrderId(id ?? null)
            openSitting(sitting)
          }
        }}
      />

      {/* The sitting's order book. Opened from its card, or from any of its
          order rows, which is where the per-order buttons used to live. */}
      {ordersSitting && (
        <SessionOrdersDrawer
          open
          onOpenChange={(v) => {
            if (!v) openSitting(null)
          }}
          tableName={ordersSitting.tableName ?? `Order #${ordersSitting.latest.orderNumber}`}
          area={ordersSitting.area}
          seats={ordersSitting.seats}
          orderType={ordersSitting.orderType}
          startedAt={ordersSitting.startedAt}
          endedAt={ordersSitting.endedAt}
          state={ordersSitting.state}
          orders={ordersSitting.orders}
          currencySymbol={cs}
          dishImages={dishImages}
          bill={{
            subtotal: ordersSitting.subtotal,
            tax: ordersSitting.tax,
            service: ordersSitting.service,
            total: ordersSitting.total,
            paid: ordersSitting.paid,
            due: ordersSitting.due,
            sharedBill: ordersSitting.sharedBill,
            awaiting: ordersSitting.awaiting,
          }}
          invoiceNumber={
            (ordersSitting.checkId ? checks[ordersSitting.checkId]?.invoiceNumber : null) ||
            `INV-${String(ordersSitting.latest.orderNumber).padStart(6, '0')}`
          }
          paymentMethod={ordersSitting.latest.paymentMethod || 'Cash'}
          paidAt={ordersSitting.endedAt || ordersSitting.latest.completedAt || ordersSitting.latest.createdAt}
          canPay={
            ordersSitting.state === 'Active' &&
            ordersSitting.allServed &&
            canComplete &&
            canCollectPay &&
            (ordersSitting.checkId ? !ordersSitting.paidOff : ordersSitting.latest.paymentStatus !== 'PAID')
          }
          onCompletePay={() => {
            const target = ordersSitting
            openSitting(null)
            if (target.tableId && target.checkId) {
              setPaySitting(target)
            } else {
              setPayOrder(target.latest)
              setPaymentMethod('CASH')
            }
          }}
          onPrintBill={() => {
            const target = ordersSitting
            setBillDoc({
              checkId: target.checkId,
              orderId: target.latest.id,
              table: target.tableId
                ? {
                    name: target.tableName ?? 'Table',
                    seats: target.seats ?? 0,
                    area: target.area ?? '',
                  }
                : null,
              autoPrint: true,
            })
          }}
          onDownloadBill={() => {
            const target = ordersSitting
            setBillDoc({
              checkId: target.checkId,
              orderId: target.latest.id,
              table: target.tableId
                ? {
                    name: target.tableName ?? 'Table',
                    seats: target.seats ?? 0,
                    area: target.area ?? '',
                  }
                : null,
              autoPrint: false,
            })
          }}
          onSessionDetails={() => {
            const target = ordersSitting
            openSitting(null)
            setBillTable({
              id: target.tableId!,
              name: target.tableName ?? 'Table',
              checkId: target.checkId,
            })
          }}
          focusOrderId={focusOrderId}
          activity={ordersSitting.orders.flatMap((o) => [
            { id: `${o.id}-placed`, label: `Order #${o.orderNumber} placed`, at: o.createdAt },
            ...(o.completedAt
              ? [{ id: `${o.id}-done`, label: `Order #${o.orderNumber} completed`, at: o.completedAt }]
              : []),
          ]).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())}
        />
      )}

      {/* The till. Opened by Complete & Pay only. */}
      <SessionPaymentDialog
        tableId={paySitting?.tableId ?? null}
        checkId={paySitting?.checkId ?? null}
        tableName={paySitting?.tableName ?? null}
        tableHint={
          paySitting
            ? [paySitting.area || 'Main Hall', paySitting.seats ? `${paySitting.seats} Seats` : null, ORDER_TYPE_LABEL[paySitting.orderType] ?? paySitting.orderType]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        currencySymbol={cs}
        startedAt={paySitting?.startedAt ?? null}
        open={paySitting !== null}
        onOpenChange={(v) => !v && setPaySitting(null)}
        onPaid={() => void refresh()}
        onViewBill={() => {
          const target = paySitting
          if (!target) return
          setPaySitting(null)
          setBillDoc({
            checkId: target.checkId,
            orderId: target.latest.id,
            table: target.tableId
              ? {
                  name: target.tableName ?? 'Table',
                  seats: target.seats ?? 0,
                  area: target.area ?? '',
                }
              : null,
            autoPrint: false,
          })
        }}
        onViewSession={() => {
          // "Session Details" is the sitting's own order book, the one its card
          // opens — not the printable bill. The fresher copy from the board is
          // preferred, because settling just moved its orders to Completed; the
          // snapshot this sheet was opened with is the fallback if the sitting
          // has already left the filtered board.
          const target = paySitting
          if (!target) return
          setPaySitting(null)
          const fresh = sittings.find((s) =>
            target.checkId ? s.checkId === target.checkId : s.key === target.key,
          )
          openSitting(
            fresh ?? { ...target, state: 'Ended', paidOff: true, endedAt: target.endedAt ?? new Date().toISOString() },
          )
        }}
      />

      {/* The printable bill for one sitting — by check id, so it can only ever
          be the bill of the card that was pressed. */}
      <BillDialog
        orderId={billDoc?.orderId ?? null}
        checkId={billDoc?.checkId ?? null}
        tableHint={billDoc?.table ?? null}
        autoPrint={billDoc?.autoPrint ?? false}
        open={billDoc !== null}
        onOpenChange={(v) => !v && setBillDoc(null)}
      />

    </div>
  )
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
}

/** Money, in the restaurant's currency, grouped the Indian way. */
function money(symbol: string, amount: number): string {
  return `${symbol}${Number(amount ?? 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * When a table sat down, split so it can never be cut off.
 *
 * The day goes in the label ("Started · Yesterday") and the clock in the value.
 * Whole, that sentence is 123px wide and the cell is 95–116px — it was being
 * clipped at both breakpoints. Time alone fits anywhere.
 */
function sessionWhen(iso: string): { day: string; time: string } {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { day: '', time: '—' }
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d >= startOfToday) return { day: 'Today', time }
  if (d >= startOfYesterday) return { day: 'Yesterday', time }
  return { day: d.toLocaleDateString([], { day: 'numeric', month: 'short' }), time }
}

/**
 * Cell borders for the information strip.
 *
 * Two columns on a phone, four or five on a wide screen, so the edges cannot be
 * written once: an element that starts a row on a phone but sits mid-row on a
 * desktop needs its top border only below `md`.
 */
function cellEdge(index: number): string {
  return cn(
    'border-border',
    index % 2 === 1 && 'border-l',
    index >= 2 && 'border-t md:border-t-0',
    index > 0 && 'md:border-l',
  )
}

/**
 * The per-order card, for the roles that work one order at a time.
 *
 * A waiter carries plates and needs to see every line of the order in front of
 * them; a kitchen needs the whole ticket, not a summary of a table's evening.
 * So these roles keep the order-per-card board, and this card shows **all** of
 * it without asking for a click: number, table, time, status, and every item
 * with its quantity and portion. Nothing is behind an expander, because the
 * expander was exactly what a cook had no time for.
 *
 * The actions are the order's own forward transitions, gated by the same keys
 * the server checks: Kitchen holds prepare/ready, Waiter holds serve, and a
 * role without the key sees the control disabled rather than a dead 403.
 */
function OrderCard({
  order,
  currencySymbol,
  onView,
  onViewBill,
  canPrepare,
  canReady,
  canServe,
  canComplete,
  canCollectPay,
  canCancel,
  busy,
  onUpdate,
  onPay,
  canAccept,
  accepting,
  onAccept,
  onReject,
}: {
  order: Order
  currencySymbol: string
  onView: () => void
  onViewBill: () => void
  canPrepare: boolean
  canReady: boolean
  canServe: boolean
  canComplete: boolean
  canCollectPay: boolean
  canCancel: boolean
  busy: boolean
  onUpdate: (next: string) => void
  onPay: () => void
  canAccept: boolean
  accepting: boolean
  onAccept: () => void
  onReject: () => void
}) {
  const t = useT()
  const action = actionForStatus(order.status)
  const next = action?.nextStatus
  const keyPerms: Record<string, boolean> = {
    'orders.prepare': canPrepare,
    'orders.ready': canReady,
    'orders.serve': canServe,
    'orders.complete': canComplete,
  }
  const canRun =
    next === 'COMPLETED'
      ? canComplete && canCollectPay
      : next
        ? (keyPerms[ORDER_STATUS_KEYS[next]] ?? false)
        : false
  const canCancelOrder = canCancel && !['COMPLETED', 'CANCELLED'].includes(order.status)
  const billReady = order.status === 'COMPLETED'

  const where =
    order.orderType === 'DINE_IN'
      ? order.table?.name || '—'
      : order.orderType === 'TAKEAWAY'
        ? 'Takeaway'
        : 'Delivery'
  const who = order.customerName || order.customerPhone || null
  const accent = ORDER_STATUS[order.status as keyof typeof ORDER_STATUS]?.color ?? '#94a3b8'
  const isRecent = order.status === 'PENDING' && Date.now() - new Date(order.createdAt).getTime() < 60000

  return (
    <Card
      data-order-card
      className={cn(
        'flex min-h-[550px] w-full flex-col overflow-hidden rounded-2xl border border-border bg-card p-0',
        'shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[box-shadow,border-color] duration-300',
        isRecent && 'border-primary/40 shadow-[0_0_0_2px_rgba(249,115,22,0.18)]',
      )}
    >
      {/* Header: the number, where it is, and what state it is in. */}
      <div className="flex items-start justify-between gap-2 p-3.5 pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: accent }} />
          <span className="truncate text-[15px] font-bold tracking-tight">#{order.orderNumber}</span>
          {isRecent && (
            <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
              NEW
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge status={order.status} />
          <OrderTypeBadge type={order.orderType} />
        </div>
      </div>

      {/* Where and when — the two things a floor lead asks first. */}
      <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 text-[11.5px] text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Utensils className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground/80">{where}</span>
          {who && <span className="truncate text-muted-foreground/80">· {who}</span>}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
          <Clock className="size-3" />
          {orderWhen(order.createdAt)}
        </span>
      </div>

      <Separator />

      {/* Every line, always. A cook reads the whole ticket; a waiter carries the
          whole tray. Nothing here is collapsed, capped or scrolled. */}
      <div className="space-y-1.5 px-3.5 py-3">
        {order.items.map((it) => (
          <div key={it.id} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0">
              <span className="font-semibold text-muted-foreground">{it.quantity}× </span>
              <span className="font-medium text-foreground">{it.name}</span>
              {it.portion && (
                <span className="ml-1.5 rounded border border-border bg-secondary px-1 py-px align-middle text-[10px] font-semibold text-muted-foreground">
                  {it.portion}
                </span>
              )}
              {it.notes && (
                <span className="mt-0.5 block truncate text-[11px] italic text-muted-foreground/90">
                  “{it.notes}”
                </span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {currencySymbol}
              {(it.price * it.quantity).toFixed(2)}
            </span>
          </div>
        ))}
        {order.items.length === 0 && <p className="text-xs text-muted-foreground">No items</p>}
        {order.notes && (
          <p className="pt-0.5 text-[11.5px] italic text-muted-foreground">“{order.notes}”</p>
        )}
      </div>

      <Separator />

      {/* Money and the next move. */}
      <div className="mt-auto space-y-2.5 p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex flex-col leading-tight">
            <span className="text-[9.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Total
            </span>
            <span className="text-[17px] font-bold tabular-nums">
              {currencySymbol}
              {order.total.toFixed(2)}
            </span>
          </div>
          <PaymentPill status={order.paymentStatus} method={order.paymentMethod} />
        </div>

        {order.status === 'PENDING_ACTIVATION' ? (
          <div className="flex flex-wrap gap-1.5">
            <Button
              onClick={onAccept}
              disabled={accepting || !canAccept}
              title={!canAccept ? "You don't have permission to accept orders" : undefined}
              className="h-9 flex-1"
            >
              {accepting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Check className="mr-1.5 size-4" />}
              Accept
            </Button>
            <Button
              variant="outline"
              onClick={onReject}
              disabled={accepting || !canAccept}
              title={!canAccept ? "You don't have permission to reject orders" : undefined}
              className="h-9 flex-1"
            >
              <XCircle className="mr-1.5 size-4" />
              Reject
            </Button>
            <Button variant="outline" size="sm" onClick={onView} className="h-9 px-2.5" aria-label="View order">
              <Eye className="size-4" />
            </Button>
          </div>
        ) : action && canRun ? (
          <div className="flex flex-wrap gap-1.5">
            <Button
              onClick={() => (action.nextStatus === 'COMPLETED' ? onPay() : onUpdate(action.nextStatus!))}
              disabled={busy}
              className="h-9 flex-1"
              variant={action.variant}
            >
              {busy && action.icon ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                action.icon && <action.icon className="mr-1.5 size-4" />
              )}
              {t(action.label)}
            </Button>
            <Button variant="outline" size="sm" onClick={onView} className="h-9 px-2.5" aria-label="View order">
              <Eye className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onViewBill}
              disabled={!billReady}
              title="The bill becomes available once the order is completed"
              aria-label={`Bill for order ${order.orderNumber} (available once the order is completed)`}
              className="h-9 px-2.5"
            >
              <FileText className="size-4" />
            </Button>
            {canCancelOrder && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUpdate('CANCELLED')}
                title="Cancel order (kept in history)"
                aria-label={`Cancel order ${order.orderNumber}`}
                className="h-9 px-2.5 text-muted-foreground hover:border-destructive/50 hover:text-destructive"
              >
                <XCircle className="size-4" />
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {/* Either the order is finished, or the next move belongs to a key
                this role does not hold. A waiter has no business seeing a
                disabled "Complete & Pay"; they see where it stands. */}
            <div className="inline-flex flex-1 items-center gap-1.5 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
              {action ? <Clock className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {action
                ? waitingOn(action.nextStatus)
                : order.status === 'COMPLETED'
                  ? 'Completed'
                  : 'Cancelled'}
            </div>
            <Button variant="outline" size="sm" onClick={onView} className="h-9 px-2.5" aria-label="View order">
              <Eye className="size-4" />
            </Button>
            <Button
              variant={billReady ? 'default' : 'outline'}
              size="sm"
              onClick={onViewBill}
              disabled={!billReady}
              title={billReady ? 'View, print or download the bill' : 'No bill for a cancelled order'}
              className="h-9 px-2.5"
              aria-label="Bill"
            >
              <FileText className="size-4" />
            </Button>
            {canCancelOrder && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUpdate('CANCELLED')}
                title="Cancel order (kept in history)"
                aria-label={`Cancel order ${order.orderNumber}`}
                className="h-9 px-2.5 text-muted-foreground hover:border-destructive/50 hover:text-destructive"
              >
                <XCircle className="size-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

/**
 * One sitting, as one card.
 *
 * A card is a bill, so it is grouped by session and never by table: two parties
 * at the same table are two cards, two totals, two bills. Every order the table
 * wrote sits inside it as a row, in the order they were written, each keeping
 * its own status — a sitting with one dish cooking and one served is normal and
 * has to look normal.
 *
 * Money comes from the server's check (`sitting.total/paid/due`), never from
 * adding the rows up here. Collapsing the card hides the detail, not the bill:
 * the totals and the actions stay, because a cashier who has collapsed a card
 * still needs to take its money.
 */
function SittingCard({
  sitting,
  check,
  checkCanSettle,
  currencySymbol,
  dishImages,
  now,
  canComplete,
  canCollectPay,
  canEndSession,
  ending,
  onView,
  onOpenOrders,
  onOpenOrder,
  onCompletePay,
  onBill,
  onEndSession,
  onPay,
}: {
  sitting: Sitting
  check?: CheckSummary
  checkCanSettle: boolean
  currencySymbol: string
  dishImages: Record<string, string>
  now: number
  canComplete: boolean
  canCollectPay: boolean
  canEndSession: boolean
  ending: boolean
  onView: (order: Order) => void
  onOpenOrders: (sitting: Sitting) => void
  onOpenOrder: (order: Order) => void
  onCompletePay: (sitting: Sitting) => void
  onBill: (sitting: Sitting, autoPrint: boolean) => void
  onEndSession: (sitting: Sitting) => void
  onPay: (order: Order) => void
}) {
  const active = sitting.state === 'Active'
  const started = sessionWhen(sitting.startedAt)
  const hasPayPerm = canComplete && canCollectPay
  const onlyPendingActivation = sitting.orders.every((order) => order.status === 'PENDING_ACTIVATION')
  const hasBill = check ? check.orderCount > 0 : !sitting.awaiting
  const awaiting = !hasBill
  const paidOff = sitting.checkId ? sitting.paidOff : sitting.latest.paymentStatus === 'PAID'
  const canPay = active && hasPayPerm && sitting.allServed && checkCanSettle &&
    !paidOff && hasBill && Boolean(
      (sitting.tableId && sitting.checkId) || (!sitting.checkId && sitting.latest.status !== 'COMPLETED'),
    )
  const isSettledEnded = !active && !onlyPendingActivation && !awaiting && paidOff

  // The parent keys each card by session ID, so another sitting cannot reuse this state.
  const [expansion, setExpansion] = useState<OrderExpansion | null>(null)
  const currentExpansion = reconcileOrderExpansion(expansion, sitting.orders)
  if (currentExpansion !== expansion) setExpansion(currentExpansion)

  if (isSettledEnded) {
    const labelName = sitting.tableName ?? `Order #${sitting.latest.orderNumber}`
    const subLabel = sitting.tableName
      ? [sitting.area || 'Main Hall', sitting.seats ? `${sitting.seats} Seats` : null, ORDER_TYPE_LABEL[sitting.orderType] ?? sitting.orderType]
          .filter(Boolean)
          .join(' · ')
      : ORDER_TYPE_LABEL[sitting.orderType] ?? sitting.orderType
    const endedTime = sitting.endedAt ? timeOf(sitting.endedAt) : '—'

    return (
      <Card
        data-order-card
        data-session-card={sitting.sessionId ?? undefined}
        className={cn(
          'flex min-h-[550px] w-full flex-col overflow-hidden rounded-2xl border p-3 sm:p-3.5',
          'border-border/80 bg-card shadow-xs transition-all duration-200 hover:border-primary/40 hover:shadow-md',
        )}
      >
        {/* Cloche Hero */}
        <div className="flex shrink-0 flex-col items-center py-1 text-center">
          <div className="relative grid size-18 place-items-center">
            <span aria-hidden className="absolute inset-0 rounded-full bg-orange-500/[0.08] ring-1 ring-orange-500/15" />
            <span aria-hidden className="absolute inset-1 rounded-full bg-primary/[0.12] blur-[10px]" />
            <svg
              viewBox="0 0 84 68"
              fill="none"
              aria-hidden="true"
              className="relative h-13 w-17 drop-shadow-[0_3px_8px_rgba(249,115,22,0.28)]"
            >
              <defs>
                <linearGradient id={`cloche-${sitting.key}`} x1="22" y1="14" x2="62" y2="50" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stopColor="#FBBF24" />
                  <stop offset="50%" stopColor="#F97316" />
                  <stop offset="100%" stopColor="#EA580C" />
                </linearGradient>
              </defs>
              <path d="M18 19L11 12M13 31H5M66 19L73 12M71 31H79" stroke="#F97316" strokeWidth="2.8" strokeLinecap="round" />
              <circle cx="42" cy="14" r="3.6" fill="#F97316" />
              <path d="M15 47C15 30.5 27 19 42 19C57 19 69 30.5 69 47H15Z" fill={`url(#cloche-${sitting.key})`} />
              <path d="M23.5 40C25 31 31 25.5 38.5 24" stroke="white" strokeOpacity="0.45" strokeWidth="2.4" strokeLinecap="round" />
              <rect x="10" y="47" width="64" height="5" rx="2.5" fill="#f97316" />
            </svg>
            <span className="absolute bottom-0 right-0 grid size-5.5 place-items-center rounded-full bg-emerald-600 text-white shadow-sm ring-2 ring-card">
              <Check className="size-3" strokeWidth={3.5} />
            </span>
          </div>
          <h3 className="mt-1.5 text-base font-bold leading-tight tracking-tight text-foreground sm:text-lg">
            Session Ended
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {labelName} has been closed and settled.
          </p>
        </div>

        {/* Table + Paid Badge */}
        <div className="mt-2 flex shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-card px-2.5 py-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-foreground border border-border/40">
            {sitting.tableName ? <LayoutGrid className="size-4" /> : <ShoppingBag className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight text-foreground">{labelName}</p>
            <p className="truncate text-[10.5px] text-muted-foreground">{subLabel}</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <Check className="size-2.5" strokeWidth={3.6} />
            Paid
          </span>
        </div>

        {/* Started at / Ended at / Duration */}
        <div className="mt-1.5 grid shrink-0 grid-cols-3 divide-x divide-border/50 rounded-xl border border-border/50 bg-secondary/35 py-1">
          <div className="flex min-w-0 items-center justify-center gap-1 px-1">
            <CalendarDays className="size-3 shrink-0 text-muted-foreground/70" strokeWidth={2} />
            <div className="min-w-0">
              <p className="truncate text-[9px] leading-tight text-muted-foreground">Started at</p>
              <p className="truncate text-[10.5px] font-bold leading-tight tabular-nums text-foreground">{started.time}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-center justify-center gap-1 px-1">
            <Power className="size-3 shrink-0 text-muted-foreground/70" strokeWidth={2} />
            <div className="min-w-0">
              <p className="truncate text-[9px] leading-tight text-muted-foreground">Ended at</p>
              <p className="truncate text-[10.5px] font-bold leading-tight tabular-nums text-foreground">{endedTime}</p>
            </div>
          </div>
          <div className="flex min-w-0 items-center justify-center gap-1 px-1">
            <Timer className="size-3 shrink-0 text-muted-foreground/70" strokeWidth={2} />
            <div className="min-w-0">
              <p className="truncate text-[9px] leading-tight text-muted-foreground">Duration</p>
              <p className="truncate text-[10.5px] font-bold leading-tight tabular-nums text-foreground">
                {sittingDuration(sitting.startedAt, sitting.endedAt, now)}
              </p>
            </div>
          </div>
        </div>

        {/* Bill Summary */}
        <div className="mt-1.5 flex flex-col rounded-xl border border-border/60 bg-card p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
              <Layers className="size-3.5 text-muted-foreground" />
              Bill Summary
            </p>
            <span className="shrink-0 text-[10.5px] font-medium text-muted-foreground">
              {sitting.orders.length} Order{sitting.orders.length === 1 ? '' : 's'} · {sitting.qtyCount} Item{sitting.qtyCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-1 divide-y divide-border/30 border-t border-border/40 pt-0.5 text-[11px]">
            <div className="flex items-baseline justify-between py-0.5">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-semibold tabular-nums text-foreground">{money(currencySymbol, check?.subtotal ?? sitting.subtotal)}</span>
            </div>
            <div className="flex items-baseline justify-between py-0.5">
              <span className="text-muted-foreground">Tax</span>
              <span className="font-semibold tabular-nums text-foreground">{money(currencySymbol, check?.tax ?? sitting.tax)}</span>
            </div>
            {sitting.service > 0 && (
              <div className="flex items-baseline justify-between py-0.5">
                <span className="text-muted-foreground">Service</span>
                <span className="font-semibold tabular-nums text-foreground">{money(currencySymbol, sitting.service)}</span>
              </div>
            )}
          </div>

          <div className="mt-1.5 flex items-center justify-between rounded-lg bg-secondary/50 px-2.5 py-1 border border-border/40 dark:bg-secondary/40">
            <span className="text-xs font-semibold text-foreground">Total Paid</span>
            <span className="text-sm font-extrabold tabular-nums text-foreground">
              {money(currencySymbol, check?.paid ?? sitting.total)}
            </span>
          </div>
        </div>

        {/* Footer Actions: View Bill + Session Details */}
        <div className="mt-auto pt-2.5 grid shrink-0 grid-cols-2 gap-2">
          <Button
            onClick={() => onBill(sitting, false)}
            className="h-10 gap-1.5 whitespace-nowrap rounded-xl bg-primary px-2 text-xs font-semibold text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90"
          >
            <ReceiptText className="size-3.5 shrink-0" />
            View Bill
          </Button>
          <Button
            variant="outline"
            onClick={() => onOpenOrders(sitting)}
            className="h-10 gap-1.5 whitespace-nowrap rounded-xl border border-border bg-card px-2 text-xs font-semibold text-foreground hover:bg-secondary"
          >
            <Info className="size-3.5 shrink-0 text-muted-foreground" />
            Session Details
          </Button>
        </div>
      </Card>
    )
  }

  const validOrders = sitting.orders.filter((order) => order.status !== 'CANCELLED')
  const toServe = validOrders.filter((order) => ['PENDING', 'PREPARING', 'READY'].includes(order.status))
  // Serving advances the whole ticket, so its unserved quantity follows the ticket state.
  const remainingQty = toServe.reduce(
    (count, order) => count + order.items.filter((item) => item.status !== 'CANCELLED')
      .reduce((quantity, item) => quantity + item.quantity, 0),
    0,
  )
  const servingLabel = onlyPendingActivation ? 'Awaiting Acceptance'
    : validOrders.length === 0 ? 'No Items to Serve'
    : validOrders.every((order) => order.status === 'PREPARING') ? 'All Items Preparing'
    : toServe.length > 0 ? (remainingQty > 0 ? `${remainingQty} to Serve` : 'Service Pending')
    : sitting.allServed ? 'All Served'
    : 'Awaiting Acceptance'
  const paymentReason = !hasPayPerm ? 'Payment permission is required'
    : !sitting.allServed ? 'Serve all orders before settling the bill'
    : !checkCanSettle ? 'Confirm serving status for the full table check'
    : paidOff ? 'This bill is paid'
    : awaiting ? 'No bill yet'
    : undefined
  const billTotal = check?.total ?? sitting.total
  const billPaid = check?.paid ?? (paidOff ? sitting.total : sitting.paid)
  const billDue = check != null
    ? Math.max(0, check.outstanding)
    : billTotal === null || billPaid === null
      ? null
      : Math.max(0, billTotal - billPaid)
  const cardName = sitting.tableName ?? `Order #${sitting.latest.orderNumber}`
  const sessionStats = [
    { icon: ClipboardCheck, label: `${validOrders.length} Order${validOrders.length === 1 ? '' : 's'}` },
    { icon: Layers, label: `${sitting.qtyCount} Item${sitting.qtyCount === 1 ? '' : 's'}` },
    { icon: ConciergeBell, label: ORDER_TYPE_LABEL[sitting.orderType] ?? sitting.orderType },
    { icon: Clock, label: shortDuration(sitting.startedAt, sitting.endedAt, now) },
  ]

  return (
    <Card
      data-order-card
      data-session-card={sitting.sessionId ?? undefined}
      className="group relative flex min-h-[550px] w-full min-w-0 flex-col rounded-2xl border border-border/80 bg-card p-3 sm:p-3.5 shadow-xs transition-all duration-200 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-center gap-2.5 px-0.5 py-0.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-foreground dark:bg-secondary/80 border border-border/40">
          {sitting.tableName ? <Table2 aria-hidden className="size-4.5" /> : <ShoppingBag aria-hidden className="size-4.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base sm:text-[17px] leading-snug font-bold tracking-tight text-foreground truncate">{cardName}</h3>
          <p className="text-[11px] leading-tight text-muted-foreground truncate">
            {sitting.tableName
              ? [sitting.area, sitting.seats ? `${sitting.seats} Seats` : null].filter(Boolean).join(' · ')
              : ORDER_TYPE_LABEL[sitting.orderType] ?? sitting.orderType}
          </p>
        </div>
        <span className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors',
          onlyPendingActivation ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
            : active ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
            : 'bg-secondary text-muted-foreground',
        )}>
          <span className="size-1.5 rounded-full bg-current" />
          {onlyPendingActivation ? 'Awaiting' : sitting.state}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More session actions" className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground">
              <MoreHorizontal aria-hidden className="size-4.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => onView(sitting.latest)}>
              <Eye className="mr-2 size-4" /> Open latest order
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onBill(sitting, false)} disabled={awaiting} aria-label={`View bill for ${cardName}`}>
              <FileText className="mr-2 size-4" /> Bill
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onBill(sitting, true)} disabled={awaiting}>
              <Printer className="mr-2 size-4" /> Print bill
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenOrders(sitting)}>
              <Layers className="mr-2 size-4" /> View orders &amp; bill
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canEndSession || !sitting.tableId || !active || ending}
              onClick={() => onEndSession(sitting)}
            >
              <XCircle className="mr-2 size-4" /> {ending ? 'Ending…' : 'End session'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-2.5 grid grid-cols-4 divide-x divide-border/50 rounded-xl bg-secondary/40 border border-border/50 py-1.5">
        {sessionStats.map(({ icon: Icon, label }) => (
          <div key={label} className="flex min-w-0 items-center justify-center gap-1 px-1 text-center text-[10px] sm:text-[11px] font-medium text-muted-foreground">
            <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="truncate">{label}</span>
          </div>
        ))}
      </div>

      <div
        data-sitting-orders
        role="region"
        aria-label={`Orders for ${cardName}`}
        tabIndex={0}
        className="mt-2.5 flex-1 space-y-1.5 px-0.5 py-0.5"
      >
        {sitting.orders.map((order) => (
          <OrderRow
            key={order.id}
            order={order}
            currencySymbol={currencySymbol}
            dishImages={dishImages}
            expanded={currentExpansion.openId === order.id}
            onToggle={() => setExpansion(toggleOrderExpansion(currentExpansion, order.id))}
            onOpen={() => onOpenOrder(order)}
          />
        ))}
      </div>

      <div className="mt-auto pt-2.5">
        <dl aria-label={sitting.sharedBill ? "Shared table check" : "Bill totals"} className="grid grid-cols-3 divide-x divide-border/50 rounded-xl border border-border/50 bg-secondary/35 py-2">
          <Figure label="Total" amount={billTotal} currencySymbol={currencySymbol} />
          <Figure label="Due" amount={billDue} currencySymbol={currencySymbol} tone={billDue ? 'due' : undefined} />
          <Figure label="Paid" amount={billPaid} currencySymbol={currencySymbol} tone="paid" />
        </dl>

        <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-2">
          <div
            data-serve-chip
            className={cn(
              'flex h-10 items-center justify-center gap-1.5 rounded-xl px-2.5 text-center text-xs font-semibold whitespace-nowrap transition-colors duration-200',
              sitting.allServed
                ? 'border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
            )}
          >
            <ConciergeBell
              aria-hidden
              className={cn(
                'size-3.5 shrink-0 transition-colors duration-200',
                sitting.allServed
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-amber-600 dark:text-amber-400',
              )}
            />
            <span className="truncate">{servingLabel}</span>
          </div>
          <Button
            disabled={active && !canPay}
            title={active && !canPay ? paymentReason : undefined}
            onClick={() => {
              if (!active) onOpenOrders(sitting)
              else if (canPay && sitting.checkId) onCompletePay(sitting)
              else if (canPay) onPay(sitting.latest)
            }}
            className={cn(
              'h-10 gap-1 rounded-xl px-2.5 text-center text-xs font-bold whitespace-nowrap transition-all duration-200',
              active && canPay
                ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90 cursor-pointer'
                : active
                  ? 'border border-border/70 bg-secondary/40 text-muted-foreground/60 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none'
                  : 'border border-border bg-card text-foreground hover:bg-secondary cursor-pointer',
            )}
          >
            <span className="truncate">{active ? 'Complete & Pay' : 'Session Details'}</span>
            <ChevronRight aria-hidden className="size-4 shrink-0" />
          </Button>
        </div>
      </div>
    </Card>
  )
}

function compactMoney(symbol: string, amount: number) {
  return Number.isInteger(amount) ? `${symbol}${amount.toLocaleString('en-IN')}` : money(symbol, amount)
}

function Figure({ icon: Icon, label, amount, currencySymbol, tone }: {
  icon?: typeof Layers
  label: string
  amount: number | null
  currencySymbol: string
  tone?: 'paid' | 'due'
}) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center px-1 text-center">
      {Icon && <Icon aria-hidden className="mb-0.5 size-3.5 shrink-0 text-muted-foreground" />}
      <dt className="text-[10px] leading-tight font-medium text-muted-foreground">{label}</dt>
      <dd className={cn('text-[13px] leading-tight font-bold tabular-nums [overflow-wrap:anywhere] min-[360px]:text-[14px]',
        tone === 'paid' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'due' && 'text-foreground font-extrabold',
      )}>{amount === null ? '—' : compactMoney(currencySymbol, amount)}</dd>
    </div>
  )
}

function DishThumb({ src }: { src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string>()
  return (
    <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-secondary text-muted-foreground border border-border/40 min-[360px]:size-9">
      <Utensils aria-hidden className="size-3.5" />
      {src && failedSrc !== src && (
        // Menu image URLs are already supplied by the existing menu data.
        <img src={src} alt="" loading="lazy" onError={() => setFailedSrc(src)} className="absolute inset-0 size-full object-cover" />
      )}
    </span>
  )
}

function OrderRow({ order, currencySymbol, dishImages, expanded, onToggle, onOpen }: {
  order: Order
  currencySymbol: string
  dishImages: Record<string, string>
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const id = useId()
  const state = ORDER_STATUS[order.status as keyof typeof ORDER_STATUS]
  const StatusIcon = order.status === 'PREPARING' ? ChefHat
    : ['PENDING', 'PENDING_ACTIVATION'].includes(order.status) ? Hourglass
    : order.status === 'CANCELLED' ? XCircle : CircleCheck
  const statusLabel = order.status === 'PENDING_ACTIVATION' ? 'Awaiting Acceptance' : state?.label ?? order.status
  const previewNames = order.items.map((item) => item.name).join(', ')

  return (
    <div
      data-order-row={order.id}
      className={cn(
        'overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none',
        expanded ? 'border-primary/25 dark:border-primary/20 shadow-xs' : 'border-border/60 hover:border-border/90',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={`Order #${order.orderNumber}, ${statusLabel}`}
        className={cn(
          'group block w-full px-2.5 text-left cursor-pointer transition-colors duration-200 ease-out motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          expanded
            ? 'rounded-t-[15px] bg-orange-500/[0.05] dark:bg-orange-500/[0.08] hover:bg-orange-500/[0.08] dark:hover:bg-orange-500/[0.12] border-b border-border/40'
            : 'rounded-[15px] bg-transparent hover:bg-secondary/40 dark:hover:bg-white/[0.03]',
        )}
      >
        <span className="flex min-h-9 items-center gap-1.5 py-1">
          <span
            aria-hidden
            className={cn(
              'w-[3px] shrink-0 rounded-full transition-all duration-200 ease-out motion-reduce:transition-none',
              expanded
                ? 'h-4.5 bg-primary shadow-[0_0_6px_rgba(249,115,22,0.35)]'
                : 'h-4 bg-primary/35 dark:bg-primary/30 group-hover:bg-primary/50',
            )}
          />
          <span className="shrink-0 text-sm leading-none font-extrabold tabular-nums min-[360px]:text-base">#{order.orderNumber}</span>
          <time dateTime={order.createdAt} title={orderWhen(order.createdAt)} className="flex shrink-0 items-center gap-1 border-l border-border pl-1.5 text-[10px] text-muted-foreground min-[360px]:text-[11px]">
            <Clock aria-hidden className="hidden size-3 min-[360px]:block" /> {timeOf(order.createdAt)}
          </time>
          <span className={cn(
            'ml-auto flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-tight font-bold min-[360px]:px-2 min-[360px]:text-[11px]',
            order.status === 'PREPARING' ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
              : ['PENDING', 'PENDING_ACTIVATION'].includes(order.status) ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              : ['READY', 'SERVED', 'COMPLETED'].includes(order.status) ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
              : 'bg-secondary text-muted-foreground',
          )}>
            <StatusIcon aria-hidden className="size-3 shrink-0" />
            <span>{statusLabel}</span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none',
              expanded ? 'rotate-180 text-foreground' : 'rotate-0',
            )}
          />
        </span>

        <span inert={expanded} aria-hidden={expanded} className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
          expanded ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}>
          <span className="min-h-0 overflow-hidden">
            {order.items.length > 0 && (
              <span className="flex min-w-0 items-center gap-1.5 pb-2 pl-2">
                {order.items.slice(0, 3).map((item) => <DishThumb key={item.id} src={dishImages[item.menuItemId]} />)}
                {order.items.length > 3 && (
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-secondary border border-border/40 text-xs font-bold text-muted-foreground">
                    +{order.items.length - 3}
                  </span>
                )}
                <span className="min-w-0 border-l border-border pl-1.5">
                  <span className="line-clamp-2 text-[11px] leading-tight font-medium min-[360px]:text-xs">{previewNames}</span>
                </span>
              </span>
            )}
          </span>
        </span>
      </button>

      <div
        id={id}
        inert={!expanded}
        aria-hidden={!expanded}
        className={cn('grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-2 pb-1">
            {order.items.length > 0 ? (
              <ul className="divide-y divide-border/65">
                {order.items.map((item) => (
                  <li key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(3rem,auto)] items-center gap-1.5 py-1.5 pl-1 text-xs min-[360px]:gap-2">
                    <DishThumb src={dishImages[item.menuItemId]} />
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <p className="leading-tight font-bold">{item.name}</p>
                      {(item.portion || item.notes) && (
                        <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{[item.portion, item.notes].filter(Boolean).join(' · ')}</p>
                      )}
                    </div>
                    <span className="font-semibold tabular-nums">×{item.quantity}</span>
                    <span className="text-right font-bold tabular-nums">{compactMoney(currencySymbol, item.price * item.quantity)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-1 py-2 text-xs text-muted-foreground">No items</p>
            )}
            {order.notes && <p className="px-1 py-1 text-xs text-muted-foreground">{order.notes}</p>}
            <button type="button" onClick={onOpen} className="flex min-h-8 w-full items-center justify-end gap-1 border-t border-border/65 px-1 text-[11px] font-semibold text-orange-800 hover:underline dark:text-orange-300">
              Order details <ChevronRight aria-hidden className="size-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function PaymentPill({
  status,
  method,
}: {
  status: string
  method: string | null
}) {
  const paid = status === 'PAID'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium',
        paid ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
      )}
    >
      {paid ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <Clock className="h-3 w-3" />
      )}
      {paid ? method || 'Paid' : 'Unpaid'}
    </span>
  )
}

function StatChip({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: any
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-xl border px-3 py-1.5',
        accent
          ? 'border-primary/30 bg-primary/10'
          : 'border-border bg-secondary/40'
      )}
    >
      <Icon className={cn('h-4 w-4', accent ? 'text-primary' : 'text-muted-foreground')} />
      <div className="leading-none">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('text-sm font-semibold', accent && 'text-primary')}>{value}</p>
      </div>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: any
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-3">
        <Icon className="h-7 w-7 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground mt-1 max-w-xs">{description}</p>
    </div>
  )
}

// `label` is a dictionary key, not prose, so the caller resolves it in the
// language the restaurant has chosen.
function actionForStatus(status: string): {
  label: string
  nextStatus?: string
  icon?: any
  variant?: 'default' | 'secondary'
} | null {
  switch (status) {
    // A held order has no forward transition. Accepting it is a decision, and
    // it happens through its own Accept/Reject pair — after which "Start
    // Preparing" appears, as a separate, deliberate press.
    case 'PENDING_ACTIVATION':
      return null
    case 'PENDING':
      return { label: 'orders.start', nextStatus: 'PREPARING', icon: ChefHat }
    case 'PREPARING':
      return { label: 'orders.ready', nextStatus: 'READY', icon: CheckCircle2 }
    case 'READY':
      return { label: 'orders.served', nextStatus: 'SERVED', icon: Utensils }
    case 'SERVED':
      return { label: 'orders.complete', nextStatus: 'COMPLETED', icon: CreditCard }
    case 'COMPLETED':
    case 'CANCELLED':
    default:
      return null
  }
}

/**
 * What a role is waiting for, when the next step is not theirs to take.
 *
 * A waiter with a Pending order is waiting on the kitchen; the kitchen with a
 * Served order is waiting on the floor. Naming the wait is more use than a
 * greyed-out button for an action the server would refuse anyway.
 */
function waitingOn(nextStatus?: string | null): string {
  switch (nextStatus) {
    case 'PREPARING':
      return 'Waiting on the kitchen'
    case 'READY':
      return 'In the kitchen'
    case 'SERVED':
      return 'Ready — waiting to be served'
    case 'COMPLETED':
      return 'Waiting on billing'
    default:
      return 'In progress'
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
