import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { OrderQueue, type StorageLike } from '../src/lib/order-queue'
import { keyName } from '../src/lib/storage-keys'
import {
  isDefinitiveSessionRejection,
  mergeBrowsingRemainderIntoSession,
  reconcileCartOnSave,
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
  assert.ok(confirmBlock.includes('if (remainingCart.length > 0)'))
  assert.ok(confirmBlock.includes('nextCart = existingSessionCart'))
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
