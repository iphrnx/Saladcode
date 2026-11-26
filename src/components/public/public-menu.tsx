'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  ShoppingBag,
  Plus,
  Minus,
  X,
  Check,
  Clock,
  Star,
  Utensils,
  Search,
  Phone,
  MapPin,
  Loader2,
  ChevronUp,
  Sparkles,
  Flame,
  Leaf,
  Trash2,
  Heart,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { edgeFetch, edgeUrl } from '@/lib/edge'
import { orderQueue, startOrderQueue, cleanOrderErrorMessage, type QueueEntry } from '@/lib/order-queue'
import { keyName, readStored, removeStored, writeStored } from '@/lib/storage-keys'
import { DinerOrderTracker } from '@/components/public/diner-order-tracker'
import {
  canonicalPortionName,
  normalizePortionKey,
  normalizePortions,
  type MenuPortion,
} from '@/lib/portions'
import {
  applyMenuTheme,
  cacheMenuTheme,
  cachedMenuTheme,
  normaliseMenuTheme,
  type MenuTheme,
} from '@/lib/menu-theme'
import { initTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { BillDialog } from '@/components/shared/bill-dialog'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'

// ---------- Types ----------
type Tenant = {
  id: string
  name: string
  tagline?: string | null
  logo?: string | null
  currencySymbol: string
  address?: string | null
  phone?: string | null
  taxRate?: number | null
  serviceCharge?: number | null
}

type TableObj = {
  id: string
  name: string
  seats: number
  area: string
} | null

type Category = {
  id: string
  name: string
  icon?: string | null
}

type MenuItem = {
  id: string
  categoryId: string
  name: string
  description?: string | null
  price: number
  portions?: { id?: string; name: string; price: number }[] | null
  image?: string | null
  prepTime: number
  tags?: string | null
  calories?: number | null
  rating: number
  available?: boolean | null
  category?: { id: string; name: string; icon?: string | null } | null
}

export type CartItem = {
  menuItemId: string
  name: string
  portionId?: string | null
  portion?: string | null
  price: number
  image?: string | null
  quantity: number
  notes?: string
  prepTime?: number
}

export const sameCartLine = (
  c: CartItem,
  menuItemId: string,
  portion?: string | null,
  portionId?: string | null,
) =>
  c.menuItemId === menuItemId &&
  normalizePortionKey(c.portion, c.portionId) === normalizePortionKey(portion, portionId)

type PlacedOrder = {
  orderNumber: number
  total: number
  table?: { name: string } | null
  /** The lines as the server priced them, so the diner sees what was ordered. */
  items?: Array<{
    id?: string
    name: string
    quantity: number
    price: number
    portion?: string | null
  }>
}

// ---------- Constants ----------
const CORAL = '#f97316'
/** The confirmation tick: green means done, which coral does not. */
const CONFIRMED_GREEN = '#10b981'
const CORAL_DARK = '#c43d1a'
const INK = '#1a1d29'
const PAPER = '#fafaf7'
const MUTED = '#71778a'

/**
 * The footer's social buttons.
 *
 * Flat dark circles read as generic marks sitting next to a real logo, so each
 * one wears its own brand colour — Instagram keeps its gradient — with a soft
 * shadow and a lift on hover. 44px square, which is the comfortable minimum for
 * a thumb on a phone, since this is a menu people open on a phone at a table.
 */
const SOCIAL_BTN =
  'grid size-11 place-items-center rounded-full text-white ring-1 ring-black/5 ' +
  'shadow-[0_2px_8px_rgba(0,0,0,0.16)] transition-all duration-200 ' +
  'hover:-translate-y-0.5 hover:shadow-[0_6px_16px_rgba(0,0,0,0.22)] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2'

const INSTAGRAM_BG = 'bg-[linear-gradient(45deg,#f09433_0%,#e6683c_25%,#dc2743_50%,#cc2366_75%,#bc1888_100%)]'
const FACEBOOK_BG = 'bg-[#1877F2]'
const YOUTUBE_BG = 'bg-[#FF0000]'

// ---------- Helpers ----------
export function formatPrice(amount: number, symbol: string) {
  return `${symbol}${amount.toFixed(2)}`
}

function parseTags(tags?: string | null): string[] {
  if (!tags) return []
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function tagMeta(tag: string): { label: string; icon?: React.ReactNode; cls: string } {
  const t = tag.toLowerCase()
  const base =
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none'
  switch (t) {
    case 'spicy':
      return { label: 'Spicy', icon: <Flame className="size-2.5" />, cls: `${base} bg-red-500/15 text-red-600 dark:text-red-400` }
    case 'veg':
      return { label: 'Veg', icon: <Leaf className="size-2.5" />, cls: `${base} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400` }
    case 'vegan':
      return { label: 'Vegan', icon: <Leaf className="size-2.5" />, cls: `${base} bg-green-500/15 text-green-600 dark:text-green-400` }
    case 'new':
      return { label: 'New', icon: <Sparkles className="size-2.5" />, cls: `${base} bg-amber-500/15 text-amber-600 dark:text-amber-400` }
    case 'bestseller':
      return { label: 'Bestseller', icon: <Star className="size-2.5 fill-current" />, cls: `${base} bg-orange-500/15 text-orange-600 dark:text-orange-400` }
    case 'non-veg':
      return { label: 'Non-Veg', cls: `${base} bg-rose-500/15 text-rose-600 dark:text-rose-400` }
    case 'jain':
      return { label: 'Jain', icon: <Sparkles className="size-2.5" />, cls: `${base} bg-amber-500/15 text-amber-600 dark:text-amber-400` }
    case 'gluten-free':
      return { label: 'GF', cls: `${base} bg-purple-500/15 text-purple-600 dark:text-purple-400` }
    default:
      return { label: tag.toUpperCase(), cls: `${base} bg-secondary text-secondary-foreground` }
  }
}

// ---------- Main Component ----------
// ----- Diner session durability -----
//
// The guarantee this enforces: once a table session ends, reloading the page,
// refreshing the tab, or walking browser history must NOT bring the menu back.
// Only scanning the physical QR code opens it again.
//
// How: `?table=<qrToken>` is treated as a one-time scan event. It is consumed
// and stripped from the address bar immediately, so nothing that re-runs a URL
// can re-activate a session. From then on the session token in sessionStorage
// is the only key, and it is re-validated by the server on every load.



type CachedDinerSession = { token: string; tenantId: string; tableId: string }
type StoredDinerSession = { sessionId: string; sessionToken: string; updatedAt?: number }

function getDinerStorageKey(restaurantId: string, tableId: string): string {
  return `restro_session:${restaurantId}:${tableId}`
}

function getStoredDinerSession(restaurantId: string, tableId: string): StoredDinerSession | null {
  try {
    const raw = localStorage.getItem(getDinerStorageKey(restaurantId, tableId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.sessionToken === 'string' && typeof parsed.sessionId === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

function setStoredDinerSession(restaurantId: string, tableId: string, session: StoredDinerSession) {
  try {
    localStorage.setItem(
      getDinerStorageKey(restaurantId, tableId),
      JSON.stringify({ ...session, updatedAt: session.updatedAt ?? Date.now() }),
    )
  } catch {
    /* ignore */
  }
}

function removeStoredDinerSession(restaurantId: string, tableId: string) {
  try {
    localStorage.removeItem(getDinerStorageKey(restaurantId, tableId))
  } catch {
    /* ignore */
  }
}

function getStoredQrMap(qrToken: string): { restaurantId: string; tableId: string } | null {
  try {
    const raw = localStorage.getItem(`restro_qr:${qrToken}`)
    if (!raw) return null
    const [restaurantId, tableId] = raw.split(':')
    if (restaurantId && tableId) return { restaurantId, tableId }
    return null
  } catch {
    return null
  }
}

function setStoredQrMap(qrToken: string, restaurantId: string, tableId: string) {
  try {
    localStorage.setItem(`restro_qr:${qrToken}`, `${restaurantId}:${tableId}`)
  } catch {
    /* ignore */
  }
}

function findAnyStoredDinerSession(): { restaurantId: string; tableId: string; sessionId: string; sessionToken: string } | null {
  try {
    let best: { restaurantId: string; tableId: string; sessionId: string; sessionToken: string; updatedAt: number } | null = null
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('restro_session:')) {
        const parts = key.split(':')
        if (parts.length >= 3) {
          const restaurantId = parts[1]
          const tableId = parts.slice(2).join(':')
          const raw = localStorage.getItem(key)
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed?.sessionId && parsed?.sessionToken) {
              const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
              if (!best || updatedAt >= best.updatedAt) {
                best = { restaurantId, tableId, sessionId: parsed.sessionId, sessionToken: parsed.sessionToken, updatedAt }
              }
            }
          }
        }
      }
    }
    if (best) {
      return {
        restaurantId: best.restaurantId,
        tableId: best.tableId,
        sessionId: best.sessionId,
        sessionToken: best.sessionToken,
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

let pendingScanToken: string | null = null

function lockDinerSession(setState: (v: 'ended') => void) {
  pendingScanToken = null
  setState('ended')
}

export function PublicMenu() {
  const searchParams = useSearchParams()
  const [tenant, setTenant] = useState<Tenant | null>(null)
  // The menu's theme is the restaurant's, not the diner's. It is null until
  // the server has said, and until then the theme this diner was last shown
  // stands in for it.
  const [serverTheme, setServerTheme] = useState<MenuTheme | null>(null)
  const [cachedTheme, setCachedTheme] = useState<MenuTheme | null>(null)
  const menuTheme = serverTheme ?? cachedTheme ?? 'light'
  const [table, setTable] = useState<TableObj>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [social, setSocial] = useState<{ instagram?: string; facebook?: string; youtube?: string }>({})

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // session state: 'activating' | 'active' | 'ended' | 'invalid'
  const [sessionState, setSessionState] = useState<'activating' | 'active' | 'ended' | 'invalid'>('activating')
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  /** The server's id for this diner's session — used to double-check payloads. */
  const [sessionId, setSessionId] = useState<string | null>(null)
  /**
   * Whether the restaurant has accepted this table yet.
   *
   * A scan opens the menu either way — browsing and filling a cart never need
   * a staff member. What PENDING changes is the first order: it is stored and
   * priced, but held out of the kitchen until someone accepts the table.
   */
  const [activation, setActivation] = useState<'ACTIVE' | 'PENDING' | 'REJECTED' | 'EXPIRED'>('ACTIVE')
  /** True once this diner has an order waiting on that acceptance. */
  const [awaitingActivation, setAwaitingActivation] = useState(false)
  /** Bumped when a realtime order event arrives, so the tracker re-reads. */
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0)
  // Does this session have anything on it? A table can be abandoned and its
  // session ended from the POS without a single order ever being placed, and
  // there is no bill to show for that. The server answers this on the same
  // call that discovers the session is over; null means "not known yet".
  const [sessionHasOrder, setSessionHasOrder] = useState<boolean | null>(null)
  const [sessionTenantId, setSessionTenantId] = useState<string | null>(null)
  const [sessionTableId, setSessionTableId] = useState<string | null>(null)
  // The review block on the ended screen. The server says whether the
  // restaurant collects reviews and what its live average is, so the badge
  // shows a real number or no number — never an invented one.
  const [reviewsEnabled, setReviewsEnabled] = useState(true)
  const [avgRating, setAvgRating] = useState<number | null>(null)
  const [reviewCount, setReviewCount] = useState(0)

  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState<string>('all')

  const [cart, setCart] = useState<CartItem[]>([])
  // Latest cart, for the live-menu handler below, so that effect does not need
  // to re-subscribe on every change of the cart.
  const cartIdsRef = useRef<string[]>([])
  const cartRef = useRef<CartItem[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([])
  // Mirrors "a checkout is in flight" synchronously — see placeOrder.
  const placingRef = useRef(false)
  const [offline, setOffline] = useState(false)
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null)
  const [placedOrderId, setPlacedOrderId] = useState<string | null>(null)
  const [billOrderId, setBillOrderId] = useState<string | null>(null)
  const [billOpen, setBillOpen] = useState(false)

  // Bumping this re-runs the session check. Used when the browser restores the
  // page from the back/forward cache: that restores the rendered menu DOM
  // without re-running effects, so an ended session could otherwise reappear.
  const [revalidateNonce, setRevalidateNonce] = useState(0)
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setRevalidateNonce((n) => n + 1)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  // Kept in a ref so the live-menu handler below reads the current cart without
  // re-subscribing every time a line is added — updated in an effect, because a
  // ref written during render is exactly the re-render trap it exists to avoid.
  useEffect(() => {
    cartRef.current = cart
    cartIdsRef.current = cart.map((line) => line.menuItemId)
  }, [cart])

  /**
   * Live menu changes.
   *
   * A dish hidden at the till used to stay on a diner's screen until they
   * reloaded: the menu is fetched once when the session starts and nothing ever
   * told it to look again. This listens on the restaurant's menu channel — a
   * diner's phone holds no Supabase session, so it cannot be sent rows from a
   * table behind RLS, but it can subscribe to a broadcast — and asks the server
   * for the menu again when it hears one.
   *
   * It re-reads rather than trusting what the event says: that way one handler
   * covers a hidden dish, a price change and a rename, and a stale or repeated
   * event cannot put wrong data on the screen. It also refreshes when the socket
   * comes back, which covers anything missed while the phone was asleep, and
   * when the page is shown again.
   */
  useEffect(() => {
    if (!sessionTenantId || !sessionToken || !sessionTableId) return
    const supabase = createClient()
    let inFlight = false

    const refreshMenu = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await edgeFetch(
          `/api/table-session/validate?tenantId=${encodeURIComponent(sessionTenantId)}` +
            `&tableId=${encodeURIComponent(sessionTableId)}`,
          { headers: { 'x-session-token': sessionToken } },
        )
        if (!res.ok) return
        const data = await res.json().catch(() => null)
        if (!data) return
        setCategories(data.categories || [])
        setMenuItems(data.menuItems || [])

        // A dish already in the cart that has just been hidden. The cart is left
        // exactly as it is — the server refuses that line when the order is
        // placed — but the diner is told rather than finding out at checkout.
        const stillOn = new Set((data.menuItems || []).map((m: any) => m.id))
        const gone = cartIdsRef.current.filter((id) => !stillOn.has(id))
        if (gone.length > 0) {
          toast.warning('An item in your order is no longer available')
        }
      } catch {
        /* a failed refresh leaves the menu as it was */
      } finally {
        inFlight = false
      }
    }

    const channel = supabase
      .channel(`menu:${sessionTenantId}`)
      .on('broadcast', { event: 'MENU_UPDATED' }, () => {
        void refreshMenu()
      })
      .subscribe((status) => {
        // Fires on first connect and after every reconnect.
        if (status === 'SUBSCRIBED') void refreshMenu()
      })

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshMenu()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [sessionTenantId, sessionToken, sessionTableId])

  /**
   * The bill on the diner's phone is a live document. The orders function
   * already broadcasts ORDER_UPDATED on the tenant topic whenever a row
   * changes; the payload is used only as a *trigger* — the bill itself is
   * always re-read through the session-token-authorized endpoint. When the
   * cashier records the payment at the counter, the UNPAID pill here turns
   * PAID on its own, which is exactly the moment the diner is watching.
   */
  const [billRefreshKey, setBillRefreshKey] = useState(0)
  const billOrderIdRef = useRef<string | null>(null)
  const billOpenRef = useRef(false)
  // The long-lived realtime listener reads the latest committed bill state.
  // A render may be abandoned, so publishing state to refs belongs in an
  // effect rather than making an in-progress render visible to that listener.
  useEffect(() => {
    billOrderIdRef.current = billOrderId
    billOpenRef.current = billOpen
  }, [billOrderId, billOpen])

  // The ended screen's bill and review card depend on sessionHasOrder, but the
  // broadcast that usually ends a live session (ORDER_UPDATED → COMPLETED, or
  // SESSION_ENDED from the POS) carries no hasOrder — and it always beats the
  // next 1.5s validate beat. Locking from the broadcast left sessionHasOrder
  // null, so the review card and its View Bill link never rendered and the
  // diner could not reach their bill at all. This one-shot check heals that:
  // on the ended screen with hasOrder still unknown, ask the server once —
  // the same 403 payload the poll consumes already carries hasOrder, the
  // order id, and the review summary.
  const endedBillProbeRef = useRef(false)
  useEffect(() => {
    if (sessionState !== 'ended' || sessionHasOrder !== null || !sessionToken) return
    if (endedBillProbeRef.current) return
    endedBillProbeRef.current = true
    ;(async () => {
      try {
        const res = await edgeFetch(
          `/api/table-session/validate?tenantId=${encodeURIComponent(sessionTenantId || '')}&tableId=${encodeURIComponent(sessionTableId || '')}`,
          { headers: { 'x-session-token': sessionToken } },
        )
        if (!res.ok) {
          const failed = await res.json().catch(() => null)
          setSessionHasOrder(Boolean(failed?.hasOrder))
          setReviewsEnabled(failed?.reviewsEnabled !== false)
          setAvgRating(typeof failed?.averageRating === 'number' ? failed.averageRating : null)
          setReviewCount(typeof failed?.reviewCount === 'number' ? failed.reviewCount : 0)
          if (failed?.orderId) setBillOrderId(failed.orderId)
        }
      } catch {
        /* the ended screen without the probe's answer is what we already had */
      }
    })()
  }, [sessionState, sessionHasOrder, sessionToken, sessionTenantId, sessionTableId])

  // Listen on this diner's own topic, not the restaurant's.
  //
  // The tenant topic used to carry every order in the restaurant on a public
  // channel, and a diner knows the tenant id — so any diner could read every
  // other table's orders. The topic now carries this session's token, which
  // only this browser holds, and the server addresses events to it alone.
  // Subscribing needs the token; the diner's row-level access is the token.
  const isRealtimeConnectedRef = useRef(false)
  const handleSessionTerminated = () => {
    const tId = tenant?.id || sessionTenantId
    const tblId = table?.id || sessionTableId
    if (tId && tblId) {
      removeStoredDinerSession(tId, tblId)
    }
    lockDinerSession(setSessionState)
    setOrdersRefreshKey((k) => k + 1)
    setCartOpen(false)
  }

  useEffect(() => {
    if (!sessionToken) return
    const supabase = createClient()
    const channel = supabase
      .channel(`diner:${sessionToken}`)
      .on('broadcast', { event: 'ORDER_UPDATED' }, (msg: any) => {
        const updated = msg?.payload?.order
        if (!updated?.id) return
        // Only this session's orders can arrive here, but check anyway: a
        // payload must never be trusted to decide whose bill is being shown.
        if (updated.tableSessionId && sessionId && updated.tableSessionId !== sessionId) return
        setOrdersRefreshKey((k) => k + 1)
        if (billOpenRef.current && billOrderIdRef.current === updated.id) {
          setBillRefreshKey((k) => k + 1)
        }
      })
      .on('broadcast', { event: 'ORDER_CREATED' }, () => {
        setOrdersRefreshKey((k) => k + 1)
      })
      .on('broadcast', { event: 'CHECK_UPDATED' }, (msg: any) => {
        setOrdersRefreshKey((k) => k + 1)
        setBillRefreshKey((k) => k + 1)
        if (msg?.payload?.status === 'PAID' || msg?.payload?.reason === 'FINALISED') {
          handleSessionTerminated()
        }
      })
      .on('broadcast', { event: 'SESSION_ENDED' }, () => {
        handleSessionTerminated()
      })
      .on('broadcast', { event: 'TABLE_ACTIVATED' }, () => {
        setActivation('ACTIVE')
      })
      .subscribe((status: string) => {
        isRealtimeConnectedRef.current = status === 'SUBSCRIBED'
      })
    return () => {
      isRealtimeConnectedRef.current = false
      void supabase.removeChannel(channel)
    }
  }, [sessionToken, sessionId, tenant?.id, sessionTenantId, table?.id, sessionTableId])

  const pillsRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  // ----- Session-gated menu access -----
  useEffect(() => {
    let cancelled = false

    function lockButKeepCredential(session: CachedDinerSession | null, data?: any) {
      lockDinerSession(setSessionState)
      if (session) {
        setSessionToken(session.token)
        setSessionTenantId(session.tenantId)
        setSessionTableId(session.tableId)
      }
      if (data?.tenant) setTenant(data.tenant)
    }

    function adopt(session: CachedDinerSession, data: any) {
      setSessionToken(session.token)
      setSessionId(data?.session?.id ?? null)
      setActivation((data?.activationStatus ?? data?.session?.activationStatus ?? 'ACTIVE') as any)
      setSessionTenantId(session.tenantId)
      setSessionTableId(session.tableId)
      setTenant(data.tenant)
      setTable(data.table)
      setCategories(data.categories || [])
      setMenuItems(data.menuItems || [])
      setSocial(data.social || {})
      setServerTheme(normaliseMenuTheme(data.theme))
    }

    async function activateAndLoad() {
      try {
        setLoading(true)
        setError(null)
        setSessionState('activating')

        const urlScanToken = new URLSearchParams(window.location.search).get('table')
        if (urlScanToken) {
          pendingScanToken = urlScanToken
        }
        const qrToken = pendingScanToken

        if (qrToken) {
          const mapped = getStoredQrMap(qrToken)
          let stored = mapped ? getStoredDinerSession(mapped.restaurantId, mapped.tableId) : null

          let res = await edgeFetch(
            `/api/table-session/validate?table=${encodeURIComponent(qrToken)}`,
            stored?.sessionToken ? { headers: { 'x-session-token': stored.sessionToken } } : undefined,
          )

          let data = await res.json().catch(() => null)

          if (!res.ok && stored && mapped) {
            removeStoredDinerSession(mapped.restaurantId, mapped.tableId)
            stored = null
            res = await edgeFetch(`/api/table-session/validate?table=${encodeURIComponent(qrToken)}`)
            data = await res.json().catch(() => null)
          }

          if (cancelled) return

          if (!res.ok) {
            setError(data?.error || 'Could not load table menu. Please scan again.')
            setSessionState('invalid')
            setLoading(false)
            return
          }

          if (data?.tenant?.id && data?.table?.id) {
            setStoredQrMap(qrToken, data.tenant.id, data.table.id)
          }

          if (data?.session) {
            adopt({ token: data.session.token, tenantId: data.tenant.id, tableId: data.table.id }, data)
            setStoredDinerSession(data.tenant.id, data.table.id, {
              sessionId: data.session.id,
              sessionToken: data.session.token,
            })
            setSessionState('active')
          } else {
            setSessionToken(null)
            setSessionId(null)
            setTenant(data.tenant)
            setTable(data.table)
            setSessionTenantId(data.tenant.id)
            setSessionTableId(data.table.id)
            setCategories(data.categories || [])
            setMenuItems(data.menuItems || [])
            setSocial(data.social || {})
            setServerTheme(normaliseMenuTheme(data.theme))
            setSessionState('active')
          }
          setLoading(false)
          return
        }

        const anyStored = findAnyStoredDinerSession()
        if (!anyStored) {
          if (!cancelled) {
            setSessionState('invalid')
            setLoading(false)
          }
          return
        }

        const res = await edgeFetch(
          `/api/table-session/validate?tenantId=${encodeURIComponent(anyStored.restaurantId)}&tableId=${encodeURIComponent(anyStored.tableId)}`,
          { headers: { 'x-session-token': anyStored.sessionToken } },
        )
        const data = await res.json().catch(() => null)

        if (cancelled) return

        if (!res.ok) {
          removeStoredDinerSession(anyStored.restaurantId, anyStored.tableId)
          setSessionHasOrder(Boolean(data?.hasOrder))
          setReviewsEnabled(data?.reviewsEnabled !== false)
          setAvgRating(typeof data?.averageRating === 'number' ? data.averageRating : null)
          setReviewCount(typeof data?.reviewCount === 'number' ? data.reviewCount : 0)
          if (data?.orderId) setBillOrderId(data.orderId)
          lockButKeepCredential(
            {
              token: anyStored.sessionToken,
              tenantId: anyStored.restaurantId,
              tableId: anyStored.tableId,
            },
            data,
          )
          setLoading(false)
          return
        }

        adopt({ token: anyStored.sessionToken, tenantId: anyStored.restaurantId, tableId: anyStored.tableId }, data)
        setSessionState('active')
        setLoading(false)
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || 'Something went wrong')
          setSessionState('invalid')
          setLoading(false)
        }
      }
    }

    activateAndLoad()
    return () => {
      cancelled = true
    }
  }, [revalidateNonce])

  // ----- Cart persistence (keyed by SESSION once ordered, or table while browsing) -----
  // Switching tables / re-scanning creates a new session → fresh cart.
  const cartSuffix = useMemo(() => {
    if (sessionToken) return sessionToken
    if (table?.id) return `browsing:${table.id}`
    return null
  }, [sessionToken, table?.id])

  const cartKey = useMemo(() => {
    if (!cartSuffix) return null
    return keyName('cart', cartSuffix)
  }, [cartSuffix])

  // load
  useEffect(() => {
    if (!cartSuffix) return
    try {
      const raw = readStored('cart', cartSuffix)
      if (raw) {
        const parsed = JSON.parse(raw) as CartItem[]
        if (Array.isArray(parsed)) setCart(parsed)
      }
    } catch {
      /* ignore */
    }
  }, [cartSuffix])

  // save
  useEffect(() => {
    if (!cartSuffix) return
    try {
      writeStored('cart', JSON.stringify(cart), cartSuffix)
    } catch {
      /* ignore */
    }
  }, [cart, cartSuffix])

  // ----- Cart actions -----
  function addToCart(item: MenuItem, portion?: { id?: string; name: string; price: number } | null) {
    const linePortion = portion?.name ? canonicalPortionName(portion.name) : null
    const linePortionId =
      portion?.id || (linePortion ? normalizePortionKey(linePortion) : null)
    const linePrice = portion ? portion.price : item.price
    setCart((prev) => {
      const existing = prev.find((c) =>
        sameCartLine(c, item.id, linePortion, linePortionId),
      )
      if (existing) {
        return prev.map((c) =>
          sameCartLine(c, item.id, linePortion, linePortionId)
            ? {
                ...c,
                portion: linePortion,
                portionId: linePortionId,
                price: linePrice,
                quantity: c.quantity + 1,
              }
            : c,
        )
      }
      return [
        ...prev,
        {
          menuItemId: item.id,
          name: item.name,
          portionId: linePortionId,
          portion: linePortion,
          price: linePrice,
          image: item.image,
          quantity: 1,
          prepTime: item.prepTime,
        },
      ]
    })
    toast.success(`${item.name}${linePortion ? ` (${linePortion})` : ''} added`, {
      duration: 1500,
    })
  }

  function decrement(item: MenuItem, portion?: string | null, portionId?: string | null) {
    setCart((prev) => {
      const existing = prev.find((c) =>
        sameCartLine(c, item.id, portion, portionId),
      )
      if (!existing) return prev
      if (existing.quantity <= 1) {
        return prev.filter((c) => !sameCartLine(c, item.id, portion, portionId))
      }
      return prev.map((c) =>
        sameCartLine(c, item.id, portion, portionId)
          ? { ...c, quantity: c.quantity - 1 }
          : c,
      )
    })
  }

  function setItemNotes(menuItemId: string, notes: string, portion?: string | null, portionId?: string | null) {
    setCart((prev) =>
      prev.map((c) =>
        sameCartLine(c, menuItemId, portion, portionId) ? { ...c, notes } : c
      )
    )
  }

  function removeFromCart(menuItemId: string, portion?: string | null, portionId?: string | null) {
    setCart((prev) =>
      prev.filter((c) => !sameCartLine(c, menuItemId, portion, portionId))
    )
  }

  function clearCart() {
    setCart([])
  }

  // ===== Instant Session End Listeners (BroadcastChannel + Realtime + Adaptive Heartbeat) =====
  // When restaurant staff marks an order COMPLETED, the customer menu ends instantly without any delay.
  const isValidatingSessionRef = useRef(false)
  useEffect(() => {
    if (sessionState !== 'active') return

    const targetTableId = sessionTableId || table?.id
    const targetTenantId = sessionTenantId || tenant?.id

    // 1. Same-device / cross-tab instant broadcast (0ms delay)
    let bc: BroadcastChannel | null = null
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      bc = new BroadcastChannel('the_salad_orders_sync')
      bc.onmessage = (e) => {
        const msg = e.data
        if (!msg) return
        if (
          msg.type === 'SESSION_ENDED' &&
          (!msg.tableId || !targetTableId || msg.tableId === targetTableId)
        ) {
          lockDinerSession(setSessionState)
          setCartOpen(false)
        }
      }
    }

    // 2. Adaptive Heartbeat & Session Validation (Realtime-first fallback)
    const validateSession = async () => {
      if (!sessionToken || isValidatingSessionRef.current) return
      if (typeof document !== 'undefined' && document.hidden) return
      isValidatingSessionRef.current = true
      try {
        const tId = targetTenantId || ''
        const tblId = targetTableId || ''
        const res = await edgeFetch(
          `/api/table-session/validate?tenantId=${encodeURIComponent(tId)}&tableId=${encodeURIComponent(
            tblId
          )}`,
          { headers: { 'x-session-token': sessionToken } }
        )
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            const failed = await res.json().catch(() => null)
            setSessionHasOrder(Boolean(failed?.hasOrder))
            setReviewsEnabled(failed?.reviewsEnabled !== false)
            setAvgRating(typeof failed?.averageRating === 'number' ? failed.averageRating : null)
            setReviewCount(typeof failed?.reviewCount === 'number' ? failed.reviewCount : 0)
            lockDinerSession(setSessionState)
            setCartOpen(false)
          }
          return
        }
        const data = await res.json()
        if (data.sessionStatus !== 'ACTIVE') {
          lockDinerSession(setSessionState)
          setCartOpen(false)
          return
        }
        const next = (data.activationStatus ?? data.session?.activationStatus ?? 'ACTIVE') as typeof activation
        setActivation((prev) => {
          if (prev === 'PENDING' && next === 'ACTIVE') {
            setAwaitingActivation(false)
            toast.success('Your table is ready — your order is with the kitchen.', { duration: 3000 })
          }
          return next
        })
      } catch {
        // network blips are ignored; adaptive schedule will retry
      } finally {
        isValidatingSessionRef.current = false
      }
    }

    let timer: NodeJS.Timeout | null = null
    let isCancelled = false

    const scheduleNext = () => {
      if (isCancelled) return
      // When awaiting host acceptance, poll every 5s so diner isn't delayed.
      // When active and Realtime channel is healthy, 30s heartbeat is plenty.
      // When Realtime is disconnected/reconnecting, fallback to 10s.
      const delay = activation === 'PENDING' ? 5000 : (isRealtimeConnectedRef.current ? 30000 : 10000)
      timer = setTimeout(async () => {
        await validateSession()
        scheduleNext()
      }, delay)
    }

    scheduleNext()

    const onVisibleOrOnline = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void validateSession()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibleOrOnline)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onVisibleOrOnline)
    }

    return () => {
      isCancelled = true
      if (bc) bc.close()
      if (timer) clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibleOrOnline)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onVisibleOrOnline)
      }
    }
  }, [sessionState, sessionToken, sessionTenantId, sessionTableId, tenant?.id, table?.id, activation])


  // ----- "The page is going away" beacon — a goodbye, not a verdict -----
  //
  // `pagehide` is not the diner leaving: it is also a refresh, an app switch,
  // a phone locking, or the browser reclaiming a backgrounded tab. (An earlier
  // version of this beacon ended the session three seconds after it fired and
  // stranded exactly those diners.) So the beacon only *stamps* the session
  // (`close_pending_at`); the sweep ends it when the stamp is two minutes old
  // and no heartbeat landed after it. A refreshed page heartbeats within
  // seconds and disproves its own stamp — and a session with an order is
  // never ended by this path at all. See migration 0058.
  useEffect(() => {
    if (sessionState !== 'active' || !sessionToken) return
    const sayGoodbye = () => {
      try {
        navigator.sendBeacon(
          edgeUrl('/api/table-session/release'),
          new Blob([JSON.stringify({ sessionToken })], { type: 'application/json' }),
        )
      } catch {
        /* a browser without sendBeacon leaves the 30-minute idle rule in charge */
      }
    }
    window.addEventListener('pagehide', sayGoodbye)
    return () => window.removeEventListener('pagehide', sayGoodbye)
  }, [sessionState, sessionToken])

  // ----- Derived values -----
  const currency = tenant?.currencySymbol || '$'
  const taxRate = (tenant?.taxRate ?? 8) / 100
  const serviceRate = (tenant?.serviceCharge ?? 0) / 100

  const cartCount = cart.reduce((s, c) => s + c.quantity, 0)
  const itemsTotal = cart.reduce((s, c) => s + c.price * c.quantity, 0)
  const discount = 0
  const taxableAmount = Math.max(0, itemsTotal - discount)
  const tax = +(taxableAmount * taxRate).toFixed(2)
  const service = +(itemsTotal * serviceRate).toFixed(2)
  const grandTotal = +(taxableAmount + tax + service).toFixed(2)

  const estimatedPrep = useMemo(() => {
    if (cart.length === 0) return 0
    // sum of prep times (with light queue consideration)
    const sum = cart.reduce((s, c) => s + (c.prepTime || 15) * c.quantity, 0)
    return Math.max(15, Math.min(sum, 60))
  }, [cart])

  // ----- Filtering & grouping -----
  const filteredItems = useMemo(() => {
    let items = menuItems
    if (activeCat !== 'all') {
      items = items.filter((i) => i.categoryId === activeCat)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.description || '').toLowerCase().includes(q) ||
          (i.tags || '').toLowerCase().includes(q)
      )
    }
    return items
  }, [menuItems, activeCat, search])

  const groupedSections = useMemo(() => {
    // If searching, group as a single "Search Results" section
    if (search.trim()) {
      return [{ category: null, items: filteredItems }]
    }
    // If a specific category is selected, only show that section
    if (activeCat !== 'all') {
      const cat = categories.find((c) => c.id === activeCat)
      if (!cat) return []
      return [{ category: cat, items: filteredItems }]
    }
    // Otherwise show all category sections that have items
    return categories
      .map((category) => ({
        category,
        items: filteredItems.filter((i) => i.categoryId === category.id),
      }))
      .filter((s) => s.items.length > 0)
  }, [filteredItems, categories, activeCat, search])

  // ----- Scroll to section (when category pill tapped) -----
  function selectCategory(id: string) {
    setActiveCat(id)
    // small delay so DOM updates (filter) then scroll
    requestAnimationFrame(() => {
      const el = sectionRefs.current[id === 'all' ? 'all' : id]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
  }

  // ----- Place order (requires active session) -----
  // The checkout is snapshotted into the persistent queue with an
  // idempotency key: a network drop can no longer lose or duplicate the
  // order. The cart is cleared only by the confirmation itself.
  function placeOrder() {
    if (!cart.length) return
    // Synchronous double-click guard: `busy` is React state and two clicks
    // can land before it flushes. The ref closes the window.
    if (placingRef.current) return
    const currentQrToken = pendingScanToken || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('table') : null)
    const effectiveTenantId = sessionTenantId || tenant?.id
    if (sessionState !== 'active' || (!sessionToken && !currentQrToken) || !effectiveTenantId) {
      toast.error('This table session has ended or is not active. Please scan table QR to continue.')
      lockDinerSession(setSessionState)
      return
    }

    // Validate that cart items exist and are available in current menu
    if (menuItems.length > 0) {
      const availableItemIds = new Set(
        menuItems.filter((m) => m.available !== false).map((m) => m.id),
      )
      const staleItem = cart.find((c) => !availableItemIds.has(c.menuItemId))
      if (staleItem) {
        toast.error('One or more items in your cart are no longer available. Please review your cart.')
        return
      }
    }

    const items = cart.map((c) => ({
      menuItemId: c.menuItemId,
      portionId: c.portionId || undefined,
      portion: c.portion || undefined,
      quantity: c.quantity,
      notes: c.notes || '',
    }))
    const existingStoredSession =
      !sessionToken && table?.id ? getStoredDinerSession(effectiveTenantId, table.id) : null
    const activeToken = sessionToken || existingStoredSession?.sessionToken || null

    const actorKey = sessionToken || (table?.id ? `table_${table.id}` : `qr_${currentQrToken}`)
    const payload: Record<string, any> = {
      orderType: 'DINE_IN',
      items,
    }
    if (activeToken) {
      payload.tableSessionToken = activeToken
    } else if (currentQrToken) {
      payload.qrToken = currentQrToken
      if (table?.id) payload.tableId = table.id
    }
    placingRef.current = true
    orderQueue(effectiveTenantId, actorKey, {}).enqueue(
      'diner',
      payload,
      items.length,
    )
  }

  // Everything that happens once the server has the order — fresh commit or
  // reconciled replay. One function, because the two paths must not diverge.
  function handleOrderConfirmed(order: any, entry: QueueEntry) {
    if (order?.id) {
      setPlacedOrderId(order.id)
      try {
        writeStored('lastOrderId', order.id)
      } catch {}
    }

    // Remove only the submitted items from the cart they came from before
    // adopting the session so a rejected attempt never wipes the browsing cart
    // and an empty session cart cannot overwrite remaining items.
    let remainingCart = [...cartRef.current]
    for (const line of entry.payload?.items ?? []) {
      const qty = Math.max(1, Number(line.quantity) || 1)
      remainingCart = remainingCart
        .map((c) =>
          sameCartLine(c, line.menuItemId, line.portion ?? null, line.portionId ?? null)
            ? { ...c, quantity: c.quantity - qty }
            : c,
        )
        .filter((c) => c.quantity > 0)
    }

    if (order?.sessionToken && order?.sessionId) {
      const tId = tenant?.id || sessionTenantId
      const tblId = table?.id || sessionTableId
      let nextCart = remainingCart

      if (order.sessionToken !== sessionToken) {
        let existingSessionCart: CartItem[] = []
        try {
          const raw = readStored('cart', order.sessionToken)
          if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) existingSessionCart = parsed
          }
        } catch {}

        if (remainingCart.length > 0) {
          const merged = existingSessionCart.map((c) => ({ ...c }))
          for (const item of remainingCart) {
            const idx = merged.findIndex((c) =>
              sameCartLine(c, item.menuItemId, item.portion ?? null, item.portionId ?? null),
            )
            if (idx >= 0) {
              merged[idx] = {
                ...merged[idx],
                quantity: merged[idx].quantity + item.quantity,
                notes: merged[idx].notes || item.notes,
              }
            } else {
              merged.push({ ...item })
            }
          }
          nextCart = merged
          try {
            writeStored('cart', JSON.stringify(merged), order.sessionToken)
          } catch {}
        } else {
          // No unsubmitted browsing remainder: leave the saved session cart intact.
          nextCart = existingSessionCart
        }
      }

      setCart(nextCart)
      cartRef.current = nextCart

      if (tblId) {
        try {
          removeStored('cart', `browsing:${tblId}`)
        } catch {}
      }
      if (tId && tblId) {
        setStoredDinerSession(tId, tblId, {
          sessionId: order.sessionId,
          sessionToken: order.sessionToken,
        })
      }
      setSessionToken(order.sessionToken)
      setSessionId(order.sessionId)
    } else {
      setCart(remainingCart)
      cartRef.current = remainingCart
    }

    // Refresh diner order tracker immediately
    setOrdersRefreshKey((k) => k + 1)
    setCartOpen(true)

    // Broadcast immediately across browser tabs/windows
    try {
      if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
        const bc = new BroadcastChannel('the_salad_orders_sync')
        bc.postMessage({
          type: 'ORDER_CREATED',
          tenantId: tenant?.id || sessionTenantId,
          order,
          timestamp: new Date().toISOString(),
        })
        bc.close()
      }
    } catch {
      /* ignore */
    }

    setPlacedOrder({
      orderNumber: order.orderNumber,
      total: order.total,
      table: order.table,
      items: Array.isArray(order.items) ? order.items : [],
    })
    if (order?.pendingActivation) {
      // Not a failure and not a confirmation: the order exists, but the kitchen
      // has not been told about it yet.
      setAwaitingActivation(true)
      toast.success('Order sent — waiting for the restaurant to accept your table', { duration: 3500 })
    } else {
      setAwaitingActivation(false)
      toast.success('Order placed!', { duration: 2500 })
    }
  }

  // The queue lifecycle follows the session or table: same scope (tenant + actorKey)
  // from first order to last, so a refresh mid-checkout resumes it.
  useEffect(() => {
    const effectiveTenantId = sessionTenantId || tenant?.id
    const currentQrToken = pendingScanToken || (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('table') : null)
    const actorKey = sessionToken || (table?.id ? `table_${table.id}` : (currentQrToken ? `qr_${currentQrToken}` : null))
    if (!effectiveTenantId || !actorKey) return
    const q = orderQueue(effectiveTenantId, actorKey, {
      onConfirmed: (order, entry) => {
        placingRef.current = false
        handleOrderConfirmed(order, entry)
      },
      onFailed: (error, entry) => {
        placingRef.current = false
        const msg = cleanOrderErrorMessage(error)
        toast.error(`Order Failed: ${msg}`)
        q.retire(entry.key)
      },
      onChange: (entries) => {
        setQueueEntries(entries)
        placingRef.current = entries.some(
          (e) => e.state === 'pending' || e.state === 'submitting',
        )
      },
    })
    q.retireAllFailed()
    setQueueEntries(q.load())
    const stop = startOrderQueue(effectiveTenantId, actorKey, {})
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
  }, [sessionTenantId, tenant?.id, sessionToken, table?.id])

  function closeSheet() {
    setCartOpen(false)
    // small delay so the closing animation finishes before clearing success state
    setTimeout(() => {
      setPlacedOrder(null)
    }, 350)
  }

  // Handle opening bill modal
  const handleOpenBill = async () => {
    try {
      const q = new URLSearchParams()
      if (placedOrderId) {
        q.set('orderId', placedOrderId)
      } else {
        try {
          const savedId = readStored('lastOrderId')
          if (savedId) q.set('orderId', savedId)
        } catch {}
      }
      const tblId = sessionTableId || table?.id
      if (tblId) q.set('tableId', tblId)
      const tntId = sessionTenantId || tenant?.id
      if (tntId) q.set('tenantId', tntId)

      if (typeof window !== 'undefined') {
        const qr = new URLSearchParams(window.location.search).get('table')
        if (qr) q.set('qrToken', qr)
      }

      const res = await edgeFetch(`/api/table-session/bill?${q.toString()}`, {
        headers: sessionToken ? { 'x-session-token': sessionToken } : undefined,
      })
      const data = await res.json()
      if (data.ok && data.orderId) {
        setBillOrderId(data.orderId)
        setBillOpen(true)
      } else {
        toast.info('No bill found for this session')
      }
    } catch {
      toast.error('Failed to load bill')
    }
  }

  // ---------- The theme ----------
  //
  // It is applied to the document, not only to the menu, because the cart
  // sheet and the item sheet are rendered in a portal on the document body.
  // The theme the diner was last shown is put on straight away, so the menu
  // does not load in the wrong palette.
  //
  // These sit above every early return, because a hook that is only reached
  // on some renders is a hook that is called in a different order some of
  // the time.
  // The theme in force is applied to the document, so the sheets Radix
  // renders in a portal are in the same palette as the menu.
  useEffect(() => {
    applyMenuTheme(menuTheme)
    return () => {
      // Restore user's app theme when exiting public menu preview
      initTheme()
    }
  }, [menuTheme])

  // The theme this diner was last shown, read once the restaurant is known.
  // It stands in until the server answers, and it never overrules it.
  useEffect(() => {
    setCachedTheme(cachedMenuTheme(sessionTenantId))
  }, [sessionTenantId])

  useEffect(() => {
    if (!tenant || !serverTheme) return
    cacheMenuTheme(tenant.id, serverTheme)
  }, [tenant, serverTheme])

  // ---------- Loading state ----------
  // ---------- Session ended / invalid → LOCKED screen ----------
  if (sessionState === 'ended' || sessionState === 'invalid') {
    const ended = sessionState === 'ended'
    return (
      <div className={`${menuTheme} min-h-screen bg-background text-foreground flex items-center justify-center p-4 sm:p-6`}>
        <div className="max-w-[440px] w-full text-center rounded-3xl bg-card p-6 sm:p-8 shadow-sm border border-border">
          <div className="mx-auto size-16 rounded-2xl flex items-center justify-center shadow-xs" style={{ background: ended ? '#fef3c7' : '#fee2e2' }}>
            {ended ? (
              <svg className="size-8 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m0 0v-2m0 2H8m4 0h4M12 3l8 4v5c0 4.5-3.5 7.5-8 9-4.5-1.5-8-4.5-8-9V7l8-4z" />
              </svg>
            ) : (
              <svg className="size-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c0-1.5.5-2 2-2s2 .5 2 2M5 11h14M12 3l8 4v5c0 4.5-3.5 7.5-8 9-4.5-1.5-8-4.5-8-9V7l8-4z" />
              </svg>
            )}
          </div>

          {ended && reviewsEnabled && (
            <div className="mt-4 inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-muted border border-border/90 shadow-2xs">
              <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
              <span className="text-xs font-bold text-foreground tracking-tight">Customer Reviews</span>
              {avgRating !== null && reviewCount > 0 && (
                <span className="text-[11px] font-bold text-foreground">
                  ★ {avgRating.toFixed(1)} <span className="font-medium text-muted-foreground">({reviewCount})</span>
                </span>
              )}
            </div>
          )}

          <h2 className={cn("text-xl font-bold tracking-tight", ended ? "mt-2" : "mt-4")}>
            {ended ? 'Your table session has ended.' : 'Menu access requires a table session.'}
          </h2>
          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
            {ended
              ? 'Please scan the QR code on your table to continue viewing the menu and placing orders.'
              : 'This menu is only accessible by scanning the QR code on your restaurant table.'}
          </p>

          {/* When a scan was refused, say why. The server's reason is the only
              thing the diner can act on — an invalid code, a restaurant that
              is closed, a table that has been taken out of service. */}
          {!ended && error && (
            <p className="mt-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-[13px] font-medium leading-snug text-red-700">
              {error}
            </p>
          )}

          {/* The review card carries the "View Bill" link, so it only appears
              when the session actually has an order on it. A table can be
              abandoned and its session ended from the POS without anything
              ever being ordered, and there is nothing to bill and nothing to
              rate in that case. Until the server has answered, neither is
              shown — a bill button that turns out to be empty is worse than
              no bill button. */}
          {ended && sessionHasOrder === true && reviewsEnabled && (
            <SessionReviewCard
              sessionToken={sessionToken}
              onViewBill={handleOpenBill}
            />
          )}

          {ended && sessionHasOrder === false && (
            <p className="mt-4 rounded-xl bg-muted px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground border border-border">
              No orders were placed on this table, so there is no bill.
            </p>
          )}

          <div className="mt-5 rounded-xl bg-muted p-3 text-[11px] text-muted-foreground leading-relaxed border border-border">
            For security, menu access cannot be restored by refreshing the page, using browser history, or copying the URL. Only scanning the table QR code activates a new session.
          </div>
        </div>

        {/* In-app bill modal */}
        <BillDialog
          orderId={billOrderId}
          open={billOpen}
          onOpenChange={setBillOpen}
          sessionToken={sessionToken}
          refreshKey={billRefreshKey}
        />
      </div>
    )
  }

  // ---------- Activating session → loading skeleton ----------
  if (loading || sessionState === 'activating') {
    return (
      <div className={`${menuTheme} min-h-screen bg-background text-foreground`}>
        <div className="max-w-md mx-auto px-4 pt-6">
          <Skeleton className="h-16 w-16 rounded-2xl bg-muted" />
          <Skeleton className="mt-4 h-7 w-3/4 bg-muted" />
          <Skeleton className="mt-2 h-4 w-1/2 bg-muted" />
          <Skeleton className="mt-4 h-12 w-full rounded-2xl bg-muted" />
          <div className="mt-4 flex gap-2 overflow-hidden">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-20 rounded-full bg-muted" />
            ))}
          </div>
          <div className="mt-6 space-y-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="flex gap-4 rounded-2xl bg-card p-3 shadow-sm"
              >
                <Skeleton className="size-20 rounded-xl bg-muted" />
                <div className="flex-1 space-y-2 py-1">
                  <Skeleton className="h-4 w-2/3 bg-muted" />
                  <Skeleton className="h-3 w-full bg-muted" />
                  <Skeleton className="h-3 w-1/3 bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ---------- Error state ----------
  if (error || !tenant) {
    return (
      <div className={`${menuTheme} min-h-screen bg-background text-foreground flex items-center justify-center p-6`}>
        <div className="max-w-sm w-full text-center rounded-3xl bg-card p-8 shadow-sm">
          <div className="mx-auto size-14 rounded-2xl bg-red-50 flex items-center justify-center">
            <X className="size-7 text-red-500" />
          </div>
          <h2 className="mt-4 text-xl font-bold">Menu unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {error || 'We could not load this restaurant’s menu. Please try again.'}
          </p>
          <Button
            onClick={() => window.location.reload()}
            className="mt-6 w-full text-white"
            style={{ background: CORAL }}
          >
            Try again
          </Button>
        </div>
      </div>
    )
  }

  // ---------- Main render ----------
  return (
    <div
      className={`${menuTheme} min-h-screen bg-background text-foreground`}
      style={{ paddingBottom: cart.length ? 96 : 0 }}
    >
      <div className="max-w-md mx-auto relative">
        {/* Waiting on the floor to accept the table. Non-blocking on purpose:
            the diner can keep browsing and adding to the cart; only the first
            order is held. It clears itself the moment the heartbeat sees the
            table accepted — no button, nothing to dismiss. */}
        {awaitingActivation && (
          <div
            data-awaiting-activation
            className="flex items-start gap-2.5 border-b border-amber-500/20 bg-amber-50/80 px-4 py-2.5 dark:bg-amber-500/10"
            role="status"
            aria-live="polite"
          >
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20">
              <Loader2 className="size-3 animate-spin text-amber-600 dark:text-amber-400" />
            </span>
            <p className="text-[11.5px] leading-snug text-amber-900 dark:text-amber-200">
              <span className="font-semibold">Waiting for the restaurant to accept your table.</span>{' '}
              Your order is saved — it goes to the kitchen as soon as they do.
            </p>
          </div>
        )}

        {/* ===== Sticky header ===== */}
        <header className="sticky top-0 z-30 bg-background/95 backdrop-blur-md border-b border-border">
          <div className="px-4 pt-5 pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {tenant.logo ? (
                  <img
                    src={tenant.logo}
                    alt={tenant.name}
                    className="size-12 rounded-2xl object-cover ring-1 ring-black/5"
                  />
                ) : (
                  <div
                    className="size-12 rounded-2xl flex items-center justify-center text-white shadow-sm"
                    style={{ background: CORAL }}
                  >
                    <Utensils className="size-6" />
                  </div>
                )}
                <div className="min-w-0">
                  <h1 className="text-xl font-bold leading-tight truncate">
                    {tenant.name}
                  </h1>
                  {tenant.tagline && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {tenant.tagline}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {/* The diner's own orders: a compact icon with a count, and a
                    glass panel listing them with live status. */}
                <DinerOrderTracker
                  sessionToken={sessionToken}
                  refreshKey={ordersRefreshKey}
                  currencySymbol={tenant.currencySymbol}
                />
                {tenant.phone && (
                  <a
                    href={`tel:${tenant.phone}`}
                    className="size-10 rounded-full bg-card shadow-sm border border-border flex items-center justify-center text-foreground hover:bg-card-elevated transition"
                    aria-label="Call restaurant"
                  >
                    <Phone className="size-4" />
                  </a>
                )}
              </div>
            </div>

            {/* Table card */}
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-card px-3 py-1.5 text-xs font-medium shadow-sm border border-border">
              {table ? (
                <>
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  <span className="text-foreground">
                    🍽️ {table.name} · {table.area} · {table.seats} seats
                  </span>
                </>
              ) : (
                <>
                  <span className="size-1.5 rounded-full bg-amber-500" />
                  <span className="text-foreground">Takeaway order</span>
                </>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="px-4 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search dishes…"
                className="pl-9 pr-9 h-11 rounded-full bg-card border-border focus-visible:ring-primary/30 focus-visible:border-primary"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
          </div>

          {/* Category pills */}
          <div
            ref={pillsRef}
            className="px-4 pb-3 overflow-x-auto no-scrollbar"
            style={{ scrollbarWidth: 'none' }}
          >
            <div className="flex gap-2 w-max">
              <CategoryPill
                active={activeCat === 'all'}
                onClick={() => selectCategory('all')}
                icon="🍽️"
                label="All"
              />
              {categories.map((c) => (
                <CategoryPill
                  key={c.id}
                  active={activeCat === c.id}
                  onClick={() => selectCategory(c.id)}
                  icon={c.icon || '🍴'}
                  label={c.name}
                />
              ))}
            </div>
          </div>
        </header>

        {/* ===== Menu sections ===== */}
        <main className="px-4 py-4">
          {groupedSections.length === 0 ? (
            <div className="py-16 text-center">
              <div className="mx-auto size-14 rounded-2xl bg-card shadow-sm flex items-center justify-center">
                <Search className="size-6 text-muted-foreground" />
              </div>
              <p className="mt-4 text-sm font-medium text-foreground">
                No dishes found
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try a different search or category.
              </p>
              {search && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSearch('')
                    setActiveCat('all')
                  }}
                  className="mt-3 text-primary hover:text-primary hover:bg-primary/10"
                >
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            groupedSections.map((section, idx) => {
              const key =
                section.category?.id || (search.trim() ? 'search' : 'all')
              return (
                <section
                  key={key}
                  ref={(el) => {
                    sectionRefs.current[key] = el
                  }}
                  className={idx > 0 ? 'mt-8' : ''}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-lg">
                      {section.category?.icon || (search.trim() ? '🔎' : '🍽️')}
                    </span>
                    <h2 className="text-lg font-bold tracking-tight">
                      {search.trim()
                        ? `Search results (${section.items.length})`
                        : section.category?.name || 'Menu'}
                    </h2>
                  </div>
                  <div className="space-y-3">
                    {section.items.map((item) => {
                      const itemLines = cart.filter((c) => c.menuItemId === item.id)
                      const totalQty = itemLines.reduce((s, c) => s + c.quantity, 0)
                      return (
                        <MenuItemCard
                          key={item.id}
                          item={item}
                          currency={currency}
                          inCartQty={totalQty}
                          itemLines={itemLines}
                          onAdd={() => addToCart(item)}
                          onDecrement={() => decrement(item)}
                          onAddPortion={(portion) => addToCart(item, portion)}
                          onDecrementPortion={(portion) => decrement(item, portion.name, portion.id)}
                        />
                      )
                    })}
                  </div>
                </section>
              )
            })
          )}

          {/* Footer info */}
          <footer className="mt-12 pb-8 text-center">
            <Separator className="my-6 bg-muted" />
            {tenant.address && (
              <div className="flex items-start justify-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="size-3.5 mt-0.5 shrink-0" />
                <span className="max-w-[260px]">{tenant.address}</span>
              </div>
            )}
            {tenant.phone && (
              <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <Phone className="size-3.5" />
                <span>{tenant.phone}</span>
              </div>
            )}
            {/* Social media icons */}
            {(social.instagram || social.facebook || social.youtube) && (
              <div className="mt-5 flex flex-col items-center gap-2.5">
                <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Follow us</p>
                <div className="flex items-center justify-center gap-3">
                {social.instagram && (
                  <a href={social.instagram} target="_blank" rel="noopener noreferrer" className={cn(SOCIAL_BTN, INSTAGRAM_BG)} aria-label="Instagram">
                    <svg className="size-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
                  </a>
                )}
                {social.facebook && (
                  <a href={social.facebook} target="_blank" rel="noopener noreferrer" className={cn(SOCIAL_BTN, FACEBOOK_BG)} aria-label="Facebook">
                    <svg className="size-5" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                  </a>
                )}
                {social.youtube && (
                  <a href={social.youtube} target="_blank" rel="noopener noreferrer" className={cn(SOCIAL_BTN, YOUTUBE_BG)} aria-label="YouTube">
                    <svg className="size-5" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
                  </a>
                )}
                </div>
              </div>
            )}
            <p className="mt-4 text-[10px] uppercase tracking-widest text-muted-foreground">
              Powered by The Salad
            </p>
          </footer>
        </main>

        {/* ===== Floating cart button ===== */}
        {cart.length > 0 && !cartOpen && (
          <button
            onClick={() => setCartOpen(true)}
            className="fixed bottom-24 right-1/2 translate-x-[15.5rem] sm:translate-x-[16rem] z-40 size-12 rounded-full shadow-lg flex items-center justify-center text-white bg-slate-900 dark:bg-card dark:text-foreground border border-border/80 transition-transform active:scale-95 cursor-pointer"
            aria-label="Open cart"
          >
            <ShoppingBag className="size-5" />
            {cartCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full text-[10px] font-bold flex items-center justify-center ring-2 ring-background"
                style={{ background: CORAL }}
              >
                {cartCount}
              </span>
            )}
          </button>
        )}

        {/* ===== Sticky cart bar ===== */}
        {cart.length > 0 && !cartOpen && (
          <div className="fixed bottom-0 left-0 right-0 z-40">
            <div className="max-w-md mx-auto px-4 pb-4 pt-2">
              <button
                onClick={() => setCartOpen(true)}
                className="w-full flex items-center justify-between rounded-2xl px-4 py-3 text-white shadow-xl transition-transform active:scale-[0.98]"
                style={{ background: CORAL }}
              >
                <div className="flex items-center gap-2.5">
                  <span className="size-7 rounded-full bg-card/20 flex items-center justify-center text-xs font-bold">
                    {cartCount}
                  </span>
                  <span className="text-sm font-semibold">
                    {cartCount === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold">
                    {formatPrice(grandTotal, currency)}
                  </span>
                  <span className="flex items-center gap-1 text-sm font-semibold">
                    View Order
                    <ChevronUp className="size-4" />
                  </span>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* ===== Cart sheet ===== */}
        <Sheet open={cartOpen} onOpenChange={(o) => (o ? setCartOpen(true) : closeSheet())}>
          <SheetContent
            side="bottom"
            hideCloseButton
            className={`${menuTheme} max-w-md mx-auto rounded-t-3xl p-0 border-0 bg-background max-h-[92vh] flex flex-col`}
          >
            {placedOrder ? (
              <SuccessView
                order={placedOrder}
                tableName={table?.name}
                estimatedPrep={estimatedPrep}
                currency={currency}
                onClose={closeSheet}
              />
            ) : cart.length === 0 ? (
              <EmptyCart onClose={closeSheet} />
            ) : (
              <>
                <SheetHeader className="shrink-0 px-5 pt-5 pb-3 border-b border-border">
                  <div className="flex items-center justify-between">
                    <SheetTitle className="text-lg font-bold flex items-center gap-2">
                      <ShoppingBag className="size-5" style={{ color: CORAL }} />
                      Your Order
                    </SheetTitle>
                    <button
                      onClick={closeSheet}
                      className="size-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted transition"
                      aria-label="Close cart"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <SheetDescription className="text-xs">
                    {table ? (
                      <>
                        🍽️ {table.name} · {table.area} · Dine-in
                      </>
                    ) : (
                      <>Takeaway order</>
                    )}
                  </SheetDescription>
                </SheetHeader>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <div className="px-5 py-4 space-y-4">
                    {cart.map((c) => (
                      <CartLine
                        key={`${c.menuItemId}::${c.portionId || c.portion || ''}`}
                        item={c}
                        currency={currency}
                        onAdd={() => {
                          const mi = menuItems.find((m) => m.id === c.menuItemId)
                          if (mi) {
                            addToCart(
                              mi,
                              c.portion ? { id: c.portionId ?? undefined, name: c.portion, price: c.price } : null,
                            )
                          }
                        }}
                        onDecrement={() => {
                          const mi = menuItems.find((m) => m.id === c.menuItemId)
                          if (mi) decrement(mi, c.portion, c.portionId)
                        }}
                        onRemove={() => removeFromCart(c.menuItemId, c.portion, c.portionId)}
                        onNotesChange={(n) => setItemNotes(c.menuItemId, n, c.portion, c.portionId)}
                      />
                    ))}

                    {/* Suggested note */}
                    <div className="rounded-2xl bg-orange-50 dark:bg-orange-950/40 border border-orange-200/80 dark:border-orange-500/25 p-3 text-xs text-orange-950 dark:text-orange-100 flex items-start gap-2.5">
                      <Sparkles className="size-3.5 mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
                      <span className="leading-relaxed font-medium">
                        Add notes for the kitchen — allergies, spice level, or
                        special requests.
                      </span>
                    </div>
                  </div>
                </div>

                {/* Totals + place order */}
                <div className="shrink-0 border-t border-border bg-card px-5 pt-4 pb-5 space-y-3 rounded-b-3xl">
                  <div className="space-y-1.5 text-sm">
                    <Row label="Subtotal" value={formatPrice(itemsTotal, currency)} />
                    {service > 0 && (
                      <Row
                        label={`Service (${Math.round(serviceRate * 100)}%)`}
                        value={formatPrice(service, currency)}
                      />
                    )}
                    <Row
                      label={`Tax (${Math.round(taxRate * 100)}%)`}
                      value={formatPrice(tax, currency)}
                    />
                    <Separator className="my-2 bg-muted" />
                    <div className="flex items-center justify-between">
                      <span className="font-bold">Total</span>
                      <span className="font-bold text-lg">
                        {formatPrice(grandTotal, currency)}
                      </span>
                    </div>
                    {estimatedPrep > 0 && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
                        <Clock className="size-3.5" />
                        <span>
                          Estimated prep time ~{estimatedPrep} min
                        </span>
                      </div>
                    )}
                  </div>
                  {(() => {
                    const activeEntry = queueEntries.find((e) => e.state === 'pending' || e.state === 'submitting')
                    const busy = Boolean(activeEntry)
                    const isRetrying = Boolean(activeEntry && activeEntry.attempts > 0)

                    return (
                      <div className="space-y-2">
                        {isRetrying && (
                          <p className="text-center text-xs text-amber-600 dark:text-amber-400 py-1 font-medium">
                            Order pending, reconnecting…
                          </p>
                        )}
                        <Button
                          onClick={placeOrder}
                          disabled={busy || cart.length === 0}
                          className="w-full h-12 text-white text-base font-semibold rounded-2xl shadow-sm transition active:scale-[0.99]"
                          style={{ background: CORAL }}
                        >
                          {busy ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              Placing order…
                            </>
                          ) : (
                            <>Place Order · {formatPrice(grandTotal, currency)}</>
                          )}
                        </Button>
                      </div>
                    )
                  })()}
                </div>
              </>
            )}
          </SheetContent>
        </Sheet>

        {/* Bill dialog modal */}
        <BillDialog
          orderId={billOrderId}
          open={billOpen}
          onOpenChange={setBillOpen}
          sessionToken={sessionToken}
          refreshKey={billRefreshKey}
        />
      </div>
    </div>
  )
}

