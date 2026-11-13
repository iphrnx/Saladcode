'use client'

import { createContext, useContext, useCallback, useState, useEffect, useRef, ReactNode } from 'react'
import { edgeFetch, onForbidden } from '@/lib/edge'
import { describeFailure, failIfNotOk, type ApiFailure } from '@/lib/api-error'
import { hasPermission } from '@/lib/permissions'

export interface Tenant {
  id: string
  name: string
  slug: string
  tagline: string | null
  logo: string | null
  currency: string
  currencySymbol: string
  address: string | null
  phone: string | null
  email: string | null
  taxRate: number
  serviceCharge: number
  plan: string
}

export interface User {
  id: string
  name: string
  email: string
  role: string
  avatar?: string | null
  roleId?: string | null
  twoFactorEnabled?: boolean
  /** The owner's own contact number. */
  phone?: string | null
}

export interface Role {
  id: string
  name: string
  description: string | null
  permissions: string
  isSystem: boolean
  color: string
}

export interface Staff {
  id: string
  name: string
  employeeId: string
  roleId: string | null
  active: boolean
  avatar?: string | null
  role?: Role | null
  lockedUntil?: string | null
  lastLogin?: string | null
  createdAt?: string
}

export interface Category {
  id: string
  name: string
  icon: string | null
  sortOrder: number
  _count?: { menuItems: number }
}

export interface MenuItem {
  id: string
  categoryId: string
  name: string
  description: string | null
  price: number
  /** Portion options with a stable id and price each; null/empty = single-price dish. */
  portions?: { id?: string; name: string; price: number }[] | null
  image: string | null
  available: boolean
  prepTime: number
  tags: string | null
  calories: number | null
  rating: number
  category?: Category
}

export interface OrderItem {
  id: string
  menuItemId: string
  name: string
  portionId?: string | null
  portion?: string | null
  price: number
  quantity: number
  notes: string | null
  status: string
}

export interface Order {
  id: string
  /** The table sitting this order belongs to — the grouping key for a bill. */
  tableSessionId?: string | null
  /** The consolidated bill this order is part of. */
  checkId?: string | null
  orderNumber: number
  tableId: string | null
  orderType: string
  status: string
  itemsTotal: number
  discount: number
  tax: number
  serviceCharge: number
  total: number
  promoCode: string | null
  customerName: string | null
  customerPhone: string | null
  notes: string | null
  paymentMethod: string | null
  paymentStatus: string
  createdAt: string
  updatedAt?: string
  completedAt: string | null
  servedById: string | null
  items: OrderItem[]
  table?: { id: string; name: string; seats: number; area: string } | null
  servedBy?: { id: string; name: string } | null
}

export interface Table {
  id: string
  name: string
  seats: number
  area: string
  qrToken: string
  active: boolean
  currentStatus?: string
  _count?: { orders: number }
}

export interface Reservation {
  id: string
  tableId: string | null
  name: string
  phone: string
  email: string | null
  partySize: number
  date: string
  time: string
  status: string
  occasion: string | null
  notes: string | null
  createdAt: string
  table?: { id: string; name: string } | null
}

export interface PromoCode {
  id: string
  code: string
  description: string | null
  type: string
  value: number
  minOrder: number
  maxDiscount: number
  usageLimit: number
  usedCount: number
  validFrom: string
  validTo: string | null
  active: boolean
}

export interface Session {
  id: string
  userId: string
  /** Not exposed by auth.sessions; kept optional for compatibility. */
  token?: string
  device: string | null
  browser: string | null
  os: string | null
  ip: string | null
  location: string | null
  /** "owner" = email/password session; "staff" = PIN login session. */
  kind?: 'owner' | 'staff'
  /** Staff role name (Waiter, Cashier, …); null/absent for owner sessions. */
  role?: string | null
  current: boolean
  /** auth.sessions.updated_at — last token use, NOT the sign-in time. */
  lastActive: string
  /** auth.sessions.created_at — when this session signed in. */
  createdAt: string
  user?: { id: string; name: string; email: string }
  /**
   * Sessions behind this row. The server groups one row per browser, because
   * a device that signed in five times is still one device; `ids` is what a
   * revoke acts on so it cannot leave the others behind.
   */
  count?: number
  ids?: string[]
  /** Oldest sign-in in the group (createdAt is the newest). */
  firstSeen?: string
}

