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
  selectedSessionId?: string | null
  customerName?: string
  customerPhone?: string
  promoCode: string
  savedAt: number
}

function suffix(tenantId: string, userId: string): string {
  return `${tenantId}-${userId}`
}

function draftsSuffix(tenantId: string, userId: string): string {
  return `${tenantId}-${userId}-drafts`
}

function activeSessionSuffix(tenantId: string, userId: string): string {
  return `${tenantId}-${userId}-active-session`
}

/** Persist currently loaded POS active session id in localStorage. */
export function savePosActiveSessionId(
  tenantId: string,
  userId: string,
  sessionId: string | null | undefined,
): void {
  if (sessionId?.trim()) {
    writeStored('posCart', sessionId.trim(), activeSessionSuffix(tenantId, userId))
  } else {
    removeStored('posCart', activeSessionSuffix(tenantId, userId))
  }
}

/** Retrieve persisted POS active session id from localStorage. */
export function getPosActiveSessionId(
  tenantId: string,
  userId: string,
): string | null {
  const id = readStored('posCart', activeSessionSuffix(tenantId, userId))
  return id?.trim() || null
}

/** Clear persisted POS active session id from localStorage. */
export function clearPosActiveSessionId(
  tenantId: string,
  userId: string,
): void {
  removeStored('posCart', activeSessionSuffix(tenantId, userId))
}

function sessionDraftKey(sessionKey?: string | null): string {
  return sessionKey?.trim() ? `sess_${sessionKey.trim()}` : 'default'
}

/** Read all session drafts for this tenant+user. */
function getPosSessionDrafts(
  tenantId: string,
  userId: string,
): Record<string, PosCartSnapshot> {
  const raw = readStored('posCart', draftsSuffix(tenantId, userId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/** Save a draft for a specific session (or default unattached cart). */
export function savePosSessionDraft(
  tenantId: string,
  userId: string,
  sessionKey: string | null | undefined,
  snapshot: Omit<PosCartSnapshot, 'savedAt'>,
): void {
  const drafts = getPosSessionDrafts(tenantId, userId)
  const key = sessionDraftKey(sessionKey)
  if (snapshot.cart.length === 0) {
    delete drafts[key]
  } else {
    drafts[key] = { ...snapshot, savedAt: Date.now() }
  }
  writeStored('posCart', JSON.stringify(drafts), draftsSuffix(tenantId, userId))
  writeStored('posCart', JSON.stringify({ ...snapshot, savedAt: Date.now() }), suffix(tenantId, userId))
}

/** Retrieve a draft for a specific session key. */
export function getPosSessionDraft(
  tenantId: string,
  userId: string,
  sessionKey: string | null | undefined,
): PosCartSnapshot | null {
  const drafts = getPosSessionDrafts(tenantId, userId)
  const key = sessionDraftKey(sessionKey)
  return drafts[key] ?? null
}

/** Remove a draft for a specific session after confirmed order creation. */
export function clearPosSessionDraft(
  tenantId: string,
  userId: string,
  sessionKey: string | null | undefined,
): void {
  const drafts = getPosSessionDrafts(tenantId, userId)
  const key = sessionDraftKey(sessionKey)
  delete drafts[key]
  writeStored('posCart', JSON.stringify(drafts), draftsSuffix(tenantId, userId))
}

export function persistPosCart(
  tenantId: string,
  userId: string,
  snapshot: Omit<PosCartSnapshot, 'savedAt'>,
): void {
  savePosSessionDraft(tenantId, userId, snapshot.selectedSessionId, snapshot)
}

export function restorePosCart(tenantId: string, userId: string): PosCartSnapshot | null {
  const raw = readStored('posCart', suffix(tenantId, userId))
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.cart)) return parsed as PosCartSnapshot
    } catch {}
  }
  const drafts = getPosSessionDrafts(tenantId, userId)
  const defaultDraft = drafts['default']
  if (defaultDraft && Array.isArray(defaultDraft.cart)) return defaultDraft
  const firstDraft = Object.values(drafts)[0]
  return firstDraft && Array.isArray(firstDraft.cart) ? firstDraft : null
}

export function clearPosCart(tenantId: string, userId: string): void {
  removeStored('posCart', suffix(tenantId, userId))
  removeStored('posCart', draftsSuffix(tenantId, userId))
}
