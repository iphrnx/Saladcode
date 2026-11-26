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
  /** Unique version token for the draft content, used to deduplicate recovery across repeated closures. */
  draftVersion?: string
}

export interface RecoverablePosDraft extends Omit<PosCartSnapshot, 'selectedSessionId'> {
  sessionId: string
  sourceVersion?: string
}

export type OrderLineRef = {
  menuItemId: string
  portion?: string | null
  portionId?: string | null
  quantity: number
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

function recoverableSuffix(tenantId: string, userId: string): string {
  return `${tenantId}-${userId}-recoverable`
}

function lockSuffix(tenantId: string, userId: string): string {
  return `${tenantId}-${userId}-lock`
}

let draftSeq = 0
function nextDraftVersion(): string {
  draftSeq += 1
  return `${Date.now()}-${draftSeq}-${Math.random().toString(36).slice(2, 8)}`
}

const LOCK_STALE_MS = 2000

function acquireRecoveryLock(tenantId: string, userId: string): string | null {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const existingRaw = readStored('posCart', lockSuffix(tenantId, userId))
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw)
      if (parsed && typeof parsed.ts === 'number' && Date.now() - parsed.ts < LOCK_STALE_MS) {
        return null
      }
    } catch {}
  }
  const wrote = writeStored('posCart', JSON.stringify({ nonce, ts: Date.now() }), lockSuffix(tenantId, userId))
  if (!wrote) return nonce // If storage lock itself can't be written, proceed with in-storage check
  const verifyRaw = readStored('posCart', lockSuffix(tenantId, userId))
  if (verifyRaw) {
    try {
      const parsed = JSON.parse(verifyRaw)
      if (parsed?.nonce && parsed.nonce !== nonce) return null
    } catch {}
  }
  return nonce
}