/** Server-computed audit counts over explicit windows (see _shared/audit.ts). */
export interface SecurityStats {
  failedLogins24h: number
  auditEvents7d: number
}

export interface SecurityLog {
  id: string
  userId: string | null
  action: string
  ip: string | null
  userAgent: string | null
  meta: string | null
  createdAt: string
  user?: { id: string; name: string; email: string } | null
  /** Who did it, resolved server-side from the profile or staff record. */
  actor?: {
    kind: 'owner' | 'staff' | 'attempt' | 'unknown'
    name: string
    role: string | null
  } | null
}

/** What one table check owes, as the server computed it. */
export interface CheckSummary {
  orderCount: number
  /** Before tax: item prices less discount, as the server sums them. */
  subtotal?: number
  tax?: number
  /** After tax and service charge. */
  total: number
  paid: number
  outstanding: number
  status: string
  invoiceNumber: string | null
}

/**
 * One sitting at one table.
 *
 * Read-only facts the server owns: when it opened, whether it is ACTIVE or
 * ENDED, and when it closed. No totals — the money lives on the check
 * (`CheckSummary`), which is the one place that adds orders up.
 */
export interface TableSitting {
  id: string
  tableId: string
  /** `ACTIVE` or `ENDED`. */
  status: string
  startedAt: string
  endedAt: string | null
}

export interface SubscriptionState {
  planId: string
  planName: string
  status: string
  isPaid: boolean
  isTrial: boolean
  /** The trial is over and there is no paid subscription. */
  isRestricted: boolean
  trialStartedAt: string | null
  trialEndsAt: string | null
  trialDaysRemaining: number | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  limits: { locations: number | null; staff: number | null; menuItems: number | null }
  features: string[]
  priceMonthly: number
  /** The annual price, 0 when the plan is not sold yearly. */
  priceYearly?: number
  /** Which interval the paid plan is on. */
  billingInterval?: 'monthly' | 'annual'
  /** How the period was bought. `pay_once` never renews itself. */
  paymentMode?: 'autopay' | 'pay_once' | null
  currency: string
  /** The plan the subscription is on; different from planId during the trial. */
  subscriptionPlan?: string | null
  subscriptionStartedAt?: string | null
  /** Recurring plans renew by themselves; one-time plans end when paid out. */
  billingMode?: 'onetime' | 'recurring'
}

export interface AppData {
  tenant: Tenant
  /**
   * The Realtime topic this restaurant's staff listen on. Issued by the server
   * at bootstrap to a caller with `orders.view`/`tables.view`; it carries a
   * per-tenant secret, so it cannot be derived from the tenant id. Null when
   * the caller may not read orders or the floor.
   */
  realtimeTopic?: string | null
  /** The plan in force. Absent only if the server could not work it out. */
  subscription?: SubscriptionState
  settings: Record<string, string>
  currentUser: User
  currentStaff?: {
    id: string
    name: string
    employeeId: string
    role: string
    avatar?: string | null
  } | null
  staffPermissions?: string[]
  /** The caller's effective permissions: every key for an owner, the role's list for staff. */
  permissions?: string[]
  users: (User & { roleRef?: Role | null })[]
  roles: Role[]
  staff: Staff[]
  categories: Category[]
  menuItems: MenuItem[]
  tables: Table[]
  orders: Order[]
  reservations: Reservation[]
  promos: PromoCode[]
  sessions: Session[]
  securityLogs: SecurityLog[]
  /** Null when the caller lacks security.view (staff without the module). */
  securityStats: SecurityStats | null
  summary: {
    revenue: number
    ordersToday: number
    activeOrders: number
    totalTables: number
    totalMenuItems: number
    pendingReservations: number
  }
}

import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

