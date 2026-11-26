import { normalizePortionKey } from './portions'
import { keyName, legacyKeyNames } from './storage-keys'
import type { QueueEntry, StorageLike } from './order-queue'

export interface SyncableCartItem {
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

export function sameSyncCartLine(
  c: Pick<SyncableCartItem, 'menuItemId' | 'portion' | 'portionId'>,
  menuItemId: string,
  portion?: string | null,
  portionId?: string | null,
): boolean {
  return (
    c.menuItemId === menuItemId &&
    normalizePortionKey(c.portion, c.portionId) === normalizePortionKey(portion, portionId)
  )
}

/**
 * Reconcile local React cart edits with the latest cart persisted in storage
 * by another tab, using the same line identity rules.
 */
export function reconcileCartOnSave<T extends SyncableCartItem>(
  localCart: T[],
  lastSyncedCart: T[],
  latestStoredCart: T[],
): T[] {
  const result = localCart.map((c) => ({ ...c }))

  for (const ext of latestStoredCart) {
    const prev = lastSyncedCart.find((p) =>
      sameSyncCartLine(p, ext.menuItemId, ext.portion ?? null, ext.portionId ?? null),
    )
    const localIdx = result.findIndex((l) =>
      sameSyncCartLine(l, ext.menuItemId, ext.portion ?? null, ext.portionId ?? null),
    )

    if (!prev) {
      // Added externally by another tab (e.g. a browsing tab merging an unsubmitted dish).
      if (localIdx >= 0) {
        result[localIdx] = {
          ...result[localIdx],
          quantity: result[localIdx].quantity + ext.quantity,
          notes: result[localIdx].notes || ext.notes,
        }
      } else {
        result.push({ ...ext })
      }
    } else if (localIdx >= 0) {
      const localChangedNotes = (result[localIdx].notes ?? '') !== (prev.notes ?? '')
      const extChangedNotes = (ext.notes ?? '') !== (prev.notes ?? '')
      const nextNotes = !localChangedNotes && extChangedNotes ? ext.notes : result[localIdx].notes

      // Apply external quantity delta (increment or decrement) when this tab kept the line.
      const nextQty =
        ext.quantity !== prev.quantity
          ? result[localIdx].quantity + (ext.quantity - prev.quantity)
          : result[localIdx].quantity

      if (nextQty <= 0) {
        result.splice(localIdx, 1)
      } else if (nextQty !== result[localIdx].quantity || nextNotes !== result[localIdx].notes) {
        result[localIdx] = {
          ...result[localIdx],
          quantity: nextQty,
          notes: nextNotes,
        }
      }
    }
  }

  // Apply confirmed/external removals by subtracting the baseline quantity from
  // the local line (so stale increments like 2 -> 3 become 3 - 2 = 1).
  for (const prev of lastSyncedCart) {
    const stillInStored = latestStoredCart.some((ext) =>
      sameSyncCartLine(ext, prev.menuItemId, prev.portion ?? null, prev.portionId ?? null),
    )
    if (stillInStored) continue
    const localIdx = result.findIndex((l) =>
      sameSyncCartLine(l, prev.menuItemId, prev.portion ?? null, prev.portionId ?? null),
    )
    if (localIdx >= 0) {
      const nextQty = result[localIdx].quantity - prev.quantity
      if (nextQty <= 0) {
        result.splice(localIdx, 1)
      } else {
        result[localIdx] = {
          ...result[localIdx],
          quantity: nextQty,
        }
      }
    }
  }

  return result
}

/**
 * Merge remaining unsubmitted browsing items into an existing session cart
 * without overwriting items already saved in that session.
 */
export function mergeBrowsingRemainderIntoSession<T extends SyncableCartItem>(
  existingSessionCart: T[],
  browsingRemainder: T[],
): T[] {
  const merged = existingSessionCart.map((c) => ({ ...c }))
  for (const item of browsingRemainder) {
    const idx = merged.findIndex((c) =>
      sameSyncCartLine(c, item.menuItemId, item.portion ?? null, item.portionId ?? null),
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
  return merged
}

/**
 * Reconcile confirmed order quantities against the previous sync baseline and
 * the latest saved cart, removing only confirmed quantities while preserving
 * unsubmitted edits from either tab.
 */
export function reconcileCartOnConfirm<T extends SyncableCartItem>(
  localCart: T[],
  lastSyncedCart: T[],
  latestStoredCart: T[],
  submittedItems: Array<{ menuItemId: string; portion?: string | null; portionId?: string | null; quantity?: number }>,
): T[] {
  let next = reconcileCartOnSave(localCart, lastSyncedCart, latestStoredCart)
  for (const line of submittedItems) {
    const qty = Math.max(1, Number(line.quantity) || 1)
    next = next
      .map((c) =>
        sameSyncCartLine(c, line.menuItemId, line.portion ?? null, line.portionId ?? null)
          ? { ...c, quantity: c.quantity - qty }
          : c,
      )
      .filter((c) => c.quantity > 0)
  }
  return next
}

const DEFINITIVE_SESSION_CODES = new Set([
  'SESSION_ENDED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'TABLE_UNAVAILABLE',
  'RESTAURANT_UNAVAILABLE',
])

const NON_SESSION_CODES = new Set([
  'ITEM_UNAVAILABLE',
  'ORDER_PRICING_CHANGED',
  'PROMO_REJECTED',
  'PROMO_STALE',
  'LOOKUP_FAILED',
])

/**
 * True when a definitive checkout rejection indicates the cached diner
 * session credential is ended, expired, or invalid (and should be cleared so
 * a retry can re-authenticate via the scanned QR).
 */
export interface MigrationResult {
  sessionEntries: QueueEntry[]
  migratedEntries: QueueEntry[]
}

/**
 * Move any unresolved (`pending` / `submitting`) checkouts from the table- or
 * QR-scoped queue into the adopted session-scoped queue, preserving each
 * entry's idempotency key and preventing duplicate submissions.
 */
export function migratePendingTableQueueToSession(
  storage: StorageLike,
  tenantId: string,
  tableId: string | null | undefined,
  sessionToken: string,
  qrToken?: string | null,
  markCartDeducted = false,
): MigrationResult {
  const sessionQueueKey = keyName('orderQueue', `${tenantId}-${sessionToken}`)
  const readEntries = (k: string): QueueEntry[] => {
    try {
      const raw = storage.getItem(k)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  let sessionEntries = readEntries(sessionQueueKey)
  const seenKeys = new Set(sessionEntries.map((e) => e.key))
  const migratedEntries: QueueEntry[] = []

  const sourceActors = [
    tableId ? `table_${tableId}` : null,
    qrToken ? `qr_${qrToken}` : null,
  ].filter(Boolean) as string[]

  const sourceUpdates: Array<{ key: string; remaining: QueueEntry[] }> = []
  let changed = false

  for (const actor of sourceActors) {
    const suffix = `${tenantId}-${actor}`
    const candidateKeys = [keyName('orderQueue', suffix), ...legacyKeyNames('orderQueue', suffix)]
    for (const sourceKey of candidateKeys) {
      const sourceEntries = readEntries(sourceKey)
      if (sourceEntries.length === 0) continue

      const remainingSource: QueueEntry[] = []
      for (const entry of sourceEntries) {
        const unresolved = entry.state === 'pending' || entry.state === 'submitting'
        const matchesSession =
          !entry.payload?.tableSessionToken || entry.payload.tableSessionToken === sessionToken
        if (unresolved && matchesSession) {
          if (!seenKeys.has(entry.key)) {
            seenKeys.add(entry.key)
            // An interrupted 'submitting' entry may already have reached the server;
            // ensure attempts >= 1 so OrderQueue reconciles by key before re-POSTing.
            const attempts =
              entry.state === 'submitting' ? Math.max(1, entry.attempts || 0) : entry.attempts
            const migratedEntry: QueueEntry = {
              ...entry,
              state: 'pending',
              attempts,
              claimId: null,
              claimAt: null,
              ...(markCartDeducted ? { cartDeducted: true } : {}),
            }
            sessionEntries = [...sessionEntries, migratedEntry]
            migratedEntries.push(migratedEntry)
            changed = true
          }
        } else {
          remainingSource.push(entry)
        }
      }

      if (remainingSource.length !== sourceEntries.length) {
        sourceUpdates.push({ key: sourceKey, remaining: remainingSource })
      }
    }
  }

  // Persist destination BEFORE removing or updating any source key so a failed
  // write leaves the original entry intact and recoverable.
  if (changed) {
    storage.setItem(sessionQueueKey, JSON.stringify(sessionEntries))
  }
  for (const { key, remaining } of sourceUpdates) {
    if (remaining.length === 0) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(remaining))
  }
  return { sessionEntries, migratedEntries }
}

/**
 * Resolve the unit price for a restored cart line, preferring the selected
 * portion's price from the menu item before falling back to the base price.
 */
export function resolveRestoredLinePrice(
  menuItem: {
    price?: number | null
    portions?: Array<{ id?: string | null; name?: string | null; price?: number | null }> | null
  } | null | undefined,
  portion?: string | null,
  portionId?: string | null,
  explicitPrice?: number | null,
): number {
  if (typeof explicitPrice === 'number' && Number.isFinite(explicitPrice)) {
    return explicitPrice
  }
  const targetKey = normalizePortionKey(portion, portionId)
  if (targetKey && Array.isArray(menuItem?.portions)) {
    const matched = menuItem.portions.find((p) => {
      const pIdKey = p?.id ? normalizePortionKey(null, p.id) : ''
      const pNameKey = p?.name ? normalizePortionKey(p.name, null) : ''
      return (pIdKey && pIdKey === targetKey) || (pNameKey && pNameKey === targetKey)
    })
    if (matched && typeof matched.price === 'number' && Number.isFinite(matched.price)) {
      return matched.price
    }
  }
  return Number(menuItem?.price ?? 0)
}

/**
 * Filter unresolved queue entries to those that reserved items from `sourceCartSuffix`.
 * Legacy entries without `sourceCartSuffix` still match the same queue scope.
 */
export function reservationsForSourceCart(
  entries: QueueEntry[],
  sourceCartSuffix: string | null,
): QueueEntry[] {
  return entries.filter((e) => {
    if (e.state !== 'pending' && e.state !== 'submitting') return false
    if (!e.sourceCartSuffix || !sourceCartSuffix) return true
    return e.sourceCartSuffix === sourceCartSuffix
  })
}

const CHECKOUT_LOCK_TTL_MS = 2_000

/**
 * Acquire a short cross-tab storage lease for a given cart suffix so two tabs
 * cannot read the same cart snapshot and enqueue duplicate idempotency keys.
 */
export async function withCrossTabCheckoutLock<T>(
  storage: StorageLike,
  tenantId: string,
  lockScope: string,
  fn: () => T | Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const lockKey = `the-salad-checkout-lock-${tenantId}-${lockScope}`
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockKey, () => fn())
  }
  const nonce = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const raw = storage.getItem(lockKey)
      const parsed = raw ? JSON.parse(raw) : null
      const expired = !parsed || typeof parsed.ts !== 'number' || now() - parsed.ts > CHECKOUT_LOCK_TTL_MS
      if (expired || parsed.nonce === nonce) {
        storage.setItem(lockKey, JSON.stringify({ nonce, ts: now() }))
        const verify = storage.getItem(lockKey)
        if (verify && JSON.parse(verify)?.nonce === nonce) {
          break
        }
      }
    } catch {
      break
    }
    await new Promise((r) => setTimeout(r, 15))
  }

