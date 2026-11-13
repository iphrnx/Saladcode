/**
 * Verify the QR page: natural order, branded card, PNG export and print sheet.
 * Read-only against whichever SITE the env points at.
 */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const SITE = process.env.QR_CHECK_SITE ?? 'http://localhost:3000'
const PORT = 9341
const DOWNLOADS = '/tmp/qr-downloads'
const EMAIL = process.env.QR_CHECK_EMAIL ?? 'thesaladsoft@gmail.com'
const PASSWORD = process.env.QR_CHECK_PASSWORD ?? ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

let pass = 0
const fails: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok    ${label}`) }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}

fs.rmSync(DOWNLOADS, { recursive: true, force: true })
fs.mkdirSync(DOWNLOADS, { recursive: true })

// A session for a tenant that has tables, using the magic-link OTP (no password needed).
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session
const tenantId = (await admin.from('profiles').select('tenant_id').eq('email', EMAIL).single()).data!.tenant_id
const { data: dbTables } = await admin.from('tables').select('name, area, seats').eq('tenant_id', tenantId)

const PROFILE = `/tmp/chrome-qr-${Date.now()}`
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
let version: any = null
for (let i = 0; i < 60 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(250) } }
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let msgId = 0
const pending = new Map<number, (v: any) => void>()
ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id) } }
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

const { targetId } = await send('Target.createTarget', { url: `${SITE}/` })
let pageWs: string | undefined
for (let i = 0; i < 40 && !pageWs; i++) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[]
  pageWs = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl
  if (!pageWs) await sleep(250)
}
const pws = new WebSocket(pageWs!)
await new Promise((r) => (pws.onopen = r))
let pid = 0
const ppending = new Map<number, (v: any) => void>()
const errors: string[] = []
pws.onmessage = (e: any) => {
  const m = JSON.parse(e.data)
  if (m.id && ppending.has(m.id)) { ppending.get(m.id)!(m.result); ppending.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 200))
}
const pSend = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++pid; ppending.set(i, res); pws.send(JSON.stringify({ id: i, method, params })) })
await pSend('Runtime.enable'); await pSend('Page.enable')
await pSend('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS })
const evaluate = (expr: string) => pSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r: any) => r?.result?.value)
const waitFor = async (expr: string, tries = 60, gap = 500) => { for (let i = 0; i < tries; i++) { const v = await evaluate(expr); if (v) return v; await sleep(gap) } return undefined }

const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]
const host = new URL(SITE).hostname
await pSend('Network.setCookie', {
  name: `sb-${ref}-auth-token`,
  value: 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url'),
  domain: host, path: '/', secure: SITE.startsWith('https'), sameSite: 'Lax',
})

await pSend('Page.navigate', { url: `${SITE}/?view=qr` })
await waitFor(`document.querySelectorAll('article').length > 0`, 80, 500)
await sleep(1500)

// 1. Natural order on the QR page
const order = await evaluate(`[...document.querySelectorAll('article h3')].map((h) => h.innerText.trim())`)
const expected = [...(dbTables ?? [])].map((t) => t.name).sort((a, b) => {
  const an = Number(a.match(/\d+/)?.[0] ?? 0), bn = Number(b.match(/\d+/)?.[0] ?? 0)
  return an - bn || a.localeCompare(b)
})
check('QR page lists tables in natural order', JSON.stringify(order) === JSON.stringify(expected), { order, expected })

// 2. Branded preview present in each card
const brand = await evaluate(`(() => {
  const a = document.querySelector('article');
  const text = (a?.innerText || '');
  return { scan: text.includes('SCAN TO ORDER'), powered: text.includes('Powered by The Salad'), restaurant: text.includes(${JSON.stringify((await admin.from('tenants').select('name').eq('id', tenantId).single()).data!.name)}) };
})()`)
check('preview shows SCAN TO ORDER', !!brand?.scan)
check('preview shows Powered by The Salad', !!brand?.powered)
check('preview shows the restaurant name', !!brand?.restaurant)

// 3. PNG download composes the card and keeps the QR scannable
const firstName = order?.[0]
await evaluate(`(() => { const a = [...document.querySelectorAll('article')].find((x) => (x.innerText||'').includes(${JSON.stringify(firstName)})); [...a.querySelectorAll('button')].find((b) => (b.innerText||'').includes('PNG'))?.click(); })()`)
let file: string | undefined
for (let i = 0; i < 60 && !file; i++) {
  await sleep(300)
  file = fs.readdirSync(DOWNLOADS).find((f) => f.endsWith('.png'))
}
check('PNG export downloaded', !!file, fs.readdirSync(DOWNLOADS))
if (file) {
  const { PNG } = await import('/tmp/qrtools/node_modules/pngjs/lib/png.js' as any)
  const jsQR = (await import('/tmp/qrtools/node_modules/jsqr/dist/jsQR.js' as any)).default
  const png = PNG.sync.read(fs.readFileSync(`${DOWNLOADS}/${file}`))
  check('export is a tall card, not a bare QR', png.height > png.width * 1.15, { w: png.width, h: png.height })
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)
  check('the exported QR still decodes', !!decoded, decoded?.data ?? null)
  const dbQr = (await admin.from('tables').select('qr_token').eq('tenant_id', tenantId).eq('name', firstName!).single()).data!.qr_token
  check('decoded URL points at the same table token', !!decoded?.data?.includes(dbQr), decoded?.data)
  fs.copyFileSync(`${DOWNLOADS}/${file}`, '/tmp/qr-card-export.png')
}

// 3b. Download All — every table, one download each, all branded
fs.rmSync(DOWNLOADS, { recursive: true, force: true })
fs.mkdirSync(DOWNLOADS, { recursive: true })
await pSend('Runtime.evaluate', {
  expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText||'').includes('Download All')); b?.click(); return !!b })()`,
  returnByValue: true, userGesture: true,
})
let files: string[] = []
for (let i = 0; i < 90; i++) {
  await sleep(500)
  files = fs.readdirSync(DOWNLOADS).filter((f) => f.endsWith('.png'))
  if (files.length >= (order?.length ?? 0)) break
}
check(`Download All produced ${order?.length} files`, files.length === order?.length, files)
check('Download All names each file for its table', files.every((f) => /^[a-z0-9-]+-qr\.png$/.test(f)), files.slice(0, 3))
check('file names are not doubled ("table-table-1")', !files.some((f) => f.includes('table-table-')), files.slice(0, 3))

