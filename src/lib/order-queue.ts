/**
 * The pending-order queue — the single submission pipeline for every checkout,
 * POS and diner.
 *
 * The rule it exists for: an order is never duplicated, never silently lost,
 * and never forgotten because of a network drop, a timeout, a refresh, or a
 * dead server.
 *
 * How it keeps that rule:
 *
 *  - Every checkout is snapshotted with a client-generated idempotency key
 *    BEFORE the first submission attempt. The key survives refreshes in
 *    localStorage; every retry of that checkout reuses it, and the server
 *    (migration 0056) refuses to write a second order for the same key.
 *
 *  - After any uncertain attempt, the queue RECONCILES BEFORE RETRYING: it
 *    asks the server "do you already have this key?" (GET /api/orders/by-key).
 *    A found order means the lost response actually committed — the entry is
 *    confirmed locally without ever re-POSTing. Only a definite 404 leads to
 *    a resubmission. An uncertain lookup means "ask again later", never
 *    "submit and hope".
 *
 *  - One writer at a time, across tabs: an entry is claimed with a nonce
 *    before submission; a claim left by a crashed tab goes stale and can be
 *    taken over. Two tabs can never submit the same entry simultaneously.
 *
 *  - Failure is never silent and never deletes. An entry that exhausts its
 *    retries becomes 'failed' and stays visible until a human retries or
 *    explicitly dismisses it.
 *
 * The core is deliberately free of window/fetch so the whole state machine is
 * unit-testable in Node: storage, clock, and the network call are injected.
 * The browser wiring lives at the bottom of this file.
 */

import { edgeFetch } from './edge'
import { readStored, removeStored, writeStored } from './storage-keys'

export type QueueEntryState = 'pending' | 'submitting' | 'failed'

export interface QueueEntry {
  /** Idempotency key — also the entry id. One uuid per checkout, forever. */
  key: string
  kind: 'pos' | 'diner'
  /** POST body for /api/orders, exactly as the normal path sends it. */
  payload: Record<string, any>
  /** Extra request headers the normal path sends (e.g. POS x-tenant-id). */
  headers?: Record<string, string>
  state: QueueEntryState
  attempts: number
  /** Epoch ms; a pending entry is not touched before this. */
  nextAttemptAt: number
  createdAt: number
  lastError?: string
  /** Nonce of the tab currently submitting this entry. */
  claimId?: string | null
  claimAt?: number | null
  /** Human context for the status UI: item count and total snapshot. */
  itemCount: number
}

export interface QueueHooks {
  /** The order is on the server (fresh commit or reconciled). */
  onConfirmed?: (order: any, entry: QueueEntry) => void
  /** An entry changed state (pending/submitting/failed). */
  onChange?: (entries: QueueEntry[]) => void
}

export interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000
const MAX_ATTEMPTS = 12
const CLAIM_STALE_MS = 60_000

/** Backoff with ±25% jitter — retries must not arrive in lockstep. */
export function backoffDelayMs(attempt: number, rand: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1)
  // Jitter first, cap last: the wait never exceeds BACKOFF_CAP_MS.
  return Math.min(BACKOFF_CAP_MS, Math.round(base * (0.75 + rand() * 0.5)))
}

function newClaimId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  // Fallback for very old webviews: uuidv4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export type SubmitResult =
  | { outcome: 'confirmed'; order: any }
  | { outcome: 'uncertain'; error: string }
  | { outcome: 'rejected'; error: string }

/**
 * One submission cycle for one entry: reconcile first when this is a retry,
 * then submit with the original key. Network/timeout/5xx are 'uncertain'
 * (the server may have committed); a 4xx answer is a definitive 'rejected'.
 */
export async function submitEntry(
  entry: QueueEntry,
  fetcher: typeof edgeFetch,
): Promise<SubmitResult> {
  const isRetry = entry.attempts > 0
  if (isRetry) {
    // Reconcile before re-submitting — see the module comment.
    const token = entry.kind === 'diner' ? entry.payload?.tableSessionToken : null
    const lookupUrl =
      '/api/orders/by-key/' + entry.key + (token ? `?tableSessionToken=${encodeURIComponent(token)}` : '')
    try {
      const lookup = await fetcher(lookupUrl, {
        headers: entry.headers ?? {},
      })
      if (lookup.ok) {
        return { outcome: 'confirmed', order: await lookup.json() }
      }
      if (lookup.status !== 404) {
        // 401/403 (session ended) is definitive for this entry; anything
        // else (5xx) means we still do not know.
        if (lookup.status === 401 || lookup.status === 403) {
          return { outcome: 'rejected', error: 'Session ended' }
        }
        return { outcome: 'uncertain', error: `Lookup failed (${lookup.status})` }
      }
      // 404: the server definitely does not have this key — safe to submit.
    } catch {
      return { outcome: 'uncertain', error: 'Lookup unreachable' }
    }
  }

  try {
    const res = await fetcher('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
      body: JSON.stringify({ ...entry.payload, idempotencyKey: entry.key }),
    })
    if (res.ok) {
      return { outcome: 'confirmed', order: await res.json() }
    }
    const err = await res.json().catch(() => ({}))
    if (res.status >= 500) {
      return { outcome: 'uncertain', error: cleanOrderErrorMessage(err?.error) }
    }
    // A real answer from the server: the cart is wrong, the session ended, or
    // the price changed. Retrying the same payload will not fix it — a human
    // needs to see this.
    return { outcome: 'rejected', error: cleanOrderErrorMessage(err?.error || `Rejected (${res.status})`) }
  } catch (e: any) {
    return { outcome: 'uncertain', error: e?.message || 'Network error' }
  }
}

