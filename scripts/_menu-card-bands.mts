/** Dump the vertical bands of every Menu Management card, so a refinement has numbers. */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const SITE = process.env.POS_SITE ?? 'http://localhost:3000'
const PORT = 9364
const EMAIL = 'thesaladsoft@gmail.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-menubands-${Date.now()}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
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
  const cards = [...document.querySelectorAll('[data-menu-card]')];
  const out = [];
  for (const c of cards) {
    const box = c.getBoundingClientRect();
    const rel = (el) => el ? { top: +(el.getBoundingClientRect().top - box.top).toFixed(1), h: +el.getBoundingClientRect().height.toFixed(1), right: +(box.right - el.getBoundingClientRect().right).toFixed(1) } : null;
    const name = c.querySelector('h3');
    const desc = [...c.querySelectorAll('p')].find((p) => p.className.includes('line-clamp-2'));
    const price = [...c.querySelectorAll('span')].find((s) => /whitespace-nowrap/.test(s.className) && /font-bold/.test(s.className));
    const chip = c.querySelector('[data-slot="badge"], .inline-flex.rounded-md.border, span.rounded-full');
    const img = c.querySelector('img, div > div.rounded-full');
    const sep = c.querySelector('[data-orientation="horizontal"], hr');
    const sw = c.querySelector('[role="switch"]');
    const portionRow = [...c.querySelectorAll('div')].find((d) => d.className.includes('h-[22px]') && /₹/.test(d.textContent || '') && !d.querySelector('svg'));
    const metaRow = [...c.querySelectorAll('div')].find((d) => d.className.includes('h-[22px]') && d.querySelector('svg'));
    const tagGroup = metaRow ? metaRow.firstElementChild : null;
    const portionInner = portionRow ? portionRow.firstElementChild : null;
    out.push({
      name: (name?.textContent || '').slice(0, 22),
      h: +box.height.toFixed(1),
      w: +box.width.toFixed(1),
      img: rel(img),
      nm: rel(name),
      nmLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '16')) : 0,
      desc: rel(desc),
      price: rel(price),
      chip: rel(chip),
      portion: rel(portionRow),
      meta: rel(metaRow),
      tagsShown: tagGroup ? tagGroup.children.length : 0,
      tagsClipped: tagGroup ? tagGroup.scrollWidth - tagGroup.clientWidth : 0,
      portionClipped: portionInner ? portionInner.scrollWidth - portionInner.clientWidth : 0,
      sep: rel(sep),
      sw: rel(sw),
      overflow: c.scrollHeight - c.clientHeight,
    });
  }
  return JSON.stringify({ count: out.length, cards: out, scrollX: document.documentElement.scrollWidth - window.innerWidth });
})()`

const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'narrow-desktop', width: 1280, height: 900 },
  { name: 'laptop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

for (const vp of viewports) {
  await pSend('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width < 640 }, undefined as any)
  await pSend('Page.navigate', { url: `${SITE}/?view=menu` })
  await waitFor(`document.querySelectorAll('[data-menu-card]').length > 0`, 60, 500)
  await sleep(1200)
  const raw = JSON.parse(String(await evaluate(BANDS)))
  console.log(`\n── ${vp.name} ${vp.width}×${vp.height} — ${raw.count} cards, scrollX ${raw.scrollX} ──`)
  const band = (k: string) => [...new Set(raw.cards.map((c: any) => c[k] && c[k].top))].sort((a: any, b: any) => a - b)
  const heights = [...new Set(raw.cards.map((c: any) => c.h))].sort((a: any, b: any) => a - b)
  console.log(`  heights: ${heights.join(', ')}`)
  for (const k of ['img', 'nm', 'desc', 'price', 'chip', 'portion', 'meta', 'sep', 'sw']) {
    const tops = band(k)
    const missing = raw.cards.filter((c: any) => !c[k]).length
    console.log(`  ${k.padEnd(8)} tops=${JSON.stringify(tops)}${missing ? `  (absent on ${missing})` : ''}`)
  }
  const overflow = raw.cards.filter((c: any) => c.overflow > 0)
  console.log(`  cards whose content overflows: ${overflow.length}${overflow.length ? ' — ' + overflow.map((c: any) => `${c.name}(${c.overflow})`).join(', ') : ''}`)
  const clipped = raw.cards.filter((c: any) => c.tagsClipped > 0)
  console.log(`  tags clipped by the one-line row: ${clipped.length}${clipped.length ? ' — ' + clipped.map((c: any) => `${c.name}(${c.tagsShown} tags, ${c.tagsClipped}px)`).join(', ') : ''}`)
  const pclip = raw.cards.filter((c: any) => c.portionClipped > 0)
  console.log(`  portion chips clipped: ${pclip.length}${pclip.length ? ' — ' + pclip.map((c: any) => c.name).join(', ') : ''}`)
  const cut = raw.cards.filter((c: any) => c.nmLines > 2)
  console.log(`  names over two lines: ${cut.length}${cut.length ? ' — ' + cut.map((c: any) => c.name).join(', ') : ''}`)
  console.log(`  sample: ${JSON.stringify(raw.cards[0])}`)
}
try { process.kill(-chrome.pid, 'SIGKILL') } catch {}
process.exit(0)
