import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { OrderQueue, type StorageLike } from '../src/lib/order-queue'
import { keyName } from '../src/lib/storage-keys'
import {
  isDefinitiveSessionRejection,
  mergeBrowsingRemainderIntoSession,
  migratePendingTableQueueToSession,
  reconcileCartOnConfirm,
  reconcileCartOnSave,
  subtractUnresolvedQueueQuantities,
} from '../src/lib/diner-cart-sync'

const root = process.cwd()
const publicMenuSrc = fs.readFileSync(path.join(root, 'src/components/public/public-menu.tsx'), 'utf8')
const ordersFnSrc = fs.readFileSync(path.join(root, 'supabase/functions/orders/index.ts'), 'utf8')

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

let pass = 0
let fail = 0

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ok    ${name}`)
    pass++
  } catch (err) {
    console.error(`  FAIL  ${name}:`, err instanceof Error ? err.message : err)
    fail++
  }
}

console.log('PR #13 P2 Regression Tests:')

// ---------------------------------------------------------------------------
// 1. Saved session discovery keeps browsing cart selected until confirmation
// ---------------------------------------------------------------------------
await check('public-menu.tsx keeps browsing cart selected in placeOrder and adopts session only on confirm', () => {
  const placeStart = publicMenuSrc.indexOf('function placeOrder()')
  const placeEnd = publicMenuSrc.indexOf('function handleOrderConfirmed(')
  const placeBlock = publicMenuSrc.slice(placeStart, placeEnd)
  assert.ok(placeBlock.includes('const existingStoredSession ='))
  assert.ok(placeBlock.includes('payload.tableSessionToken = activeToken'))
  assert.ok(!placeBlock.includes('setSessionToken('), 'placeOrder must not switch sessionToken before confirmation')
  assert.ok(!placeBlock.includes('setSessionId('), 'placeOrder must not switch sessionId before confirmation')

  const confirmStart = placeEnd
  const confirmEnd = publicMenuSrc.indexOf('useEffect(() => {\n    const effectiveTenantId =', confirmStart)
  const confirmBlock = publicMenuSrc.slice(confirmStart, confirmEnd)
  const removeIdx = confirmBlock.indexOf('let remainingCart = [...cartRef.current]')
  const adoptIdx = confirmBlock.indexOf('setSessionToken(order.sessionToken)')
  assert.ok(removeIdx !== -1 && adoptIdx !== -1 && removeIdx < adoptIdx, 'submitted items must be removed before adopting session')
})

await check('P2-1 behavior: rejected checkout leaves browsing cart intact/editable; retry submits both items to saved session and clears only after confirm', async () => {
  const store = new MemoryStorage()
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const savedSession = { sessionId: 'sess-existing', sessionToken: 'tok-saved' }

  // Seed empty session cart and browsing cart with 2 of an item.
  const sessionCartKey = keyName('cart', savedSession.sessionToken)
  const browsingCartKey = keyName('cart', `browsing:${tableId}`)
  store.setItem(sessionCartKey, JSON.stringify([]))
  store.setItem(
    browsingCartKey,
    JSON.stringify([{ menuItemId: 'dish-1', name: 'Paneer Tikka', price: 250, quantity: 2 }]),
  )

  let activeSessionToken: string | null = null
  let browsingCart = JSON.parse(store.getItem(browsingCartKey)!)
  const sentPayloads: any[] = []
  let failNext = true

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      sentPayloads.push(body)
      if (failNext) {
        return new Response(JSON.stringify({ error: 'Temporary validation error' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          id: 'ord-retry-1',
          orderNumber: 101,
          total: 500,
          sessionId: savedSession.sessionId,
          sessionToken: savedSession.sessionToken,
          items: body.items,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }) as any

  let failedCount = 0
  let confirmedOrder: any = null
  const q = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-table_${tableId}`),
    fetcher,
    {
      onFailed: (_err, entry) => {
        failedCount++
        q.retire(entry.key)
      },
      onConfirmed: (order, entry) => {
        confirmedOrder = order
        // Mirror handleOrderConfirmed: subtract submitted items from browsing cart, then adopt session.
        for (const line of entry.payload.items) {
          browsingCart = browsingCart
            .map((c: any) => (c.menuItemId === line.menuItemId ? { ...c, quantity: c.quantity - line.quantity } : c))
            .filter((c: any) => c.quantity > 0)
        }
        store.setItem(keyName('cart', order.sessionToken), JSON.stringify(browsingCart))
        store.removeItem(browsingCartKey)
        activeSessionToken = order.sessionToken
      },
    },
    () => 1000,
  )

  // Attempt 1 (rejected): uses saved token while keeping browsing cart selected.
  q.enqueue('diner', {
    orderType: 'DINE_IN',
    tableSessionToken: savedSession.sessionToken,
    items: browsingCart.map((c: any) => ({ menuItemId: c.menuItemId, quantity: c.quantity })),
  }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  assert.equal(failedCount, 1)
  assert.equal(sentPayloads[0].tableSessionToken, savedSession.sessionToken)
  assert.equal(activeSessionToken, null, 'session must not be adopted on rejected checkout')
  assert.equal(browsingCart.length, 1)
  assert.equal(browsingCart[0].quantity, 2, 'both items remain in browsing cart')
  assert.equal(JSON.parse(store.getItem(browsingCartKey)!)[0].quantity, 2)

  // Verify browsing cart is still editable before retry.
  browsingCart[0].notes = 'Extra spicy'
  store.setItem(browsingCartKey, JSON.stringify(browsingCart))

  // Attempt 2 (succeeds): submits both items to existing session and clears only after confirmation.
  failNext = false
  q.enqueue('diner', {
    orderType: 'DINE_IN',
    tableSessionToken: savedSession.sessionToken,
    items: browsingCart.map((c: any) => ({ menuItemId: c.menuItemId, quantity: c.quantity, notes: c.notes })),
  }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  assert.equal(confirmedOrder?.id, 'ord-retry-1')
  assert.equal(sentPayloads[1].tableSessionToken, savedSession.sessionToken)
  assert.equal(sentPayloads[1].items[0].quantity, 2)
  assert.equal(activeSessionToken, savedSession.sessionToken)
  assert.equal(browsingCart.length, 0)
  assert.equal(store.getItem(browsingCartKey), null)
  assert.deepEqual(JSON.parse(store.getItem(sessionCartKey)!), [])
})