// ---------- Sub-components ----------
export function CategoryPill({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-xs font-semibold transition-all',
        active
          ? 'text-white shadow-sm'
          : 'bg-card text-foreground border border-border hover:bg-card-elevated'
      )}
      style={active ? { background: CORAL } : undefined}
    >
      <span className="text-sm leading-none">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

export function MenuItemCard({
  item,
  currency,
  inCartQty,
  itemLines = [],
  onAdd,
  onDecrement,
  onAddPortion,
  onDecrementPortion,
}: {
  item: MenuItem
  currency: string
  inCartQty: number
  itemLines?: CartItem[]
  onAdd: () => void
  onDecrement: () => void
  onAddPortion?: (portion: MenuPortion) => void
  onDecrementPortion?: (portion: MenuPortion) => void
}) {
  const tags = parseTags(item.tags)
  const portions = useMemo(() => normalizePortions(item.portions), [item.portions])
  const [selectedPortionId, setSelectedPortionId] = useState<string>(() => portions[0]?.id ?? '')
  const activePortion =
    portions.find((p) => p.id === selectedPortionId) ?? portions[0] ?? null
  const activeLine = activePortion
    ? itemLines.find((c) => sameCartLine(c, item.id, activePortion.name, activePortion.id))
    : undefined
  const activeQty = activePortion ? (activeLine?.quantity ?? 0) : inCartQty
  const displayPrice = activePortion ? activePortion.price : item.price
  return (
    <article className="flex gap-3 rounded-2xl bg-card p-3 shadow-sm border border-border hover:shadow-md transition-shadow">
      {/* Image */}
      <div className="relative shrink-0">
        {item.image ? (
          <img
            src={item.image}
            alt={item.name}
            className="size-20 sm:size-22 rounded-xl object-cover ring-1 ring-black/5"
            loading="lazy"
          />
        ) : (
          <div className="size-20 rounded-xl bg-card-elevated flex items-center justify-center">
            <Utensils className="size-6 text-muted-foreground" />
          </div>
        )}
        {item.rating >= 4.7 && (
          <span className="absolute -top-1 -left-1 rounded-full bg-amber-400 text-white text-[9px] font-bold px-1.5 py-0.5 shadow-sm flex items-center gap-0.5">
            <Star className="size-2.5 fill-current" />
            Top
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-sm leading-snug line-clamp-2">
            {item.name}
          </h3>
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
            {item.description}
          </p>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-0.5">
            <Star className="size-3 fill-amber-400 text-amber-400" />
            <span className="font-semibold text-foreground">
              {item.rating.toFixed(1)}
            </span>
          </span>
          <span className="inline-flex items-center gap-0.5">
            <Clock className="size-3" />
            {item.prepTime}m
          </span>
          {item.calories ? (
            <span className="inline-flex items-center gap-0.5">
              <Flame className="size-3" />
              {item.calories} cal
            </span>
          ) : null}
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tags.slice(0, 3).map((t) => {
              const meta = tagMeta(t)
              return (
                <span key={t} className={meta.cls}>
                  {meta.icon}
                  {meta.label}
                </span>
              )
            })}
          </div>
        )}

        {/* Portion selector pills — customer picks portion before adding */}
        {portions.length > 0 && activePortion && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`Select portion for ${item.name}`}>
            {portions.map((p) => {
              const selected = p.id === activePortion.id
              const pQty =
                itemLines.find((c) => sameCartLine(c, item.id, p.name, p.id))?.quantity ?? 0
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPortionId(p.id)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-all',
                    selected
                      ? 'text-white shadow-xs'
                      : 'border-border bg-card-elevated text-foreground hover:border-primary/40',
                  )}
                  style={selected ? { background: CORAL, borderColor: CORAL } : undefined}
                >
                  <span>{p.name}</span>
                  {pQty > 0 && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-px text-[10px] font-bold',
                        selected ? 'bg-white/25 text-white' : 'bg-primary/15 text-primary',
                      )}
                    >
                      ×{pQty}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Price + action */}
        <div className="mt-auto pt-2 flex items-center justify-between">
          <span className="font-bold text-base text-foreground tabular-nums">
            {formatPrice(displayPrice, currency)}
          </span>
          {activeQty === 0 ? (
            <button
              onClick={() => {
                if (activePortion) {
                  onAddPortion?.(activePortion)
                } else {
                  onAdd()
                }
              }}
              className="size-8 rounded-full text-white shadow-sm flex items-center justify-center transition-transform active:scale-90"
              style={{ background: CORAL }}
              aria-label={
                activePortion
                  ? `Add ${item.name} (${activePortion.name}) to cart`
                  : `Add ${item.name} to cart`
              }
            >
              <Plus className="size-4" />
            </button>
          ) : (
            <div
              className="flex items-center gap-1 rounded-full p-1 text-white"
              style={{ background: CORAL }}
            >
              <button
                onClick={() => {
                  if (activePortion) {
                    onDecrementPortion?.(activePortion)
                  } else {
                    onDecrement()
                  }
                }}
                className="size-7 rounded-full bg-card/20 flex items-center justify-center transition active:scale-90"
                aria-label="Decrease quantity"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="min-w-5 text-center text-xs font-bold tabular-nums">
                {activeQty}
              </span>
              <button
                onClick={() => {
                  if (activePortion) {
                    onAddPortion?.(activePortion)
                  } else {
                    onAdd()
                  }
                }}
                className="size-7 rounded-full bg-card/20 flex items-center justify-center transition active:scale-90"
                aria-label="Increase quantity"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

export function CartLine({
  item,
  currency,
  onAdd,
  onDecrement,
  onRemove,
  onNotesChange,
}: {
  item: CartItem
  currency: string
  onAdd: () => void
  onDecrement: () => void
  onRemove: () => void
  onNotesChange: (n: string) => void
}) {
  const lineTotal = item.price * item.quantity
  return (
    <div className="rounded-2xl bg-card p-3 border border-border">
      <div className="flex gap-3">
        <div className="shrink-0">
          {item.image ? (
            <img
              src={item.image}
              alt={item.name}
              className="size-14 rounded-lg object-cover ring-1 ring-black/5"
            />
          ) : (
            <div className="size-14 rounded-lg bg-card-elevated flex items-center justify-center">
              <Utensils className="size-5 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h4 className="text-sm font-semibold leading-snug line-clamp-1">
              {item.name}
              {item.portion && (
                <span
                  className="ml-1.5 rounded-full border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-950/40 px-1.5 py-px text-[10px] font-semibold text-orange-700 dark:text-orange-300 align-middle"
                >
                  {item.portion}
                </span>
              )}
            </h4>
            <button
              onClick={onRemove}
              className="shrink-0 text-muted-foreground hover:text-red-500 transition"
              aria-label="Remove item"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground font-medium mt-0.5">
            {formatPrice(item.price, currency)} each
          </p>

          <div className="mt-2 flex items-center justify-between">
            <div
              className="flex items-center gap-1 rounded-full p-0.5 text-white"
              style={{ background: CORAL }}
            >
              <button
                onClick={onDecrement}
                className="size-7 rounded-full bg-card/20 flex items-center justify-center transition active:scale-90"
                aria-label="Decrease quantity"
              >
                <Minus className="size-3.5" />
              </button>
              <span className="min-w-6 text-center text-xs font-bold tabular-nums">
                {item.quantity}
              </span>
              <button
                onClick={onAdd}
                className="size-7 rounded-full bg-card/20 flex items-center justify-center transition active:scale-90"
                aria-label="Increase quantity"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <span className="font-bold text-sm text-foreground tabular-nums">{formatPrice(lineTotal, currency)}</span>
          </div>
        </div>
      </div>

      <Textarea
        value={item.notes || ''}
        onChange={(e) => onNotesChange(e.target.value)}
        placeholder="Add notes (no onions, extra spicy…)"
        className="mt-3 min-h-9 text-xs rounded-lg bg-background text-foreground placeholder:text-muted-foreground/80 border-border focus-visible:ring-primary/30 focus-visible:border-primary resize-none"
        rows={1}
      />
    </div>
  )
}

function EmptyCart({ onClose }: { onClose: () => void }) {
  return (
    <div className="py-16 px-6 text-center relative">
      <button
        onClick={onClose}
        className="absolute top-4 right-4 size-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted transition"
        aria-label="Close cart"
      >
        <X className="size-4" />
      </button>
      <div
        className="mx-auto size-16 rounded-2xl flex items-center justify-center bg-orange-50 dark:bg-orange-950/40 border border-orange-200/80 dark:border-orange-500/25 text-orange-600 dark:text-orange-400"
      >
        <ShoppingBag className="size-7 text-primary" />
      </div>
      <h3 className="mt-4 text-lg font-bold">Your cart is empty</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Add a few dishes from the menu to get started.
      </p>
      <Button
        onClick={onClose}
        className="mt-6 w-full text-white"
        style={{ background: CORAL }}
      >
        Browse menu
      </Button>
    </div>
  )
}

function SuccessView({
  order,
  tableName,
  estimatedPrep,
  currency,
  onClose,
}: {
  order: PlacedOrder
  tableName?: string
  estimatedPrep: number
  currency: string
  onClose: () => void
}) {
  // The tick is green: this is a finished thing, not an action to take, and
  // coral is the colour of every button on the page.
  const lines = order.items ?? []

  return (
    // A column that scrolls its own body and keeps the button put. The
    // confirmation used to sit directly in the sheet's 92vh box with nothing to
    // scroll, so on a phone a longer order — or simply a long list of items —
    // was cut off at the bottom with no way to reach it.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-6 pt-10 pb-8 text-center flex flex-col items-center">
          {/* Check animation */}
          <div className="relative shrink-0">
            <div
              className="absolute inset-0 rounded-full animate-ping opacity-25"
              style={{ background: CONFIRMED_GREEN }}
            />
            <div
              className="relative size-20 rounded-full flex items-center justify-center shadow-lg"
              style={{ background: CONFIRMED_GREEN }}
            >
              <Check className="size-10 text-white" strokeWidth={3} />
            </div>
          </div>

          <h2 className="mt-6 text-2xl font-bold">Order Confirmed!</h2>
          <p className="mt-2 text-sm text-muted-foreground max-w-[280px]">
            The kitchen has received your order and will start preparing it right
            away.
          </p>

          <div className="mt-6 w-full rounded-2xl bg-card p-4 border border-border text-left space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">Order number</span>
              <span className="font-bold text-base text-foreground">#{order.orderNumber}</span>
            </div>
            {tableName && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground font-medium">Table</span>
                <span className="font-semibold text-sm text-foreground">{tableName}</span>
              </div>
            )}

            {/* What was actually ordered. Names wrap rather than clip, and the
                price stays on the right. */}
            {lines.length > 0 && (
              <>
                <Separator className="bg-muted" />
                <div className="space-y-2">
                  {lines.map((line, i) => (
                    <div key={line.id ?? `${line.name}-${i}`} className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0 flex-1 text-foreground">
                        <span className="text-foreground/80 font-semibold">{line.quantity}× </span>
                        <span className="break-words font-medium">{line.name}</span>
                        {line.portion && (
                          <span className="ml-1.5 rounded bg-primary/10 border border-primary/20 px-1 py-px text-[10px] font-semibold text-primary align-middle">
                            {line.portion}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-foreground font-semibold tabular-nums whitespace-nowrap">
                        {formatPrice(line.price * line.quantity, currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <Separator className="bg-muted" />
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground/80">Total</span>
              <span className="font-bold text-base text-foreground tabular-nums">
                {formatPrice(order.total, currency)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">Estimated prep time</span>
              <span className="font-semibold text-sm text-foreground inline-flex items-center gap-1">
                <Clock className="size-3.5 text-primary" />
                ~{estimatedPrep || 20} min
              </span>
            </div>
          </div>

          <div className="mt-4 w-full rounded-2xl bg-orange-50 dark:bg-orange-950/40 border border-orange-200/80 dark:border-orange-500/25 p-3 text-xs text-orange-950 dark:text-orange-100 flex items-start gap-2.5">
            <Clock className="size-3.5 mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
            <span className="leading-relaxed font-medium">
              Your order status will be updated by the kitchen. Sit tight — your
              meal is on the way!
            </span>
          </div>
        </div>
      </div>

      {/* Always reachable, however long the order is. The bottom padding clears
          the home indicator on a phone. */}
      <div className="shrink-0 border-t border-border px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-background">
        <Button
          onClick={onClose}
          className="w-full h-12 text-white text-base font-semibold rounded-2xl"
          style={{ background: CORAL }}
        >
          Done
        </Button>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  )
}

/**
 * The thank-you note that sits beside the bill action on the session-ended
 * screen.
 *
 * It carries one fact the diner cannot act on later: the bill is downloadable
 * now and may not be afterwards. The session token is what authorises that
 * download, and the token dies with the session — so the line is true, and it
 * belongs next to the button that does it rather than in a footnote.
 */
function BillReminder({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-50/60 px-3.5 py-3 text-left',
        'dark:border-amber-500/20 dark:bg-amber-500/10',
        className,
      )}
    >
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <Heart className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[12.5px] font-semibold leading-snug text-foreground">
          Thanks for dining with us! ❤️
        </p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Please download your bill for your records, as it may not be available after your session ends.
        </p>
      </div>
    </div>
  )
}

function SessionReviewCard({
  sessionToken,
  onViewBill,
}: {
  sessionToken: string | null
  onViewBill?: () => void
}) {
  const [rating, setRating] = useState<number>(5)
  const [hoverRating, setHoverRating] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [name, setName] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const RATING_LABELS: Record<number, string> = {
    1: 'Disappointed 🙁',
    2: 'Could be better 😐',
    3: 'Good experience 👍',
    4: 'Very good! Loved it 😊',
    5: 'Outstanding! Excellent ⭐',
  }

  const QUICK_TAGS = [
    'Delicious Food 🍕',
    'Quick Service ⚡',
    'Great Ambience ✨',
    'Friendly Staff 👏',
    'Value for Money 💰',
    'Clean & Safe 🌿',
  ]

  const activeRating = hoverRating ?? rating

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!sessionToken) {
      toast.error('Your table session has ended. Please scan the QR code on your table again.')
      return
    }
    setSubmitting(true)
    try {
      const res = await edgeFetch('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // The session token is the proof a real diner sat at this table;
          // the server derives tenant, table and session from it.
          tableSessionToken: sessionToken,
          rating,
          authorName: name.trim() || undefined,
          comment: comment.trim() || undefined,
          tags: selectedTags,
        }),
      })
      if (!res.ok) {
        // Surface the server's reason (duplicate, collection paused) rather
        // than hiding it behind the generic toast.
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Failed to submit review')
      }
      setSubmitted(true)
      toast.success('Thank you for rating and reviewing your experience!')
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      toast.error(message && message !== 'Failed to submit review' ? message : 'Could not submit review. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleViewBill = () => {
    // The parent always supplies onViewBill, which opens the in-app BillDialog
    // with the session token attached. The old fallback used window.open on
    // /api/bill/<id>, which could not carry auth and opened raw JSON in a tab.
    if (onViewBill) {
      onViewBill()
      return
    }
    toast.info('Open the bill from the session screen')
  }


  if (submitted) {
    return (
      <div className="mt-5 w-full rounded-2xl bg-amber-50/70 border border-amber-500/25/70 p-5 text-center animate-in fade-in zoom-in-95 duration-300">
        <div className="size-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto text-emerald-600 mb-2 shadow-xs">
          <Check className="size-6" />
        </div>
        <h3 className="font-bold text-base text-foreground">Review Submitted!</h3>
        <div className="flex items-center justify-center gap-1 my-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <Star
              key={star}
              className={cn(
                'size-5 transition-all',
                star <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground'
              )}
            />
          ))}
        </div>
        <p className="text-xs text-foreground leading-relaxed max-w-xs mx-auto">
          Thank you for sharing your feedback! We truly appreciate you dining with us and hope to welcome you back soon.
        </p>
        <BillReminder className="mt-4" />
        <div className="mt-3 pt-3 border-t border-amber-500/25/50">
          <button
            type="button"
            onClick={handleViewBill}
            className="text-xs font-semibold text-muted-foreground hover:text-foreground underline transition-colors cursor-pointer"
          >
            View Bill
          </button>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-5 w-full text-left bg-muted/90 rounded-2xl p-4 border border-border/80 shadow-xs"
    >
      <div className="text-center mb-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Rate your experience
        </p>
        {/* Star rating buttons */}
        <div className="flex items-center justify-center gap-1.5 mt-2">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              onMouseEnter={() => setHoverRating(star)}
              onMouseLeave={() => setHoverRating(null)}
              onClick={() => setRating(star)}
              className="p-1 rounded-lg hover:scale-125 active:scale-95 transition-all focus:outline-hidden cursor-pointer"
              aria-label={`${star} star`}
            >
              <Star
                className={cn(
                  'size-7 transition-colors drop-shadow-xs',
                  star <= activeRating
                    ? 'fill-amber-400 text-amber-400'
                    : 'text-muted-foreground hover:text-amber-200'
                )}
              />
            </button>
          ))}
        </div>
        <p className="text-xs font-medium text-amber-600 h-4 mt-1 transition-all">
          {RATING_LABELS[activeRating] || ''}
        </p>
      </div>

      {/* Quick feedback tags */}
      <div className="mb-3">
        <p className="text-[11px] text-muted-foreground font-medium mb-1.5">What did you like most?</p>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_TAGS.map((tag) => {
            const isSelected = selectedTags.includes(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] font-medium border transition-all cursor-pointer',
                  isSelected
                    ? 'bg-amber-100 text-amber-900 border-amber-300 shadow-xs scale-102 font-semibold'
                    : 'bg-card text-foreground border-border hover:border-slate-300'
                )}
              >
                {tag}
              </button>
            )
          })}
        </div>
      </div>

      {/* Comment text area */}
      <div className="space-y-2 mb-3">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Share your thoughts about the food or service..."
          rows={2}
          maxLength={500}
          className="w-full text-xs rounded-xl border border-border bg-card p-2.5 text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-amber-400/50 resize-none"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name (optional)"
          maxLength={50}
          className="w-full text-xs rounded-xl border border-border bg-card px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-amber-400/50"
        />
      </div>

      {/* Submit Button */}
      <Button
        type="submit"
        disabled={submitting}
        className="w-full rounded-xl bg-[#1a1d29] hover:bg-black text-white text-xs font-semibold py-2.5 shadow-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer"
      >
        {submitting ? (
          <>
            <Loader2 className="size-3.5 animate-spin" />
            Submitting review…
          </>
        ) : (
          <>
            <Star className="size-3.5 fill-amber-400 text-amber-400" />
            Submit Review
          </>
        )}
      </Button>

      <BillReminder className="mt-3" />

      {/* View Bill option */}
      <div className="mt-3 text-center">
        <button
          type="button"
          onClick={handleViewBill}
          className="text-xs text-muted-foreground hover:text-foreground underline transition-colors cursor-pointer"
        >
          View Bill
        </button>
      </div>
    </form>
  )
}