/**
 * One audio context for the page, not one per order.
 *
 * A browser refuses to start audio until the page has been interacted with, and
 * a context created *outside* a gesture stays `suspended` — its oscillators run
 * to nothing, silently, with no error. The chime used to build a fresh context
 * on every order and never resume it, which is why a diner's order was
 * announced by the toast but made no sound: nobody had touched the POS tab, so
 * the context was born suspended and stayed that way. (It also leaked a context
 * per order, and browsers cap how many a page may hold, so the chime would have
 * gone quiet for good after enough orders.)
 *
 * So: one context, created or resumed on the first real interaction, and
 * resumed before playing if it is somehow suspended again.
 */
let chimeCtx: AudioContext | null = null

function orderChimeContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as any).webkitAudioContext
  if (!Ctor) return null
  if (!chimeCtx || chimeCtx.state === 'closed') chimeCtx = new Ctor()
  return chimeCtx
}

/**
 * Called on the first user gesture anywhere in the app.
 *
 * This is the moment audio is allowed to start: doing it here, inside the
 * handler, is what makes the context run when an order arrives later — including
 * one that arrives from a diner's phone while nobody is touching the till.
 */
export function primeOrderChime() {
  const ctx = orderChimeContext()
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
}

function ringChime(ctx: AudioContext) {
  const now = ctx.currentTime

  // 1st chime tone (G5)
  const osc1 = ctx.createOscillator()
  const gain1 = ctx.createGain()
  osc1.type = 'sine'
  osc1.frequency.setValueAtTime(784, now)
  gain1.gain.setValueAtTime(0, now)
  gain1.gain.linearRampToValueAtTime(0.2, now + 0.04)
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35)
  osc1.connect(gain1)
  gain1.connect(ctx.destination)
  osc1.start(now)
  osc1.stop(now + 0.35)

  // 2nd chime tone (C6)
  const osc2 = ctx.createOscillator()
  const gain2 = ctx.createGain()
  osc2.type = 'sine'
  osc2.frequency.setValueAtTime(1046.5, now + 0.12)
  gain2.gain.setValueAtTime(0, now + 0.12)
  gain2.gain.linearRampToValueAtTime(0.25, now + 0.16)
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.6)
  osc2.connect(gain2)
  gain2.connect(ctx.destination)
  osc2.start(now + 0.12)
  osc2.stop(now + 0.6)
}

export function playOrderChime() {
  try {
    const ctx = orderChimeContext()
    if (!ctx) return

    if (ctx.state === 'suspended') {
      // Play the moment the browser lets us, rather than into a context that is
      // not running — which sounds like nothing at all.
      ctx
        .resume()
        .then(() => ringChime(ctx))
        .catch(() => {
          /* still not allowed: the page has had no interaction at all */
        })
      return
    }

    ringChime(ctx)
  } catch {
    // Audio autoplay restrictions before interaction — silently ignored
  }
}