// 4. Print sheet carries the same design and a millimetre-sized QR
const targetsBefore = new Set(((await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as any[]).map((t) => t.id))
// userGesture: true — a synthetic click without it cannot open a window, and
// the real button click always carries one.
const printState = await pSend('Runtime.evaluate', {
  expression: `(() => {
    const btn = [...document.querySelectorAll('article button')].find((b) => (b.innerText||'').includes('Print'));
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`,
  returnByValue: true,
  userGesture: true,
}).then((r: any) => r?.result?.value)
check('print button clicked', printState === 'clicked', printState)
await sleep(1200)
// The print window starts blank and is written into once the large QR loads.
let popup: any
for (let i = 0; i < 20 && !popup; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[]
  popup = targets.find((t) => !targetsBefore.has(t.id) && t.type === 'page' && t.webSocketDebuggerUrl)
  if (!popup) await sleep(300)
}
check('print window opened', !!popup)
if (popup) {
  const pws2 = new WebSocket(popup.webSocketDebuggerUrl)
  await new Promise((r) => (pws2.onopen = r))
  let qid = 0
  const qp = new Map<number, (v: any) => void>()
  pws2.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && qp.has(m.id)) { qp.get(m.id)!(m.result); qp.delete(m.id) } }
  const q = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++qid; qp.set(i, res); pws2.send(JSON.stringify({ id: i, method, params })) })
  await q('Runtime.enable')
  for (let i = 0; i < 20; i++) {
    const len = await q('Runtime.evaluate', { expression: 'document.documentElement.outerHTML.length', returnByValue: true }).then((r: any) => r?.result?.value ?? 0)
    if (len > 200) break
    await sleep(300)
  }
  const html = String(await q('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }).then((r: any) => r?.result?.value) ?? '')
  check('print sheet has SCAN TO ORDER', html.includes('SCAN TO ORDER'))
  check('print sheet has Powered by The Salad', html.includes('Powered by The Salad'))
  check('print sheet sizes the QR in mm', /\.qr\s*\{[^}]*width:\s*88mm/.test(html), html.slice(0, 120))
  check('print sheet shows the table name', html.includes(firstName ?? '___'))
  await q('Page.printToPDF', { printBackground: true, paperWidth: 5.8, paperHeight: 8.3 }).then(async (r: any) => {
    if (r?.data) fs.writeFileSync('/tmp/qr-print.pdf', Buffer.from(r.data, 'base64'))
  })
}

check('no page exceptions', errors.length === 0, errors.slice(0, 3))
console.log(`\n${pass} passed, ${fails.length} failed`)
chrome.kill('SIGKILL')
process.exit(fails.length ? 1 : 0)
