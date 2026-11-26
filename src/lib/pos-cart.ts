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
import { normalizePortionKey } from './portions'
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
  const now = Date.now()
  if (snapshot.cart.length === 0) {
    delete drafts[key]
  } else {
    drafts[key] = { ...snapshot, savedAt: now }
  }
  writeStored('posCart', JSON.stringify(drafts), draftsSuffix(tenantId, userId))
  // Only the unattached ('default') cart is mirrored to the legacy single-cart key;
  // session drafts must never overwrite the unattached cart snapshot.
  if (key === 'default') {
    writeStored('posCart', JSON.stringify({ ...snapshot, selectedSessionId: null, savedAt: now }), suffix(tenantId, userId))
  }
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
  if (key === 'default') {
    removeStored('posCart', suffix(tenantId, userId))
  }
}

/**
 * Subtract submitted order lines from a stored draft, preserving any items
 * added after submission. Deletes the draft if no items remain.
 */
export function subtractPosSessionDraft(
  tenantId: string,
  userId: string,
  sessionKey: string | null | undefined,
  lines: Array<{ menuItemId: string; portion?: string | null; portionId?: string | null; quantity: number }>,
): PosCartSnapshot | null {
  const existing = getPosSessionDraft(tenantId, userId, sessionKey)
  if (!existing || !Array.isArray(existing.cart) || existing.cart.length === 0) return null

  let remaining = [...existing.cart]
  for (const line of lines) {
    const qty = Math.max(1, Number(line.quantity) || 1)
    const lineKey = normalizePortionKey(line.portion, line.portionId)
    remaining = remaining
      .map((c) =>
        c.menuItemId === line.menuItemId && normalizePortionKey(c.portion, c.portionId) === lineKey
          ? { ...c, quantity: c.quantity - qty }
          : c,
      )
      .filter((c) => c.quantity > 0)
  }

  if (remaining.length === 0) {
    clearPosSessionDraft(tenantId, userId, sessionKey)
    return null
  }
  const updated: Omit<PosCartSnapshot, 'savedAt'> = {
    ...existing,
    cart: remaining,
  }
  savePosSessionDraft(tenantId, userId, sessionKey, updated)
  return { ...updated, savedAt: Date.now() }
}

export function persistPosCart(
  tenantId: string,
  userId: string,
  snapshot: Omit<PosCartSnapshot, 'savedAt'>,
): void {
  savePosSessionDraft(tenantId, userId, snapshot.selectedSessionId, snapshot)
}

export function restorePosCart(tenantId: string, userId: string): PosCartSnapshot | null {
  const drafts = getPosSessionDrafts(tenantId, userId)
  const defaultDraft = drafts['default']
  if (defaultDraft && Array.isArray(defaultDraft.cart) && defaultDraft.cart.length > 0) {
    return defaultDraft
  }
  const raw = readStored('posCart', suffix(tenantId, userId))
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.cart) && !parsed.selectedSessionId) {
        return parsed as PosCartSnapshot
      }
    } catch {}
  }
  return null
}

export function clearPosCart(tenantId: string, userId: string): void {
  removeStored('posCart', suffix(tenantId, userId))
  removeStored('posCart', draftsSuffix(tenantId, userId))
}