export function cleanOrderErrorMessage(raw?: string): string {
  if (!raw) return 'Order could not be sent. Please tap Retry.'
  const lower = raw.toLowerCase()
  if (
    lower.includes('column') ||
    lower.includes('relation') ||
    lower.includes('constraint') ||
    lower.includes('syntax') ||
    lower.includes('pl/pgsql') ||
    lower.includes('database') ||
    lower.includes('p0001') ||
    lower.includes('server error') ||
    lower.includes('internal') ||
    lower.includes('violates') ||
    lower.includes('duplicate key') ||
    lower.includes('foreign key') ||
    lower.includes('null value') ||
    lower.includes('does not exist') ||
    lower.includes('malformed') ||
    lower.includes('function ') ||
    lower.includes('sql')
  ) {
    return 'Unable to place order. Please tap Retry.'
  }
  return raw
}

/**
 * The queue for one scope (one restaurant + one actor). Scopes never mix:
 * a POS queue for tenant A and a diner queue for tenant B are different
 * storage keys and different processors.
 */
export class OrderQueue {
  constructor(
    private readonly storage: StorageLike,
    private readonly storageKey: string,
    private readonly fetcher: typeof edgeFetch,
    private readonly hooks: QueueHooks = {},
    private readonly now: () => number = Date.now,
  ) {}

  private processing = false

  load(): QueueEntry[] {
    try {
      const raw = this.storage.getItem(this.storageKey)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private save(entries: QueueEntry[]) {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(entries))
    } catch {
      /* storage full/blocked — the in-memory run still completes */
    }
    this.hooks.onChange?.(entries)
  }

  /** Snapshot a checkout into the queue and start processing immediately. */
  enqueue(
    kind: 'pos' | 'diner',
    payload: Record<string, any>,
    itemCount: number,
    headers?: Record<string, string>,
  ): QueueEntry {
    const entry: QueueEntry = {
      key: newKey(),
      kind,
      payload,
      headers,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: this.now(),
      createdAt: this.now(),
      itemCount,
    }
    const entries = [...this.load(), entry]
    this.save(entries)
    void this.process()
    return entry
  }

  /** Human retry of a failed entry: reset the clock, keep the key. */
  retry(key: string) {
    const entries = this.load().map((e) =>
      e.key === key
        ? { ...e, state: 'pending' as const, attempts: 0, nextAttemptAt: this.now(), lastError: undefined, claimId: null }
        : e,
    )
    this.save(entries)
    void this.process()
  }

  /**
   * Explicit human discard. Before dropping, reconcile: if the server has the
   * order after all, this is not a discard — it is a confirmation.
   * If the server confirms 404 (not found) or 401/403, the order is definitely
   * not created, so we drop it from the queue without re-submitting.
   */
  async dismiss(key: string): Promise<'confirmed' | 'removed' | 'uncertain'> {
    const entries = this.load()
    const entry = entries.find((e) => e.key === key)
    if (!entry) return 'removed'

    const token = entry.kind === 'diner' ? entry.payload?.tableSessionToken : null
    const lookupUrl =
      '/api/orders/by-key/' + entry.key + (token ? `?tableSessionToken=${encodeURIComponent(token)}` : '')

    try {
      const lookup = await this.fetcher(lookupUrl, {
        headers: entry.headers ?? {},
      })
      if (lookup.ok) {
        const order = await lookup.json().catch(() => null)
        this.confirm(key, order)
        return 'confirmed'
      }
      if (lookup.status === 404 || lookup.status === 401 || lookup.status === 403) {
        // The server definitely does not have this order; dropping is safe.
        this.save(this.load().filter((e) => e.key !== key))
        return 'removed'
      }
      // If server returned 5xx, drop from local queue since user explicitly dismissed it
      this.save(this.load().filter((e) => e.key !== key))
      return 'removed'
    } catch {
      // Offline / network failure: respect the user's explicit request to dismiss
      this.save(this.load().filter((e) => e.key !== key))
      return 'removed'
    }
  }

