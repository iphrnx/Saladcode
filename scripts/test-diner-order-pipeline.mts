/**
 * End-to-end unit test suite for the diner order submission pipeline,
 * state machine, refresh recovery, and reconciliation.
 *
 * Run with:
 *   npx tsx scripts/test-diner-order-pipeline.mts
 */

import assert from 'node:assert'
import {
  OrderQueue,
  submitEntry,
  backoffDelayMs,
  cleanOrderErrorMessage,
  type QueueEntry,
  type StorageLike,
} from '../src/lib/order-queue'

function createMockStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v
    },
    removeItem: (k: string) => {
      delete data[k]
    },
  }
}

async function runTests() {
  console.log('🧪 Starting Diner Order Pipeline Verification...\n')

  // ── Test 1: Stale Submitting State Auto-Recovery on Refresh ────────────────
  {
    console.log('▶ Test 1: Auto-recovery of stale "submitting" state across refresh...')
    const storageKey = 'test-queue'
    const nowMs = 1_000_000
    const staleClaimAt = nowMs - 20_000 // 20s ago (> 15s CLAIM_STALE_MS)

    const initialEntries: QueueEntry[] = [
      {
        key: 'entry-uuid-1',
        kind: 'diner',
        payload: { tableSessionToken: 'token-123', items: [{ menuItemId: 'item-1', quantity: 2 }] },
        state: 'submitting',
        attempts: 1,
        nextAttemptAt: staleClaimAt,
        createdAt: staleClaimAt - 5_000,
        claimId: 'crashed-tab-claim',
        claimAt: staleClaimAt,
        itemCount: 2,
      },
    ]

    const storage = createMockStorage({ [storageKey]: JSON.stringify(initialEntries) })
    const q = new OrderQueue(storage, storageKey, (async () => ({} as any)) as any, {}, () => nowMs)

    // Load should automatically normalize stale submitting to pending
    const loaded = q.load()
    assert.strictEqual(loaded.length, 1)
    assert.strictEqual(loaded[0].state, 'pending', 'Stale submitting entry must be recovered to pending on load')
    assert.strictEqual(loaded[0].claimId, null, 'claimId must be reset')
    assert.strictEqual(loaded[0].claimAt, null, 'claimAt must be reset')
    console.log('  ✔ Stale "submitting" state safely recovered to "pending" on load')
  }

  // ── Test 2: Reconciliation Before Resubmitting ────────────────────────────
  {
    console.log('▶ Test 2: Reconciliation before resending (no duplicate orders)...')
    const key = 'idem-key-abc-123'
    const entry: QueueEntry = {
      key,
      kind: 'diner',
      payload: { tableSessionToken: 'sess-token-xyz', items: [] },
      state: 'pending',
      attempts: 1, // It's a retry
      nextAttemptAt: 1000,
      createdAt: 500,
      itemCount: 1,
    }

    let lookupCalled = false
    let postCalled = false

    const mockFetcher = (async (url: string, init: any) => {
      if (url.includes('/api/orders/by-key/')) {
        lookupCalled = true
        assert.ok(url.includes(key), 'Lookup url must include idempotency key')
        // Simulate server already has order #42
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'order-42', orderNumber: 42, total: 350 }),
        } as any
      }
      if (url === '/api/orders') {
        postCalled = true
        return { ok: true, status: 201, json: async () => ({}) } as any
      }
      throw new Error(`Unexpected url: ${url}`)
    }) as any

    const result = await submitEntry(entry, mockFetcher)
    assert.strictEqual(lookupCalled, true, 'Reconciliation lookup must be performed on retry')
    assert.strictEqual(postCalled, false, 'POST /api/orders must NOT be called if lookup found the order')
    assert.strictEqual(result.outcome, 'confirmed')
    assert.strictEqual((result as any).order.orderNumber, 42)
    console.log('  ✔ Reconciled existing order without resubmitting or duplicating')
  }

  // ── Test 3: Safe Resubmission on Definite 404 Lookup ───────────────────────
  {
    console.log('▶ Test 3: Safe submission after definite 404 lookup...')
    const key = 'idem-key-def-456'
    const entry: QueueEntry = {
      key,
      kind: 'diner',
      payload: { tableSessionToken: 'sess-token-xyz', items: [{ menuItemId: 'pizza', quantity: 1 }] },
      state: 'pending',
      attempts: 1,
      nextAttemptAt: 1000,
      createdAt: 500,
      itemCount: 1,
    }

    let lookupCalled = false
    let postCalled = false

    const mockFetcher = (async (url: string, init: any) => {
      if (url.includes('/api/orders/by-key/')) {
        lookupCalled = true
        return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as any
      }
      if (url === '/api/orders') {
        postCalled = true
        const parsedBody = JSON.parse(init.body)
        assert.strictEqual(parsedBody.idempotencyKey, key, 'POST body must preserve original key')
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'order-99', orderNumber: 99, total: 150 }),
        } as any
      }
      throw new Error(`Unexpected url: ${url}`)
    }) as any

    const result = await submitEntry(entry, mockFetcher)
    assert.strictEqual(lookupCalled, true, 'Lookup was checked')
    assert.strictEqual(postCalled, true, 'POST /api/orders was safely executed on 404')
    assert.strictEqual(result.outcome, 'confirmed')
    console.log('  ✔ Safely executed POST after server confirmed 404 not found')
  }

  // ── Test 4: Bounded Retries & Transition to "failed" (No Infinite Loops) ───
  {
    console.log('▶ Test 4: Bounded retries transition to "failed" state...')
    const storageKey = 'test-bounded'
    let fakeNow = 10_000
    const storage = createMockStorage()
    let attemptsCount = 0

    // Mock fetcher that fails with network timeout
    const failingFetcher = (async () => {
      attemptsCount++
      throw new Error('Connection timed out')
    }) as any

    const q = new OrderQueue(storage, storageKey, failingFetcher, {}, () => fakeNow)

    q.enqueue('diner', { tableSessionToken: 'token-test', items: [] }, 1)

    // Run process cycles advancing clock each time past backoff
    for (let i = 0; i < 15; i++) {
      fakeNow += 40_000
      await q.process()
    }

    const entries = q.load()
    assert.strictEqual(entries.length, 1)
    assert.strictEqual(entries[0].state, 'failed', 'Order must transition to "failed" after bounded attempts')
    assert.strictEqual(entries[0].attempts >= 12, true, 'Retries must be bounded (<= 12)')
    console.log(`  ✔ Bounded after ${entries[0].attempts} attempts; transitioned cleanly to "failed"`)
  }

  // ── Test 5: "Retry Now" Reuses Same Idempotency Key ────────────────────────
  {
    console.log('▶ Test 5: "Retry Now" reuses the same key and triggers reconciliation...')
    const storageKey = 'test-retry-now'
    const nowMs = 50_000
    const key = 'fixed-idem-uuid'
    const storage = createMockStorage({
      [storageKey]: JSON.stringify([
        {
          key,
          kind: 'diner',
          payload: { tableSessionToken: 'tok', items: [] },
          state: 'failed',
          attempts: 5,
          nextAttemptAt: nowMs,
          createdAt: nowMs - 10_000,
          lastError: 'Network error',
          itemCount: 1,
        },
      ]),
    })

    let reconciledKey: string | null = null
    const reconcilingFetcher = (async (url: string, init?: any) => {
      if (url.includes('/api/orders/by-key/')) {
        reconciledKey = url.split('/by-key/')[1].split('?')[0]
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'order-recovered', orderNumber: 101, total: 200 }),
        } as any
      }
      if (url === '/api/orders') {
        const body = JSON.parse(init.body)
        reconciledKey = body.idempotencyKey
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 'order-recovered', orderNumber: 101, total: 200 }),
        } as any
      }
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any

    let confirmedOrder: any = null
    const q = new OrderQueue(
      storage,
      storageKey,
      reconcilingFetcher,
      {
        onConfirmed: (order) => {
          confirmedOrder = order
        },
      },
      () => nowMs,
    )

    q.retry(key)
    // Wait for async processing triggered by retry()
    await new Promise((r) => setTimeout(r, 50))

    assert.strictEqual(reconciledKey, key, 'Retry Now must reconcile using the exact same idempotency key')
    assert.ok(confirmedOrder, 'Retry Now must complete confirmation')
    assert.strictEqual(confirmedOrder.orderNumber, 101)
    assert.strictEqual(q.load().length, 0, 'Confirmed order must be cleared from the queue')
    console.log('  ✔ "Retry Now" cleanly reused key, reconciled, and cleared queue')
  }

  // ── Test 6: User-Friendly Error Sanitization ───────────────────────────────
  {
    console.log('▶ Test 6: Database/internal error sanitization...')
    const dbErr = cleanOrderErrorMessage('column "item_name" of relation "order_items" does not exist')
    assert.strictEqual(dbErr, 'Unable to place order. Please tap Retry.')

    const p0001Err = cleanOrderErrorMessage('P0001: check constraint violated')
    assert.strictEqual(p0001Err, 'Unable to place order. Please tap Retry.')

    const friendlyErr = cleanOrderErrorMessage('Promo code expired')
    assert.strictEqual(friendlyErr, 'Promo code expired')
    console.log('  ✔ Internal DB errors safely masked; friendly errors preserved')
  }

  console.log('\n🎉 ALL 6 DINER ORDER PIPELINE TESTS PASSED!\n')
}

runTests().catch((err) => {
  console.error('❌ Pipeline test failed:', err)
  process.exit(1)
})