interface AppContextValue {
  data: AppData | null
  loading: boolean
  /**
   * `'NO_TENANT'` when the account has no restaurant yet, so the shell can send
   * it to the wizard; a classified failure otherwise, so the shell can say what
   * actually went wrong instead of "Failed to load" for a 401, a 403 and a 500
   * alike.
   */
  error: ApiFailure | 'NO_TENANT' | null
  tenantId: string | null
  setTenantId: (id: string) => void
  refresh: () => Promise<void>
  addOrUpdateOrder: (order: Order, notify?: boolean, opts?: { force?: boolean }) => void
  removeOrder: (orderId: string) => void
  /**
   * Replace the security slice — sessions, audit rows, counts.
   *
   * The Security page refreshes itself while it is open, and re-fetching the
   * whole bootstrap every few seconds to move one counter would pull the
   * entire menu and order book each time. `security` returns exactly these
   * four fields, so the page hands them straight back.
   */
  applySecurity: (patch: {
    sessions?: Session[]
    securityLogs?: SecurityLog[]
    securityStats?: SecurityStats | null
    users?: AppData['users']
  }) => void
  /**
   * Bumped whenever a table session ends. The POS board shows open sessions and
   * is not fed by the orders table, so it has no other way to notice a diner
   * closing their menu without the page being reloaded.
   */
  sessionRevision: number
  /** Authoritative per-table-check totals, keyed by check id. */
  checks: Record<string, CheckSummary>
  /**
   * The sittings, keyed by session id.
   *
   * Facts about the sitting itself — when the table sat down, whether it is
   * still open, when it closed. The order rows carry `tableSessionId` and
   * nothing else, so without this a screen grouping by sitting could not say
   * how long a table had been there, or whether it is still live.
   */
  tableSessions: Record<string, TableSitting>
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppDataProvider({ children }: { children: ReactNode }) {
  // Unlock audio on the first interaction of any kind, once per load. Until
  // this happens a browser will not start an audio context at all, so the chime
  // for an order that arrives from a diner's phone would otherwise be silent.
  useEffect(() => {
    const prime = () => primeOrderChime()
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    for (const e of events) window.addEventListener(e, prime, { once: true, passive: true })
    return () => {
      for (const e of events) window.removeEventListener(e, prime)
    }
  }, [])

  const [data, setData] = useState<AppData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiFailure | 'NO_TENANT' | null>(null)
  const [tenantId, setTenantIdState] = useState<string | null>(null)
  const [sessionRevision, setSessionRevision] = useState(0)
  /** Per-check totals from the server, keyed by check id. */
  const [checks, setChecks] = useState<Record<string, CheckSummary>>({})
  /** The sittings themselves, keyed by session id — start, status, end. */
  const [tableSessions, setTableSessions] = useState<Record<string, TableSitting>>({})
  // Seeded from the loaded data so an order fetched on first load is not
  // announced as new afterwards.
  useEffect(() => {
    if (!data?.orders) return
    for (const o of data.orders) knownOrderIds.current.add(o.id)
  }, [data])
  const recentNotifiedIds = useRef<Set<string>>(new Set())
  /**
   * Ids we have already been told about.
   *
   * Brand-newness cannot be decided inside the setData updater — React may run
   * that later, or twice — so it is tracked here, before the state call. Without
   * it the toast fired for any order the caller flagged, including an order the
   * user had just touched: tapping "Start Preparing" changed the status, the next
   * delta sync returned the same order, and the board announced it as new.
   */
  const knownOrderIds = useRef<Set<string>>(new Set())
  // The delta sync asks for orders changed since this timestamp. It starts a
  // minute in the past rather than at "now", because the bootstrap payload the
  // page rendered from was fetched *before* this component mounted: an order
  // that lands between those two moments is in neither, and the till never
  // heard about it — no chime, no toast, nothing on the board until a reload.
  // The overlap is harmless: orders the client already knows are skipped before
  // anything is announced.
  const lastSyncTimeRef = useRef<string>(new Date(Date.now() - 60_000).toISOString())

  const refresh = useCallback(async () => {
    try {
      setError(null)
      setLoading(true)
      const headers: Record<string, string> = {}
      if (tenantId) headers['x-tenant-id'] = tenantId
      const res = await edgeFetch('/api/bootstrap', { headers })
      if (res.status === 404) {
        setError('NO_TENANT')
        setLoading(false)
        return
      }
      // Classified rather than collapsed: an expired session (401) needs a
      // sign-in, a refused one (403) needs the permission named, and a 500
      // needs a retry. All three used to read "Failed to load".
      await failIfNotOk(res, 'your restaurant')
      const json = await res.json()
      setData(json)
      if (json.tableSessions) setTableSessions(json.tableSessions)
      lastSyncTimeRef.current = new Date().toISOString()
    } catch (e) {
      setError(describeFailure(e, 'your restaurant'))
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * Re-read the caller's effective permissions, and nothing else.
   *
   * Deliberately not `refresh()`: that replaces the whole payload, which would
   * clobber state this page has already advanced on its own — an order queued
   * offline, an optimistic status tap. Only `permissions` can change under a
   * live session, so only `permissions` is replaced.
   */
  const refreshPermissions = useCallback(async () => {
    try {
      const headers: Record<string, string> = {}
      if (tenantId) headers['x-tenant-id'] = tenantId
      const res = await edgeFetch('/api/bootstrap', { headers })
      if (!res.ok) return
      const json = await res.json()
      if (!Array.isArray(json?.permissions)) return
      setData((prev) => (prev ? { ...prev, permissions: json.permissions } : prev))
    } catch {
      /* the next 403 will ask again */
    }
  }, [tenantId])

  /**
   * A role changed while this session was open.
   *
   * The server re-derives permissions on every request, so a permission taken
   * away takes effect there at once — while the sidebar and the view gate still
   * hold the list this page loaded with, and keep offering a module whose every
   * request now answers 403. Coalesced and rate-limited, because a refused
   * screen fires several requests at once and each of them will 403.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastRun = 0
    const unsubscribe = onForbidden(() => {
      if (timer) return
      const wait = Math.max(0, 10_000 - (Date.now() - lastRun))
      timer = setTimeout(() => {
        timer = null
        lastRun = Date.now()
        void refreshPermissions()
      }, wait)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [refreshPermissions])

  const addOrUpdateOrder = useCallback((order: Order, shouldNotify: boolean = false, opts?: { force?: boolean }) => {
    if (!order || !order.id) return

    // Decided before the state call, so it reflects what we knew a moment ago.
    const isBrandNew = !knownOrderIds.current.has(order.id)
    if (isBrandNew) knownOrderIds.current.add(order.id)

    setData((prev) => {
      if (!prev) return prev
      const existingIdx = prev.orders.findIndex((o) => o.id === order.id)
      const existing = existingIdx >= 0 ? prev.orders[existingIdx] : null

      // Freshness guard. The realtime poll that carries an order may have read
      // it *before* a write this screen already knows about (the PATCH the
      // cashier just made, or an optimistic tap). Without this check the stale
      // read lands after the fresh one and the card visibly walks backwards —
      // a completed order growing its "Mark Ready" button again. Same-version
      // replays are skipped too; `force` is reserved for an explicit rollback,
      // which must always be allowed to restore its snapshot.
      if (
        existing && !opts?.force &&
        existing.updatedAt && order.updatedAt &&
        new Date(order.updatedAt).getTime() <= new Date(existing.updatedAt).getTime()
      ) {
        return prev
      }

      let nextOrders = [...prev.orders]

      if (existingIdx >= 0) {
        // Merge updated order
        nextOrders[existingIdx] = { ...nextOrders[existingIdx], ...order }
      } else {
        // Prepend brand new order
        nextOrders = [order, ...prev.orders]
      }

      // Update table status if dine-in
      let nextTables = prev.tables
      if (order.tableId) {
        nextTables = prev.tables.map((t) =>
          t.id === order.tableId
            ? { ...t, currentStatus: order.status === 'COMPLETED' ? 'AVAILABLE' : 'OCCUPIED' }
            : t
        )
      }

      return {
        ...prev,
        orders: nextOrders,
        tables: nextTables,
        // The summary is deliberately NOT recomputed here. This list is a
        // 200-order window, so revenue and counts derived from it drift on a
        // busy day; the delta sync carries the server's aggregate and owns
        // these numbers.
      }
    })

    // Only a genuinely new order is announced. A status change is not news, and
    // the delta sync flags every order it carries.
    if (isBrandNew && shouldNotify && !recentNotifiedIds.current.has(order.id)) {
      recentNotifiedIds.current.add(order.id)
      setTimeout(() => recentNotifiedIds.current.delete(order.id), 60000)

      playOrderChime()
      const tableName = order.table?.name || 'Table'
      const cs = order.total ? '₹' : ''
      toast.success(`🔔 New Order #${order.orderNumber} (${tableName})`, {
        description: `${order.items?.length || 1} items · Total: ${cs}${order.total?.toFixed(2) || '0.00'}`,
        duration: 5000,
      })
    }
  }, [])

  const removeOrder = useCallback((orderId: string) => {
    if (!orderId) return
    knownOrderIds.current.delete(orderId)
    recentNotifiedIds.current.delete(orderId)
    setData((prev) =>
      prev ? { ...prev, orders: prev.orders.filter((o) => o.id !== orderId) } : prev,
    )
  }, [])

  const applySecurity = useCallback<AppContextValue['applySecurity']>((patch) => {
    setData((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        sessions: patch.sessions ?? prev.sessions,
        securityLogs: patch.securityLogs ?? prev.securityLogs,
        securityStats: patch.securityStats !== undefined ? patch.securityStats : prev.securityStats,
        users: patch.users ?? prev.users,
      }
    })
  }, [])

  /**
   * What the realtime layer is allowed to ask for.
   *
   * The delta poll hits `/api/orders/sync`, which needs `orders.view`. A role
   * that may open the POS but not read orders would otherwise poll an endpoint
   * that answers 403 every four seconds, for as long as the tab is open, with
   * the failure swallowed — so that one request is skipped rather than the
   * whole layer.
   *
   * The layer itself is not only orders: `SESSION_ENDED` is broadcast on this
   * topic and is what clears a table whose diner has closed the menu. That is
   * `tables.view`'s business, so a role holding it keeps the subscription even
   * without `orders.view`. Booleans rather than the array, so a refresh that
   * rebuilds `permissions` does not tear the socket down and put it back up.
   */
  const canReadOrders = hasPermission(data?.permissions, 'orders.view')
  const canReadTables = hasPermission(data?.permissions, 'tables.view')
  const canUseRealtime = canReadOrders || canReadTables

  // Real-time synchronization, in three layers:
  //   1. Supabase Realtime (Postgres Changes) — instant, cross-device
  //   2. BroadcastChannel — instant, cross-tab in the same browser
  //   3. Periodic delta sync — safety net if the socket drops
  useEffect(() => {
    const activeTenantId = tenantId || data?.tenant?.id
    if (!activeTenantId || !canUseRealtime) return

    let bc: BroadcastChannel | null = null
    let pollTimer: NodeJS.Timeout | null = null
    let realtimeDebounce: NodeJS.Timeout | null = null
    let isCancelled = false

    // 1. Cross-Tab Broadcast Channel (instantaneous local sync)
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        bc = new BroadcastChannel('the_salad_orders_sync')
        bc.onmessage = (event) => {
          if (!event.data || isCancelled) return
          if (event.data.tenantId && event.data.tenantId !== activeTenantId) return
          if (event.data.type === 'ORDER_CREATED' || event.data.type === 'ORDER_UPDATED') {
            addOrUpdateOrder(event.data.order, event.data.type === 'ORDER_CREATED')
          } else if (event.data.type === 'ORDER_DELETED' && event.data.order?.id) {
            removeOrder(event.data.order.id)
          }
        }
      }
    } catch {
      // ignore
    }

    // 3. Fallback Periodic Delta Sync (every 4 seconds) to guarantee no missed orders
    const runDeltaSync = async () => {
      if (isCancelled || !canReadOrders) return
      try {
        const since = lastSyncTimeRef.current
        const res = await edgeFetch(`/api/orders/sync?tenantId=${encodeURIComponent(activeTenantId)}&since=${encodeURIComponent(since)}`)
        if (res.ok) {
          const json = await res.json()
          if (json.orders && Array.isArray(json.orders)) {
            for (const ord of json.orders) {
              addOrUpdateOrder(ord, true)
            }
          }
          // The authoritative figures per table check, so a session header and
          // its bill can never disagree.
          if (json.checks) setChecks(json.checks)
          // The sittings: start, status and end. Merged, not replaced — the
          // poll returns the sittings that are open or recent, and a card for
          // an older closed one keeps the row it already had.
          if (json.tableSessions) {
            setTableSessions((prev) => ({ ...prev, ...json.tableSessions }))
          }
          // The server's aggregate owns the counters — see addOrUpdateOrder.
          if (json.summary) {
            setData((prev) =>
              prev ? { ...prev, summary: { ...prev.summary, ...json.summary } } : prev,
            )
          }
          if (json.serverTime) {
            lastSyncTimeRef.current = json.serverTime
          }
        }
      } catch {
        // ignore network hiccups
      }
    }

    // 2. Supabase Realtime
    const supabase = createClient()
    // The server-issued topic, or the legacy tenant topic for a bundle talking
    // to an older function. A capability topic is a private channel: Realtime
    // checks it against `realtime.messages` RLS, where a signed-in user may
    // only read their own tenant's.
    const topic = data?.realtimeTopic || `orders:${activeTenantId}`
    // Public channel, capability topic — see migration 0075: this project
    // cannot authorise private channels, and a private channel with no policy
    // is silent.
    const channel = supabase.channel(topic)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `tenant_id=eq.${activeTenantId}`,
        },
        (payload: any) => {
          if (isCancelled) return
          // A deleted row is never returned by the delta sync (it no longer
          // exists), so without this branch a voided order lingered on every
          // other screen until somebody reloaded.
          if (payload?.eventType === 'DELETE' && payload?.old?.id) {
            removeOrder(payload.old.id)
            return
          }
          if (realtimeDebounce) clearTimeout(realtimeDebounce)
          realtimeDebounce = setTimeout(runDeltaSync, 150)
        }
      )
      // Instant realtime broadcast events from Edge Functions (ORDER_UPDATED, ORDER_CREATED, ORDER_DELETED)
      .on('broadcast', { event: 'ORDER_UPDATED' }, (msg: any) => {
        if (isCancelled) return
        const ord = msg?.payload?.order
        if (ord?.id) {
          addOrUpdateOrder(ord, false, { force: true })
        } else {
          void runDeltaSync()
        }
      })
      .on('broadcast', { event: 'ORDER_CREATED' }, (msg: any) => {
        if (isCancelled) return
        const ord = msg?.payload?.order
        if (ord?.id) {
          addOrUpdateOrder(ord, true)
        } else {
          void runDeltaSync()
        }
      })
      .on('broadcast', { event: 'ORDER_DELETED' }, (msg: any) => {
        if (isCancelled) return
        const ordId = msg?.payload?.order?.id
        if (ordId) {
          removeOrder(ordId)
        }
      })
      // A session ending is not an orders-table write, so postgres_changes above
      // never fires for it. The staff function broadcasts it on this same topic
      // instead; without listening, the POS board kept showing a table whose
      // diner had already closed the menu until the page was reloaded.
      .on('broadcast', { event: 'SESSION_ENDED' }, () => {
        if (isCancelled) return
        setSessionRevision((n) => n + 1)
      })
      // A table asking to be accepted, and a table that just was. Both change
      // the floor board, and neither is an orders-table write — so the
      // postgres listener above never fires for them.
      .on('broadcast', { event: 'ACTIVATION_REQUESTED' }, (msg: any) => {
        if (isCancelled) return
        setSessionRevision((n) => n + 1)
        // Optional by design: a browser that has never been interacted with
        // cannot play audio, and this is a nudge, not a requirement.
        if (typeof window !== 'undefined') {
          try {
            if (window.localStorage.getItem('the-salad-activation-sound') !== 'off') playOrderChime()
          } catch {
            playOrderChime()
          }
        }
        void msg
      })
      .on('broadcast', { event: 'TABLE_ACTIVATED' }, () => {
        if (isCancelled) return
        setSessionRevision((n) => n + 1)
      })
      .subscribe((status: string) => {
        // Reconnect reconciliation. Everything broadcast while the socket was
        // down is gone, so coming back means re-reading the floor and the
        // order list rather than waiting for the next poll — the poll is a
        // safety net, not the plan.
        if (isCancelled) return
        if (status === 'SUBSCRIBED') {
          setSessionRevision((n) => n + 1)
          void runDeltaSync()
        }
      })

    pollTimer = setInterval(runDeltaSync, 4000)

    return () => {
      isCancelled = true
      if (bc) bc.close()
      if (realtimeDebounce) clearTimeout(realtimeDebounce)
      void supabase.removeChannel(channel)
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [tenantId, data?.tenant?.id, canUseRealtime, canReadOrders, addOrUpdateOrder, removeOrder])

  const setTenantId = useCallback((id: string) => {
    setTenantIdState(id)
  }, [])

  return (
    <AppContext.Provider value={{ data, loading, error, tenantId, setTenantId, refresh, addOrUpdateOrder, removeOrder, applySecurity, sessionRevision, checks, tableSessions }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppDataProvider')
  return ctx
}
