/** Dump the vertical bands of the tallest POS card, so a compaction has numbers. */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const SITE = process.env.POS_SITE ?? 'http://localhost:3000'
const PORT = 9363
const EMAIL = 'thesaladsoft@gmail.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-bands-${Date.now()}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
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

const BANDS = `(() => {
  const cards = [...document.querySelectorAll('[role="button"][tabindex="0"]')].filter((c) => c.querySelector('h4'));
  const tallest = cards.reduce((a, b) => (b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a));
  const box = tallest.getBoundingClientRect();
  const rows = [];
  const add = (label, el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    rows.push({ label, top: +(r.top - box.top).toFixed(1), h: +r.height.toFixed(1), fs: cs.fontSize, lh: cs.lineHeight, clamp: cs.webkitLineClamp || cs.lineClamp || '' });
  };
  const h4 = tallest.querySelector('h4');
  const nm = tallest.querySelector('h4 span.line-clamp-2');
  const tg = tallest.querySelector('h4 > span.float-right');
  const ncs = nm ? getComputedStyle(nm) : null;
  rows.push({ label: 'h4', top: +(h4.getBoundingClientRect().top - box.top).toFixed(1), h: +h4.getBoundingClientRect().height.toFixed(1), fs: getComputedStyle(h4).fontSize, lh: getComputedStyle(h4).lineHeight, clamp: 'w=' + h4.getBoundingClientRect().width.toFixed(1) + ' scrollH=' + h4.scrollHeight });
  if (tg) rows.push({ label: 'tag', top: +(tg.getBoundingClientRect().top - box.top).toFixed(1), h: +tg.getBoundingClientRect().height.toFixed(1), fs: '', lh: '', clamp: 'w=' + tg.getBoundingClientRect().width.toFixed(1) + ' right=' + tg.getBoundingClientRect().right.toFixed(1) + ' h4right=' + h4.getBoundingClientRect().right.toFixed(1) });
  add('image', tallest.querySelector('.rounded-full'));
  add('name', tallest.querySelector('h4'));
  add('desc', tallest.querySelector('p.line-clamp-2'));
  add('meta', [...tallest.querySelectorAll('p')].find((p) => p.textContent.includes('min')));
  add('portionStrip', tallest.querySelector('[role="group"]')?.parentElement);
  add('price', tallest.querySelector('span.text-gradient-primary'));
  return { card: { h: +box.height.toFixed(1), w: +box.width.toFixed(1) }, name: tallest.querySelector('h4').innerText.replace(/\\n/g,' ').slice(0,30), rows,
    overflow: { scroll: tallest.scrollHeight, client: tallest.clientHeight } };
})()`

for (const vp of [{ name: 'desktop', w: 1440, h: 1000 }, { name: 'mobile', w: 390, h: 844 }]) {
  await pSend('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 640 })
  await pSend('Page.navigate', { url: `${SITE}/?view=dashboard` })
  await waitFor(`(document.body?.innerText||'').includes('Point of Sale')`)
  await waitFor(`document.querySelectorAll('[role="button"][tabindex="0"] h4').length > 3`)
  await sleep(1200)
  const b = await evaluate(BANDS)
  console.log(`\n── ${vp.name} ${vp.w}×${vp.h} ── card ${b.card.h}×${b.card.w}  "${b.name}"  scroll/client ${b.overflow.scroll}/${b.overflow.client}`)
  for (const r of b.rows) console.log(`   ${String(r.label).padEnd(13)} top=${String(r.top).padStart(6)}  h=${String(r.h).padStart(6)}  ${r.fs}/${r.lh}${r.clamp ? ' clamp=' + r.clamp : ''}`)
}
chrome.kill('SIGKILL')