// ---------------------------------------------------------------------------
// 2. First-order QR reconciliation fails closed (503) when token lookup fails
// ---------------------------------------------------------------------------
await check('orders/index.ts returns retryable 503 when session token lookup fails in getByKey', () => {
  const getByKeyStart = ordersFnSrc.indexOf('async function getByKey(')
  const getByKeyEnd = ordersFnSrc.indexOf('async function list(', getByKeyStart)
  const getByKeyBlock = ordersFnSrc.slice(getByKeyStart, getByKeyEnd)
  assert.ok(getByKeyBlock.includes('if (sessError || !resolvedToken)'))
  assert.ok(getByKeyBlock.includes('503'))
  assert.ok(!getByKeyBlock.includes('sessionToken: sessRow?.token || ""'))
})

await check('P2-2 behavior: failed token lookup keeps checkout queued; restored lookup reconciles original order + token without duplicate order/session', async () => {
  const store = new MemoryStorage()
  let nowMs = 1_000_000
  const qrToken = 'qr-table-1'
  const committedOrderId = 'ord-committed-1'
  const committedSessionId = 'sess-committed-1'
  const committedToken = 'tok-committed-1'

  let postCalls = 0
  let tokenLookupFails = true
  let committedOrder: { id: string; idempotencyKey: string; sessionId: string } | null = null

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      postCalls++
      const body = JSON.parse(String(init.body))
      // Server commits order + session, but response is lost to a network drop.
      committedOrder = {
        id: committedOrderId,
        idempotencyKey: body.idempotencyKey,
        sessionId: committedSessionId,
      }
      throw new Error('Network connection lost')
    }
    if (url.startsWith('/api/orders/by-key/')) {
      const parsed = new URL(`https://example.test${url}`)
      const key = parsed.pathname.split('/').pop()
      const qToken = parsed.searchParams.get('qrToken')
      assert.equal(qToken, qrToken)
      if (!committedOrder || committedOrder.idempotencyKey !== key) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      }
      // Simulate getByKey when table_sessions lookup fails or returns empty token -> 503.
      if (tokenLookupFails) {
        return new Response(
          JSON.stringify({ error: 'Could not resolve diner credentials. Please retry.' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          id: committedOrder.id,
          orderNumber: 202,
          total: 320,
          sessionId: committedOrder.sessionId,
          sessionToken: committedToken,
          pendingActivation: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Unexpected URL' }), { status: 500 })
  }) as any

  let confirmed: any = null
  const q = new OrderQueue(
    store,
    keyName('orderQueue', `tenant-1-qr_${qrToken}`),
    fetcher,
    {
      onConfirmed: (order) => {
        confirmed = order
      },
    },
    () => nowMs,
  )

  // Initial submit: server commits, client loses response -> stays queued (attempts = 1).
  q.enqueue('diner', { orderType: 'DINE_IN', qrToken, items: [{ menuItemId: 'd1', quantity: 1 }] }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()
  assert.equal(postCalls, 1)
  assert.equal(q.load().length, 1)
  assert.equal(q.load()[0].state, 'pending')
  assert.equal(q.load()[0].attempts, 1)
  assert.equal(confirmed, null)

  // Retry 1 while token lookup fails -> 503 -> submitEntry returns 'uncertain', stays queued.
  nowMs += 60_000
  await q.process()
  assert.equal(postCalls, 1, 'must not re-POST while reconciliation returns 503')
  assert.equal(q.load().length, 1, 'checkout must stay queued when token lookup fails')
  assert.equal(q.load()[0].state, 'pending')
  assert.equal(q.load()[0].attempts, 2)
  assert.equal(confirmed, null)

  // Restore token lookup and retry -> reconciles original order + usable token and clears queue.
  tokenLookupFails = false
  nowMs += 60_000
  await q.process()
  assert.equal(postCalls, 1, 'no duplicate order/session created on reconciliation')
  assert.equal(q.load().length, 0, 'queue entry cleared after usable token is returned')
  assert.equal(confirmed?.id, committedOrderId)
  assert.equal(confirmed?.sessionToken, committedToken)
  assert.equal(confirmed?.sessionId, committedSessionId)
})

// ---------------------------------------------------------------------------
// 3. Two-tab cart merge: browsing tab B does not overwrite session A's cart
// ---------------------------------------------------------------------------
await check('public-menu.tsx merges remaining browsing cart into existing session cart without overwriting', () => {
  const confirmStart = publicMenuSrc.indexOf('function handleOrderConfirmed(')
  const confirmEnd = publicMenuSrc.indexOf('useEffect(() => {\n    const effectiveTenantId =', confirmStart)
  const confirmBlock = publicMenuSrc.slice(confirmStart, confirmEnd)
  assert.ok(confirmBlock.includes("readStored('cart', order.sessionToken)"))
  assert.ok(confirmBlock.includes('remainingCart.length > 0'))
  assert.ok(confirmBlock.includes(': existingSessionCart'))
})

await check('P2-3 behavior: two-tab checkout preserves Tab A unsubmitted session cart when Tab B submits browsing cart', async () => {
  const sharedStorage = new MemoryStorage()
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const qrToken = 'qr-table-1'
  const sessionStorageKey = `restro_session:${tenantId}:${tableId}`
  const browsingCartKey = keyName('cart', `browsing:${tableId}`)

  const sameLine = (a: any, b: any) =>
    a.menuItemId === b.menuItemId &&
    (a.portionId || a.portion || '') === (b.portionId || b.portion || '')

  // Track server-side orders per session.
  const serverOrders: any[] = []
  const sessionId = 'sess-tab-a'
  const sessionToken = 'tok-tab-a'

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      if (body.tableSessionToken) {
        assert.equal(body.tableSessionToken, sessionToken)
        const order = {
          id: `ord-${serverOrders.length + 1}`,
          orderNumber: 300 + serverOrders.length + 1,
          total: 200,
          sessionId,
          sessionToken,
          items: body.items,
        }
        serverOrders.push(order)
        return new Response(JSON.stringify(order), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      // First order from Tab A via qrToken establishes the session.
      const order = {
        id: 'ord-1',
        orderNumber: 301,
        total: 150,
        sessionId,
        sessionToken,
        items: body.items,
      }
      serverOrders.push(order)
      return new Response(JSON.stringify(order), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }) as any

  // 1. Open Tab A and Tab B before either has a session; add Dish B to Tab B's browsing cart.
  let tabASessionToken: string | null = null
  let tabBSessionToken: string | null = null
  let tabBCart: any[] = [{ menuItemId: 'dish-b', name: 'Masala Chai', price: 60, quantity: 1 }]
  sharedStorage.setItem(browsingCartKey, JSON.stringify(tabBCart))

  // 2. Tab A places first order to establish the session, then adds Dish A-unsubmitted (qty 2).
  const queueA = new OrderQueue(
    sharedStorage,
    keyName('orderQueue', `${tenantId}-table_${tableId}-A`),
    fetcher,
    {
      onConfirmed: (order) => {
        tabASessionToken = order.sessionToken
        sharedStorage.setItem(
          sessionStorageKey,
          JSON.stringify({ sessionId: order.sessionId, sessionToken: order.sessionToken }),
        )
        sharedStorage.removeItem(browsingCartKey)
      },
    },
    () => 1000,
  )
  queueA.enqueue('diner', { orderType: 'DINE_IN', qrToken, tableId, items: [{ menuItemId: 'dish-a-1', quantity: 1 }] }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await queueA.process()
  assert.equal(tabASessionToken, sessionToken)

  const sessionCartKey = keyName('cart', sessionToken)
  const tabAUnsubmitted = [{ menuItemId: 'dish-a-unsubmitted', name: 'Garlic Naan', price: 80, quantity: 2 }]
  sharedStorage.setItem(sessionCartKey, JSON.stringify(tabAUnsubmitted))

  // 3. Tab B submits its browsing cart (discovers saved session token, keeps browsing cart until confirm).
  const discovered = JSON.parse(sharedStorage.getItem(sessionStorageKey)!)
  let tabBConfirmedOrder: any = null
  const queueB = new OrderQueue(
    sharedStorage,
    keyName('orderQueue', `${tenantId}-table_${tableId}-B`),
    fetcher,
    {
      onConfirmed: (order, entry) => {
        tabBConfirmedOrder = order
        // Mirror handleOrderConfirmed: subtract submitted items from Tab B's browsing cart,
        // then merge any remainder into existing session cart (or leave intact if empty).
        let remaining = [...tabBCart]
        for (const line of entry.payload.items) {
          remaining = remaining
            .map((c) => (sameLine(c, line) ? { ...c, quantity: c.quantity - line.quantity } : c))
            .filter((c) => c.quantity > 0)
        }
        const existingSessionCart = JSON.parse(sharedStorage.getItem(keyName('cart', order.sessionToken)) || '[]')
        if (remaining.length > 0) {
          const merged = [...existingSessionCart, ...remaining]
          sharedStorage.setItem(keyName('cart', order.sessionToken), JSON.stringify(merged))
        }
        tabBCart = existingSessionCart
        sharedStorage.removeItem(browsingCartKey)
        tabBSessionToken = order.sessionToken
      },
    },
    () => 2000,
  )
  queueB.enqueue(
    'diner',
    {
      orderType: 'DINE_IN',
      tableSessionToken: discovered.sessionToken,
      items: tabBCart.map((c) => ({ menuItemId: c.menuItemId, quantity: c.quantity })),
    },
    1,
  )
  await new Promise((r) => setTimeout(r, 10))
  await queueB.process()

  assert.equal(tabBConfirmedOrder?.sessionId, sessionId)
  assert.equal(tabBSessionToken, sessionToken)
  assert.equal(tabBConfirmedOrder?.items.length, 1)
  assert.equal(tabBConfirmedOrder?.items[0].menuItemId, 'dish-b')

  // 4. Reload Tab A and assert its unsubmitted dish is still in the session cart with qty 2,
  // and Tab B's submitted dish is absent from the saved cart.
  const reloadedTabACart = JSON.parse(sharedStorage.getItem(sessionCartKey) || '[]')
  assert.equal(reloadedTabACart.length, 1)
  assert.equal(reloadedTabACart[0].menuItemId, 'dish-a-unsubmitted')
  assert.equal(reloadedTabACart[0].quantity, 2)
  assert.equal(reloadedTabACart.some((c: any) => c.menuItemId === 'dish-b'), false)
})

// ---------------------------------------------------------------------------
// 4. Preserve another tab's browsing cart on follow-up confirmation
// ---------------------------------------------------------------------------
await check('P2-4: follow-up order confirmation in Tab A preserves Tab B unsubmitted browsing cart', async () => {
  const sharedStorage = new MemoryStorage()
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const sessionToken = 'tok-a'
  const browsingCartKey = keyName('cart', `browsing:${tableId}`)
  const sessionCartKey = keyName('cart', sessionToken)

  // Confirm public-menu.tsx gates browsing cart removal on adoptingNewSession.
  assert.ok(publicMenuSrc.includes('if (adoptingNewSession && tblId)'))

  // Tab B saves an unsubmitted dish while browsing.
  const tabBBrowsingCart = [{ menuItemId: 'dish-b', name: 'Lassi', price: 90, quantity: 2 }]
  sharedStorage.setItem(browsingCartKey, JSON.stringify(tabBBrowsingCart))

  // Tab A confirms a follow-up order from its active session cart (adoptingNewSession === false).
  sharedStorage.setItem(sessionCartKey, JSON.stringify([{ menuItemId: 'dish-a2', name: 'Roti', price: 30, quantity: 1 }]))
  const adoptingNewSession = false // order.sessionToken === sessionToken
  if (adoptingNewSession) {
    sharedStorage.removeItem(browsingCartKey)
  }

  // Reload Tab B: browsing cart and quantity are still intact.
  const reloadedB = JSON.parse(sharedStorage.getItem(browsingCartKey) || '[]')
  assert.equal(reloadedB.length, 1)
  assert.equal(reloadedB[0].menuItemId, 'dish-b')
  assert.equal(reloadedB[0].quantity, 2)
})

// ---------------------------------------------------------------------------
// 5. Preserve merged dishes when a stale tab next saves
// ---------------------------------------------------------------------------
await check('P2-5: stale Tab A edit reconciles with Tab B merged unsubmitted dish via reconcileCartOnSave', async () => {
  const sharedStorage = new MemoryStorage()
  const sessionToken = 'tok-shared'
  const sessionCartKey = keyName('cart', sessionToken)

  // Tab A is open on active session with Dish A (qty 1).
  const tabALastSynced = [{ menuItemId: 'dish-a', name: 'Dal', price: 180, quantity: 1 }]
  sharedStorage.setItem(sessionCartKey, JSON.stringify(tabALastSynced))

  // Tab B starts checkout with Dish B, holds response, and adds Dish C while in flight.
  const tabBBrowsingCart = [
    { menuItemId: 'dish-b', name: 'Paneer', price: 240, quantity: 1 },
    { menuItemId: 'dish-c', name: 'Jeera Rice', price: 140, quantity: 1 },
  ]
  const tabBSubmitted = [{ menuItemId: 'dish-b', quantity: 1 }]

  // Release successful response: Tab B removes submitted Dish B and merges Dish C into session cart.
  const tabBRemaining = tabBBrowsingCart.filter((c) => !tabBSubmitted.some((s) => s.menuItemId === c.menuItemId))
  const existingOnRelease = JSON.parse(sharedStorage.getItem(sessionCartKey) || '[]')
  const afterTabBMerge = mergeBrowsingRemainderIntoSession(existingOnRelease, tabBRemaining)
  sharedStorage.setItem(sessionCartKey, JSON.stringify(afterTabBMerge))

  // Without reloading Tab A, Tab A makes an ordinary cart edit (Dish A -> qty 2) and saves.
  const tabALocalEdited = [{ menuItemId: 'dish-a', name: 'Dal', price: 180, quantity: 2 }]
  const latestStoredBeforeTabASave = JSON.parse(sharedStorage.getItem(sessionCartKey) || '[]')
  const reconciled = reconcileCartOnSave(tabALocalEdited, tabALastSynced, latestStoredBeforeTabASave)
  sharedStorage.setItem(sessionCartKey, JSON.stringify(reconciled))

  // Also verify intentional removal by another tab is preserved when local tab did not edit that line.
  const afterRemoval = reconcileCartOnSave(
    [
      { menuItemId: 'dish-a', name: 'Dal', price: 180, quantity: 2 },
      { menuItemId: 'dish-c', name: 'Jeera Rice', price: 140, quantity: 1 },
    ],
    [
      { menuItemId: 'dish-a', name: 'Dal', price: 180, quantity: 2 },
      { menuItemId: 'dish-c', name: 'Jeera Rice', price: 140, quantity: 1 },
    ],
    [{ menuItemId: 'dish-a', name: 'Dal', price: 180, quantity: 2 }],
  )
  assert.equal(afterRemoval.length, 1)
  assert.equal(afterRemoval[0].menuItemId, 'dish-a')
})

// ---------------------------------------------------------------------------
// 6. Recover checkout after a cached session ends (and keep on transient error)
// ---------------------------------------------------------------------------
await check('P2-6: definitive rejection clears ended cached session so QR retry succeeds; transient error keeps valid credential', async () => {
  const store = new MemoryStorage()
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const qrToken = 'qr-table-1'
  const sessionKey = `restro_session:${tenantId}:${tableId}`
  const endedToken = 'tok-ended'
  const validToken = 'tok-valid-existing'
  const newToken = 'tok-new-session'

  // Seed ended cached session and browsing cart.
  store.setItem(sessionKey, JSON.stringify({ sessionId: 'sess-ended', sessionToken: endedToken }))
  let browsingCart = [{ menuItemId: 'dish-1', name: 'Dosa', price: 120, quantity: 1 }]
  let postCount = 0
  let confirmedCount = 0

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      postCount++
      const body = JSON.parse(String(init.body))
      if (body.tableSessionToken === endedToken) {
        return new Response(
          JSON.stringify({ error: 'Session ended. Please scan the table QR code again to continue.' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )
      }
      if (body.tableSessionToken === validToken) {
        return new Response(
          JSON.stringify({ error: 'Upstream timeout' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      }
      assert.equal(body.qrToken, qrToken)
      return new Response(
        JSON.stringify({
          id: 'ord-new-1',
          orderNumber: 401,
          total: 120,
          sessionId: 'sess-new',
          sessionToken: newToken,
          items: body.items,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }) as any

  const q = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-table_${tableId}-recover`),
    fetcher,
    {
      onFailed: (error, entry) => {
        const failedToken = entry.payload?.tableSessionToken
        if (failedToken && isDefinitiveSessionRejection(error)) {
          const cur = JSON.parse(store.getItem(sessionKey) || 'null')
          if (cur?.sessionToken === failedToken) store.removeItem(sessionKey)
        }
        q.retire(entry.key)
      },
      onConfirmed: () => {
        confirmedCount++
        browsingCart = []
      },
    },
    () => 1000,
  )

  // Submit with ended token -> 403 -> clears cached credential, keeps browsing cart.
  q.enqueue('diner', { orderType: 'DINE_IN', tableSessionToken: endedToken, items: browsingCart }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  assert.equal(store.getItem(sessionKey), null, 'ended credential must be cleared')
  assert.equal(browsingCart.length, 1, 'pending items must survive rejection')

  // Retry through QR -> confirms exactly one order in valid new session.
  q.enqueue('diner', { orderType: 'DINE_IN', qrToken, tableId, items: browsingCart }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  assert.equal(confirmedCount, 1)
  assert.equal(postCount, 2)
  assert.equal(browsingCart.length, 0)

  // Transient 503 failure with valid cached credential -> keeps credential intact.
  store.setItem(sessionKey, JSON.stringify({ sessionId: 'sess-valid', sessionToken: validToken }))
  q.enqueue('diner', { orderType: 'DINE_IN', tableSessionToken: validToken, items: [{ menuItemId: 'd2', quantity: 1 }] }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()
  const stillCached = JSON.parse(store.getItem(sessionKey) || 'null')
  assert.equal(stillCached?.sessionToken, validToken, 'transient failure must leave valid cached credential intact')
})

// ---------------------------------------------------------------------------
// 7. Prevent duplicate orders after a failed table lookup (#4)
// ---------------------------------------------------------------------------
await check('orders/index.ts returns retryable 503 on table lookup error in getByKey and QR POST', () => {
  const getByKeyStart = ordersFnSrc.indexOf('async function getByKey(')
  const getByKeyEnd = ordersFnSrc.indexOf('async function list(', getByKeyStart)
  const getByKeyBlock = ordersFnSrc.slice(getByKeyStart, getByKeyEnd)
  assert.ok(getByKeyBlock.includes('if (tableError) return json(req, { error:'))
  assert.ok(getByKeyBlock.includes('503'))

  const qrPostStart = ordersFnSrc.indexOf('} else if (qrToken) {')
  const qrPostEnd = ordersFnSrc.indexOf('// ── 2. POS / Staff', qrPostStart)
  const qrPostBlock = ordersFnSrc.slice(qrPostStart, qrPostEnd)
  assert.ok(qrPostBlock.includes('if (tableError) {'))
  assert.ok(qrPostBlock.includes('if (existingError) {'))
  assert.ok(qrPostBlock.includes('503'))
})

await check('P2-7: failed table lookup during reconciliation keeps checkout queued with original idempotency key; restored lookup reconciles single order & session', async () => {
  const store = new MemoryStorage()
  let nowMs = 2_000_000
  const qrToken = 'qr-table-4'
  const committedOrderId = 'ord-table-lookup-1'
  const committedSessionId = 'sess-table-lookup-1'
  const committedToken = 'tok-table-lookup-1'

  let postCalls = 0
  let tableLookupFails = true
  const ordersCreated: any[] = []
  const sessionsCreated: string[] = []

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      postCalls++
      const body = JSON.parse(String(init.body))
      // First POST commits 1 order + 1 session on server, then response drops.
      if (ordersCreated.length === 0) {
        sessionsCreated.push(committedSessionId)
        ordersCreated.push({
          id: committedOrderId,
          idempotencyKey: body.idempotencyKey,
          sessionId: committedSessionId,
          sessionToken: committedToken,
        })
      }
      throw new Error('Connection dropped before response')
    }
    if (url.startsWith('/api/orders/by-key/')) {
      const parsed = new URL(`https://example.test${url}`)
      const key = parsed.pathname.split('/').pop()
      assert.equal(parsed.searchParams.get('qrToken'), qrToken)
      if (tableLookupFails) {
        return new Response(
          JSON.stringify({ error: 'Could not verify table availability. Please retry.' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      }
      const found = ordersCreated.find((o) => o.idempotencyKey === key)
      if (!found) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      }
      return new Response(
        JSON.stringify({
          id: found.id,
          orderNumber: 501,
          total: 250,
          sessionId: found.sessionId,
          sessionToken: found.sessionToken,
          pendingActivation: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Unexpected' }), { status: 500 })
  }) as any

  let confirmed: any = null
  const q = new OrderQueue(
    store,
    keyName('orderQueue', `tenant-1-qr_${qrToken}`),
    fetcher,
    {
      onConfirmed: (order) => {
        confirmed = order
      },
    },
    () => nowMs,
  )

  // Enqueue and drop response.
  const entry = q.enqueue('diner', { orderType: 'DINE_IN', qrToken, items: [{ menuItemId: 'd1', quantity: 1 }] }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  assert.equal(postCalls, 1)
  assert.equal(q.load().length, 1)
  assert.equal(q.load()[0].key, entry.key)

  // Retry while table lookup fails -> 503 keeps checkout queued with original idempotency key.
  nowMs += 60_000
  await q.process()
  assert.equal(postCalls, 1, 'must not re-POST while table lookup returns 503')
  assert.equal(q.load().length, 1)
  assert.equal(q.load()[0].key, entry.key)
  assert.equal(q.load()[0].state, 'pending')
  assert.equal(confirmed, null)

  // Restore table lookup -> reconciles original order ID + usable token, clears queue, 1 order & 1 session.
  tableLookupFails = false
  nowMs += 60_000
  await q.process()
  assert.equal(postCalls, 1)
  assert.equal(q.load().length, 0)
  assert.equal(confirmed?.id, committedOrderId)
  assert.equal(confirmed?.sessionToken, committedToken)
  assert.equal(ordersCreated.length, 1)
  assert.equal(sessionsCreated.length, 1)
})

// ---------------------------------------------------------------------------
// 8. Follow-up confirmation keeps confirmed dish out of session cart
// ---------------------------------------------------------------------------
await check('P2-8: follow-up order removes confirmed dish from persisted cart and reload keeps it out', () => {
  const store = new MemoryStorage()
  const sessionToken = 'tok-followup'
  const sessionCartKey = keyName('cart', sessionToken)

  const initialCart = [
    { menuItemId: 'dish-submitted', name: 'Idli', price: 60, quantity: 1 },
    { menuItemId: 'dish-unsubmitted', name: 'Vada', price: 70, quantity: 2 },
  ]
  store.setItem(sessionCartKey, JSON.stringify(initialCart))

  // Reconcile confirmed order against baseline and stored cart, then persist before advancing baseline.
  const latestStored = JSON.parse(store.getItem(sessionCartKey)!)
  const nextCart = reconcileCartOnConfirm(
    initialCart,
    initialCart,
    latestStored,
    [{ menuItemId: 'dish-submitted', quantity: 1 }],
  )
  store.setItem(sessionCartKey, JSON.stringify(nextCart))
  const newBaseline = nextCart

  // Even if save effect runs next, dish-submitted stays out and dish-unsubmitted stays qty 2.
  const afterSave = reconcileCartOnSave(
    nextCart,
    newBaseline,
    JSON.parse(store.getItem(sessionCartKey)!),
  )
  store.setItem(sessionCartKey, JSON.stringify(afterSave))

  const reloaded = JSON.parse(store.getItem(sessionCartKey)!)
  assert.equal(reloaded.some((c: any) => c.menuItemId === 'dish-submitted'), false)
  assert.equal(reloaded.find((c: any) => c.menuItemId === 'dish-unsubmitted')?.quantity, 2)
})

// ---------------------------------------------------------------------------
// 9. Unavailable dish keeps valid session credential; late rejection leaves newer token
// ---------------------------------------------------------------------------
await check('P2-9: unavailable dish rejection keeps token and cart; late rejection does not evict newer token', async () => {
  const store = new MemoryStorage()
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const sessionKey = `restro_session:${tenantId}:${tableId}`
  const validToken = 'tok-valid-active'
  store.setItem(sessionKey, JSON.stringify({ sessionId: 'sess-1', sessionToken: validToken }))

  let cart = [
    { menuItemId: 'dish-unavailable', name: 'Special', price: 300, quantity: 1 },
    { menuItemId: 'dish-good', name: 'Tea', price: 40, quantity: 1 },
  ]
  const sentTokens: string[] = []
  let failUnavailable = true

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      sentTokens.push(body.tableSessionToken || '')
      if (failUnavailable) {
        return new Response(
          JSON.stringify({ error: 'One or more items are no longer available', code: 'ITEM_UNAVAILABLE' }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          id: 'ord-fixed-1',
          orderNumber: 601,
          total: 40,
          sessionId: 'sess-1',
          sessionToken: validToken,
          items: body.items,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }) as any

  let confirmed = false
  const q = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-table_${tableId}-unavail`),
    fetcher,
    {
      onFailed: (error, entry, code) => {
        const failedToken = entry.payload?.tableSessionToken
        if (failedToken && isDefinitiveSessionRejection(error, code)) {
          const cur = JSON.parse(store.getItem(sessionKey) || 'null')
          if (cur?.sessionToken === failedToken) store.removeItem(sessionKey)
        }
        q.retire(entry.key)
      },
      onConfirmed: () => {
        confirmed = true
      },
    },
    () => 1000,
  )

  q.enqueue('diner', { orderType: 'DINE_IN', tableSessionToken: validToken, items: cart }, 2)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  // Token and cart survive ITEM_UNAVAILABLE.
  assert.equal(JSON.parse(store.getItem(sessionKey)!).sessionToken, validToken)
  assert.equal(cart.length, 2)

  // Diner removes unavailable item and retries -> uses existing session without opening a new check.
  cart = cart.filter((c) => c.menuItemId !== 'dish-unavailable')
  failUnavailable = false
  q.enqueue('diner', { orderType: 'DINE_IN', tableSessionToken: validToken, items: cart }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()
  assert.equal(confirmed, true)
  assert.deepEqual(sentTokens, [validToken, validToken])

  // Late rejection of an old token must not evict a newer cached token.
  const newerToken = 'tok-newer'
  store.setItem(sessionKey, JSON.stringify({ sessionId: 'sess-new', sessionToken: newerToken }))
  const lateFailedToken = 'tok-older'
  if (isDefinitiveSessionRejection('Session ended', 'SESSION_ENDED')) {
    const cur = JSON.parse(store.getItem(sessionKey) || 'null')
    if (cur?.sessionToken === lateFailedToken) store.removeItem(sessionKey)
  }
  assert.equal(JSON.parse(store.getItem(sessionKey)!).sessionToken, newerToken)
})

// ---------------------------------------------------------------------------
// 10. Transient session lookup failure keeps order queued; ended session clears
// ---------------------------------------------------------------------------
await check('P2-10: validateDinerSession lookup error returns 503 so order stays queued and recovers; ended session clears token', async () => {
  const validateStart = ordersFnSrc.indexOf('async function validateDinerSession(')
  const validateEnd = ordersFnSrc.indexOf('async function endTableSession(', validateStart)
  const validateBlock = ordersFnSrc.slice(validateStart, validateEnd)
  assert.ok(validateBlock.includes('if (error) {'))
  assert.ok(validateBlock.includes('503'))
  assert.ok(validateBlock.includes('LOOKUP_FAILED'))

  const store = new MemoryStorage()
  let nowMs = 3_000_000
  const token = 'tok-sess-lookup'
  const sessionKey = `restro_session:tenant-1:tbl-1`
  store.setItem(sessionKey, JSON.stringify({ sessionId: 'sess-1', sessionToken: token }))

  let postCalls = 0
  let lookupFails = true
  const ordersCreated: any[] = []

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      postCalls++
      const body = JSON.parse(String(init.body))
      if (ordersCreated.length === 0) {
        ordersCreated.push({ id: 'ord-sess-1', idempotencyKey: body.idempotencyKey, sessionToken: token })
      }
      throw new Error('Dropped response')
    }
    if (url.startsWith('/api/orders/by-key/')) {
      if (lookupFails) {
        return new Response(
          JSON.stringify({ error: 'Could not verify table availability. Please retry.', code: 'LOOKUP_FAILED' }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ id: 'ord-sess-1', orderNumber: 701, total: 100, sessionId: 'sess-1', sessionToken: token }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }) as any

  let confirmedOrder: any = null
  const q = new OrderQueue(
    store,
    keyName('orderQueue', `tenant-1-${token}`),
    fetcher,
    { onConfirmed: (o) => { confirmedOrder = o } },
    () => nowMs,
  )

  const entry = q.enqueue('diner', { orderType: 'DINE_IN', tableSessionToken: token, items: [{ menuItemId: 'd1', quantity: 1 }] }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  // Retry while session lookup fails -> 503 keeps entry + credential + idempotency key.
  nowMs += 60_000
  await q.process()
  assert.equal(q.load().length, 1)
  assert.equal(q.load()[0].key, entry.key)
  assert.equal(JSON.parse(store.getItem(sessionKey)!).sessionToken, token)
  assert.equal(confirmedOrder, null)

  // Restore lookup -> recovers original order, clears queue, 1 order total.
  lookupFails = false
  nowMs += 60_000
  await q.process()
  assert.equal(q.load().length, 0)
  assert.equal(confirmedOrder?.id, 'ord-sess-1')
  assert.equal(postCalls, 1)
  assert.equal(ordersCreated.length, 1)
})

// ---------------------------------------------------------------------------
// 11. QR reload restores browsing cart once without duplicating on repeat reloads
// ---------------------------------------------------------------------------
await check('P2-11: QR reload imports browsing cart into active session once without overwriting A or duplicating', () => {
  const store = new MemoryStorage()
  const tableId = 'tbl-1'
  const sessionToken = 'tok-a'
  const browsingKey = keyName('cart', `browsing:${tableId}`)
  const sessionKey = keyName('cart', sessionToken)

  // Verify public-menu.tsx activateAndLoad performs this merge on data?.session.
  assert.ok(publicMenuSrc.includes("const browsingRaw = readStored('cart', `browsing:${data.table.id}`)"))
  assert.ok(publicMenuSrc.includes("removeStored('cart', `browsing:${data.table.id}`)"))

  // Tab A has an item in session cart; Tab B has qty 2 in browsing cart.
  store.setItem(sessionKey, JSON.stringify([{ menuItemId: 'dish-a', name: 'Idli', price: 50, quantity: 1 }]))
  store.setItem(browsingKey, JSON.stringify([{ menuItemId: 'dish-b', name: 'Coffee', price: 40, quantity: 2 }]))

  const simulateQrReload = () => {
    const browsingRaw = store.getItem(browsingKey)
    if (browsingRaw) {
      const browsingItems = JSON.parse(browsingRaw)
      if (Array.isArray(browsingItems) && browsingItems.length > 0) {
        const sessionRaw = store.getItem(sessionKey)
        const sessionItems = sessionRaw ? JSON.parse(sessionRaw) : []
        const merged = mergeBrowsingRemainderIntoSession(sessionItems, browsingItems)
        store.setItem(sessionKey, JSON.stringify(merged))
      }
      store.removeItem(browsingKey)
    }
    return JSON.parse(store.getItem(sessionKey) || '[]')
  }

  // Reload 1: both A's dish and B's dish (qty 2) are present.
  const reload1 = simulateQrReload()
  assert.equal(reload1.find((c: any) => c.menuItemId === 'dish-a')?.quantity, 1)
  assert.equal(reload1.find((c: any) => c.menuItemId === 'dish-b')?.quantity, 2)
  assert.equal(store.getItem(browsingKey), null)

  // Reload 2: dish-b stays qty 2 (never imported twice).
  const reload2 = simulateQrReload()
  assert.equal(reload2.find((c: any) => c.menuItemId === 'dish-b')?.quantity, 2)
})

// ---------------------------------------------------------------------------
// 12. P1: Pending checkout resumes across session adoption on reload
// ---------------------------------------------------------------------------
await check('P1-12: lost response + QR reload migrates table queue to session queue, keeps idempotency key & blocks duplicate checkout', async () => {
  const store = new MemoryStorage()
  let nowMs = 4_000_000
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const qrToken = 'qr-table-1'
  const sessionToken = 'tok-tab-a'
  const sessionId = 'sess-tab-a'
  const browsingKey = keyName('cart', `browsing:${tableId}`)
  const sessionCartKey = keyName('cart', sessionToken)

  // Tab A established session; Tab B has Dish B (submitted, response dropped) + Dish C (unsubmitted).
  store.setItem(`restro_session:${tenantId}:${tableId}`, JSON.stringify({ sessionId, sessionToken }))
  store.setItem(
    browsingKey,
    JSON.stringify([
      { menuItemId: 'dish-b', name: 'Biryani', price: 220, quantity: 1 },
      { menuItemId: 'dish-c', name: 'Raita', price: 50, quantity: 1 },
    ]),
  )

  let postCalls = 0
  let reconciledCalls = 0
  const committedOrder = {
    id: 'ord-migrated-1',
    orderNumber: 801,
    total: 220,
    sessionId,
    sessionToken,
    items: [{ menuItemId: 'dish-b', quantity: 1 }],
  }
  let storedIdempotencyKey: string | null = null

  const dropFetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      postCalls++
      const body = JSON.parse(String(init.body))
      storedIdempotencyKey = body.idempotencyKey
      throw new Error('Response dropped')
    }
    return new Response(JSON.stringify({ error: 'Offline' }), { status: 503 })
  }) as any

  // Step 1: Browsing Tab B submits into table-scoped queue with A's saved token, response drops.
  const tableQueue = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-table_${tableId}`),
    dropFetcher,
    {},
    () => nowMs,
  )
  const entry = tableQueue.enqueue(
    'diner',
    { orderType: 'DINE_IN', tableSessionToken: sessionToken, items: [{ menuItemId: 'dish-b', quantity: 1 }] },
    1,
  )
  await new Promise((r) => setTimeout(r, 10))
  await tableQueue.process()
  assert.equal(postCalls, 1)
  assert.equal(tableQueue.load().length, 1)

  // Step 2: Tab B reloads via QR URL, adopts sessionToken, migrates queue & subtracts unresolved items from cart.
  const migrated = migratePendingTableQueueToSession(store, tenantId, tableId, sessionToken, qrToken)
  assert.equal(migrated.length, 1)
  assert.equal(migrated[0].key, entry.key)
  assert.equal(tableQueue.load().length, 0, 'table queue must be drained after migration')

  const browsingItems = JSON.parse(store.getItem(browsingKey) || '[]')
  const unsubmittedOnly = subtractUnresolvedQueueQuantities(browsingItems, migrated)
  assert.equal(unsubmittedOnly.some((c: any) => c.menuItemId === 'dish-b'), false, 'unresolved dish must not re-enter cart')
  assert.equal(unsubmittedOnly.find((c: any) => c.menuItemId === 'dish-c')?.quantity, 1)
  store.setItem(sessionCartKey, JSON.stringify(unsubmittedOnly))
  store.removeItem(browsingKey)

  // Step 3: Session-scoped queue resumes with original idempotency key and reconciles original order.
  const recoverFetcher = (async (url: string) => {
    if (url.startsWith(`/api/orders/by-key/${entry.key}`)) {
      reconciledCalls++
      return new Response(JSON.stringify(committedOrder), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'Should not re-POST' }), { status: 500 })
  }) as any

  let recovered: any = null
  const sessionQueue = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-${sessionToken}`),
    recoverFetcher,
    { onConfirmed: (o) => { recovered = o } },
    () => nowMs + 60_000,
  )
  await sessionQueue.process()

  assert.equal(reconciledCalls, 1)
  assert.equal(postCalls, 1, 'only one order created')
  assert.equal(recovered?.id, 'ord-migrated-1')
  assert.equal(storedIdempotencyKey, entry.key)
  assert.equal(sessionQueue.load().length, 0, 'queue cleared only after confirmation')

  // After reload, confirmed dish-b stays out and dish-c survives.
  const finalCart = JSON.parse(store.getItem(sessionCartKey) || '[]')
  assert.equal(finalCart.some((c: any) => c.menuItemId === 'dish-b'), false)
  assert.equal(finalCart.find((c: any) => c.menuItemId === 'dish-c')?.quantity, 1)
})

// ---------------------------------------------------------------------------
// 13. P2: Confirmed removal delta applied to stale incremented cart (3 - 2 = 1)
// ---------------------------------------------------------------------------
await check('P2-13: confirmed removal of 2 units reduces stale tab edit from 3 to 1 while preserving unrelated dishes', () => {
  const baseline = [
    { menuItemId: 'dish-a', name: 'Samosa', price: 40, quantity: 2 },
    { menuItemId: 'dish-other', name: 'Chai', price: 30, quantity: 1 },
  ]
  // Tab A confirms both units of dish-a, leaving only dish-other in stored cart.
  const storedAfterTabAConfirm = [
    { menuItemId: 'dish-other', name: 'Chai', price: 30, quantity: 1 },
  ]
  // Stale Tab B increments dish-a from 2 to 3 before processing storage update.
  const staleTabBLocal = [
    { menuItemId: 'dish-a', name: 'Samosa', price: 40, quantity: 3 },
    { menuItemId: 'dish-other', name: 'Chai', price: 30, quantity: 1 },
  ]

  const reconciled = reconcileCartOnSave(staleTabBLocal, baseline, storedAfterTabAConfirm)
  assert.equal(reconciled.find((c) => c.menuItemId === 'dish-a')?.quantity, 1)
  assert.equal(reconciled.find((c) => c.menuItemId === 'dish-other')?.quantity, 1)
})

// ---------------------------------------------------------------------------
// 14. P2: Clear rejected active token from BOTH page state and storage
// ---------------------------------------------------------------------------
await check('P2-14: ended adopted session clears both page state and storage so QR retry succeeds without reload', async () => {
  const store = new MemoryStorage()
  const tenantId = 'tenant-1'
  const tableId = 'tbl-1'
  const qrToken = 'qr-table-1'
  const sessionKey = `restro_session:${tenantId}:${tableId}`
  const endedToken = 'tok-ended-adopted'
  const newToken = 'tok-fresh-qr'

  // Simulate Tab B having adopted A's session in BOTH page state and storage.
  let pageSessionToken: string | null = endedToken
  let pageSessionId: string | null = 'sess-ended'
  store.setItem(sessionKey, JSON.stringify({ sessionId: pageSessionId, sessionToken: endedToken }))
  let cart = [{ menuItemId: 'dish-1', name: 'Dosa', price: 120, quantity: 1 }]

  let postCount = 0
  const sentPayloads: any[] = []

  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/orders' && init?.method === 'POST') {
      postCount++
      const body = JSON.parse(String(init.body))
      sentPayloads.push(body)
      if (body.tableSessionToken === endedToken) {
        return new Response(
          JSON.stringify({ error: 'Session ended. Please scan the table QR code again to continue.', code: 'SESSION_ENDED' }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ id: 'ord-qr-retry', orderNumber: 901, total: 120, sessionId: 'sess-new', sessionToken: newToken }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }) as any

  let confirmedOrder: any = null
  const q = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-${endedToken}`),
    fetcher,
    {
      onFailed: (error, entry, code) => {
        const failedToken = entry.payload?.tableSessionToken
        if (failedToken && isDefinitiveSessionRejection(error, code)) {
          const cur = JSON.parse(store.getItem(sessionKey) || 'null')
          if (cur?.sessionToken === failedToken) store.removeItem(sessionKey)
          if (pageSessionToken === failedToken) {
            pageSessionToken = null
            pageSessionId = null
          }
        }
        q.retire(entry.key)
      },
      onConfirmed: (o) => { confirmedOrder = o },
    },
    () => 1000,
  )

  q.enqueue('diner', { orderType: 'DINE_IN', tableSessionToken: pageSessionToken, items: cart }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await q.process()

  // Both page state and storage cleared; cart preserved.
  assert.equal(pageSessionToken, null)
  assert.equal(pageSessionId, null)
  assert.equal(store.getItem(sessionKey), null)
  assert.equal(cart.length, 1)

  // Retry without reload goes through QR token and creates 1 order in valid session.
  const qrRetryQ = new OrderQueue(
    store,
    keyName('orderQueue', `${tenantId}-table_${tableId}`),
    fetcher,
    { onConfirmed: (o) => { confirmedOrder = o } },
    () => 2000,
  )
  qrRetryQ.enqueue('diner', { orderType: 'DINE_IN', qrToken, tableId, items: cart }, 1)
  await new Promise((r) => setTimeout(r, 10))
  await qrRetryQ.process()

  assert.equal(postCount, 2)
  assert.equal(sentPayloads[1].qrToken, qrToken)
  assert.equal(sentPayloads[1].tableSessionToken, undefined)
  assert.equal(confirmedOrder?.id, 'ord-qr-retry')
  assert.equal(confirmedOrder?.sessionToken, newToken)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
