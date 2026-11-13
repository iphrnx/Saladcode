/**
 * POS cart persistence.
 *
 * A cashier's half-built order used to live only in memory: a refresh, a
 * crashed tab, or an accidental close lost it. The cart is now written to
 * localStorage on every change, scoped to the restaurant AND the staff
 * member, and restored when they come back.
 *
 * The rules that keep this safe:
 *
 *  - Restore never overwrites. If the in-memory cart already has items (a new
 *    cart built before hydration ran), the stored one is left alone — the
 *    fresher state wins, nothing is silently replaced.
 *
 *  - Clearing is deliberate: after a confirmed order (not a queued one —
 *    queue confirmation clears it), or an explicit Clear.
 *
 *  - Scope is the boundary: tenant + user id. One restaurant's cart never
 *    appears in another's, and two staff on the same device never share one.
 */

import { readStored, removeStored, writeStored } from './storage-keys'
import type { CartItem } from './store'

export interface PosCartSnapshot {
  cart: CartItem[]
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
  selectedTableId: string | null
  promoCode: string
  savedAt: number
}

function suffix(tenantId: string, userId: string): string {
  return `${tenantId}-${userId}`
}

export function persistPosCart(
  tenantId: string,
  userId: string,
  snapshot: Omit<PosCartSnapshot, 'savedAt'>,
): void {
  writeStored('posCart', JSON.stringify({ ...snapshot, savedAt: Date.now() }), suffix(tenantId, userId))
}

export function restorePosCart(tenantId: string, userId: string): PosCartSnapshot | null {
  const raw = readStored('posCart', suffix(tenantId, userId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.cart)) return null
    return parsed as PosCartSnapshot
  } catch {
    return null
  }
}

export function clearPosCart(tenantId: string, userId: string): void {
  removeStored('posCart', suffix(tenantId, userId))
}