  private confirm(key: string, order: any) {
    const entries = this.load()
    const entry = entries.find((e) => e.key === key)
    this.save(entries.filter((e) => e.key !== key))
    if (entry) this.hooks.onConfirmed?.(order, entry)
  }

  /**
   * Claim-and-submit every due entry, one at a time. Single-flight per tab;
   * the claim nonce guards the cross-tab case (two tabs read the same entry
   * — the second claim write loses the readback and steps aside).
   */
  async process(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      for (;;) {
        const now = this.now()
        const entries = this.load()
        const due = entries.find(
          (e) =>
            e.state === 'pending' &&
            e.nextAttemptAt <= now &&
            (!e.claimId || !e.claimAt || now - e.claimAt > CLAIM_STALE_MS),
        )
        if (!due) return

        const claimId = newClaimId()
        let claimed = entries.map((e) =>
          e.key === due.key ? { ...e, state: 'submitting' as const, claimId, claimAt: now } : e,
        )
        this.save(claimed)

        // Readback: the last writer holds the claim.
        const held = this.load().find((e) => e.key === due.key)
        if (!held || held.claimId !== claimId) continue

        const result = await submitEntry(held, this.fetcher)
        const fresh = this.load().filter((e) => e.key !== due.key || e.claimId === claimId)
        if (result.outcome === 'confirmed') {
          this.confirm(due.key, result.order)
        } else if (result.outcome === 'rejected') {
          this.save(
            fresh.map((e) =>
              e.key === due.key
                ? { ...e, state: 'failed' as const, lastError: result.error, claimId: null, claimAt: null }
                : e,
            ),
          )
        } else {
          const attempts = held.attempts + 1
          this.save(
            fresh.map((e) =>
              e.key === due.key
                ? {
                    ...e,
                    state: attempts >= MAX_ATTEMPTS ? ('failed' as const) : ('pending' as const),
                    attempts,
                    nextAttemptAt: this.now() + backoffDelayMs(attempts),
                    lastError: result.error,
                    claimId: null,
                    claimAt: null,
                  }
                : e,
            ),
          )
        }
      }
    } finally {
      this.processing = false
    }
  }

  /** Due in the future? Schedule one wake-up so a lone pending entry still goes. */
  nextDueInMs(): number | null {
    const entries = this.load().filter((e) => e.state === 'pending')
    if (!entries.length) return null
    return Math.max(0, Math.min(...entries.map((e) => e.nextAttemptAt)) - this.now())
  }
}

// ---------------------------------------------------------------------------
// Browser wiring. The class above is the state machine; this is what connects
// it to localStorage, online/offline events, and a per-scope singleton so the
// POS, the diner menu, and a returning page all share one queue.
// ---------------------------------------------------------------------------

const instances = new Map<string, OrderQueue>()
const wakeTimers = new Map<string, number>()

/** The (singleton per scope) queue for this restaurant + actor. */
export function orderQueue(tenantId: string, actorId: string, hooks: QueueHooks = {}): OrderQueue {
  const id = `${tenantId}:${actorId}`
  let q = instances.get(id)
  if (!q) {
    // Scoped by restaurant AND actor: a queue never crosses either boundary.
    const suffix = `${tenantId}-${actorId}`
    const storage: StorageLike = {
      getItem: () => readStored('orderQueue', suffix),
      setItem: (_k, v) => writeStored('orderQueue', v, suffix),
      removeItem: () => removeStored('orderQueue', suffix),
    }
    q = new OrderQueue(storage, id, edgeFetch, hooks)
    instances.set(id, q)
  } else {
    // Latest hooks win — a remounting component must not lose confirmations.
    Object.assign((q as any).hooks, hooks)
  }
  return q
}

/**
 * Resume processing for a scope and keep it alive: on reconnect, on a timer
 * (a safety net for missed events), and whenever an entry's backoff expires.
 */
export function startOrderQueue(tenantId: string, actorId: string, hooks: QueueHooks = {}): () => void {
  const q = orderQueue(tenantId, actorId, hooks)
  const id = `${tenantId}:${actorId}`
  let stopped = false

  const kick = () => {
    if (stopped) return
    void q.process().then(scheduleWake)
  }
  const scheduleWake = () => {
    if (stopped) return
    const dueIn = q.nextDueInMs()
    if (dueIn === null) return
    const prev = wakeTimers.get(id)
    if (prev) window.clearTimeout(prev)
    wakeTimers.set(id, window.setTimeout(kick, dueIn + 50))
  }

  const onOnline = () => kick()
  window.addEventListener('online', onOnline)
  const interval = window.setInterval(kick, 20_000)
  kick()

  return () => {
    stopped = true
    window.removeEventListener('online', onOnline)
    window.clearInterval(interval)
    const t = wakeTimers.get(id)
    if (t) window.clearTimeout(t)
    wakeTimers.delete(id)
  }
}
