/**
 * Real two-tab Chrome CDP regression test for PR #13 P1/P2 fixes.
 *
 * Drives the production Next.js PublicMenu, OrderQueue, diner-cart-sync, and
 * localStorage persistence paths in two real Chrome tabs sharing one browser
 * profile against a local Edge Function test backend with transport-layer
 * fault injection.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

const BACKEND_PORT = 18787
const APP_PORT = 3002
const CDP_PORT = 9229
const APP_ORIGIN = `http://localhost:${APP_PORT}`
const QR_URL = `${APP_ORIGIN}/?view=public-menu&table=qr-table-1`
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE_DIR = '/tmp/chrome-pr13-two-tab-profile'

const TENANT = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Test Bistro',
  currencySymbol: '₹',
  taxRate: 5,
  serviceCharge: 0,
}

const TABLE = {
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Table 1',
  seats: 4,
  area: 'Main Hall',
  active: true,
}

const CATEGORIES = [{ id: 'cat-1', name: 'Mains', icon: '🍛', sortOrder: 1 }]

const MENU_ITEMS = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    categoryId: 'cat-1',
    name: 'Paneer Tikka',
    price: 250,
    portions: [
      { id: 'half', name: 'Half', price: 150 },
      { id: 'large', name: 'Large', price: 380 },
    ],
    prepTime: 15,
    available: true,
    rating: 4.8,
  },
  { id: '10000000-0000-4000-8000-000000000002', categoryId: 'cat-1', name: 'Masala Dosa', price: 140, prepTime: 10, available: true, rating: 4.7 },
  { id: '10000000-0000-4000-8000-000000000003', categoryId: 'cat-1', name: 'Mango Lassi', price: 90, prepTime: 5, available: true, rating: 4.9 },
]

interface BackendOrder {
  id: string
  orderNumber: number
  idempotencyKey: string
  sessionId: string
  sessionToken: string
  items: Array<{ menuItemId: string; name: string; quantity: number; price: number }>
  total: number
  status: string
}

const state = {
  sessionSeq: 0,
  orderSeq: 100,
  sessions: new Map<string, { id: string; token: string; status: 'ACTIVE' | 'ENDED' }>(),
  orders: [] as BackendOrder[],
  dropNextPostResponse: false,
  holdNextPost: false,
  releaseHeldPost: null as (() => void) | null,
  rejectNextPostUnavailable: false,
  removeLargePortionFromCatalog: false,
  postAttempts: [] as Array<{ key: string; token: string | null; items: any[] }>,
  byKeyCalls: [] as Array<{ key: string; qrToken: string | null; token: string | null }>,
}

function currentMenuItems() {
  if (!state.removeLargePortionFromCatalog) return MENU_ITEMS
  return MENU_ITEMS.map((m) =>
    m.id === MENU_ITEMS[0].id
      ? { ...m, portions: (m.portions || []).filter((p) => p.id !== 'large') }
      : m,
  )
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin || APP_ORIGIN
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
      'authorization, x-client-info, apikey, content-type, x-tenant-id, x-staff-session, x-session-token, prefer',
    'content-type': 'application/json',
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const backend = http.createServer(async (req, res) => {
  const headers = corsHeaders(req)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers)
    res.end()
    return
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${BACKEND_PORT}`)
  const path = url.pathname

  if (path === '/functions/v1/table-session/validate' && req.method === 'GET') {
    const token = req.headers['x-session-token'] as string | undefined
    if (token) {
      const sess = state.sessions.get(token)
      if (!sess || sess.status !== 'ACTIVE') {
        res.writeHead(403, headers)
        res.end(JSON.stringify({ error: 'Session ended. Please scan the table QR code again to continue.', sessionStatus: 'INVALID' }))
        return
      }
      res.writeHead(200, headers)
      res.end(
        JSON.stringify({
          sessionStatus: 'ACTIVE',
          session: { id: sess.id, token: sess.token, status: 'ACTIVE', activationStatus: 'ACTIVE', tenantId: TENANT.id, tableId: TABLE.id },
          sessionToken: sess.token,
          sessionId: sess.id,
          activationStatus: 'ACTIVE',
          tenant: TENANT,
          table: TABLE,
          social: {},
          theme: 'light',
          categories: CATEGORIES,
          menuItems: currentMenuItems(),
        }),
      )
      return
    }

    res.writeHead(200, headers)
    res.end(
      JSON.stringify({
        sessionStatus: 'BROWSING',
        session: null,
        sessionToken: null,
        sessionId: null,
        activationStatus: 'ACTIVE',
        tenant: TENANT,
        table: TABLE,
        social: {},
        theme: 'light',
        categories: CATEGORIES,
        menuItems: currentMenuItems(),
      }),
    )
    return
  }

  if (path === '/functions/v1/table-session/orders' && req.method === 'GET') {
    const token = (req.headers['x-session-token'] as string) || ''
    const sess = state.sessions.get(token)
    if (!sess || sess.status !== 'ACTIVE') {
      res.writeHead(401, headers)
      res.end(JSON.stringify({ error: 'Session required.' }))
      return
    }
    const list = state.orders.filter((o) => o.sessionId === sess.id)
    res.writeHead(200, headers)
    res.end(JSON.stringify({ orders: list, sessionId: sess.id }))
    return
  }

  if (path === '/functions/v1/table-session/release' && req.method === 'POST') {
    res.writeHead(200, headers)
    res.end(JSON.stringify({ success: true }))
    return
  }

  if (path.startsWith('/functions/v1/orders/by-key/') && req.method === 'GET') {
    const key = path.split('/').pop() || ''
    const token = (req.headers['x-session-token'] as string) || url.searchParams.get('tableSessionToken')
    const qrToken = url.searchParams.get('qrToken')
    state.byKeyCalls.push({ key, qrToken, token })
    const found = state.orders.find((o) => o.idempotencyKey === key)
    if (!found) {
      res.writeHead(404, headers)
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify(found))
    return
  }

  if (path === '/functions/v1/orders' && req.method === 'POST') {
    const body = await readJson(req)
    state.postAttempts.push({
      key: body.idempotencyKey,
      token: (req.headers['x-session-token'] as string) || body.tableSessionToken || null,
      items: body.items || [],
    })
    if (state.rejectNextPostUnavailable) {
      state.rejectNextPostUnavailable = false
      res.writeHead(409, headers)
      res.end(JSON.stringify({ error: 'One or more items are no longer available', code: 'ITEM_UNAVAILABLE' }))
      return
    }
    const token = (req.headers['x-session-token'] as string) || body.tableSessionToken
    let sess = token ? state.sessions.get(token) : undefined

    if (token) {
      if (!sess || sess.status !== 'ACTIVE') {
        res.writeHead(403, headers)
        res.end(JSON.stringify({ error: 'Session ended. Please scan the table QR code again to continue.', code: 'SESSION_ENDED' }))
        return
      }
    } else {
      const id = `00000000-0000-4000-9000-${String(++state.sessionSeq).padStart(12, '0')}`
      const newTok = `tok-browser-${state.sessionSeq}`
      sess = { id, token: newTok, status: 'ACTIVE' }
      state.sessions.set(newTok, sess)
    }

    let order = state.orders.find((o) => o.idempotencyKey === body.idempotencyKey)
    if (!order) {
      const mappedItems = (body.items || []).map((it: any) => {
        const m = MENU_ITEMS.find((x) => x.id === it.menuItemId)!
        return { menuItemId: m.id, name: m.name, quantity: it.quantity, price: m.price }
      })
      const total = mappedItems.reduce((s: number, x: any) => s + x.price * x.quantity, 0)
      order = {
        id: `ord-${++state.orderSeq}`,
        orderNumber: state.orderSeq,
        idempotencyKey: body.idempotencyKey,
        sessionId: sess.id,
        sessionToken: sess.token,
        items: mappedItems,
        total,
        status: 'PENDING',
      }
      state.orders.push(order)
    }

    if (state.holdNextPost) {
      state.holdNextPost = false
      await new Promise<void>((resolve) => {
        state.releaseHeldPost = resolve
      })
      state.releaseHeldPost = null
    }

    if (state.dropNextPostResponse) {
      state.dropNextPostResponse = false
      res.writeHead(201, headers)
      res.flushHeaders()
      res.write('{')
      setTimeout(() => res.destroy(), 30)
      return
    }

    res.writeHead(201, headers)
    res.end(JSON.stringify(order))
    return
  }

  res.writeHead(404, headers)
  res.end(JSON.stringify({ error: 'Not found' }))
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => Promise<T | false | null | undefined>, timeoutMs = 15000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const val = await fn()
    if (val) return val
    await sleep(150)
  }
  throw new Error('Timed out waiting for condition')
}

let nextApp: ChildProcess | null = null
let chrome: ChildProcess | null = null
let ws: WebSocket | null = null

try {
  await new Promise<void>((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve))

  nextApp = spawn('npx', ['next', 'dev', '-p', String(APP_PORT)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_EDGE_BASE: `http://127.0.0.1:${BACKEND_PORT}`,
    },
    stdio: 'ignore',
  })

  await waitFor(async () => {
    try {
      const r = await fetch(QR_URL)
      return r.ok
    } catch {
      return false
    }
  }, 45000)

  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  chrome = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-sandbox',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const version = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      return r.ok ? r.json() : false
    } catch {
      return false
    }
  }, 15000)

  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((r) => (ws!.onopen = r))
  let msgId = 0
  const pending = new Map<number, (v: any) => void>()
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data))
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result)
      pending.delete(msg.id)
    }
  }
  const send = (method: string, params: any = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve) => {
      const id = ++msgId
      pending.set(id, resolve)
      ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })

  const evalIn = async (sessionId: string, expression: string) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (res?.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`)
    }
    return res?.result?.value
  }

  // Open two real tabs in the same Chrome browser context.
  const tA = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sidA } = await send('Target.attachToTarget', { targetId: tA.targetId, flatten: true })
  await send('Page.enable', {}, sidA)
  await send('Runtime.enable', {}, sidA)
  await send('Network.enable', {}, sidA)
  await send('Page.navigate', { url: QR_URL }, sidA)

  const tB = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sidB } = await send('Target.attachToTarget', { targetId: tB.targetId, flatten: true })
  await send('Page.enable', {}, sidB)
  await send('Runtime.enable', {}, sidB)
  await send('Page.navigate', { url: QR_URL }, sidB)

  // Wait for both tabs to render menu items (first cold Turbopack compile of PublicMenu can take ~30s).
  try {
    await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Paneer Tikka')`), 20000)
  } catch {
    const probe = await evalIn(sidA, `fetch('http://127.0.0.1:${BACKEND_PORT}/functions/v1/table-session/validate?table=qr-table-1').then(r=>r.status).catch(e=>String(e))`)
    const diag = await evalIn(sidA, `JSON.stringify({ url: location.href, ready: document.readyState, text: (document.body?.innerText || '').slice(0, 200) })`)
    throw new Error(`Tab A did not render menu: ${diag} probe=${probe}`)
  }
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Paneer Tikka')`), 60000)

  // 1. Lost response and reload:
  // Tab A adds Paneer Tikka and places first order -> establishes session tok-browser-1.
  await evalIn(
    sidA,
    `(() => {
      const btns = [...document.querySelectorAll('button[aria-label^="Add "]')];
      btns[0]?.click();
    })()`,
  )
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))
  await evalIn(
    sidA,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`,
  )
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  await evalIn(
    sidA,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`,
  )
  await waitFor(() => (state.orders.length === 1 ? true : false))
  const sess1 = state.sessions.get('tok-browser-1')!
  assert.ok(sess1, 'Tab A established session tok-browser-1')

  // Tab A adds 1 unsubmitted unit of Masala Dosa and 1 unit of Mango Lassi.
  await evalIn(
    sidA,
    `[...document.querySelectorAll('button[aria-label="Close"], button')].find(b => b.textContent?.includes('Back to Menu') || b.getAttribute('aria-label') === 'Close')?.click()`,
  )
  await sleep(200)
  await evalIn(
    sidA,
    `(() => {
      const btns = [...document.querySelectorAll('button[aria-label^="Add "]')];
      btns[1]?.click();
      btns[2]?.click();
    })()`,
  )
  await waitFor(async () => {
    const raw = await evalIn(sidA, `localStorage.getItem('the-salad-cart-session-tok-browser-1')`)
    const items = JSON.parse(raw || '[]')
    return items.some((c: any) => c.menuItemId === MENU_ITEMS[1].id) &&
      items.some((c: any) => c.menuItemId === MENU_ITEMS[2].id)
      ? true
      : false
  })

  // Tab B (still browsing) adds 1 unit of Masala Dosa, drops response on submit, then reloads via QR URL.
  await evalIn(
    sidB,
    `(() => {
      const btns = [...document.querySelectorAll('button[aria-label^="Add "]')];
      btns[1]?.click();
    })()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await evalIn(
    sidB,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Place Order')`))

  state.dropNextPostResponse = true
  await evalIn(
    sidB,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`,
  )
  await waitFor(() => (state.orders.length === 2 ? true : false))
  const droppedOrder = state.orders[1]

  // Reload Tab B through the QR URL; it must migrate the queue and recover droppedOrder via by-key.
  await send('Page.navigate', { url: QR_URL }, sidB)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Paneer Tikka')`))
  try {
    await waitFor(() => (state.byKeyCalls.some((c) => c.key === droppedOrder.idempotencyKey) ? true : false))
  } catch {
    const ls = await evalIn(sidB, `JSON.stringify(localStorage)`)
    throw new Error(`byKeyCalls=${JSON.stringify(state.byKeyCalls)} ls=${ls}`)
  }

  // Verify exactly 1 order for that checkout and Tab A's unsubmitted Masala Dosa + Mango Lassi remain.
  assert.equal(state.orders.length, 2)
  await send('Page.reload', {}, sidA)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Paneer Tikka')`))
  const cartAfterReloadA = await evalIn(sidA, `localStorage.getItem('the-salad-cart-session-tok-browser-1')`)
  const parsedA = JSON.parse(cartAfterReloadA || '[]')
  assert.equal(parsedA.find((c: any) => c.menuItemId === MENU_ITEMS[1].id)?.quantity, 1, 'Tab A unsubmitted Dosa remains')
  assert.equal(parsedA.find((c: any) => c.menuItemId === MENU_ITEMS[2].id)?.quantity, 1, 'Tab A unsubmitted Lassi remains')
  console.log('  ok    Browser test 1: Lost response + QR reload recovers order via original key and preserves Tab A cart')

  // 2. Ended-session fallback in real browser:
  // Reload Tab B so the confirmation sheet is closed and tok-browser-1 is adopted in page state & storage,
  // then end tok-browser-1 on backend, submit -> 403 clears credential -> retry via QR without reload.
  await send('Page.reload', {}, sidB)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Paneer Tikka')`))
  sess1.status = 'ENDED'
  await evalIn(
    sidB,
    `[...document.querySelectorAll('button[aria-label^="Add "]')][0]?.click()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await evalIn(
    sidB,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Place Order')`))
  await evalIn(
    sidB,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`,
  )
  await waitFor(async () => {
    const stored = await evalIn(sidB, `localStorage.getItem('restro_session:${TENANT.id}:${TABLE.id}')`)
    return stored === null
  })
  // Retry Place Order in Tab B without reloading -> creates 1 order in new session tok-browser-2.
  await evalIn(
    sidB,
    `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`,
  )
  await waitFor(() => (state.orders.length === 3 ? true : false))
  assert.equal(state.orders[2].sessionToken, 'tok-browser-2')
  console.log('  ok    Browser test 2: Ended session clears page state & storage and retries via QR without reload')

  // 3. Duplicate checkout across two tabs with the same shared cart:
  await send('Page.reload', {}, sidA)
  await send('Page.reload', {}, sidB)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Mango Lassi')`))
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Mango Lassi')`))

  // Put the same shared cart (1 Mango Lassi) in both tabs.
  await evalIn(sidB, `[...document.querySelectorAll('button[aria-label^="Add "]')][2]?.click()`)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await send('Page.reload', {}, sidA)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))

  // Open View Order in both tabs, hold A's checkout response, then submit from B before A finishes.
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Place Order')`))

  const ordersBeforeDup = state.orders.length
  const attemptsBeforeDup = state.postAttempts.length
  state.holdNextPost = true
  await Promise.all([
    evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`),
    evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`),
  ])
  await waitFor(() => (state.releaseHeldPost !== null ? true : false))
  await sleep(300)
  state.releaseHeldPost!()
  try {
    await waitFor(() => (state.orders.length === ordersBeforeDup + 1 ? true : false))
  } catch (err) {
    throw new Error(`waitFor orders failed: orders=${state.orders.length} before=${ordersBeforeDup} attempts=${JSON.stringify(state.postAttempts.slice(attemptsBeforeDup))} (${String(err)})`)
  }
  await sleep(400)
  const dupAttempts = state.postAttempts.slice(attemptsBeforeDup)
  const uniqueDupKeys = new Set(dupAttempts.map((a) => a.key))
  assert.equal(uniqueDupKeys.size, 1, 'simultaneous checkout must use only one idempotency key')
  assert.equal(state.orders.length, ordersBeforeDup + 1, 'must create exactly 1 order for duplicate shared-cart checkout')

  // Also cover stale-tab B attempting checkout after A confirms before B receives storage update:
  // Put 1 Mango Lassi in A & B, confirm from A while suppressing storage event in B, then click Place Order in B.
  await evalIn(sidB, `window.addEventListener('storage', (e) => e.stopImmediatePropagation(), true)`)
  await send('Page.reload', {}, sidA)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Mango Lassi')`))
  await evalIn(sidA, `[...document.querySelectorAll('button[aria-label^="Add "]')][2]?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))
  await send('Page.reload', {}, sidB)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidB, `window.addEventListener('storage', (e) => e.stopImmediatePropagation(), true)`)
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Place Order')`))
  const ordersBeforeStale = state.orders.length
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await waitFor(() => (state.orders.length === ordersBeforeStale + 1 ? true : false))
  // Now B still shows stale Place Order button; clicking it must not create a second order.
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await sleep(350)
  assert.equal(state.orders.length, ordersBeforeStale + 1, 'stale tab must not re-submit item already confirmed by A')
  console.log('  ok    Browser test 3: Simultaneous + stale-tab checkout across two tabs produces exactly 1 order')

  // 4. Reload with an unrelated reservation:
  // Reset browser storage, open both tabs in browsing mode, establish session in A,
  // hold A's follow-up order for 1 Masala Dosa, independently add 2 Masala Dosa in B,
  // reload B twice via QR, then resolve A and verify B's 2 units remain intact.
  await evalIn(sidA, `localStorage.clear(); sessionStorage.clear()`)
  await send('Page.navigate', { url: QR_URL }, sidA)
  await send('Page.navigate', { url: QR_URL }, sidB)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Masala Dosa')`))
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Masala Dosa')`))

  // A places first order to establish session tok-browser-3.
  await evalIn(sidA, `[...document.querySelectorAll('button[aria-label^="Add "]')][0]?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await waitFor(() => (state.sessions.has('tok-browser-3') ? true : false))

  // A adds 1 Masala Dosa and holds its follow-up checkout response.
  await send('Page.reload', {}, sidA)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Masala Dosa')`))
  await evalIn(sidA, `[...document.querySelectorAll('button[aria-label^="Add "]')][1]?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  state.holdNextPost = true
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await waitFor(() => (state.releaseHeldPost !== null ? true : false))

  // B (still browsing) independently adds 2 Masala Dosa, then reloads twice through QR.
  await evalIn(
    sidB,
    `(() => {
      const btn = [...document.querySelectorAll('button[aria-label^="Add "]')][1];
      btn?.click();
      btn?.click();
    })()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await waitFor(async () => {
    const ok = await evalIn(sidB, `Object.entries(localStorage).some(([k, v]) => k.includes('browsing') && JSON.parse(v || '[]').some((c) => c.menuItemId === '${MENU_ITEMS[1].id}' && c.quantity === 2))`)
    return ok ? true : false
  })
  await send('Page.navigate', { url: QR_URL }, sidB)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Masala Dosa')`))
  await send('Page.navigate', { url: QR_URL }, sidB)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Masala Dosa')`))
  await waitFor(async () => {
    const raw = await evalIn(sidB, `localStorage.getItem('the-salad-cart-session-tok-browser-3')`)
    const items = JSON.parse(raw || '[]')
    return items.some((c: any) => c.menuItemId === MENU_ITEMS[1].id)
  })

  const cartB1 = JSON.parse((await evalIn(sidB, `localStorage.getItem('the-salad-cart-session-tok-browser-3')`)) || '[]')
  assert.equal(cartB1.find((c: any) => c.menuItemId === MENU_ITEMS[1].id)?.quantity, 3, 'A pending 1 + B independent 2 = 3 across both reloads')

  // Resolve A's held follow-up order and verify B's 2 units remain intact.
  state.releaseHeldPost!()
  await waitFor(async () => {
    const raw = await evalIn(sidB, `localStorage.getItem('the-salad-cart-session-tok-browser-3')`)
    const items = JSON.parse(raw || '[]')
    return items.find((c: any) => c.menuItemId === MENU_ITEMS[1].id)?.quantity === 2
  })
  const cartB2 = JSON.parse((await evalIn(sidB, `localStorage.getItem('the-salad-cart-session-tok-browser-3')`)) || '[]')
  assert.equal(cartB2.find((c: any) => c.menuItemId === MENU_ITEMS[1].id)?.quantity, 2, 'B retains 2 units after A confirms')
  console.log('  ok    Browser test 4: Reload with unrelated A reservation preserves B 2 independent units')

  // 5. Removed portion: select Large (₹380, base ₹250) through UI, submit 2 units (dropped),
  // remove Large from test catalog, reload, and return 409 ITEM_UNAVAILABLE -> restores 2x Large at ₹380 (subtotal ₹760) with no order created.
  await evalIn(sidB, `localStorage.setItem('the-salad-cart-session-tok-browser-3', '[]')`)
  await send('Page.navigate', { url: QR_URL }, sidB)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Paneer Tikka')`))
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Large'))?.click()`)
  await evalIn(
    sidB,
    `(() => {
      const btn = [...document.querySelectorAll('button[aria-label^="Add "]')][0];
      btn?.click();
      btn?.click();
    })()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Place Order')`))

  const ordersBeforeRemovedPortion = state.orders.length
  // Reject with 503-equivalent dropped response? Instead use holdNextPost + reload, or seed queue after clicking Place Order:
  // Actually, dropNextPostResponse commits on server, whereas we want NO order created when rejected:
  // Hold the POST, reload B so it stays unresolved in queue, then reject the retry after catalog removes Large!
  state.holdNextPost = true
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await waitFor(() => (state.releaseHeldPost !== null ? true : false))
  // Roll back the simulated server order (representing network drop before commit) while keeping client queue entry.
  state.orders.pop()
  state.removeLargePortionFromCatalog = true
  state.rejectNextPostUnavailable = true
  state.releaseHeldPost = null
  await send('Page.navigate', { url: QR_URL }, sidB)
  // Wait for the recovered queue entry to hit POST /orders and receive 409 ITEM_UNAVAILABLE.
  await waitFor(() => (!state.rejectNextPostUnavailable ? true : false))
  await waitFor(async () => {
    const raw = await evalIn(sidB, `localStorage.getItem('the-salad-cart-session-tok-browser-3')`)
    const items = JSON.parse(raw || '[]')
    return items.length === 1 && items[0].quantity === 2 ? items : false
  })
  const restoredCart = JSON.parse((await evalIn(sidB, `localStorage.getItem('the-salad-cart-session-tok-browser-3')`)) || '[]')
  assert.equal(restoredCart[0].portionId, 'large')
  assert.equal(restoredCart[0].portion, 'Large')
  assert.equal(restoredCart[0].price, 380)
  assert.equal(restoredCart[0].quantity, 2)
  assert.equal(state.orders.length, ordersBeforeRemovedPortion, 'failed checkout must create no order')
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  try {
    await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('760')`))
  } catch (err) {
    const bodyText = await evalIn(sidB, `document.body?.innerText`)
    throw new Error(`waitFor 760 failed: ${String(err)}\nBODY:\n${bodyText}`)
  }
  state.removeLargePortionFromCatalog = false
  console.log('  ok    Browser test 5: Removed portion restores 2x Large at ₹380 with subtotal ₹760 and no order')

  // 6. Independent reservations: A holds 1 Masala Dosa in session queue; B (browsing) independently adds 2 Masala Dosa
  // and submits using A's saved session token -> B's POST has quantity 2 and its own key; confirming both deducts only each order's own qty.
  await evalIn(sidA, `localStorage.clear(); sessionStorage.clear()`)
  await send('Page.navigate', { url: QR_URL }, sidA)
  await send('Page.navigate', { url: QR_URL }, sidB)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Masala Dosa')`))
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Masala Dosa')`))

  // Establish session tok-browser-4 in A.
  await evalIn(sidA, `[...document.querySelectorAll('button[aria-label^="Add "]')][0]?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  try {
    await waitFor(() => (state.sessions.has('tok-browser-4') ? true : false))
  } catch (err) {
    const bodyText = await evalIn(sidA, `document.body?.innerText`)
    throw new Error(`waitFor tok-browser-4 failed: sessions=${JSON.stringify([...state.sessions.keys()])} attempts=${JSON.stringify(state.postAttempts.slice(-3))} body=${bodyText?.slice(0, 400)}`)
  }

  // A adds 1 Masala Dosa and holds its session order unresolved.
  await send('Page.reload', {}, sidA)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Masala Dosa')`))
  await evalIn(sidA, `[...document.querySelectorAll('button[aria-label^="Add "]')][1]?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Place Order')`))
  const attemptsBeforeIndep = state.postAttempts.length
  state.holdNextPost = true
  await evalIn(sidA, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await waitFor(() => (state.releaseHeldPost !== null ? true : false))
  const releaseAIndep = state.releaseHeldPost!
  state.releaseHeldPost = null

  // B (still browsing) independently adds 2 Masala Dosa and submits using saved tok-browser-4.
  await evalIn(
    sidB,
    `(() => {
      const btn = [...document.querySelectorAll('button[aria-label^="Add "]')][1];
      btn?.click();
      btn?.click();
    })()`,
  )
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('View Order')`))
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('View Order'))?.click()`)
  await waitFor(() => evalIn(sidB, `document.body?.innerText?.includes('Place Order')`))
  await evalIn(sidB, `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('Place Order'))?.click()`)
  await waitFor(() => (state.postAttempts.length >= attemptsBeforeIndep + 2 ? true : false))

  const indepAttempts = state.postAttempts.slice(attemptsBeforeIndep)
  assert.equal(indepAttempts[0].items[0].quantity, 1, 'A submitted 1 unit')
  assert.equal(indepAttempts[1].items[0].quantity, 2, 'B submitted 2 independent units')
  assert.notEqual(indepAttempts[0].key, indepAttempts[1].key, 'A and B have distinct idempotency keys')

  releaseAIndep()
  await sleep(300)
  await send('Page.reload', {}, sidA)
  await send('Page.reload', {}, sidB)
  await waitFor(() => evalIn(sidA, `document.body?.innerText?.includes('Masala Dosa')`))
  const finalIndepCart = JSON.parse((await evalIn(sidA, `localStorage.getItem('the-salad-cart-session-tok-browser-4')`)) || '[]')
  assert.equal(finalIndepCart.length, 0, 'each confirmation deducted only its own quantities')
  console.log('  ok    Browser test 6: Independent reservations submit separate keys/quantities and deduct once')
} finally {
  try { ws?.close() } catch { }
  try { chrome?.kill('SIGKILL') } catch { }
  try { nextApp?.kill('SIGKILL') } catch { }
  try { backend.close() } catch { }
  await sleep(300)
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }) } catch { }
}
