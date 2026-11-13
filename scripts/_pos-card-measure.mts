/** Measure POS card geometry — heights per row, and where the price sits. */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const SITE = process.env.POS_SITE ?? 'http://localhost:3000'
let pass = 0
const fails: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok    ${label}`) }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ''}`) }
}
const PORT = 9361
const EMAIL = 'thesaladsoft@gmail.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-pos-${Date.now()}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
let version: any = null
for (let i = 0; i < 60 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(250) } }
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pend = new Map<number, (v: any) => void>()
ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result); pend.delete(m.id) } }
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
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
const pp = new Map<number, (v: any) => void>()
pws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pp.has(m.id)) { pp.get(m.id)!(m.result); pp.delete(m.id) } }
const pSend = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++pid; pp.set(i, res); pws.send(JSON.stringify({ id: i, method, params })) })
await pSend('Runtime.enable'); await pSend('Page.enable')
const evaluate = (expr: string) => pSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r: any) => r?.result?.value)
const waitFor = async (expr: string, tries = 90, gap = 500) => { for (let i = 0; i < tries; i++) { const v = await evaluate(expr); if (v) return v; await sleep(gap) } return undefined }

const ref = new URL(SB).hostname.split('.')[0]
await pSend('Network.setCookie', { name: `sb-${ref}-auth-token`, value: 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url'), domain: new URL(SITE).hostname, path: '/', secure: SITE.startsWith('https'), sameSite: 'Lax' })

const MEASURE = `(() => {
  const cards = [...document.querySelectorAll('[role="button"][tabindex="0"]')].filter((c) => c.querySelector('h4'));
  const groups = new Map();
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    const key = Math.round(r.top);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name: c.querySelector('h4')?.innerText.replace(/\\n/g,' ').slice(0,26), h: Math.round(r.height), w: Math.round(r.width), priceTop: Math.round(c.querySelector('span.text-gradient-primary')?.getBoundingClientRect().top ?? 0), priceBottom: Math.round(c.querySelector('span.text-gradient-primary')?.getBoundingClientRect().bottom ?? 0), portions: !!c.querySelector('[role="group"]') });
  }
  return [...groups.values()].filter(g => g.length > 1).slice(0, 4).map((g) => ({
    heights: [...new Set(g.map((x) => x.h))],
    priceTops: [...new Set(g.map((x) => x.priceTop))],
    priceBottoms: [...new Set(g.map((x) => x.priceBottom))],
    withPortions: g.filter((x) => x.portions).length,
    names: g.map((x) => x.name),
  }));
})()`

for (const vp of [{ name: 'desktop', w: 1440, h: 1000 }, { name: 'mobile', w: 390, h: 844 }]) {
  await pSend('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 640 })
  await pSend('Page.navigate', { url: `${SITE}/?view=dashboard` })
  await waitFor(`(document.body?.innerText||'').includes('Point of Sale')`)
  await waitFor(`document.querySelectorAll('[role="button"][tabindex="0"] h4').length > 3`)
  await sleep(1500)
  const rows = await evaluate(MEASURE)
  console.log(`\n── ${vp.name} ${vp.w}×${vp.h} ──`)
  for (const r of rows ?? []) console.log(JSON.stringify(r))
  const shot = await pSend('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`/tmp/pos-cards-${vp.name}.png`, Buffer.from(shot.data, 'base64'))

  // One height for the whole grid, and prices on one baseline.
  const heights = new Set((rows ?? []).flatMap((r: any) => r.heights))
  check(`${vp.name}: every card is the same height`, heights.size === 1, [...heights])
  const tops = (rows ?? []).map((r: any) => r.priceTops[0])
  const gaps = tops.slice(1).map((t: number, i: number) => t - tops[i])
  const rowGap = gaps.length > 1 ? Math.min(...gaps) : 0
  check(`${vp.name}: price lines are evenly spaced between rows`, new Set(gaps.map((g) => Math.abs(g - rowGap) <= 1)).size === 1 || gaps.length < 2, gaps)

  // Portion selection and adding still work.
  const clickCard = async (name: string) => evaluate(`(() => {
    const card = [...document.querySelectorAll('[role="button"][tabindex="0"]')].find((c) => (c.querySelector('h4')?.innerText || '').includes(${JSON.stringify(name)}));
    if (!card) return 'no-card';
    card.click();
    return 'clicked';
  })()`)
  const cartText = () => evaluate('document.body.innerText')

  const plain = await clickCard('KitKat Shake')
  await sleep(700)
  check(`${vp.name}: tapping a plain dish adds it`, plain === 'clicked' && /KitKat Shake/.test(await cartText()))

  // The portion card: pick the second portion, then tap the card.
  const portions = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[role="button"][tabindex="0"]')].find((c) => (c.querySelector('h4')?.innerText || '').includes('Veg Momos'));
    if (!card) return null;
    const chips = [...card.querySelectorAll('[role="group"] button')];
    chips[1]?.click();
    return { chips: chips.map((b) => b.innerText), price: card.querySelector('span.text-gradient-primary')?.innerText };
  })()`)
  check(`${vp.name}: the portion strip offers both portions`, portions?.chips?.length === 2, portions?.chips)
  await sleep(300)
  const afterChip = await evaluate(`(() => {
    const card = [...document.querySelectorAll('[role="button"][tabindex="0"]')].find((c) => (c.querySelector('h4')?.innerText || '').includes('Veg Momos'));
    return { price: card?.querySelector('span.text-gradient-primary')?.innerText, selected: [...card.querySelectorAll('[role="group"] button')].find((b) => b.className.includes('bg-primary'))?.innerText };
  })()`)
  check(`${vp.name}: choosing a portion moves the price and the highlight`, afterChip?.selected === portions?.chips?.[1] && afterChip?.price !== portions?.price, { before: portions, after: afterChip })
  const momosAdd = await clickCard('Veg Momos')
  await sleep(700)
  const cartAfter = await cartText()
  check(`${vp.name}: tapping the card adds the selected portion`, momosAdd === 'clicked' && /Veg Momos/.test(cartAfter) && cartAfter.includes(afterChip?.price ?? '#####'), afterChip?.price)
}
console.log(`\n${pass} passed, ${fails.length} failed`)
chrome.kill('SIGKILL')
process.exit(fails.length ? 1 : 0)
