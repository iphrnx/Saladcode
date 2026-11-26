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
import { formatCurrency } from '@/lib/constants'
import { normalizePortions, normalizePortionKey, type MenuPortion } from '@/lib/portions'
import { orderQueue, startOrderQueue, cleanOrderErrorMessage, type QueueEntry } from '@/lib/order-queue'
import { persistPosCart, restorePosCart, clearPosCart, getPosSessionDraft, savePosSessionDraft, clearPosSessionDraft, subtractPosSessionDraft, subtractLinesFromCart, saveRecoverablePosDraft, getRecoverablePosDrafts, clearRecoverablePosDraft, subtractRecoverablePosDraft, tryRecoverDraftToUnattachedCart, isRecoveryConsumed, resolveSessionLifecycle, savePosActiveSessionId, getPosActiveSessionId, clearPosActiveSessionId, type RecoverablePosDraft } from '@/lib/pos-cart'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { StatusBadge, OrderTypeBadge, Tag } from '@/components/shared/badges'
import { Search, Plus, Minus, Trash2, ShoppingBag, X, Check, CreditCard, Ticket, Clock, LogOut, Loader2, Receipt, Maximize2, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'

function formatElapsed(date: Date | string | undefined | null): { text: string; mins: number } {
  if (!date) return { text: '', mins: 0 }
  const time = new Date(date).getTime()
  if (isNaN(time)) return { text: '', mins: 0 }
  const diff = Date.now() - time
  if (diff < 0) return { text: 'just now', mins: 0 }
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return { text: '<1m ago', mins: 0 }
  if (mins < 60) return { text: `${mins}m ago`, mins }
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return { text: remMins > 0 ? `${hrs}h ${remMins}m ago` : `${hrs}h ago`, mins }
}

function getItemSummary(items: Array<{ name: string; quantity?: number }>): string {
  if (!items || items.length === 0) return 'No items'
  const firstItem = items[0]
  const otherCount = items.length - 1
  if (otherCount <= 0) {
    return firstItem.name
  }
  return `${firstItem.name} +${otherCount} item${otherCount === 1 ? '' : 's'}`
}

function getSessionIdentifier(
  tableName: string,
  customerName?: string | null,
  sessionNumber?: number | null,
  orderType?: string,
): string {
  const custName = (customerName || '').trim()
  const hasGuestName = custName && custName.toLowerCase() !== 'guest'

  if (orderType === 'TAKEAWAY') {
    if (hasGuestName) return `Takeaway · ${custName}`
    return sessionNumber ? `Takeaway · Diner ${sessionNumber}` : 'Takeaway'
  }
  if (orderType === 'DELIVERY') {
    if (hasGuestName) return `Delivery · ${custName}`
    return sessionNumber ? `Delivery · Diner ${sessionNumber}` : 'Delivery'
  }
  if (hasGuestName) {
    return `${tableName} · ${custName}`
  }
  if (sessionNumber) {
    return `${tableName} · Diner ${sessionNumber}`
  }
  return tableName
}

function ActiveSessionCard({
  card,
  isSelected,
  currencySymbol,
  onSelect,
  onClick,
  onUnload,
  className,
}: {
  card: any
  isSelected: boolean
  currencySymbol: string
  onSelect?: () => void
  onClick?: () => void
  onUnload: () => void
  className?: string
}) {
  const handleClick = onClick || onSelect
  return (
    <div
      data-active-session-card
      role="button"
      tabIndex={0}
      onClick={handleClick}
      className={cn(
        'w-56 shrink-0 rounded-2xl border bg-card p-3.5 text-left select-none transition-all cursor-pointer relative flex flex-col justify-between',
        isSelected
          ? 'ring-2 ring-primary border-primary bg-primary/5 shadow-sm'
          : card.statusTone === 'orange'
            ? 'border-orange-500/40 hover:border-orange-500/70'
            : card.statusTone === 'amber'
              ? 'border-amber-500/40 hover:border-amber-500/70'
              : card.statusTone === 'emerald'
                ? 'border-emerald-500/30 hover:border-emerald-500/60'
                : card.statusTone === 'blue'
                  ? 'border-blue-500/40 hover:border-blue-500/70'
                  : card.statusTone === 'purple'
                    ? 'border-purple-500/40 hover:border-purple-500/70'
                    : 'border-border/80 hover:border-border',
        className
      )}
    >
      <div>
        {/* Zone 1: Header */}
        <div className="flex items-center justify-between gap-1.5">
          <p className="truncate font-semibold text-foreground text-xs sm:text-[13px]" title={card.compactIdentifier || card.tableName}>
            {card.compactIdentifier || card.tableName}
          </p>
          <div className="flex items-center gap-1 shrink-0">
            {card.elapsedText && (
              <span
                className={cn(
                  'text-[10px]',
                  card.elapsedMinutes > 45
                    ? 'text-rose-600 dark:text-rose-400 font-semibold'
                    : card.elapsedMinutes > 25
                      ? 'text-amber-600 dark:text-amber-400 font-medium'
                      : 'text-muted-foreground'
                )}
                title={card.lastActivityAt ? new Date(card.lastActivityAt).toLocaleTimeString() : undefined}
              >
                {card.elapsedText}
              </span>
            )}
            {isSelected && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onUnload()
                }}
                className="text-primary hover:text-primary-hover hover:bg-primary/10 rounded p-0.5 transition-colors"
                title="Unload session"
                aria-label="Unload session"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Zone 2: Dynamic Status Pill */}
        <div className="mt-1.5 flex items-center justify-between gap-1">
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold border',
              card.statusStage === 'New KOT'
                ? 'bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/25'
                : card.statusStage === 'Preparing'
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25'
                  : card.statusStage === 'Served'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25'
                    : card.statusStage === 'Bill Requested'
                      ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25 animate-pulse'
                      : card.statusStage === 'Verifying'
                        ? 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/25'
                        : 'bg-secondary text-muted-foreground border-transparent'
            )}
          >
            {card.statusLabel || card.statusStage}
          </span>
          <span className="text-[10px] text-muted-foreground truncate uppercase tracking-wider">
            {card.orderType === 'TAKEAWAY' ? 'Takeaway' : card.orderType === 'DELIVERY' ? 'Delivery' : 'Dine In'}
          </span>
        </div>

        {/* Zone 3: Context Line */}
        <p className="mt-2 text-[11px] text-muted-foreground truncate" title={card.itemSummary}>
          {isSelected ? (
            <span className="font-semibold text-primary">Editing in Cart</span>
          ) : (
            <>
              {card.area ? <span className="text-foreground/80 font-medium">{card.area} · </span> : ''}
              <span>{card.itemSummary}</span>
            </>
          )}
        </p>
      </div>

      {/* Zone 4: Smart Financial Footer */}
      <div className="mt-2.5 pt-2 border-t border-border/50">
        {card.isVerifyingPayment ? (
          <p className="text-[11px] font-medium text-purple-600 dark:text-purple-400 animate-pulse">
            Verifying payment...
          </p>
        ) : (
          <div>
            <p className="text-xs font-bold text-foreground">
              {formatCurrency(card.outstanding, currencySymbol)} due
            </p>
            {card.paid > 0 && card.paid < card.total && (
              <p className="text-[10.5px] text-muted-foreground mt-0.5">
                {formatCurrency(card.paid, currencySymbol)} paid of {formatCurrency(card.total, currencySymbol)}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function DashboardView() {
  const tr = useT()
  const { data, refresh, sessionRevision, tableSessions, checks } = useApp()
  const { denied, handleLoad, handleAction } = useAccessDenied()
  const { cart, addToCart, updateCartQty, removeFromCart, setCartNotes, clearCart, replaceCart, hydrateCart, subtractCartLines, orderType, setOrderType, selectedTableId, setSelectedTableId, selectedSessionId, setSelectedSessionId, setSessionContext, promoCode, setPromoCode } = useStore()
  const [activeCat, setActiveCat] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [lastOrder, setLastOrder] = useState<any>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [appliedPromo, setAppliedPromo] = useState<any | null>(null)
  const [promoQuote, setPromoQuote] = useState<any | null>(null)
  const [promoError, setPromoError] = useState('')
  const [promoChecking, setPromoChecking] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([])
  // Mirrors "a checkout is in flight" synchronously — see submitOrder.
  const submittingRef = useRef(false)
  const [offline, setOffline] = useState(false)
  const [forceNewSitting, setForceNewSitting] = useState(false)
  const [activeSessionsModalOpen, setActiveSessionsModalOpen] = useState(false)
  const [modalSearch, setModalSearch] = useState('')
  const [modalZoneFilter, setModalZoneFilter] = useState('all')
  const [tick, setTick] = useState(0)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [refreshingCart, setRefreshingCart] = useState(false)
  const [recoverableDrafts, setRecoverableDrafts] = useState<RecoverablePosDraft[]>([])

  const refreshCartPricing = useCallback(async (providedData?: any) => {
    setRefreshingCart(true)
    try {
      const fresh = providedData !== undefined ? providedData : await refresh()
      // If the response is null or lacks usable menu data, report a refresh failure before calling replaceCart()
      if (!fresh || !Array.isArray(fresh.menuItems)) {
        throw new Error('Could not load authoritative menu data. Please retry.')
      }

      const freshMenu = fresh.menuItems
      const currentCart = useStore.getState().cart
      let anyUnavailable = false
      const updatedCart = currentCart.map((c) => {
        const mi = freshMenu.find((m: any) => m.id === c.menuItemId)
        if (!mi || mi.available === false) {
          anyUnavailable = true
          return {
            ...c,
            unavailable: true,
            unavailableReason: !mi ? 'Item removed from menu' : 'Item is currently unavailable',
          }
        }
        if (c.portionId || c.portion) {
          const normPortions = normalizePortions(mi.portions)
          const matchedPortion = normPortions.find(
            (p: any) =>
              (c.portionId && p.id === c.portionId) ||
              normalizePortionKey(p.name) === normalizePortionKey(c.portion),
          )
          if (!matchedPortion) {
            anyUnavailable = true
            return {
              ...c,
              unavailable: true,
              unavailableReason: `Portion "${c.portion || 'Selected'}" is no longer available`,
            }
          }
          return {
            ...c,
            price: matchedPortion.price,
            portionId: matchedPortion.id,
            portion: matchedPortion.name,
            unavailable: false,
            unavailableReason: undefined,
          }
        }
        return {
          ...c,
          price: mi.price,
          unavailable: false,
          unavailableReason: undefined,
        }
      })
      replaceCart(updatedCart)
      setRefreshError(null)
      return { ok: true, anyUnavailable }
    } catch (err: any) {
      const errMsg = err?.message || 'Failed to refresh menu prices'
      setRefreshError(errMsg)
      return { ok: false, error: errMsg }
    } finally {
      setRefreshingCart(false)
    }
  }, [refresh, replaceCart])

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 15000)
    return () => clearInterval(timer)
  }, [])

  // Synchronize configured default order type when starting a new session or loading settings
  const defaultOrderType = data?.settings?.pref_default_order_type as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | undefined
  const defaultOrderTypeAppliedRef = useRef(false)
  useEffect(() => {
    if (!defaultOrderTypeAppliedRef.current && defaultOrderType && ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(defaultOrderType)) {
      if (cart.length === 0) {
        setOrderType(defaultOrderType)
        defaultOrderTypeAppliedRef.current = true
      }
    }
  }, [defaultOrderType, cart.length, setOrderType])

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
        submittingRef.current = false
        setLastOrder(order)
        const originSessionId = entry.payload.tableSessionId ?? null
        const currentSessionId = useStore.getState().selectedSessionId ?? null
        const submittedLines = entry.payload.items ?? []

        if (currentSessionId === originSessionId) {
          subtractCartLines(submittedLines)
          setPromoCode('')
          setAppliedPromo(null)
          setPromoQuote(null)
          setPromoError('')
          const remainingCart = useStore.getState().cart
          if (remainingCart.length === 0) {
            if (tenantId && userId) {
              clearPosSessionDraft(tenantId, userId, originSessionId)
              if (originSessionId) {
                clearPosActiveSessionId(tenantId, userId)
              }
            }
            if (originSessionId) {
              // Confirming the last item of a sitting restores the cashier's unattached cart
              // before the persistence effect runs, preventing it from being overwritten with [].
              const pre = preSelectSnapshotRef.current ?? (tenantId && userId ? getPosSessionDraft(tenantId, userId, null) : null)
              if (pre) {
                replaceCart(pre.cart)
                setSessionContext(pre.selectedTableId, null, pre.orderType)
                setCustomerName(pre.customerName ?? '')
                setCustomerPhone(pre.customerPhone ?? '')
                setPromoCode(pre.promoCode ?? '')
              } else {
                setSelectedSessionId(null)
                setSelectedTableId(null)
                setCustomerName('')
                setCustomerPhone('')
                setPromoCode('')
                replaceCart([])
              }
              preSelectSnapshotRef.current = null
            } else {
              setSelectedSessionId(null)
              setSelectedTableId(null)
              setCustomerName('')
              setCustomerPhone('')
            }
          }
          setCartOpen(false)
        } else {
          // Cashier switched to another cart/session while this order was in flight:
          // clear only the submitted lines from the originating draft without disturbing active work.
          if (tenantId && userId) {
            subtractPosSessionDraft(tenantId, userId, originSessionId, submittedLines)
            if (originSessionId && getPosActiveSessionId(tenantId, userId) === originSessionId) {
              clearPosActiveSessionId(tenantId, userId)
            }
          }
          if (!originSessionId && preSelectSnapshotRef.current) {
            const remainingPre = subtractLinesFromCart(preSelectSnapshotRef.current.cart, submittedLines)
            preSelectSnapshotRef.current = remainingPre.length > 0
              ? { ...preSelectSnapshotRef.current, cart: remainingPre }
              : null
          }
        }
        if (tenantId && userId && originSessionId) {
          subtractRecoverablePosDraft(tenantId, userId, originSessionId, submittedLines)
          setRecoverableDrafts(getRecoverablePosDrafts(tenantId, userId))
        }

        if (order.promoApplied === false && order.promoReason) {
          // The server is the authority on promos, and it can still decline a
          // code the cashier had already applied. Say so, or the customer is
          // charged full price on a total they were shown discounted.
          toast.error(`Promo not applied: ${order.promoReason}`, {
            description: `Order #${order.orderNumber} placed at full price.`,
            duration: 8000,
          })
        } else if (entry.payload.tableSessionId) {
          toast.success(`Order updated!`)
        } else {
          toast.success(`Order #${order.orderNumber} placed!`)
        }
        refresh()
      },
      onFailed: async (error, entry, code) => {
        submittingRef.current = false
        const msg = cleanOrderErrorMessage(error)
        const isPricingChanged =
          code === 'ORDER_PRICING_CHANGED' ||
          entry.errorCode === 'ORDER_PRICING_CHANGED' ||
          msg.toLowerCase().includes('pricing has changed') ||
          msg.toLowerCase().includes('totals and try again') ||
          msg.toLowerCase().includes('terms have changed')

        // Prevent automatic replay of the rejected payload
        q.retire(entry.key)

        if (isPricingChanged) {
          // Invalidate stale promo quote and require explicit re-application
          setAppliedPromo(null)
          setPromoQuote(null)
          setPromoError('Pricing has changed. Please review the updated totals and reapply the promo code if desired.')

          // Reopen cart sheet with updated totals
          setCartOpen(true)

          // Refresh affected cart lines from authoritative menu and portion prices
          // and refresh tax and service-charge settings.
          // Preserve quantities, selected portions, notes, customer details, and selected diner session.
          const res = await refreshCartPricing()
          if (!res.ok) {
            toast.error('Pricing changed, but refreshing menu prices failed', {
              description: 'Your cart has been preserved. Tap here to retry refreshing prices.',
              action: {
                label: 'Retry Refresh',
                onClick: () => { void refreshCartPricing() },
              },
              duration: 8000,
            })
          } else if (res.anyUnavailable) {
            toast.error('Pricing or availability changed', {
              description: 'One or more items in your cart are no longer available. Please resolve them before checking out.',
              duration: 8000,
            })
          } else {
            toast.error('Pricing has changed since review', {
              description: 'Cart totals have been updated to current menu prices. Please review and reapply the promo code.',
              duration: 6000,
            })
          }
          return
        }

        toast.error(`Order Failed: ${msg}`)
        if (
          msg.toLowerCase().includes('promo') ||
          msg.toLowerCase().includes('reapply')
        ) {
          setAppliedPromo(null)
          setPromoQuote(null)
          setPromoError(msg)
          setCartOpen(true)
        }
      },
      onChange: (entries) => {
        setQueueEntries(entries)
        submittingRef.current = entries.some(
          (e) => e.state === 'pending' || e.state === 'submitting',
        )
      },
    })
    q.retireAllFailed()
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
      if (snapshot?.cart?.length) {
        hydrateCart(snapshot)
        if (snapshot.customerName) setCustomerName(snapshot.customerName)
        if (snapshot.customerPhone) setCustomerPhone(snapshot.customerPhone)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, userId, cart.length])

  useEffect(() => {
    if (!tenantId || !userId) return
    savePosSessionDraft(tenantId, userId, selectedSessionId, {
      cart,
      orderType,
      selectedTableId,
      selectedSessionId,
      customerName,
      customerPhone,
      promoCode,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, orderType, selectedTableId, selectedSessionId, customerName, customerPhone, promoCode, tenantId, userId])

  const queueBusy = queueEntries.some((e) => e.state === 'pending' || e.state === 'submitting')

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
  const minOrder = Number(appliedPromo?.minOrder ?? appliedPromo?.min_order ?? 0)
  if (appliedPromo && subtotal >= minOrder) {
    const promoValue = Number(appliedPromo.value) || 0
    const promoType = appliedPromo.type
    const maxDiscount = Number(appliedPromo.maxDiscount ?? appliedPromo.max_discount ?? 0)

    if (promoType === 'PERCENTAGE') {
      discount = (subtotal * promoValue) / 100
      if (maxDiscount > 0) discount = Math.min(discount, maxDiscount)
    } else {
      discount = promoValue
      if (maxDiscount > 0) discount = Math.min(discount, maxDiscount)
    }
    discount = Math.min(subtotal, Math.max(0, discount)) // never go negative
  }
  // Round the capped discount to two decimals before calculating taxable amount, tax, and final total
  discount = +discount.toFixed(2)
  const taxableAmount = Math.max(0, +(subtotal - discount).toFixed(2))
  const tax = +((taxableAmount) * taxRate / 100).toFixed(2)
  const service = +((subtotal) * serviceRate / 100).toFixed(2)
  const total = +(taxableAmount + tax + service).toFixed(2)

  // If cart changes make an applied promo ineligible, clear it immediately
  useEffect(() => {
    if (appliedPromo) {
      const min = Number(appliedPromo.minOrder ?? appliedPromo.min_order ?? 0)
      if (subtotal < min) {
        setAppliedPromo(null)
        setPromoQuote(null)
        setPromoError(`Promo "${appliedPromo.code}" requires minimum order of ${tenant?.currencySymbol || '₹'}${min.toFixed(2)}`)
      }
    }
  }, [subtotal, appliedPromo, tenant?.currencySymbol])

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
      setPromoQuote(null)
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
        setPromoQuote(null)
        setPromoError(result.reason || tr('pos.promoInvalid'))
        toast.error(result.reason || tr('pos.promoInvalid'))
        return
      }

      setAppliedPromo(result.promo)
      setPromoQuote(result.quote || null)
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
      setPromoQuote(null)
      setPromoError(describeFailure(err, 'the promo code').message)
      handleAction(err, 'the promo code')
    } finally {
      setPromoChecking(false)
    }
  }

  const removePromo = () => {
    setAppliedPromo(null)
    setPromoQuote(null)
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
  const [billTable, setBillTable] = useState<{ id: string; name: string; checkId?: string | null } | null>(null)

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

  /**
   * Compact, dynamic active session cards with live state, order stage pills,
   * item summaries, and financial tracking.
   */
  const activeSessionCards = useMemo(() => {
    interface SessionCardItem {
      id: string
      sessionId?: string
      tableId: string | null
      tableName: string
      compactIdentifier: string
      area?: string
      orderType?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
      customerName?: string
      sessionNumber?: number | null
      total: number
      paid: number
      outstanding: number
      statusTone: 'orange' | 'amber' | 'emerald' | 'blue' | 'purple' | 'slate'
      statusStage: 'New KOT' | 'Preparing' | 'Served' | 'Bill Requested' | 'Verifying' | 'Open'
      statusLabel: string
      itemSummary: string
      items: Array<{ name: string; quantity: number; portion?: string | null; status?: string }>
      lastActivityAt: string | null
      elapsedMinutes: number
      elapsedText: string
      isVerifyingPayment: boolean
      isBillRequested: boolean
    }

    const cards: SessionCardItem[] = []
    const seenCheckIds = new Set<string>()
    const seenSessionIds = new Set<string>()

    // Pre-calculate count of unnamed sessions per order type to distinguish multiple unnamed sessions
    const unnamedCountByType: Record<string, number> = { TAKEAWAY: 0, DELIVERY: 0 }
    for (const group of sessions) {
      for (const s of (group.sessions || [])) {
        if (s.status === 'ACTIVE' && (s.orderType === 'TAKEAWAY' || s.orderType === 'DELIVERY' || !group.tableId)) {
          const type = (s.orderType || (group.tableId ? 'DINE_IN' : 'TAKEAWAY')) as 'TAKEAWAY' | 'DELIVERY'
          const name = (s.customerName || '').trim()
          if (!name || name.toLowerCase() === 'guest') {
            unnamedCountByType[type] = (unnamedCountByType[type] || 0) + 1
          }
        }
      }
    }
    const unnamedIndexByType: Record<string, number> = { TAKEAWAY: 0, DELIVERY: 0 }

    // 1. Live sessions from the active floor groups
    for (const group of sessions) {
      const live = (group.sessions || [])
        .filter((s: any) => s.status === 'ACTIVE')
        .sort((a: any, b: any) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
      const totalLiveAtTable = live.length

      live.forEach((s: any, idx: number) => {
        seenSessionIds.add(s.id)
        if (s.check?.id) seenCheckIds.add(s.check.id)

        // Totals strictly for this specific session or its own orders
        let total = 0
        let paid = 0
        let outstanding = 0

        const orders = s.order_rows || []
        const activeOrders = orders.filter((o: any) => o.status !== 'CANCELLED' && o.status !== 'PENDING_ACTIVATION')
        const ordersTotal = activeOrders.reduce((sum: number, o: any) => sum + Number(o.total || 0), 0)

        if (s.check) {
          total = Number(s.check.total || 0)
          paid = Number(s.check.paid_total || s.check.paid || 0)
          outstanding = Math.max(0, total - paid)
        } else {
          total = ordersTotal
          paid = 0
          outstanding = ordersTotal
        }

        // Exclude fully paid, completed, ended, or abandoned/scan-only empty sessions
        if (s.status === 'ENDED') return
        if (s.check?.status === 'PAID') return
        if (total > 0 && outstanding <= 0.01 && (s.check?.status === 'PAID' || (activeOrders.length > 0 && activeOrders.every((o: any) => o.status === 'COMPLETED')))) return
        if (total === 0 && activeOrders.length === 0) return

        // Correlate strictly with app orders belonging to this exact session
        const matchingAppOrders = (data?.orders || []).filter(
          (o: any) => o.tableSessionId === s.id && o.status !== 'CANCELLED' && o.status !== 'PENDING_ACTIVATION'
        )

        // Gather all dish items across orders
        const allItems: Array<{ name: string; quantity: number; portion?: string | null; status?: string }> = []
        const combinedOrderSources = matchingAppOrders.length > 0 ? matchingAppOrders : activeOrders
        for (const ord of combinedOrderSources) {
          if (Array.isArray(ord.items)) {
            for (const it of ord.items) {
              allItems.push({
                name: it.name,
                quantity: Number(it.quantity || 1),
                portion: it.portion,
                status: it.status || ord.status,
              })
            }
          }
        }
        const itemSummary = getItemSummary(allItems)

        // Elapsed time / last activity
        const lastActivityAt = s.lastSeenAt || s.updatedAt || s.createdAt || combinedOrderSources[0]?.createdAt || combinedOrderSources[0]?.created_at || null
        const elapsed = formatElapsed(lastActivityAt)

        // Payment verification and bill requested detection
        const isVerifyingPayment = Boolean(
          s.paymentVerificationPending ||
          (s.check && s.check.status === 'VERIFYING') ||
          combinedOrderSources.some((o: any) => o.payment_status === 'VERIFYING' || o.paymentStatus === 'PENDING_VERIFICATION')
        )
        const isBillRequested = Boolean(
          s.billRequested ||
          s.check?.status === 'UNSETTLED'
        )

        // Dynamic status pill
        let statusStage: 'New KOT' | 'Preparing' | 'Served' | 'Bill Requested' | 'Verifying' | 'Open' = 'Open'
        let statusTone: 'orange' | 'amber' | 'emerald' | 'blue' | 'purple' | 'slate' = 'slate'

        if (isVerifyingPayment) {
          statusStage = 'Verifying'
          statusTone = 'purple'
        } else if (isBillRequested) {
          statusStage = 'Bill Requested'
          statusTone = 'blue'
        } else if (s.activationStatus === 'PENDING' || orders.some((o: any) => o.status === 'PENDING' || o.status === 'PENDING_ACTIVATION') || matchingAppOrders.some((o: any) => o.status === 'PENDING' || o.status === 'PENDING_ACTIVATION')) {
          statusStage = 'New KOT'
          statusTone = 'orange'
        } else if (combinedOrderSources.some((o: any) => o.status === 'CONFIRMED' || o.status === 'PREPARING')) {
          statusStage = 'Preparing'
          statusTone = 'amber'
        } else if (combinedOrderSources.length > 0 && combinedOrderSources.every((o: any) => o.status === 'READY' || o.status === 'SERVED' || o.status === 'COMPLETED')) {
          statusStage = 'Served'
          statusTone = 'emerald'
        } else if (outstanding > 0) {
          statusStage = 'Open'
          statusTone = 'amber'
        } else {
          statusStage = 'Open'
          statusTone = 'slate'
        }

        const isTakeawayOrDelivery = s.orderType === 'TAKEAWAY' || s.orderType === 'DELIVERY' || !group.tableId
        const derivedOrderType = (s.orderType || (group.tableId ? 'DINE_IN' : 'TAKEAWAY')) as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
        const rawCustName = (s.customerName || '').trim()
        const isGuest = !rawCustName || rawCustName.toLowerCase() === 'guest'

        let sessionNumber: number | null = null
        let displayName = ''

        if (isTakeawayOrDelivery) {
          const typeLabel = derivedOrderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery'
          if (!isGuest) {
            displayName = `${typeLabel} · ${rawCustName}`
          } else {
            displayName = `${typeLabel} · Guest`
            const totalUnnamed = unnamedCountByType[derivedOrderType] || 0
            if (totalUnnamed > 1) {
              unnamedIndexByType[derivedOrderType] = (unnamedIndexByType[derivedOrderType] || 0) + 1
              sessionNumber = unnamedIndexByType[derivedOrderType]
            }
          }
        } else {
          displayName = group.table?.name || 'Table'
          sessionNumber = totalLiveAtTable > 1 && group.tableId ? idx + 1 : null
        }

        const compactIdentifier = getSessionIdentifier(displayName, s.customerName, sessionNumber, derivedOrderType)

        cards.push({
          id: `sess-${s.id}`,
          sessionId: s.id,
          tableId: group.tableId ?? null,
          tableName: displayName,
          compactIdentifier,
          orderType: derivedOrderType,
          customerName: s.customerName,
          area: isTakeawayOrDelivery ? (derivedOrderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery') : group.table?.area,
          sessionNumber,
          total: +total.toFixed(2),
          paid: +paid.toFixed(2),
          outstanding: +outstanding.toFixed(2),
          statusTone,
          statusStage,
          statusLabel: statusStage,
          itemSummary,
          items: allItems,
          lastActivityAt,
          elapsedMinutes: elapsed.mins,
          elapsedText: elapsed.text,
          isVerifyingPayment,
          isBillRequested,
        })
      })
    }

    // 2. Pending bills that don't have an active session (e.g. sitting ended unpaid)
    for (const b of pendingBills) {
      if (b.checkId && seenCheckIds.has(b.checkId)) continue
      if (b.sessionId && seenSessionIds.has(b.sessionId)) continue
      if (Number(b.outstanding || 0) <= 0.01) continue
      if (b.status === 'PAID' || b.status === 'VOID') continue

      const alreadyRepresented = cards.some(
        (c) =>
          (b.checkId && c.id === `bill-${b.checkId}`) ||
          (b.sessionId && c.sessionId === b.sessionId)
      )
      if (alreadyRepresented) continue

      const isTakeawayOrDelivery = b.orderType === 'TAKEAWAY' || b.orderType === 'DELIVERY' || !b.tableId
      const derivedOrderType = (b.orderType || (b.tableId ? 'DINE_IN' : 'TAKEAWAY')) as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
      const rawCustName = (b.customerName || '').trim()
      const isGuest = !rawCustName || rawCustName.toLowerCase() === 'guest'
      const typeLabel = derivedOrderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery'
      const displayName = isTakeawayOrDelivery
        ? (!isGuest ? `${typeLabel} · ${rawCustName}` : `${typeLabel} · Guest`)
        : (b.tableName || 'Table')

      const matchingAppOrders = (data?.orders || []).filter(
        (o: any) =>
          (b.checkId ? o.checkId === b.checkId : (b.sessionId ? o.tableSessionId === b.sessionId : false)) &&
          o.status !== 'CANCELLED' &&
          o.status !== 'PENDING_ACTIVATION'
      )
      const allItems: Array<{ name: string; quantity: number; portion?: string | null; status?: string }> = []
      for (const ord of matchingAppOrders) {
        if (Array.isArray(ord.items)) {
          for (const it of ord.items) {
            allItems.push({
              name: it.name,
              quantity: Number(it.quantity || 1),
              portion: it.portion,
              status: it.status || ord.status,
            })
          }
        }
      }
      const itemSummary = getItemSummary(allItems)
      const lastActivityAt = b.openedAt || null
      const elapsed = formatElapsed(lastActivityAt)
      const compactIdentifier = getSessionIdentifier(displayName, b.customerName, null, derivedOrderType)
      const statusStage = b.status === 'UNSETTLED' ? 'Bill Requested' : 'Open'

      cards.push({
        id: `bill-${b.checkId || b.tableId || b.sessionId}`,
        sessionId: b.sessionId ?? undefined,
        tableId: b.tableId ?? null,
        tableName: displayName,
        compactIdentifier,
        orderType: derivedOrderType,
        customerName: b.customerName,
        area: isTakeawayOrDelivery ? (derivedOrderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery') : b.area,
        sessionNumber: null,
        total: +Number(b.total || 0).toFixed(2),
        paid: +Number(b.paid || 0).toFixed(2),
        outstanding: +Number(b.outstanding || 0).toFixed(2),
        statusTone: statusStage === 'Bill Requested' ? 'blue' : 'amber',
        statusStage,
        statusLabel: statusStage,
        itemSummary,
        items: allItems,
        lastActivityAt,
        elapsedMinutes: elapsed.mins,
        elapsedText: elapsed.text,
        isVerifyingPayment: false,
        isBillRequested: b.status === 'UNSETTLED',
      })
    }

    return cards
  }, [sessions, pendingBills, data?.orders, tick])

  // ── Session selection & isolated cart drafts ─────────────────────────────
  // Snapshot ref of the unattached cart to restore when deselecting an active session card
  const preSelectSnapshotRef = useRef<{
    cart: typeof cart
    orderType: typeof orderType
    selectedTableId: typeof selectedTableId
    customerName: string
    customerPhone: string
    promoCode: string
  } | null>(null)

  const handleSessionCardClick = (card: {
    sessionId?: string
    tableId: string | null
    orderType?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
    customerName?: string
    isVerifyingPayment?: boolean
  }) => {
    setForceNewSitting(false)
    if (!card.sessionId) return

    if (card.isVerifyingPayment) {
      toast.info('Payment verification in progress for this session. Editing is temporarily locked.')
      return
    }

    // 1. Clicking the already-selected session card -> Deselect & Restore to neutral
    if (selectedSessionId === card.sessionId) {
      handleDeselectSession()
      return
    }

    // 2. Selecting a session card
    if (!selectedSessionId) {
      // Remember current draft as pre-selection baseline
      preSelectSnapshotRef.current = {
        cart: [...cart],
        orderType,
        selectedTableId,
        customerName,
        customerPhone,
        promoCode,
      }
      if (tenantId && userId) {
        savePosSessionDraft(tenantId, userId, null, {
          cart,
          orderType,
          selectedTableId,
          selectedSessionId: null,
          customerName,
          customerPhone,
          promoCode,
        })
      }
    } else {
      // Switching from another session -> save that session's draft
      if (tenantId && userId) {
        savePosSessionDraft(tenantId, userId, selectedSessionId, {
          cart,
          orderType,
          selectedTableId,
          selectedSessionId,
          customerName,
          customerPhone,
          promoCode,
        })
      }
    }

    // Persist loaded session id so page refresh doesn't drop active editing state
    if (tenantId && userId && card.sessionId) {
      savePosActiveSessionId(tenantId, userId, card.sessionId)
    }

    // Restore or initialize draft for this clicked session
    const existingDraft = tenantId && userId ? getPosSessionDraft(tenantId, userId, card.sessionId) : null
    const targetOrderType = card.orderType || (card.tableId ? 'DINE_IN' : 'TAKEAWAY')
    setAppliedPromo(null)
    setPromoQuote(null)
    setPromoError('')

    if (existingDraft) {
      replaceCart(existingDraft.cart)
      setSessionContext(card.tableId ?? null, card.sessionId, targetOrderType)
      setCustomerName(existingDraft.customerName ?? card.customerName ?? '')
      setCustomerPhone(existingDraft.customerPhone ?? '')
      setPromoCode(existingDraft.promoCode ?? '')
    } else {
      replaceCart([])
      setSessionContext(card.tableId ?? null, card.sessionId, targetOrderType)
      setCustomerName(card.customerName ?? '')
      setCustomerPhone('')
      setPromoCode('')
    }
  }

  const restorePreSelectOrNeutral = useCallback(() => {
    setAppliedPromo(null)
    setPromoQuote(null)
    setPromoError('')
    const pre = preSelectSnapshotRef.current ?? (tenantId && userId ? getPosSessionDraft(tenantId, userId, null) : null)
    if (pre) {
      replaceCart(pre.cart)
      setSessionContext(pre.selectedTableId, null, pre.orderType)
      setCustomerName(pre.customerName ?? '')
      setCustomerPhone(pre.customerPhone ?? '')
      setPromoCode(pre.promoCode ?? '')
    } else {
      setSelectedSessionId(null)
      setSelectedTableId(null)
      setCustomerName('')
      setCustomerPhone('')
      setPromoCode('')
      replaceCart([])
    }
    preSelectSnapshotRef.current = null
  }, [tenantId, userId, replaceCart, setSessionContext, setSelectedSessionId, setSelectedTableId, setPromoCode])

  const handleDeselectSession = () => {
    setForceNewSitting(false)
    if (!selectedSessionId && !selectedTableId) return
    if (tenantId && userId) {
      clearPosActiveSessionId(tenantId, userId)
      if (selectedSessionId) {
        savePosSessionDraft(tenantId, userId, selectedSessionId, {
          cart,
          orderType,
          selectedTableId,
          selectedSessionId,
          customerName,
          customerPhone,
          promoCode,
        })
      }
    }
    restorePreSelectOrNeutral()
  }

  const handleUnloadSession = () => {
    setForceNewSitting(false)
    if (tenantId && userId) {
      if (selectedSessionId) {
        clearPosSessionDraft(tenantId, userId, selectedSessionId)
      }
      clearPosActiveSessionId(tenantId, userId)
    }
    restorePreSelectOrNeutral()
  }

  // Sync recoverable drafts state on tenant/user mount
  useEffect(() => {
    if (!tenantId || !userId) {
      setRecoverableDrafts([])
      return
    }
    setRecoverableDrafts(getRecoverablePosDrafts(tenantId, userId))
  }, [tenantId, userId])

  const visibleRecoverableDrafts = useMemo(
    () =>
      recoverableDrafts.filter(
        (d) =>
          !queueEntries.some(
            (e) =>
              (e.state === 'pending' || e.state === 'submitting') &&
              (e.payload?.tableSessionId ?? null) === d.sessionId,
          ),
      ),
    [recoverableDrafts, queueEntries],
  )

  const recoverClosedSession = useCallback(
    (closedSessionId: string) => {
      if (!tenantId || !userId || !closedSessionId) return
      const isCurrentlySelected = useStore.getState().selectedSessionId === closedSessionId
      const storedDraft = getPosSessionDraft(tenantId, userId, closedSessionId)
      const liveState = useStore.getState()

      const unsentCart = isCurrentlySelected ? liveState.cart : (storedDraft?.cart ?? [])
      const sourceVersion = storedDraft?.draftVersion
      if (unsentCart.length > 0 && !(sourceVersion && isRecoveryConsumed(tenantId, userId, closedSessionId, sourceVersion))) {
        const saved = saveRecoverablePosDraft(tenantId, userId, {
          sessionId: closedSessionId,
          cart: unsentCart,
          orderType: isCurrentlySelected ? liveState.orderType : (storedDraft?.orderType ?? 'DINE_IN'),
          selectedTableId: isCurrentlySelected ? liveState.selectedTableId : (storedDraft?.selectedTableId ?? null),
          customerName: isCurrentlySelected ? customerName : (storedDraft?.customerName ?? ''),
          customerPhone: isCurrentlySelected ? customerPhone : (storedDraft?.customerPhone ?? ''),
          promoCode: isCurrentlySelected ? liveState.promoCode : (storedDraft?.promoCode ?? ''),
          sourceVersion,
        })
        if (!saved) {
          // Destination write failed (e.g. storage quota): preserve source draft so items are never lost.
          toast.error('Could not save unsent items for recovery (storage full). Keeping draft in place.')
          return
        }
        setRecoverableDrafts(getRecoverablePosDrafts(tenantId, userId))
      }

      clearPosSessionDraft(tenantId, userId, closedSessionId)
      if (getPosActiveSessionId(tenantId, userId) === closedSessionId) {
        clearPosActiveSessionId(tenantId, userId)
      }

      if (isCurrentlySelected) {
        restorePreSelectOrNeutral()
      }
    },
    [tenantId, userId, customerName, customerPhone, restorePreSelectOrNeutral],
  )

  const handleRecoverDraft = useCallback(
    (sessionId: string) => {
      if (!tenantId || !userId || selectedSessionId || cart.length > 0) return
      const isHeld = queueEntries.some(
        (e) =>
          (e.state === 'pending' || e.state === 'submitting') &&
          (e.payload?.tableSessionId ?? null) === sessionId,
      )
      if (isHeld) return
      const res = tryRecoverDraftToUnattachedCart(tenantId, userId, cart, sessionId)
      if (!res.ok) {
        if (res.reason === 'storage_error') {
          toast.error('Could not restore items — browser storage is full. Please free space and retry.')
        } else if (res.reason === 'non_empty') {
          toast.info('An unattached cart already has items. Clear or submit it before recovering.')
        }
        return
      }
      const recovered = res.snapshot
      replaceCart(recovered.cart)
      setSessionContext(recovered.selectedTableId, null, recovered.orderType)
      setCustomerName(recovered.customerName ?? '')
      setCustomerPhone(recovered.customerPhone ?? '')
      setPromoCode(recovered.promoCode ?? '')
      setAppliedPromo(null)
      setPromoQuote(null)
      setPromoError('')
      setRecoverableDrafts(getRecoverablePosDrafts(tenantId, userId))
      toast.success('Unsent items restored to cart')
    },
    [tenantId, userId, selectedSessionId, cart, queueEntries, replaceCart, setSessionContext, setPromoCode],
  )

  const handleDismissRecoverableDraft = useCallback(
    (sessionId: string) => {
      if (!tenantId || !userId) return
      clearRecoverablePosDraft(tenantId, userId, sessionId)
      setRecoverableDrafts(getRecoverablePosDrafts(tenantId, userId))
    },
    [tenantId, userId],
  )

  // Restore persisted active session on refresh, and clear stale selection only when
  // authoritative lifecycle confirms closure. If a session is omitted from `/table-session/active`
  // (e.g. >3m old after its last order was cancelled) or its status is still unknown,
  // preserve the sitting selection and unsent items.
  const restoredSessionRef = useRef(false)
  useEffect(() => {
    if (!tenantId || !userId || !sessionsLoadedOnce.current) return
    if (!restoredSessionRef.current) {
      restoredSessionRef.current = true
      const savedActiveSessionId = getPosActiveSessionId(tenantId, userId)
      if (savedActiveSessionId && !selectedSessionId) {
        const lifecycle = resolveSessionLifecycle(savedActiveSessionId, sessions, tableSessions, checks, data?.orders)
        if (lifecycle.state === 'open' && lifecycle.editable) {
          handleSessionCardClick(lifecycle.editable)
        } else if (lifecycle.state === 'closed') {
          recoverClosedSession(savedActiveSessionId)
        } else {
          // Lifecycle unknown: preserve selection & any saved draft without deleting it
          const savedDraft = getPosSessionDraft(tenantId, userId, savedActiveSessionId)
          handleSessionCardClick({
            sessionId: savedActiveSessionId,
            tableId: savedDraft?.selectedTableId ?? null,
            orderType: savedDraft?.orderType,
            customerName: savedDraft?.customerName,
          })
        }
        return
      }
    }

    if (selectedSessionId) {
      const lifecycle = resolveSessionLifecycle(selectedSessionId, sessions, tableSessions, checks, data?.orders)
      if (lifecycle.state === 'closed') {
        recoverClosedSession(selectedSessionId)
      }
    }
  }, [tenantId, userId, sessions, tableSessions, checks, data?.orders, selectedSessionId, recoverClosedSession])

  const loadedSessionOrders = useMemo(() => {
    if (!selectedSessionId) return []
    const appOrders = (data?.orders || []).filter(
      (o: any) => o.tableSessionId === selectedSessionId && o.status !== 'CANCELLED'
    )
    if (appOrders.length > 0) return appOrders
    for (const group of sessions) {
      const found = (group.sessions || []).find((s: any) => s.id === selectedSessionId)
      if (found && found.order_rows) return found.order_rows
    }
    return []
  }, [selectedSessionId, data?.orders, sessions])

  const modalZones = useMemo(() => {
    const set = new Set<string>()
    for (const card of activeSessionCards) {
      if (card.area) set.add(card.area)
    }
    return ['all', ...Array.from(set)]
  }, [activeSessionCards])

  const filteredModalCards = useMemo(() => {
    return activeSessionCards.filter((card) => {
      if (modalZoneFilter !== 'all' && card.area !== modalZoneFilter) return false
      if (modalSearch.trim()) {
        const q = modalSearch.toLowerCase().trim()
        const matchName = (card.tableName || '').toLowerCase().includes(q)
        const matchIdent = (card.compactIdentifier || '').toLowerCase().includes(q)
        const matchCust = (card.customerName || '').toLowerCase().includes(q)
        const matchSummary = (card.itemSummary || '').toLowerCase().includes(q)
        const matchItems = (card.items || []).some((it: any) => (it.name || '').toLowerCase().includes(q))
        if (!matchName && !matchIdent && !matchCust && !matchSummary && !matchItems) return false
      }
      return true
    })
  }, [activeSessionCards, modalZoneFilter, modalSearch])

  const handleSelectSession = (sessionId: string | null) => {
    if (!sessionId) {
      handleDeselectSession()
      return
    }
    if (!selectedSessionId) {
      preSelectSnapshotRef.current = {
        cart: [...cart],
        orderType,
        selectedTableId,
        customerName,
        customerPhone,
        promoCode,
      }
      if (tenantId && userId) {
        savePosSessionDraft(tenantId, userId, null, {
          cart,
          orderType,
          selectedTableId,
          selectedSessionId: null,
          customerName,
          customerPhone,
          promoCode,
        })
      }
    }
    setSelectedSessionId(sessionId)
  }

  const handleNewSitting = () => {
    handleDeselectSession()
    setForceNewSitting(true)
  }

  const handleCancelNewSitting = () => {
    setForceNewSitting(false)
  }

  // Listen for payments and session closures broadcast across windows/tabs/realtime
  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
    const bc = new BroadcastChannel('the_salad_orders_sync')
    const handleMsg = (ev: MessageEvent) => {
      const msg = ev?.data
      if (!msg) return
      if (msg.type === 'CHECK_UPDATED' || msg.type === 'SESSION_ENDED') {
        const endedSessionId = msg.sessionId
        const paidCheckId = msg.checkId
        const isPaidOrEnded = msg.status === 'PAID' || msg.status === 'ENDED' || msg.reason === 'FINALISED'

        if (isPaidOrEnded) {
          // Immediately update local React state to remove settled card without waiting for poll
          setSessions((prev) =>
            prev
              .map((group) => {
                const updatedSessions = (group.sessions || []).filter((s: any) => {
                  if (endedSessionId && s.id === endedSessionId) return false
                  if (paidCheckId && s.check?.id === paidCheckId) return false
                  return true
                })
                const isGroupCheckPaid = group.check?.id === paidCheckId
                return {
                  ...group,
                  sessions: updatedSessions,
                  check: isGroupCheckPaid ? { ...group.check, status: 'PAID', outstanding: 0 } : group.check,
                }
              })
              .filter(
                (g) =>
                  (g.sessions && g.sessions.length > 0) ||
                  (g.check && g.check.status !== 'PAID' && Number(g.check.outstanding || 0) > 0.01)
              )
          )

          setPendingBills((prev) =>
            prev.filter((b) => {
              if (endedSessionId && b.sessionId === endedSessionId) return false
              if (paidCheckId && b.checkId === paidCheckId) return false
              return true
            })
          )

          // If the selected session (or a saved draft's session) just settled, route through shared recovery
          if (endedSessionId && (selectedSessionId === endedSessionId || (tenantId && userId && getPosSessionDraft(tenantId, userId, endedSessionId)))) {
            recoverClosedSession(endedSessionId)
          }

          // Trigger a background re-sync
          void loadSessions()
        }
      }
    }

    bc.addEventListener('message', handleMsg)
    return () => {
      bc.removeEventListener('message', handleMsg)
      bc.close()
    }
  }, [selectedSessionId, tenantId, userId, loadSessions, recoverClosedSession])

  const endSession = async (tableId: string, tableName?: string, force = false, sessionId?: string) => {
    setEndingTable(sessionId ? `${tableId}:${sessionId}` : tableId)
    try {
      const res = await edgeFetch('/api/table-session/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenant?.id ?? '' },
        body: JSON.stringify({
          tableId,
          ...(sessionId ? { sessionId } : {}),
          force,
        }),
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
              onClick: () => void endSession(tableId, tableName, true, sessionId),
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
      if (stillOwed && canCollect) {
        setBillTable({
          id: tableId,
          name: tableName ?? 'Table',
          checkId: body?.settlement?.checkId,
        })
      }
      await loadSessions()
    } catch (err) {
      handleAction(err, 'the table session')
    } finally {
      setEndingTable(null)
    }
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
    const floorTable = selectedTableId ? floor.find((f: any) => f.tableId === selectedTableId) : null
    void floorTable
    let activeSessionId: string | null = null

    if (orderType === 'DINE_IN') {
      if (!selectedTableId) {
        toast.error('Please select a table')
        return
      }
      activeSessionId = selectedSessionId || null
    } else {
      // Takeaway or Delivery
      if (selectedSessionId) {
        activeSessionId = selectedSessionId
      }
      if (!customerName.trim() && !activeSessionId) {
        toast.error('Please enter customer name')
        return
      }
    }

    if (activeSessionId) {
      const lifecycle = resolveSessionLifecycle(activeSessionId, sessions, tableSessions, checks, data?.orders)
      if (lifecycle.state === 'closed') {
        toast.error(
          orderType === 'DINE_IN'
            ? 'The selected table session has ended or is closed. Please start or select an active session.'
            : 'The selected session has ended or is closed. Please start or select an active session.',
        )
        return
      }
    }

    // Block submission if refresh failed, is in flight, or cart has unavailable items
    if (refreshError) {
      toast.error('Menu price refresh failed. Please tap "Retry Refresh" before checkout.')
      return
    }
    if (refreshingCart) {
      toast.error('Menu prices are currently refreshing. Please wait a moment.')
      return
    }
    if (cart.some((c) => c.unavailable)) {
      toast.error('One or more items in your cart are no longer available. Please resolve or remove them before checkout.')
      return
    }

    // Validate that cart items exist and are available in current menu
    if (data?.menuItems && data.menuItems.length > 0) {
      const availableItemIds = new Set(
        data.menuItems.filter((m: any) => m.available !== false).map((m: any) => m.id),
      )
      const staleItem = cart.find((c) => !availableItemIds.has(c.menuItemId))
      if (staleItem) {
        toast.error('One or more items in your cart are no longer available. Please review your cart.')
        return
      }
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
    // Build the checkout payload strictly from the validated applied promo state.
    // Raw input and codes rejected by Apply have no effect on checkout.
    const promoMin = Number(appliedPromo?.minOrder ?? appliedPromo?.min_order ?? 0)
    const effectivePromoCode = appliedPromo && subtotal >= promoMin && discount > 0
      ? (appliedPromo.code || promoCode.trim())
      : undefined
    const effectivePromoQuote = effectivePromoCode ? (promoQuote || undefined) : undefined

    const confirmedPricing = {
      subtotal: +subtotal.toFixed(2),
      discount: +discount.toFixed(2),
      tax: +tax.toFixed(2),
      serviceCharge: +service.toFixed(2),
      total: +total.toFixed(2),
    }

    orderQueue(tenant.id, data.currentUser.id, {}).enqueue(
      'pos',
      {
        tableId: orderType === 'DINE_IN' ? selectedTableId : null,
        tableSessionId: activeSessionId || undefined,
        createNewSitting: !activeSessionId,
        orderType,
        items,
        promoCode: effectivePromoCode,
        promoQuote: effectivePromoQuote,
        pricing: confirmedPricing,
        customerName: orderType !== 'DINE_IN' ? (customerName.trim() || undefined) : undefined,
        customerPhone: orderType !== 'DINE_IN' ? (customerPhone.trim() || undefined) : undefined,
        servedById: data.currentUser.id,
      },
      items.length,
      { 'x-tenant-id': tenant.id },
    )
    setCustomerName('')
    setCustomerPhone('')
    setForceNewSitting(false)
    setCartOpen(false)
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Menu area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Order queue status — clean sending/offline indicator */}
        {queueBusy && (
          <div className="fixed bottom-3 left-3 z-50 max-w-[calc(100vw-1.5rem)]">
            <div className="flex items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-[11px] font-medium text-muted-foreground shadow-lg backdrop-blur">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {offline
                ? tr('pos.queue.offline')
                : tr('pos.queue.sending')}
            </div>
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

          {/* Active Sessions Strip */}
          <div className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setActiveSessionsModalOpen(true)}
                className="group flex items-center gap-2 hover:opacity-85 transition-opacity text-left cursor-pointer"
                aria-label="Expand active sessions"
              >
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground group-hover:text-foreground transition-colors">
                  Active Sessions
                </h3>
                <Maximize2 className="h-3.5 w-3.5 text-muted-foreground opacity-60 group-hover:opacity-100 transition-opacity" />
                {activeSessionCards.length > 0 && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary group-hover:bg-primary/25 transition-colors">
                    {activeSessionCards.length}
                  </span>
                )}
              </button>
              {activeSessionCards.length > 3 && (
                <button
                  type="button"
                  onClick={() => setActiveSessionsModalOpen(true)}
                  className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1"
                >
                  View all ({activeSessionCards.length})
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {activeSessionCards.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {tr('pos.noSessions')}
              </p>
            ) : (
              <div className="flex gap-3 overflow-x-auto scrollbar-thin pb-2">
                {activeSessionCards.map((card) => {
                  const isSelected = Boolean(card.sessionId && selectedSessionId === card.sessionId)
                  return (
                    <ActiveSessionCard
                      key={card.id}
                      card={card}
                      isSelected={isSelected}
                      currencySymbol={tenant.currencySymbol}
                      onClick={() => handleSessionCardClick(card)}
                      onSelect={() => handleSessionCardClick(card)}
                      onUnload={handleDeselectSession}
                    />
                  )
                })}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Expandable Active Sessions Modal */}
      <Dialog open={activeSessionsModalOpen} onOpenChange={setActiveSessionsModalOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-5 sm:p-6 overflow-hidden">
          <DialogHeader className="shrink-0 pb-3 border-b border-border">
            <DialogTitle className="text-lg font-bold flex items-center gap-2">
              Active Sessions
              {activeSessionCards.length > 0 && (
                <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">
                  {activeSessionCards.length}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Live overview of all floor tables, takeaway, and delivery sittings. Tap any session to view or add items in cart.
            </DialogDescription>
          </DialogHeader>

          {/* Search & Zone Filter Bar */}
          <div className="py-3 space-y-2.5 shrink-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={modalSearch}
                onChange={(e) => setModalSearch(e.target.value)}
                placeholder="Search by table, sitting, guest name, or dishes..."
                className="pl-9 h-9 text-xs sm:text-sm bg-secondary/40 border-border"
              />
              {modalSearch && (
                <button
                  onClick={() => setModalSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Zone Filters */}
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none py-1">
              {modalZones.map((zone) => (
                <button
                  key={zone}
                  onClick={() => setModalZoneFilter(zone)}
                  className={cn(
                    "px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
                    modalZoneFilter === zone
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-secondary text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                  )}
                >
                  {zone === 'all' ? `All (${activeSessionCards.length})` : zone}
                </button>
              ))}
            </div>
          </div>

          {/* Modal Cards Grid */}
          <div className="flex-1 overflow-y-auto pr-1 min-h-0">
            {filteredModalCards.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No active sessions match your search or filter.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {filteredModalCards.map((card) => (
                  <ActiveSessionCard
                    key={card.id}
                    card={card}
                    isSelected={Boolean(card.sessionId && selectedSessionId === card.sessionId)}
                    currencySymbol={tenant.currencySymbol}
                    className="w-full shrink"
                    onSelect={() => {
                      handleSessionCardClick(card)
                      setActiveSessionsModalOpen(false)
                    }}
                    onUnload={handleDeselectSession}
                  />
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <TableCheckDialog
        tableId={billTable?.id ?? null}
        tableName={billTable?.name ?? null}
        checkId={billTable?.checkId ?? null}
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
          selectedSessionId={selectedSessionId}
          setSelectedSessionId={handleSelectSession}
          onDeselectSession={handleDeselectSession}
          onUnloadSession={handleUnloadSession}
          committedOrders={loadedSessionOrders}
          liveSessions={selectedTableId ? (floor.find((f: any) => f.tableId === selectedTableId)?.liveSessions || []) : []}
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
          activeSessionCards={activeSessionCards}
          forceNewSitting={forceNewSitting}
          onNewSitting={handleNewSitting}
          onCancelNewSitting={handleCancelNewSitting}
          refreshError={refreshError}
          refreshingCart={refreshingCart}
          onRetryRefresh={() => { void refreshCartPricing() }}
          recoverableDrafts={visibleRecoverableDrafts}
          onRecoverDraft={handleRecoverDraft}
          onDismissRecoverableDraft={handleDismissRecoverableDraft}
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
            selectedSessionId={selectedSessionId}
            setSelectedSessionId={handleSelectSession}
            onDeselectSession={handleDeselectSession}
            onUnloadSession={handleUnloadSession}
            committedOrders={loadedSessionOrders}
            liveSessions={selectedTableId ? (floor.find((f: any) => f.tableId === selectedTableId)?.liveSessions || []) : []}
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
            activeSessionCards={activeSessionCards}
            forceNewSitting={forceNewSitting}
            onNewSitting={handleNewSitting}
            onCancelNewSitting={handleCancelNewSitting}
            refreshError={refreshError}
            refreshingCart={refreshingCart}
            onRetryRefresh={() => { void refreshCartPricing() }}
            recoverableDrafts={visibleRecoverableDrafts}
            onRecoverDraft={handleRecoverDraft}
            onDismissRecoverableDraft={handleDismissRecoverableDraft}
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
  selectedSessionId: string | null
  setSelectedSessionId: (id: string | null) => void
  onDeselectSession?: () => void
  onUnloadSession?: () => void
  committedOrders?: any[]
  liveSessions: any[]
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
  activeSessionCards?: any[]
  forceNewSitting?: boolean
  onNewSitting?: () => void
  onCancelNewSitting?: () => void
  refreshError?: string | null
  refreshingCart?: boolean
  onRetryRefresh?: () => void
  recoverableDrafts?: RecoverablePosDraft[]
  onRecoverDraft?: (sessionId: string) => void
  onDismissRecoverableDraft?: (sessionId: string) => void
}

function CartPanel(p: CartPanelProps) {
  const tr = useT()
  const { embedded } = p
  const tableName = p.tables.find((t) => t.id === p.selectedTableId)?.name || 'Table'
  const isAmbiguousSitting = false
  const cardMatch = (p.activeSessionCards || []).find((c: any) => c.sessionId === p.selectedSessionId)
  const hasUnavailableLines = p.cart.some((c) => c.unavailable)
  const hasRefreshError = Boolean(p.refreshError)

  const committedItems = useMemo(() => {
    if (!p.selectedSessionId) return []
    if (cardMatch?.items && cardMatch.items.length > 0) {
      return cardMatch.items
    }
    if (p.committedOrders && p.committedOrders.length > 0) {
      const items: any[] = []
      for (const ord of p.committedOrders) {
        if (Array.isArray(ord.items)) {
          for (const it of ord.items) {
            items.push({
              id: it.id,
              name: it.name,
              portion: it.portion,
              price: Number(it.price || 0),
              quantity: Number(it.quantity || 1),
              status: it.status || ord.status,
            })
          }
        }
      }
      if (items.length > 0) return items
    }
    return []
  }, [p.selectedSessionId, cardMatch?.items, p.committedOrders])

  return (
    <div className={cn('flex flex-col h-full min-h-0 flex-1', embedded && 'overflow-hidden')}>
      {/* Order type + table/customer */}
      <div className="shrink-0 px-3 py-2.5 space-y-2 border-b border-border">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary/50 p-0.5 border border-border">
          {(['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                p.setOrderType(t)
                if (t !== 'DINE_IN') p.setSelectedTableId(null)
              }}
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

        {/* Stateful Header Card: When a session is loaded, replace Select table dropdown */}
        {p.selectedSessionId ? (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-3 flex items-center justify-between shadow-xs">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                <h4 className="font-semibold text-sm truncate text-foreground">
                  {cardMatch?.compactIdentifier || (cardMatch?.sessionNumber ? `Adding to ${tableName} · Diner ${cardMatch.sessionNumber}` : `Adding to ${tableName}`)}
                </h4>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                <span className="font-semibold text-foreground">
                  {formatCurrency(cardMatch?.outstanding ?? 0, p.currencySymbol)} due
                </span>
                {Number(cardMatch?.paid ?? 0) > 0 && (
                  <span> · {formatCurrency(Number(cardMatch?.paid ?? 0), p.currencySymbol)} paid</span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={p.onUnloadSession || p.onDeselectSession}
              className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors shrink-0 ml-2"
              title="Unload session"
              aria-label="Unload session"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : p.orderType === 'DINE_IN' ? (
          <div className="space-y-2">
            <Select
              value={p.selectedTableId || ''}
              onValueChange={(v) => {
                p.setSelectedTableId(v || null)
                if (p.selectedSessionId) {
                  p.setSelectedSessionId(null)
                }
                if (p.onCancelNewSitting) {
                  p.onCancelNewSitting()
                }
              }}
            >
              <SelectTrigger className="bg-secondary/50 border-0 h-9">
                <SelectValue placeholder={tr('pos.selectTable')} />
              </SelectTrigger>
              <SelectContent>
                {p.tables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name} · {t.seats} seats · {t.area}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
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
          </div>
        )}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 min-h-0">
        {/* Recoverable unsent items from remotely closed sittings */}
        {p.recoverableDrafts && p.recoverableDrafts.length > 0 && (
          <div className="mt-3 space-y-2">
            {p.recoverableDrafts.map((draft) => {
              const itemCount = draft.cart.reduce((s, c) => s + c.quantity, 0)
              const label = draft.customerName?.trim()
                ? draft.customerName.trim()
                : draft.orderType === 'TAKEAWAY'
                  ? 'Takeaway'
                  : draft.orderType === 'DELIVERY'
                    ? 'Delivery'
                    : (p.tables.find((t) => t.id === draft.selectedTableId)?.name || 'Closed sitting')
              return (
                <div key={draft.sessionId} className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground truncate">
                        Unsent items from {label} ({itemCount})
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {!p.selectedSessionId && p.cart.length === 0
                          ? 'Restore these items into a new unattached cart.'
                          : 'Clear or finish the current cart to recover these items.'}
                      </p>
                    </div>
                    {p.onDismissRecoverableDraft && (
                      <button
                        type="button"
                        onClick={() => p.onDismissRecoverableDraft?.(draft.sessionId)}
                        className="text-muted-foreground hover:text-foreground p-0.5 rounded shrink-0"
                        title="Dismiss recoverable items"
                        aria-label="Dismiss recoverable items"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {p.onRecoverDraft && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={Boolean(p.selectedSessionId) || p.cart.length > 0}
                      onClick={() => p.onRecoverDraft?.(draft.sessionId)}
                      className="w-full h-7 text-xs font-semibold"
                    >
                      Recover items
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Already Ordered items (read-only section) */}
        {p.selectedSessionId && committedItems.length > 0 && (
          <div className="pt-3 pb-1 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
              <span className="flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                Already Ordered
                <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.2 text-[10px] font-medium text-foreground">
                  {committedItems.length}
                </span>
              </span>
              <span className="text-[10px] text-muted-foreground font-normal">Read-only</span>
            </div>
            <div className="space-y-1 rounded-xl border border-border/70 bg-secondary/15 p-2">
              {committedItems.map((item: any, idx: number) => (
                <div key={item.id || idx} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg bg-card/70">
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <span className="font-bold text-muted-foreground text-[11px] shrink-0">
                      {item.quantity}×
                    </span>
                    <span className="truncate font-medium text-foreground">
                      {item.name}
                      {item.portion && (
                        <span className="ml-1 rounded bg-secondary px-1 py-0.5 text-[9px] text-muted-foreground">
                          {item.portion}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[11px] font-semibold text-muted-foreground">
                      {formatCurrency(Number(item.price || 0) * Number(item.quantity || 1), p.currencySymbol)}
                    </span>
                    {item.status && (
                      <span className={cn(
                        "rounded px-1.5 py-0.2 text-[9px] font-semibold uppercase",
                        item.status === 'SERVED' ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" :
                        item.status === 'PREPARING' ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" :
                        "bg-secondary text-muted-foreground"
                      )}>
                        {item.status.toLowerCase()}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Newly added items or empty state */}
        {p.cart.length === 0 ? (
          p.selectedSessionId && committedItems.length > 0 ? (
            <div className="rounded-xl border border-dashed border-border/80 bg-secondary/10 p-5 text-center my-4">
              <p className="text-xs font-semibold text-foreground">Tap menu items to add to this order</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Newly tapped items will appear here before updating</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-3">
                <ShoppingBag className="h-7 w-7 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">{tr('pos.cartEmpty')}</p>
              <p className="text-xs text-muted-foreground mt-1">{tr('pos.cartHint')}</p>
            </div>
          )
        ) : (
          <div className="space-y-3 py-3">
            {p.refreshError && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs flex items-center justify-between gap-2 text-destructive mb-3">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="shrink-0">⚠️</span>
                  <span className="truncate">{p.refreshError}</span>
                </div>
                {p.onRetryRefresh && (
                  <button
                    onClick={p.onRetryRefresh}
                    disabled={p.refreshingCart}
                    className="shrink-0 font-semibold underline hover:opacity-80"
                  >
                    {p.refreshingCart ? 'Refreshing…' : 'Retry Refresh'}
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                {p.selectedSessionId && <Plus className="h-3.5 w-3.5 text-primary" />}
                {p.selectedSessionId ? `New Items to Add (${p.cart.length})` : 'Item'}
              </span>
              <span>Qty · Price</span>
            </div>
            <Separator />
            {p.cart.map((c) => (
              <div
                key={`${c.menuItemId}::${c.portionId ?? c.portion ?? ''}`}
                className={cn(
                  "rounded-xl p-3",
                  c.unavailable ? "bg-destructive/10 border border-destructive/40" : "bg-secondary/30"
                )}
              >
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
                    {c.unavailable && (
                      <p className="text-xs font-semibold text-destructive mt-1 flex items-center gap-1">
                        <span>⚠️</span>
                        <span>{c.unavailableReason || 'Item or portion is no longer available. Please remove.'}</span>
                      </p>
                    )}
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
          disabled={
            p.submitting ||
            p.cart.length === 0 ||
            !p.canCheckout ||
            isAmbiguousSitting ||
            cardMatch?.isVerifyingPayment ||
            hasUnavailableLines ||
            hasRefreshError ||
            p.refreshingCart
          }
          title={
            hasRefreshError
              ? "Menu price refresh failed. Please tap 'Retry Refresh' before checkout."
              : hasUnavailableLines
              ? "Please remove or resolve unavailable items before checkout"
              : cardMatch?.isVerifyingPayment
              ? "Payment verification is pending for this session"
              : !p.canCheckout
              ? "You don't have permission to create orders"
              : isAmbiguousSitting
              ? "Please select which diner session to add this order to"
              : p.cart.length === 0
              ? (p.selectedSessionId ? "Add menu items to update this order" : "Cart is empty")
              : undefined
          }
          className="w-full h-10 text-sm font-semibold bg-gradient-to-r from-primary to-primary-hover hover:shadow-glow-primary transition-premium border-0"
        >
          {p.submitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {p.selectedSessionId ? 'Updating order…' : 'Placing order…'}</>
          ) : p.refreshingCart ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Refreshing menu prices…</>
          ) : hasRefreshError ? (
            <>Price Refresh Required</>
          ) : hasUnavailableLines ? (
            <>Resolve Unavailable Items</>
          ) : isAmbiguousSitting ? (
            <>Select Diner Session</>
          ) : p.selectedSessionId ? (
            p.cart.length === 0 ? (
              <>Update Order · Select items</>
            ) : (
              <>
                <Check className="h-4 w-4 mr-2" />
                Update Order · +{formatCurrency(p.total, p.currencySymbol)}
                <span className="ml-1.5 text-xs opacity-85 font-normal">
                  (Total: {formatCurrency(Number(cardMatch?.total ?? 0) + p.total, p.currencySymbol)})
                </span>
              </>
            )
          ) : (
            <><CreditCard className="h-4 w-4 mr-2" /> Place Order · {formatCurrency(p.total, p.currencySymbol)}</>
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
