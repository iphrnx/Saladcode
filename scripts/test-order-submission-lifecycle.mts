import assert from 'node:assert/strict'
import {
  OrderQueue,
  cleanOrderErrorMessage,
  type QueueEntry,
  type StorageLike,
} from '../src/lib/order-queue'

function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function testSuite() {
  console.log('── Testing Order Submission Lifecycle & Clean Toast Notification ──')

  // 1. Error Message Sanitization
  {
    assert.equal(
      cleanOrderErrorMessage('None of the items exist in the menu'),
      'One or more items in your cart do not exist or are no longer available. Please review your cart.',
    )
    assert.equal(
      cleanOrderErrorMessage('item_unavailable'),
      'One or more items in your cart do not exist or are no longer available. Please review your cart.',
    )
    assert.equal(
      cleanOrderErrorMessage('session_ended'),
      'This session has ended or is closed. Please start or select an active session.',
    )
    assert.equal(
      cleanOrderErrorMessage('table_required_for_dine_in'),
      'Please select a table for Dine-in orders.',
    )
    assert.equal(
      cleanOrderErrorMessage(''),
      'Unable to place order. Please review your cart and try again.',
    )
    console.log('  ✓ cleanOrderErrorMessage transforms raw backend rejections into clear user messages')
  }

  // 2. Deterministic 4xx rejection fires onFailed, marks failed, never auto-retries
  {
    const storage = createMemoryStorage()
    let failedCalledWith: { error: string; entry: QueueEntry } | null = null
    let confirmedCalled = false

    const queue = new OrderQueue(
      storage,
      'test-q-1',
      async () =>
        new Response(JSON.stringify({ error: 'None of the items exist in the menu' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }) as any,
      {
        onFailed: (error, entry) => {
          failedCalledWith = { error, entry }
        },
        onConfirmed: () => {
          confirmedCalled = true
        },
      },
    )

    queue.enqueue('pos', { items: [{ menuItemId: 'item-1', quantity: 1 }] }, 1)
    await sleep(20)

    assert.equal(confirmedCalled, false, 'Should not confirm failed order')
    assert.ok(failedCalledWith, 'onFailed must be invoked on deterministic 4xx rejection')
    assert.ok(
      failedCalledWith!.error.includes('One or more items in your cart do not exist'),
      'Error in onFailed must be cleaned',
    )
    assert.equal(queue.load()[0].state, 'failed', 'Entry state must be failed')

    // Calling process() again must NOT re-attempt or post again
    let postedAgain = false
    const queueNoPost = new OrderQueue(
      storage,
      'test-q-1',
      async () => {
        postedAgain = true
        return new Response('{}', { status: 200 }) as any
      },
    )
    await queueNoPost.process()
    assert.equal(postedAgain, false, 'Failed entries must never be automatically retried')
    console.log('  ✓ 4xx rejection invokes onFailed once and never auto-retries')
  }

  // 3. retire(key) and retireAllFailed() move entries to history and unblock UI
  {
    const storage = createMemoryStorage()
    const queue = new OrderQueue(
      storage,
      'test-q-retire',
      async () =>
        new Response(JSON.stringify({ error: 'Invalid dish' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }) as any,
    )

    const entry1 = queue.enqueue('pos', { items: [{ menuItemId: 'i-1', quantity: 1 }] }, 1)
    await sleep(20)
    const entry2 = queue.enqueue('pos', { items: [{ menuItemId: 'i-2', quantity: 2 }] }, 2)
    await sleep(20)

    assert.equal(queue.load().length, 2)
    assert.equal(queue.load().every((e) => e.state === 'failed'), true)

    // Retire entry 1 individually
    queue.retire(entry1.key)
    assert.equal(queue.load().length, 1)
    assert.equal(queue.load()[0].key, entry2.key)

    // Check history storage has entry1
    const hist = JSON.parse(storage.getItem('test-q-retire-history') || '[]')
    assert.equal(hist.length, 1)
    assert.equal(hist[0].key, entry1.key)

    // retireAllFailed() removes remaining failed entries
    queue.retireAllFailed()
    assert.equal(queue.load().length, 0, 'All failed entries must be safely retired')

    const updatedHist = JSON.parse(storage.getItem('test-q-retire-history') || '[]')
    assert.equal(updatedHist.length, 2)
    console.log('  ✓ retire() and retireAllFailed() clean active queue and archive to history')
  }

  // 4. Offline / Uncertain network outcomes stay pending with backoff and preserve idempotency key
  {
    const storage = createMemoryStorage()
    let attempts = 0
    let failedFired = false
    let confirmedFired = false

    const queue = new OrderQueue(
      storage,
      'test-q-offline',
      async () => {
        attempts++
        throw new TypeError('Failed to fetch (network drop)')
      },
      {
        onFailed: () => {
          failedFired = true
        },
        onConfirmed: () => {
          confirmedFired = true
        },
      },
    )

    const entry = queue.enqueue('diner', { tableSessionToken: 'tok-123', items: [] }, 1)
    await sleep(20)

    assert.equal(failedFired, false, 'onFailed must NOT fire on uncertain network drop')
    assert.equal(confirmedFired, false, 'onConfirmed must NOT fire until confirmed')
    assert.equal(queue.load()[0].state, 'pending', 'Entry stays pending for silent recovery')
    assert.equal(queue.load()[0].attempts, 1)
    assert.equal(queue.load()[0].key, entry.key, 'Idempotency key preserved across retries')
    console.log('  ✓ Network timeouts stay pending, silently recovering without premature failure toasts')
  }

  // 5. Successful submission fires onConfirmed and removes entry
  {
    const storage = createMemoryStorage()
    let confirmedOrder: any = null

    const queue = new OrderQueue(
      storage,
      'test-q-success',
      async () =>
        new Response(
          JSON.stringify({ id: 'ord-100', orderNumber: '100', total: 500 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as any,
      {
        onConfirmed: (order) => {
          confirmedOrder = order
        },
      },
    )

    queue.enqueue('pos', { items: [{ menuItemId: 'burger', quantity: 2 }] }, 2)
    await sleep(20)

    assert.ok(confirmedOrder, 'onConfirmed must be called')
    assert.equal(confirmedOrder.orderNumber, '100')
    assert.equal(queue.load().length, 0, 'Confirmed entry must be cleared from queue')
    console.log('  ✓ Confirmed order fires onConfirmed and clears queue immediately')
  }

  console.log('\nAll order submission lifecycle tests passed cleanly!')
}

testSuite().catch((e) => {
  console.error(e)
  process.exit(1)
})
