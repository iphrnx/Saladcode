/**
 * Order-lifecycle E2E: QR Diner → POS → payment, against the LOCAL orders
 * function (proxied via CDP interception) so the new transition/payment rules
 * are what the UI actually exercises. Staging/dev only; fixture data; cleaned
 * up after. NOT committed.
 *
 *   npx tsx --env-file=.env.local scripts/_order-lifecycle-e2e.mts
 */
import { createClient } from '@supabase/supabase-js'
import { spawn, type ChildProcess } from 'node:child_process'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SITE = 'http://localhost:3000'
const LOCAL_FN = 'http://localhost:8000'
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } })

const stamp = Date.now().toString(36)
const EMAIL = `e2e-lifecycle-${stamp}@example.com`
const PASSWORD = 'Lifecycle123!'
let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail?: any) => {
  if (cond) { passed++; console.log(`ok ${name}`) }
  else { failed++; console.log(`FAIL ${name}${detail ? ' — ' + JSON.stringify(detail).slice(0, 260) : ''}`) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── CDP plumbing ──────────────────────────────────────────────────────────
let chrome: ChildProcess | null = null
let ws: WebSocket | null = null
let msgId = 0
const pending = new Map<number, (v: any) => void>()
const interceptHandlers = new Map<string, (p: any) => void>()
const send = (method: string, params: any = {}, sessionId?: string): Promise<any> =>
  new Promise((resolve) => {
    const i = ++msgId
    pending.set(i, resolve)
    ws!.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

// Every orders-API call the browser makes is proxied to the local function.
const apiLog: { method: string; path: string; status: number }[] = []
let failNext: { body: any; status: number } | null = null

async function proxyTo(requestId: string, pSend: (m: string, p: any) => Promise<any>, req: any) {
  const u = new URL(req.url)
  if (req.method === 'OPTIONS') {
    await pSend('Fetch.fulfillRequest', {
      requestId, responseCode: 204,
      responseHeaders: [
        { name: 'Access-Control-Allow-Origin', value: SITE },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
        { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, DELETE, OPTIONS' },
        { name: 'Access-Control-Allow-Headers', value: 'authorization, apikey, content-type, x-tenant-id, x-session-token, x-idempotency-key' },
        { name: 'Access-Control-Max-Age', value: '600' },
      ],
    })
    return
  }
  const headers: Record<string, string> = {}
  const rawHeaders: [string, string][] = Array.isArray(req.headers)
    ? req.headers.map((h: any) => [h.name, h.value])
    : Object.entries(req.headers as Record<string, string>)
  for (const [name, value] of rawHeaders) {
    const n = name.toLowerCase()
    if (['host', 'origin', 'referer', 'user-agent', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'accept-encoding', 'accept-language', 'connection', 'cookie'].includes(n)) continue
    headers[n] = value
  }
  if (failNext && req.method === 'PATCH') {
    const injected = failNext
    failNext = null
    apiLog.push({ method: req.method, path: u.pathname, status: injected.status })
    await pSend('Fetch.fulfillRequest', {
      requestId, responseCode: injected.status,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: SITE },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
      ],
      body: btoa(JSON.stringify(injected.body)),
    })
    return
  }
  const res = await fetch(`${LOCAL_FN}${u.pathname}${u.search}`, {
    method: req.method, headers,
    body: req.postData ?? undefined,
  })
  const text = await res.text()
  apiLog.push({ method: req.method, path: u.pathname, status: res.status })
  if (u.pathname.endsWith('/sync')) { try { const j = JSON.parse(text); console.log('SYNC-RESP', (j.orders || []).map((o: any) => `#${o.orderNumber}:${o.status}`).join(',')) } catch {} }
  if (req.method === 'POST' && u.pathname.endsWith('/orders') && res.status === 200) {
    try { createdOrder = JSON.parse(text) } catch {}
  }
  await pSend('Fetch.fulfillRequest', {
    requestId, responseCode: res.status,
    responseHeaders: [
      { name: 'Content-Type', value: res.headers.get('content-type') ?? 'application/json' },
      { name: 'Access-Control-Allow-Origin', value: SITE },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
    ],
    body: btoa(unescape(encodeURIComponent(text))),
  })
}
let createdOrder: any = null

async function main() {
  // ── fixture ────────────────────────────────────────────────────────────
  const userId = (await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true })).data.user!.id
  const tenant = (await admin.from('tenants').insert({ name: `E2E Lifecycle ${stamp}`, slug: `e2e-lc-${stamp}`, currency_symbol: '₹', active: true, onboarding_done: true }).select('id').single()).data!
  await admin.from('profiles').insert({ id: userId, tenant_id: tenant.id, name: 'E2E Lifecycle', email: EMAIL, role: 'OWNER', active: true })
  const cat = (await admin.from('categories').insert({ tenant_id: tenant.id, name: 'Mains', sort_order: 0 }).select('id').single()).data!
  await admin.from('menu_items').insert([
    { tenant_id: tenant.id, category_id: cat.id, name: 'Butter Paneer', price: 240, available: true, sort_order: 0, prep_time: 15 },
    { tenant_id: tenant.id, category_id: cat.id, name: 'Garlic Naan', price: 60, available: true, sort_order: 1, prep_time: 8 },
  ])
  const table = (await admin.from('tables').insert({ tenant_id: tenant.id, name: 'T1', seats: 2, area: 'Main Hall', active: true }).select('id, qr_token').single()).data!

  // ── browser with two targets ────────────────────────────────────────────
  const PORT = 21000 + (process.pid % 8000)
  const PROFILE = `/tmp/chrome-lifecycle-${Date.now()}`
  chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
  let version: any = null
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(250) }
  }
  if (!version) throw new Error('chrome did not start')
  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((r) => (ws!.onopen = r))
  ws.onmessage = (e: any) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id) }
  }

  const mkTarget = async (url: string) => {
    const { targetId } = await send('Target.createTarget', { url })
    let pageWsUrl: string | undefined
    for (let i = 0; i < 40 && !pageWsUrl; i++) {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[]
      pageWsUrl = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl
      if (!pageWsUrl) await sleep(250)
    }
    if (!pageWsUrl) throw new Error('page ws not found for ' + targetId)
    if (process.env.DEBUG_EARLY) {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[]
      console.log('mkTarget', url.slice(0, 40), '→ targetId', String(targetId).slice(0, 12), 'pages:', list.filter((t) => t.type === 'page').map((t) => `${String(t.id).slice(0, 12)}:${t.url.slice(0, 30)}`).join(' | '))
    }
    const pws = new WebSocket(pageWsUrl)
    await new Promise((r) => (pws.onopen = r))
    let pid = 0
    const ppending = new Map<number, (v: any) => void>()
    pws.onmessage = (e: any) => {
      const m = JSON.parse(e.data)
      if (m.id && ppending.has(m.id)) { ppending.get(m.id)!(m.result); ppending.delete(m.id) }
      else if (m.method === 'Fetch.requestPaused') {
        console.log('PAUSED on', url.slice(0, 40), m.params.request.url.slice(0, 80))
        void proxyTo(m.params.requestId, pSend, m.params.request).catch((err: any) => console.log('proxy err', String(err)))
      } else if (m.method === 'Runtime.exceptionThrown') { console.log('PAGE-EXCEPTION', JSON.stringify(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 260)) }
      else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) { console.log('PAGE-CONSOLE', m.params.type, JSON.stringify(m.params.args?.map((a: any) => a.value ?? a.description ?? a.type)).slice(0, 260)) }
      else if (m.method) { console.log('event:', m.method) }
    }
    const pSend = (method: string, params: any = {}): Promise<any> =>
      new Promise((resolve) => { const i = ++pid; ppending.set(i, resolve); pws.send(JSON.stringify({ id: i, method, params })) })
    await pSend('Page.enable')
    await pSend('Runtime.enable')
    await pSend('Network.enable')
    const fen = await pSend('Fetch.enable', { patterns: [{ urlPattern: '*functions/v1/orders*', requestStage: 'Request' }] })
    console.log('Fetch.enable on', url.slice(0, 40), JSON.stringify(fen).slice(0, 120))
    const evaluate = (expr: string) =>
      pSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r: any) => r?.result?.value)
    const waitFor = async (expr: string, tries = 40, gap = 500) => {
      for (let i = 0; i < tries; i++) {
        const v = await evaluate(expr)
        if (v) return v
        await sleep(gap)
      }
      return undefined
    }
    const navigate = (u: string) => pSend('Page.navigate', { url: u })
    const reload = () => pSend('Page.reload', {})
    return { targetId, evaluate, waitFor, navigate, reload }
  }

  // ── POS login ───────────────────────────────────────────────────────────
  const pos = await mkTarget(`${SITE}/?view=login`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Welcome back')`)
  const fill = (t: any, sel: string, value: string) =>
    t.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      s.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`)
  for (let i = 0; i < 12; i++) {
    await fill(pos, 'input[type="email"]', EMAIL)
    await fill(pos, "input[placeholder='••••••••']", PASSWORD)
    await sleep(700)
    const ok = await pos.evaluate(`document.querySelector('input[type=\"email\"]')?.value === ${JSON.stringify(EMAIL)} && document.querySelector('input[placeholder=\"••••••••\"]')?.value === ${JSON.stringify(PASSWORD)}`)
    if (ok) break
  }
  await pos.evaluate(`document.querySelector('form button[type="submit"]')?.click()`)
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').trim()==='Accept All')?.click()`)
  await pos.waitFor(`location.href.includes('view=') && !location.href.includes('view=login')`, 40)
  await pos.evaluate(`location.href = ${JSON.stringify(`${SITE}/?view=orders`)}`)
  await pos.waitFor(`(document.body?.innerText||'').includes('No orders') || (document.body?.innerText||'').includes('Order #')`, 40)
  console.log('POS ready')
  // interception self-test: a direct orders fetch from the POS page
  {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    await pos.evaluate(`fetch('${url}/functions/v1/orders/selftest?x=1').catch(()=>{}); true`)
    await sleep(2500)
    console.log('selftest apiLog:', JSON.stringify(apiLog.slice(0, 3)))
  }

  // ── diner opens the QR menu and orders ──────────────────────────────────
  const diner = await mkTarget(`${SITE}/?table=${table.qr_token}`)
  await diner.waitFor(`(document.body?.innerText||'').includes('Butter Paneer')`, 60)
  {
    await diner.evaluate(`(() => { window.__fetchLog = []; const of = window.fetch; window.fetch = function(...a) { try { window.__fetchLog.push(String(a[0]).slice(0,80) + ' ' + (a[1] && a[1].method ? a[1].method : 'GET')) } catch {} return of.apply(this, a) } ; return true })()`)
  }
  {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
    console.log('diner page url:', await diner.evaluate('location.href'))
    await diner.evaluate(`fetch('${url}/functions/v1/orders/dinerselftest?x=1').catch(()=>{}); true`)
    await sleep(2500)
    console.log('diner selftest apiLog:', JSON.stringify(apiLog.slice(-3)))
  }
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').trim()==='Accept All')?.click()`)
  await sleep(400)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.getAttribute('aria-label')||'').includes('Add Butter Paneer'))?.click()`)
  await diner.waitFor(`(document.body?.innerText||'').includes('Garlic Naan')`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.getAttribute('aria-label')||'').includes('Add Garlic Naan'))?.click()`)
  await sleep(300)
  const baseline1 = (await admin.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)).count
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('View Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('View Order'))?.click()`)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('Place Order'))`)
  {
    const before = await diner.evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')].map((b) => ({ t: (b.innerText || '').slice(0, 40), d: b.disabled, cls: b.className.slice(0, 60) }))
      const sheet = document.querySelector('[data-state="open"]')
      return { btns: btns.filter((b) => b.t.toLowerCase().includes('place') || b.t.toLowerCase().includes('order')), sheetOpen: !!sheet, sheetText: sheet ? sheet.innerText.slice(0, 300) : null }
    })()`)
    console.log('BEFORE-CLICK', JSON.stringify(before).slice(0, 700))
  }
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Place Order'))?.click()`)
  await sleep(2500)
  {
    const after = await diner.evaluate(`(() => {
      const sheet = document.querySelector('[data-state="open"]')
      const toasts = [...document.querySelectorAll('[role="status"],[data-sonner-toast]')].map((t) => t.innerText.slice(0, 120))
      return { sheetOpen: !!sheet, sheetText: sheet ? sheet.innerText.slice(0, 400) : null, toasts, fetches: (window.__fetchLog || []).slice(-5) }
    })()`)
    console.log('AFTER-CLICK', JSON.stringify(after).slice(0, 900))
  }
  // Wait for a NEW order row (count grows past the baseline) and return it.
  const awaitDbOrder = async (baseline: number | null): Promise<any> => {
    for (let i = 0; i < 40; i++) {
      const cnt = (await admin.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)).count
      if (cnt !== null && baseline !== null && cnt > baseline) {
        const rows = (await admin.from('orders').select('id, order_number, status').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(1)).data
        if (rows?.[0]) return { ...rows[0], orderNumber: rows[0].order_number }
      }
      await sleep(1000)
    }
    return null
  }

  const placedAt = Date.now()
  const createdOrder = await awaitDbOrder(baseline1)
  {
    const dump = await diner.evaluate(`(() => {
      const out = {}
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k.includes('queue') || k.includes('order') || k.includes('session') || k.includes('the-salad') || k.includes('toastly') || k.includes('swixo')) out[k] = (localStorage.getItem(k) || '').slice(0, 220)
      }
      out.__body = (document.body?.innerText || '').slice(0, 300)
      return out
    })()`)
    console.log('DINER-DUMP', JSON.stringify(dump).slice(0, 1200))
    console.log('FETCHLOG', JSON.stringify(await diner.evaluate('window.__fetchLog || []')).slice(0, 800))
    console.log('PLACEBTN', JSON.stringify(await diner.evaluate(`[...document.querySelectorAll('button')].filter((b)=>(b.innerText||'').includes('Place Order')).map((b)=>b.outerHTML.slice(0,160))`)).slice(0, 500))
  }
  check('diner checkout created a DB order', !!createdOrder?.id, createdOrder)
  const successShown = await diner.waitFor(`(document.body?.innerText||'').includes('order placed') || (document.body?.innerText||'').includes('Order placed') || (document.body?.innerText||'').includes('We received')`, 20)
  check('diner saw the confirmation', !!successShown)
  await sleep(1500)
  const orderNumber = createdOrder?.orderNumber

  // ── POS sees the new order without a reload ─────────────────────────────
  const seenAt = await pos.waitFor(`(document.body?.innerText||'').includes('#${orderNumber}')`, 30, 400)
  if (!seenAt) {
    console.log('POS-BODY-AT-FAIL:', JSON.stringify(await pos.evaluate('(document.body?.innerText || "").slice(0, 500)')).slice(0, 600))
  }
  check('POS shows the QR order via realtime (no reload)', !!seenAt, { orderNumber })
  const latency = Date.now() - placedAt
  check(`POS convergence under 8s (${latency}ms)`, latency < 8000)

  // ── rapid double-click: exactly one PATCH ───────────────────────────────
  const patchesBefore = apiLog.filter((a) => a.method === 'PATCH').length
  await pos.evaluate(`(() => { const btns=[...document.querySelectorAll('button')].filter((b)=>(b.innerText||'').includes('Start Preparing')); btns[0]?.click(); btns[0]?.click(); btns[0]?.click(); })()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Mark Ready')`, 20, 400)
  await sleep(1200)
  const patchesAfter = apiLog.filter((a) => a.method === 'PATCH').length
  check(`rapid triple-click → one PATCH (${patchesAfter - patchesBefore} sent)`, patchesAfter - patchesBefore === 1, apiLog.slice(-6))
  const db1 = (await admin.from('orders').select('status, payment_status').eq('id', createdOrder.id).single()).data
  check('DB is PREPARING after the clicks', db1?.status === 'PREPARING', db1)
  check('still UNPAID while preparing', db1?.payment_status === 'UNPAID', db1)

  // ── walk to SERVED, measuring the button turnaround ─────────────────────
  const t0 = Date.now()
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Mark Ready'))?.click()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Mark Served')`, 20, 400)
  const readyMs = Date.now() - t0
  check(`Mark Ready is optimistic-fast (${readyMs}ms, was PATCH+full-bootstrap before)`, readyMs < 2500)
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Mark Served'))?.click()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Complete & Pay')`, 20, 400)
  const db2 = (await admin.from('orders').select('status').eq('id', createdOrder.id).single()).data
  check('DB is SERVED', db2?.status === 'SERVED', db2)

  // ── Complete & Pay: the recorded payment is explicit ────────────────────
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Complete & Pay'))?.click()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Confirm Payment')`, 20, 400)
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Confirm Payment'))?.click()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Completed')`, 20, 400)
  await sleep(1000)
  const db3 = (await admin.from('orders').select('status, payment_status, payment_method').eq('id', createdOrder.id).single()).data
  check('DB COMPLETED + PAID + CASH after the pay dialog', db3?.status === 'COMPLETED' && db3?.payment_status === 'PAID' && db3?.payment_method === 'CASH', db3)
  check('POS pill shows the payment (CASH)', (await pos.evaluate(`(document.body?.innerText||'')`))?.includes('CASH'))

  // ── the diner's session ended and their bill is right ────────────────────
  const ended = await diner.waitFor(`(document.body?.innerText||'').includes('View Bill') || (document.body?.innerText||'').includes('ended') || (document.body?.innerText||'').includes('Thanks')`, 30, 500)
  check('diner landed on the ended screen', !!ended)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('View Bill'))`, 30, 500)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('View Bill'))?.click()`)
  const billPaid = await diner.waitFor(`[...document.querySelectorAll('[role="dialog"] span')].some((e)=>/^PAID( · |$)/.test((e.innerText||'').trim()))`, 30, 500)
  if (!billPaid) {
    const diag = await diner.evaluate(`(() => ({
      dialog: !!document.querySelector('[role="dialog"]'),
      toasts: [...document.querySelectorAll('[data-sonner-toast], [role="status"]')].map((t) => t.innerText.slice(0, 80)),
      fetches: (window.__fetchLog || []).slice(-6),
      body: (document.body?.innerText || '').slice(0, 250),
    }))()`)
    console.log('BILL-DIAG', JSON.stringify(diag).slice(0, 900))
  }
  check('diner bill shows PAID', !!billPaid)
  const billText = await diner.evaluate(`(document.querySelector('[role="dialog"]')?.innerText||'').slice(0,1200)`)
  check('diner bill shows the method', billText?.includes('CASH'), billText?.slice(0, 200))

  // ── second order: completed WITHOUT payment — the honest state ─────────
  await diner.navigate(`${SITE}/?table=${table.qr_token}`)
  await diner.waitFor(`(document.body?.innerText||'').includes('Butter Paneer')`, 60)
  await sleep(500)
  const baseline2 = (await admin.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)).count
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.getAttribute('aria-label')||'').includes('Add Butter Paneer'))?.click()`)
  await sleep(300)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('View Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('View Order'))?.click()`)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('Place Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Place Order'))?.click()`)
  const order2 = await awaitDbOrder(baseline2)
  check('second order created', !!order2?.id, order2)
  await pos.waitFor(`(document.body?.innerText||'').includes('#${order2?.orderNumber}')`, 30, 400)
  // advance to SERVED then complete with NO payment, from the POS page's own auth
  for (const label of ['Start Preparing', 'Mark Ready', 'Mark Served']) {
    await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes(${JSON.stringify(label)}))?.click()`)
    await sleep(1400)
  }
  await pos.waitFor(`(document.body?.innerText||'').includes('Complete & Pay')`, 20, 400)
  const ownerPatch = await pos.evaluate(`(async () => {
    try {
    const raw = document.cookie.split('; ').find((c) => c.includes('auth-token'))
    if (!raw) return 'no-auth-cookie'
    const v = raw.split('=').slice(1).join('=')
    const json = v.startsWith('base64-') ? atob(v.slice(7).replace(/-/g, '+').replace(/_/g, '/')) : decodeURIComponent(v)
    const token = JSON.parse(json).access_token
    const res = await fetch('${process.env.NEXT_PUBLIC_SUPABASE_URL!}/functions/v1/orders/${order2.id}', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, apikey: ${JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)}, 'x-tenant-id': ${JSON.stringify(tenant.id)} }, body: JSON.stringify({ status: 'COMPLETED' }) })
    return res.status
    } catch (e) { return 'ERR:' + String(e).slice(0, 120) }
  })()`)
  check('completion without payment accepted (200)', ownerPatch === 200, ownerPatch)
  await sleep(1200)
  const db4 = (await admin.from('orders').select('status, payment_status').eq('id', order2.id).single()).data
  check('completed but honestly UNPAID — no auto-PAID', db4?.status === 'COMPLETED' && db4?.payment_status === 'UNPAID', db4)

  // diner opens their bill — it must say UNPAID (that is the truth).
  // No fresh navigate: the live page received the COMPLETED broadcast, and a
  // reload would mint a NEW session for the table — a new customer — from
  // which the previous session's bill is unreachable by design.
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('View Bill'))`, 30, 500)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('View Bill'))?.click()`)
  await diner.waitFor(`document.querySelector('[role="dialog"]')`, 30, 500)
  const unpaidBill = await diner.waitFor(`[...document.querySelectorAll('[role="dialog"] *')].some((e)=>(e.innerText||'')==='UNPAID')`, 30, 500)
  check('diner bill honestly shows UNPAID after completion-without-payment', !!unpaidBill)

  // ── the live flip: pay from the POS while the diner is reading the bill ─
  const payStatus = await pos.evaluate(`(async () => {
    try {
    const raw = document.cookie.split('; ').find((c) => c.includes('auth-token'))
    if (!raw) return 'no-auth-cookie'
    const v = raw.split('=').slice(1).join('=')
    const json = v.startsWith('base64-') ? atob(v.slice(7).replace(/-/g, '+').replace(/_/g, '/')) : decodeURIComponent(v)
    const token = JSON.parse(json).access_token
    const res = await fetch('${process.env.NEXT_PUBLIC_SUPABASE_URL!}/functions/v1/orders/${order2.id}', { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, apikey: ${JSON.stringify(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)}, 'x-tenant-id': ${JSON.stringify(tenant.id)} }, body: JSON.stringify({ paymentStatus: 'PAID', paymentMethod: 'UPI' }) })
    return res.status
    } catch (e) { return 'ERR:' + String(e).slice(0, 120) }
  })()`)
  check('payment recorded on a completed order (200)', payStatus === 200, payStatus)
  const flipped = await diner.waitFor(`[...document.querySelectorAll('[role="dialog"] span')].some((e)=>/^PAID( · |$)/.test((e.innerText||'').trim()))`, 30, 500)
  check('the OPEN diner bill flipped to PAID live, without reopening', !!flipped)
  const bill2 = await diner.evaluate(`(document.querySelector('[role="dialog"]')?.innerText||'')`)
  check('bill shows UPI as the method', bill2?.includes('UPI'), bill2?.slice(0, 200))

  // ── delete propagation across two POS tabs ─────────────────────────────
  const baseline3 = (await admin.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)).count
  await diner.navigate(`${SITE}/?table=${table.qr_token}`)
  await diner.waitFor(`(document.body?.innerText||'').includes('Butter Paneer')`, 60)
  await sleep(600)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.getAttribute('aria-label')||'').includes('Add Garlic Naan'))?.click()`)
  await sleep(300)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('View Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('View Order'))?.click()`)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('Place Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Place Order'))?.click()`)
  const order3 = await awaitDbOrder(baseline3)
  check('third order created', !!order3?.id, order3)
  const pos2 = await mkTarget(`${SITE}/?view=orders`)
  await pos2.waitFor(`(document.body?.innerText||'').includes('#${order3?.orderNumber}')`, 40, 500)
  await pos.waitFor(`(document.body?.innerText||'').includes('#${order3?.orderNumber}')`, 30, 400)
  // delete from POS-1
  await pos.evaluate(`(() => { const cards=[...document.querySelectorAll('[data-slot="card"]')]; const c=cards.find((x)=>(x.innerText||'').includes('#${order3?.orderNumber}')); const del=[...c.querySelectorAll('button')].find((b)=>(b.getAttribute('title')||'').includes('Delete order')); del?.click(); })()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('Delete this order') || (document.body?.innerText||'').includes('Are you sure')`, 20, 400)
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').toLowerCase().includes('delete'))?.click()`)
  await sleep(2500)
  const goneFromPos2 = !(await pos2.evaluate(`(document.body?.innerText||'')`))?.includes(`Order #${order3?.orderNumber}`)
  check('delete propagated to the second POS tab without reload', goneFromPos2)

  // ── rollback: a refused move restores the card ─────────────────────────
  const baseline4 = (await admin.from('orders').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant.id)).count
  await diner.navigate(`${SITE}/?table=${table.qr_token}`)
  await diner.waitFor(`(document.body?.innerText||'').includes('Butter Paneer')`, 60)
  await sleep(600)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.getAttribute('aria-label')||'').includes('Add Butter Paneer'))?.click()`)
  await sleep(300)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('View Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('View Order'))?.click()`)
  await diner.waitFor(`[...document.querySelectorAll('button')].some((b)=>(b.innerText||'').includes('Place Order'))`)
  await diner.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Place Order'))?.click()`)
  const order4 = await awaitDbOrder(baseline4)
  await pos.waitFor(`(document.body?.innerText||'').includes('#${order4?.orderNumber}')`, 30, 400)
  failNext = { status: 409, body: { error: `Order #${order4?.orderNumber} is COMPLETED; it cannot move to PREPARING.`, currentStatus: 'COMPLETED' } }
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Start Preparing'))?.click()`)
  await pos.waitFor(`(document.body?.innerText||'').includes('cannot move to')`, 20, 400)
  await sleep(800)
  const backToPending = (await pos.evaluate(`(document.body?.innerText||'')`))?.includes('Start Preparing')
  check('refused move rolled the card back to PENDING', backToPending)
  const db5 = (await admin.from('orders').select('status').eq('id', order4.id).single()).data
  check('DB untouched by the refused move', db5?.status === 'PENDING', db5)
  // and the button works again after the rollback
  await pos.evaluate(`[...document.querySelectorAll('button')].find((b)=>(b.innerText||'').includes('Start Preparing'))?.click()`)
  const recovered = await pos.waitFor(`(document.body?.innerText||'').includes('Mark Ready')`, 20, 400)
  check('button usable again after rollback', !!recovered)

  // ── reload mid-lifecycle: screen matches DB ─────────────────────────────
  await pos.reload()
  await pos.waitFor(`(document.body?.innerText||'').includes('#${order4?.orderNumber}')`, 40, 500)
  await sleep(1000)
  const db6 = (await admin.from('orders').select('status').eq('id', order4.id).single()).data
  const screen = await pos.evaluate(`(document.body?.innerText||'')`)
  const expectedLabel = db6?.status === 'PREPARING' ? 'Mark Ready' : 'Start Preparing'
  check(`after reload the screen matches the DB (${db6?.status})`, screen?.includes(expectedLabel), { db: db6?.status })

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}

main().catch((e) => { console.error('E2E FAILED:', e); process.exitCode = 1 }).finally(async () => {
  try {
    const t = (await admin.from('tenants').select('id').like('slug', `e2e-lc-${stamp}`).single()).data
    if (t) {
      await admin.from('tenants').delete().eq('id', t.id)
      console.log('fixture tenant cleaned')
    }
    const u = (await admin.from('profiles').select('id').eq('email', EMAIL).maybeSingle()).data
    if (u) await admin.from('profiles').delete().eq('id', u.id)
    const list = await admin.auth.admin.listUsers()
    const user = list.data.users.find((x: any) => x.email === EMAIL)
    if (user) await admin.auth.admin.deleteUser(user.id)
    console.log('fixture cleaned')
  } catch (e) { console.error('cleanup error', e) }
  try { chrome?.kill('SIGKILL') } catch {}
  setTimeout(() => process.exit(process.exitCode ?? 0), 500)
})