function releaseRecoveryLock(tenantId: string, userId: string, nonce: string): void {
  const currentRaw = readStored('posCart', lockSuffix(tenantId, userId))
  if (!currentRaw) return
  try {
    const parsed = JSON.parse(currentRaw)
    if (parsed?.nonce === nonce) {
      removeStored('posCart', lockSuffix(tenantId, userId))
    }
  } catch {
    removeStored('posCart', lockSuffix(tenantId, userId))
  }
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

const CONSUMED_RECOVERY_KEY = '__consumed_recoveries'

/** Read all session drafts for this tenant+user. */
function getPosSessionDraftsRaw(
  tenantId: string,
  userId: string,
): Record<string, any> {
  const raw = readStored('posCart', draftsSuffix(tenantId, userId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function getPosSessionDrafts(
  tenantId: string,
  userId: string,
): Record<string, PosCartSnapshot> {
  const raw = getPosSessionDraftsRaw(tenantId, userId)
  const out: Record<string, PosCartSnapshot> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k === CONSUMED_RECOVERY_KEY) continue
    if (v && Array.isArray(v.cart)) {
      out[k] = v as PosCartSnapshot
    }
  }
  return out
}

interface ConsumedRecoveryEntry {
  savedAt: number
  version?: string
}

function getConsumedRecoveries(
  tenantId: string,
  userId: string,
): Record<string, ConsumedRecoveryEntry | number> {
  const raw = getPosSessionDraftsRaw(tenantId, userId)
  const map = raw[CONSUMED_RECOVERY_KEY]
  return map && typeof map === 'object' ? (map as Record<string, ConsumedRecoveryEntry | number>) : {}
}

export function isRecoveryConsumed(
  tenantId: string,
  userId: string,
  sessionId: string | null | undefined,
  sourceVersion?: string | null,
  savedAt?: number,
): boolean {
  const sid = sessionId?.trim()
  if (!sid) return false
  const entry = getConsumedRecoveries(tenantId, userId)[sid]
  if (!entry) return false
  if (typeof entry === 'number') {
    return savedAt !== undefined ? entry >= savedAt : false
  }
  if (sourceVersion && entry.version && entry.version === sourceVersion) {
    return true
  }
  if (savedAt !== undefined && entry.savedAt >= savedAt && (!sourceVersion || !entry.version)) {
    return true
  }
  return false
}

/** Save a draft for a specific session (or default unattached cart). Returns true if persisted. */
export function savePosSessionDraft(
  tenantId: string,
  userId: string,
  sessionKey: string | null | undefined,
  snapshot: Omit<PosCartSnapshot, 'savedAt'>,
  consumedRecovery?: { sessionId: string; savedAt: number; version?: string },
): boolean {
  const drafts = getPosSessionDraftsRaw(tenantId, userId)
  const key = sessionDraftKey(sessionKey)
  const now = Date.now()
  if (snapshot.cart.length === 0) {
    delete drafts[key]
  } else {
    drafts[key] = {
      ...snapshot,
      draftVersion: snapshot.draftVersion ?? nextDraftVersion(),
      savedAt: now,
    }
  }
  if (consumedRecovery?.sessionId) {
    const prevConsumed = drafts[CONSUMED_RECOVERY_KEY] && typeof drafts[CONSUMED_RECOVERY_KEY] === 'object'
      ? drafts[CONSUMED_RECOVERY_KEY]
      : {}
    drafts[CONSUMED_RECOVERY_KEY] = {
      ...prevConsumed,
      [consumedRecovery.sessionId]: {
        savedAt: consumedRecovery.savedAt,
        version: consumedRecovery.version,
      },
    }
  }
  const draftsOk = writeStored('posCart', JSON.stringify(drafts), draftsSuffix(tenantId, userId))
  if (!draftsOk) return false
  // `draftsSuffix` is the single authoritative commit. Mirroring to the legacy
  // single-cart key is best-effort; if it fails, clear any stale legacy value
  // and still treat the authoritative write as committed so moves never leave
  // duplicate copies across reload.
  if (key === 'default') {
    const mirrorOk = writeStored('posCart', JSON.stringify({ ...snapshot, selectedSessionId: null, savedAt: now }), suffix(tenantId, userId))
    if (!mirrorOk) {
      removeStored('posCart', suffix(tenantId, userId))
    }
  }
  return true
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
  const drafts = getPosSessionDraftsRaw(tenantId, userId)
  const key = sessionDraftKey(sessionKey)
  delete drafts[key]
  writeStored('posCart', JSON.stringify(drafts), draftsSuffix(tenantId, userId))
  if (key === 'default') {
    removeStored('posCart', suffix(tenantId, userId))
  }
}

/**
 * Subtract submitted order lines from a cart array, preserving any unsubmitted
 * quantities or items added after submission.
 */
export function subtractLinesFromCart(
  cart: CartItem[],
  lines: OrderLineRef[],
): CartItem[] {
  let remaining = [...cart]
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
  return remaining
}

/**
 * Subtract submitted order lines from a stored draft, preserving any items
 * added after submission. Deletes the draft if no items remain.
 */
export function subtractPosSessionDraft(
  tenantId: string,
  userId: string,
  sessionKey: string | null | undefined,
  lines: OrderLineRef[],
): PosCartSnapshot | null {
  const existing = getPosSessionDraft(tenantId, userId, sessionKey)
  if (!existing || !Array.isArray(existing.cart) || existing.cart.length === 0) return null

  const remaining = subtractLinesFromCart(existing.cart, lines)

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

function readRecoverableDraftMap(
  tenantId: string,
  userId: string,
): Record<string, RecoverablePosDraft> {
  const raw = readStored('posCart', recoverableSuffix(tenantId, userId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    // Backwards compatibility: normalize legacy single-object format into a keyed map
    if (typeof (parsed as any).sessionId === 'string' && Array.isArray((parsed as any).cart)) {
      const legacy = parsed as RecoverablePosDraft
      const sid = legacy.sessionId.trim()
      if (
        legacy.cart.length > 0 &&
        sid &&
        !isRecoveryConsumed(tenantId, userId, sid, legacy.sourceVersion, legacy.savedAt ?? 0)
      ) {
        return { [sid]: legacy }
      }
      return {}
    }
    const out: Record<string, RecoverablePosDraft> = {}
    for (const [key, val] of Object.entries(parsed as Record<string, any>)) {
      if (val && typeof val.sessionId === 'string' && Array.isArray(val.cart) && val.cart.length > 0) {
        if (isRecoveryConsumed(tenantId, userId, val.sessionId, val.sourceVersion, val.savedAt ?? 0)) {
          continue
        }
        out[key] = val as RecoverablePosDraft
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeRecoverableDraftMap(
  tenantId: string,
  userId: string,
  map: Record<string, RecoverablePosDraft>,
): boolean {
  const keys = Object.keys(map)
  if (keys.length === 0) {
    return removeStored('posCart', recoverableSuffix(tenantId, userId))
  }
  return writeStored('posCart', JSON.stringify(map), recoverableSuffix(tenantId, userId))
}

/** Save unsent items from a remotely closed sitting into a per-session recoverable draft. */
export function saveRecoverablePosDraft(
  tenantId: string,
  userId: string,
  draft: Omit<RecoverablePosDraft, 'savedAt'>,
): RecoverablePosDraft | null {
  const sid = draft.sessionId?.trim()
  if (!sid || !Array.isArray(draft.cart) || draft.cart.length === 0) {
    return null
  }
  if (draft.sourceVersion && isRecoveryConsumed(tenantId, userId, sid, draft.sourceVersion)) {
    return null
  }
  const stored: RecoverablePosDraft = {
    ...draft,
    sessionId: sid,
    cart: [...draft.cart],
    savedAt: Date.now(),
  }
  const map = readRecoverableDraftMap(tenantId, userId)
  map[sid] = stored
  if (!writeRecoverableDraftMap(tenantId, userId, map)) {
    return null
  }
  return stored
}

/** List all recoverable drafts for this tenant+user (newest first). */
export function getRecoverablePosDrafts(
  tenantId: string,
  userId: string,
): RecoverablePosDraft[] {
  const map = readRecoverableDraftMap(tenantId, userId)
  return Object.values(map).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
}

/** Read a specific recoverable draft (or the latest one if sessionId is omitted). */
export function getRecoverablePosDraft(
  tenantId: string,
  userId: string,
  sessionId?: string | null,
): RecoverablePosDraft | null {
  const map = readRecoverableDraftMap(tenantId, userId)
  if (sessionId?.trim()) {
    return map[sessionId.trim()] ?? null
  }
  const all = Object.values(map).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
  return all[0] ?? null
}

/** Clear one recoverable draft by sessionId, or all recoverable drafts if omitted. */
export function clearRecoverablePosDraft(
  tenantId: string,
  userId: string,
  sessionId?: string | null,
): void {
  if (!sessionId?.trim()) {
    removeStored('posCart', recoverableSuffix(tenantId, userId))
    return
  }
  const map = readRecoverableDraftMap(tenantId, userId)
  delete map[sessionId.trim()]
  writeRecoverableDraftMap(tenantId, userId, map)
}

/**
 * Subtract confirmed order lines from a recoverable draft if it belongs to
 * the confirmed session. Clears only that session's draft if no items remain.
 */
export function subtractRecoverablePosDraft(
  tenantId: string,
  userId: string,
  sessionId: string | null | undefined,
  lines: OrderLineRef[],
): RecoverablePosDraft | null {
  const sid = sessionId?.trim()
  if (!sid) return null
  const existing = getRecoverablePosDraft(tenantId, userId, sid)
  if (!existing) return null

  const remaining = subtractLinesFromCart(existing.cart, lines)
  if (remaining.length === 0) {
    clearRecoverablePosDraft(tenantId, userId, sid)
    return null
  }
  return saveRecoverablePosDraft(tenantId, userId, {
    ...existing,
    cart: remaining,
  })
}

export type RecoverDraftResult =
  | { ok: true; snapshot: PosCartSnapshot }
  | { ok: false; reason: 'non_empty' | 'empty_recoverable' | 'storage_error' }

/**
 * Move a recoverable draft (by sessionId, or latest if omitted) into an empty
 * unattached cart. Acquires cross-tab lock, re-checks both canonical and
 * legacy persisted unattached drafts inside the critical section, and records
 * the recovery as consumed inside the same authoritative `draftsSuffix` write
 * so even if source cleanup fails, the same draft can never be recovered twice.
 */
export function tryRecoverDraftToUnattachedCart(
  tenantId: string,
  userId: string,
  currentUnattachedCart: CartItem[],
  sessionId?: string | null,
  beforeCommitHook?: () => void,
): RecoverDraftResult {
  if (currentUnattachedCart.length > 0) {
    return { ok: false, reason: 'non_empty' }
  }
  const lockNonce = acquireRecoveryLock(tenantId, userId)
  if (!lockNonce) {
    return { ok: false, reason: 'non_empty' }
  }
  try {
    const recoverable = getRecoverablePosDraft(tenantId, userId, sessionId)
    if (!recoverable || recoverable.cart.length === 0) {
      return { ok: false, reason: 'empty_recoverable' }
    }

    if (beforeCommitHook) {
      beforeCommitHook()
    }

    // Re-read persisted unattached cart (including legacy-only drafts) inside the lock
    // immediately before committing so an interleaved save from another tab is never overwritten.
    const persistedUnattached = restorePosCart(tenantId, userId)
    if (persistedUnattached && persistedUnattached.cart.length > 0) {
      return { ok: false, reason: 'non_empty' }
    }

    const unattached: Omit<PosCartSnapshot, 'savedAt'> = {
      cart: [...recoverable.cart],
      orderType: recoverable.orderType,
      selectedTableId: recoverable.selectedTableId,
      selectedSessionId: null,
      customerName: recoverable.customerName ?? '',
      customerPhone: recoverable.customerPhone ?? '',
      promoCode: recoverable.promoCode ?? '',
    }
    if (
      !savePosSessionDraft(tenantId, userId, null, unattached, {
        sessionId: recoverable.sessionId,
        savedAt: recoverable.savedAt,
        version: recoverable.sourceVersion,
      })
    ) {
      return { ok: false, reason: 'storage_error' }
    }
    clearRecoverablePosDraft(tenantId, userId, recoverable.sessionId)
    return { ok: true, snapshot: { ...unattached, savedAt: Date.now() } }
  } finally {
    releaseRecoveryLock(tenantId, userId, lockNonce)
  }
}

/**
 * Move a recoverable draft (by sessionId, or latest if omitted) into an empty
 * unattached cart, clearing only that recoverable draft so items can only be
 * recovered once. Returns null if nothing matches, unattached cart is non-empty,
 * or storage write fails.
 */
export function recoverDraftToUnattachedCart(
  tenantId: string,
  userId: string,
  currentUnattachedCart: CartItem[],
  sessionId?: string | null,
): PosCartSnapshot | null {
  const res = tryRecoverDraftToUnattachedCart(tenantId, userId, currentUnattachedCart, sessionId)
  return res.ok ? res.snapshot : null
}

export interface SessionGroupLike {
  tableId?: string | null
  table?: { name?: string | null; area?: string | null } | null
  sessions?: Array<{
    id: string
    status?: string | null
    orderType?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | null
    customerName?: string | null
    paymentVerificationPending?: boolean | null
    check?: { status?: string | null } | null
  }>
}

/**
 * Find the underlying session & its parent group from `/table-session/active`
 * and determine whether it is still open and editable.
 *
 * Unlike `activeSessionCards` (which includes ENDED unpaid bills and hides
 * ACTIVE sessions whose orders were all cancelled), this checks the real
 * session lifecycle and settlement status.
 */
export function findEditableSession(
  sessionId: string | null | undefined,
  sessionGroups: SessionGroupLike[],
): {
  sessionId: string
  tableId: string | null
  orderType?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
  customerName?: string
  isVerifyingPayment: boolean
} | null {
  const sid = sessionId?.trim()
  if (!sid) return null
  for (const group of sessionGroups) {
    for (const s of group.sessions ?? []) {
      if (s.id !== sid) continue
      const checkStatus = String(s.check?.status ?? '').toUpperCase()
      if (s.status !== 'ACTIVE' || checkStatus === 'PAID' || checkStatus === 'VOID') {
        return null
      }
      return {
        sessionId: s.id,
        tableId: group.tableId ?? null,
        orderType: (s.orderType ?? (group.tableId ? 'DINE_IN' : 'TAKEAWAY')) as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
        customerName: s.customerName ?? undefined,
        isVerifyingPayment: Boolean(s.paymentVerificationPending || checkStatus === 'VERIFYING'),
      }
    }
  }
  return null
}

export function isSessionEditable(
  sessionId: string | null | undefined,
  sessionGroups: SessionGroupLike[],
): boolean {
  return findEditableSession(sessionId, sessionGroups) !== null
}

export type SessionLifecycleState = 'open' | 'closed' | 'unknown'

export interface SessionLifecycleResolution {
  state: SessionLifecycleState
  editable: {
    sessionId: string
    tableId: string | null
    orderType?: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY'
    customerName?: string
    isVerifyingPayment: boolean
  } | null
}

/**
 * Resolve authoritative session lifecycle from `/table-session/active` groups,
 * `/orders/sync` `tableSessions`, and `checks`.
 *
 * `/table-session/active` omits `ACTIVE` sessions older than 3 minutes that have
 * zero live orders and zero balance (e.g. after their last order is cancelled).
 * Absence from `/table-session/active` alone is therefore treated as `'unknown'`
 * unless authoritative `tableSessions` confirms closure (`'ENDED'` / `endedAt`),
 * or confirms it is still `'ACTIVE'` (`'open'`).
 */
export function resolveSessionLifecycle(
  sessionId: string | null | undefined,
  sessionGroups: SessionGroupLike[],
  tableSessions?: Record<string, { id: string; tableId: string | null; status: string; endedAt?: string | null }>,
  checks?: Record<string, { status?: string | null }>,
  orders?: Array<{ tableSessionId?: string | null; checkId?: string | null; orderType?: string | null; customerName?: string | null }>,
): SessionLifecycleResolution {
  const sid = sessionId?.trim()
  if (!sid) return { state: 'closed', editable: null }

  const authSess = tableSessions?.[sid]

  for (const group of sessionGroups) {
    for (const s of group.sessions ?? []) {
      if (s.id !== sid) continue
      const checkStatus = String(s.check?.status ?? '').toUpperCase()
      if (
        s.status === 'ENDED' ||
        authSess?.status === 'ENDED' ||
        Boolean(authSess?.endedAt) ||
        checkStatus === 'PAID' ||
        checkStatus === 'VOID'
      ) {
        return { state: 'closed', editable: null }
      }
      if (s.status === 'ACTIVE') {
        return {
          state: 'open',
          editable: {
            sessionId: s.id,
            tableId: group.tableId ?? null,
            orderType: (s.orderType ?? (group.tableId ? 'DINE_IN' : 'TAKEAWAY')) as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
            customerName: s.customerName ?? undefined,
            isVerifyingPayment: Boolean(s.paymentVerificationPending || checkStatus === 'VERIFYING'),
          },
        }
      }
    }
  }

  // Session omitted from `/table-session/active`: consult authoritative `tableSessions`
  if (authSess) {
    if (authSess.status === 'ENDED' || Boolean(authSess.endedAt)) {
      return { state: 'closed', editable: null }
    }
    if (authSess.status === 'ACTIVE') {
      const sessOrders = (orders ?? []).filter((o) => o.tableSessionId === sid)
      for (const o of sessOrders) {
        if (o.checkId && checks?.[o.checkId]) {
          const cs = String(checks[o.checkId].status ?? '').toUpperCase()
          if (cs === 'PAID' || cs === 'VOID') {
            return { state: 'closed', editable: null }
          }
        }
      }
      const lastOrder = sessOrders[sessOrders.length - 1]
      return {
        state: 'open',
        editable: {
          sessionId: sid,
          tableId: authSess.tableId ?? null,
          orderType: ((lastOrder?.orderType as any) ?? (authSess.tableId ? 'DINE_IN' : 'TAKEAWAY')) as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
          customerName: lastOrder?.customerName ?? undefined,
          isVerifyingPayment: false,
        },
      }
    }
  }

  // Neither active list nor delta sync has a definitive record yet: preserve draft/selection
  return { state: 'unknown', editable: null }
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
  removeStored('posCart', recoverableSuffix(tenantId, userId))
}
