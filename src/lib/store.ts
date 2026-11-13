'use client'

import { create } from 'zustand'
import { canonicalPortionName, normalizePortionKey } from '@/lib/portions'

export type ViewKey =
  | 'dashboard' | 'orders' | 'analytics' | 'promos' | 'qr'
  | 'menu' | 'settings' | 'security' | 'roles' | 'billing'
  | 'location-onboarding'

export interface CartItem {
  menuItemId: string
  name: string
  /** Stable portion ID and display name for dishes sold per portion. */
  portionId?: string | null
  portion?: string | null
  price: number
  image?: string | null
  quantity: number
  notes?: string
}

/**
 * A cart line is one dish in one portion. Case-insensitive normalised key
 * ensures "Full" and "full" or matching portionId always merge into one line.
 */
const sameLine = (
  c: CartItem,
  menuItemId: string,
  portion?: string | null,
  portionId?: string | null,
) =>
  c.menuItemId === menuItemId &&
  normalizePortionKey(c.portion, c.portionId) === normalizePortionKey(portion, portionId)

interface AppState {
  // tenant context
  tenantId: string | null
  setTenantId: (id: string) => void

  // current view (for the single-page dashboard)
  view: ViewKey
  setView: (v: ViewKey) => void

  // settings sub-tab (so header dropdown can open Profile/Preferences directly)
  settingsTab: string
  setSettingsTab: (t: string) => void

  // POS cart
  cart: CartItem[]
  addToCart: (item: Omit<CartItem, 'quantity'>, qty?: number) => void
  /**
   * Cart-line identity is (menuItemId, portionId) — the same pair the line
   * was added with. Callers that pass only the portion name cannot address a
   * portioned line whose id differs from the name-derived slug, so every
   * mutation accepts the portionId alongside the name.
   */
  updateCartQty: (menuItemId: string, qty: number, portion?: string | null, portionId?: string | null) => void
  removeFromCart: (menuItemId: string, portion?: string | null, portionId?: string | null) => void
  setCartNotes: (menuItemId: string, notes: string, portion?: string | null, portionId?: string | null) => void
  clearCart: () => void
  /**
   * Restore a persisted cart — only into an EMPTY in-memory cart, so a fresh
   * cart built before hydration ran is never overwritten by an older snapshot.
   */
  hydrateCart: (snapshot: {
    cart: CartItem[]
    orderType?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
    selectedTableId?: string | null
    promoCode?: string
  }) => void
  /**
   * Remove exactly the lines a confirmed order consumed, subtracting
   * quantities so items the cashier added AFTER submitting stay in the cart.
   */
  subtractCartLines: (
    lines: Array<{ menuItemId: string; portion?: string | null; portionId?: string | null; quantity: number }>,
  ) => void

  // POS order type & table
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
  setOrderType: (t: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY') => void
  selectedTableId: string | null
  setSelectedTableId: (id: string | null) => void

  // promo
  promoCode: string
  setPromoCode: (c: string) => void

  // sidebar collapse (mobile)
  sidebarOpen: boolean
  setSidebarOpen: (b: boolean) => void
}

export const useStore = create<AppState>((set) => ({
  tenantId: null,
  setTenantId: (id) => set({ tenantId: id }),

  view: 'dashboard',
  setView: (v) => set({ view: v }),

  settingsTab: 'profile',
  setSettingsTab: (t) => set({ settingsTab: t }),

  cart: [],
  addToCart: (item, qty = 1) =>
    set((s) => {
      const cleanPortion = item.portion ? canonicalPortionName(item.portion) : null
      const cleanPortionId = item.portionId || (cleanPortion ? normalizePortionKey(cleanPortion) : null)
      const existing = s.cart.find((c) => sameLine(c, item.menuItemId, cleanPortion, cleanPortionId))
      if (existing) {
        return {
          cart: s.cart.map((c) =>
            sameLine(c, item.menuItemId, cleanPortion, cleanPortionId)
              ? { ...c, price: item.price, portion: cleanPortion, portionId: cleanPortionId, quantity: c.quantity + qty }
              : c
          ),
        }
      }
      return {
        cart: [
          ...s.cart,
          { ...item, portion: cleanPortion, portionId: cleanPortionId, quantity: qty },
        ],
      }
    }),
  updateCartQty: (menuItemId, qty, portion, portionId) =>
    set((s) => ({
      cart: qty <= 0
        ? s.cart.filter((c) => !sameLine(c, menuItemId, portion, portionId))
        : s.cart.map((c) => (sameLine(c, menuItemId, portion, portionId) ? { ...c, quantity: qty } : c)),
    })),
  removeFromCart: (menuItemId, portion, portionId) => set((s) => ({ cart: s.cart.filter((c) => !sameLine(c, menuItemId, portion, portionId)) })),
  setCartNotes: (menuItemId, notes, portion, portionId) => set((s) => ({ cart: s.cart.map((c) => (sameLine(c, menuItemId, portion, portionId) ? { ...c, notes } : c)) })),
  clearCart: () => set({ cart: [] }),
  hydrateCart: (snapshot) =>
    set((s) =>
      s.cart.length > 0 || !snapshot.cart?.length
        ? {}
        : {
            cart: snapshot.cart,
            ...(snapshot.orderType ? { orderType: snapshot.orderType } : {}),
            ...(snapshot.selectedTableId !== undefined ? { selectedTableId: snapshot.selectedTableId } : {}),
            ...(snapshot.promoCode !== undefined ? { promoCode: snapshot.promoCode } : {}),
          },
    ),
  subtractCartLines: (lines) =>
    set((s) => {
      let cart = [...s.cart]
      for (const line of lines) {
        const qty = Math.max(1, Number(line.quantity) || 1)
        cart = cart
          .map((c) =>
            sameLine(c, line.menuItemId, line.portion, line.portionId)
              ? { ...c, quantity: c.quantity - qty }
              : c,
          )
          .filter((c) => c.quantity > 0)
      }
      return { cart }
    }),

  orderType: 'DINE_IN',
  setOrderType: (t) => set({ orderType: t }),
  selectedTableId: null,
  setSelectedTableId: (id) => set({ selectedTableId: id }),

  promoCode: '',
  setPromoCode: (c) => set({ promoCode: c }),

  sidebarOpen: false,
  setSidebarOpen: (b) => set({ sidebarOpen: b }),
}))