  try {
    return await fn()
  } finally {
    try {
      const cur = storage.getItem(lockKey)
      if (cur && JSON.parse(cur)?.nonce === nonce) {
        storage.removeItem(lockKey)
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Subtract quantities already committed to unresolved queue entries so a
 * reload before confirmation cannot re-expose submitted dishes for a second
 * checkout.
 */
export function subtractUnresolvedQueueQuantities<T extends SyncableCartItem>(
  items: T[],
  queueEntries: QueueEntry[],
): T[] {
  let next = items.map((c) => ({ ...c }))
  for (const entry of queueEntries) {
    if (entry.state !== 'pending' && entry.state !== 'submitting') continue
    for (const line of entry.payload?.items ?? []) {
      const qty = Math.max(1, Number(line.quantity) || 1)
      next = next
        .map((c) =>
          sameSyncCartLine(c, line.menuItemId, line.portion ?? null, line.portionId ?? null)
            ? { ...c, quantity: c.quantity - qty }
            : c,
        )
        .filter((c) => c.quantity > 0)
    }
  }
  return next
}

export function isDefinitiveSessionRejection(errorMessage: string, errorCode?: string): boolean {
  if (errorCode) {
    if (NON_SESSION_CODES.has(errorCode)) return false
    if (DEFINITIVE_SESSION_CODES.has(errorCode)) return true
  }
  const lower = (errorMessage || '').toLowerCase()
  return (
    lower.includes('session has ended') ||
    lower.includes('session ended') ||
    lower.includes('session expired') ||
    lower.includes('invalid session') ||
    lower.includes('session_invalid_or_ended') ||
    lower.includes('this table is no longer available') ||
    lower.includes('this restaurant is currently unavailable')
  )
}
