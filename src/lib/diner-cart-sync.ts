import { normalizePortionKey } from './portions'

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
    } else if (ext.quantity !== prev.quantity && localIdx >= 0) {
      // Apply external quantity delta (increment or decrement) when this tab kept the line.
      const nextQty = result[localIdx].quantity + (ext.quantity - prev.quantity)
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

  // Respect intentional removals by another tab for lines this tab did not modify.
  for (const prev of lastSyncedCart) {
    const stillInStored = latestStoredCart.some((ext) =>
      sameSyncCartLine(ext, prev.menuItemId, prev.portion ?? null, prev.portionId ?? null),
    )
    if (stillInStored) continue
    const localIdx = result.findIndex((l) =>
      sameSyncCartLine(l, prev.menuItemId, prev.portion ?? null, prev.portionId ?? null),
    )
    if (
      localIdx >= 0 &&
      result[localIdx].quantity === prev.quantity &&
      (result[localIdx].notes || '') === (prev.notes || '')
    ) {
      result.splice(localIdx, 1)
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
 * True when a definitive checkout rejection indicates the cached diner
 * session credential is ended, expired, or invalid (and should be cleared so
 * a retry can re-authenticate via the scanned QR).
 */
export function isDefinitiveSessionRejection(errorMessage: string): boolean {
  const lower = (errorMessage || '').toLowerCase()
  return (
    lower.includes('session has ended') ||
    lower.includes('session ended') ||
    lower.includes('session expired') ||
    lower.includes('invalid session') ||
    lower.includes('session_invalid_or_ended') ||
    lower.includes('no longer available')
  )
}
