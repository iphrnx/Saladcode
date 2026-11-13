/** Every card, both widths: does anything leave its box, overlap its neighbour,
 *  or get cut in a way the user would call broken? */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const SITE = process.env.POS_SITE ?? 'http://localhost:3000'
let pass = 0
const fails: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok    ${label}`) }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`) }
}
const PORT = 9365
const EMAIL = 'thesaladsoft@gmail.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-of-${Date.now()}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
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

const AUDIT = `(() => {
  const cards = [...document.querySelectorAll('[role="button"][tabindex="0"]')].filter((c) => c.querySelector('h4'));
  const out = { cards: cards.length, escapes: [], overlaps: [], truncatedNames: [], truncatedDescs: [], stripOverflow: [], inkOverflow: [], tagOutside: [], clipped: [], priceOffsets: new Set(), metaOffsets: new Set(), nameOffsets: new Set(), imageOffsets: new Set() };
  const lines = (el) => {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:normal';
    probe.style.width = el.clientWidth + 'px';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.lineHeight = cs.lineHeight;
    probe.style.letterSpacing = cs.letterSpacing;
    probe.style.wordBreak = cs.wordBreak;
    probe.style.overflowWrap = cs.overflowWrap;
    probe.textContent = el.textContent;
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return Math.round(h / lh);
  };
  for (const c of cards) {
    const box = c.getBoundingClientRect();
    const name = c.querySelector('h4');
    const desc = c.querySelector('p.line-clamp-2');
    const strip = c.querySelector('[role="group"]');
    const price = c.querySelector('span.text-gradient-primary');
    const meta = [...c.querySelectorAll('p')].find((p) => p.textContent.includes('min'));
    const img = c.querySelector('.rounded-full');
    const label = (name?.textContent || '').slice(0, 24);
    // nothing may leave the card
    for (const el of c.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
        out.escapes.push({ card: label, el: el.tagName + '.' + String(el.className).slice(0, 40), d: [Math.round(r.left - box.left), Math.round(r.right - box.right), Math.round(r.top - box.top), Math.round(r.bottom - box.bottom)] });
      }
    }
    // the bands must not overlap each other
    const bands = [['name', name], ['desc', desc], ['meta', meta], ['strip', strip], ['price', price]].filter(([, el]) => el);
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1][1].getBoundingClientRect(), cur = bands[i][1].getBoundingClientRect();
      if (cur.top < prev.bottom - 1) out.overlaps.push({ card: label, pair: bands[i - 1][0] + '/' + bands[i][0], by: +(prev.bottom - cur.top).toFixed(1) });
    }
    if (name && lines(name) > 2) out.truncatedNames.push({ name: name.textContent.slice(0, 40), lines: lines(name) });
    // The clamp has to actually clamp: hidden ink taller than the box means the
    // name is printing outside its two-line slot.
    // A name taller than its two-line slot is cut. That is the cap doing its
    // job, not a failure — but it is worth knowing how many, and which.
    if (name && name.scrollHeight > name.clientHeight + 1) out.clipped.push({ name: name.textContent.replace(/^BESTSELLER/, '').trim().slice(0, 40), needs: Math.round(name.scrollHeight / 16.25) });
    if (desc && desc.scrollHeight > desc.clientHeight + 1) out.inkOverflow.push({ card: label, el: 'desc', scroll: desc.scrollHeight, client: desc.clientHeight });
    // And the tag must still behave as a float: pinned to the top-right of the
    // name slot, not stretched across it (which is what Safari does when the
    // cap and the float share an element).
    const tag = c.querySelector('h4 > span.float-right');
    if (tag) {
      const tr = tag.getBoundingClientRect();
      const nr = name.getBoundingClientRect();
      if (tr.right > nr.right + 1 || tr.top < nr.top - 1) out.tagOutside.push({ card: label, right: +(tr.right - nr.right).toFixed(1), top: +(tr.top - nr.top).toFixed(1) });
      if (tr.width > nr.width * 0.6) out.tagOutside.push({ card: label, stretched: +tr.width.toFixed(1), of: +nr.width.toFixed(1) });
    }
    if (desc && lines(desc) > 2) out.truncatedDescs.push({ desc: desc.textContent.slice(0, 40), lines: lines(desc) });
    if (strip) {
      for (const b of strip.querySelectorAll('button')) {
        const bcs = getComputedStyle(b);
        const ellipsis = bcs.textOverflow === 'ellipsis' && bcs.overflow === 'hidden';
        if (b.scrollWidth > b.clientWidth + 1 && !ellipsis) out.stripOverflow.push({ card: label, chip: b.textContent });
      }
      const sr = strip.getBoundingClientRect();
      if (sr.height > 22.5) out.stripOverflow.push({ card: label, stripHeight: +sr.height.toFixed(1) });
    }
    out.priceOffsets.add(Math.round(price.getBoundingClientRect().bottom - box.bottom));
    out.metaOffsets.add(Math.round(meta.getBoundingClientRect().top - box.top));
    out.nameOffsets.add(Math.round(name.getBoundingClientRect().top - box.top));
    out.imageOffsets.add(Math.round(img.getBoundingClientRect().top - box.top));
  }
  return { ...out, priceOffsets: [...out.priceOffsets], metaOffsets: [...out.metaOffsets], nameOffsets: [...out.nameOffsets], imageOffsets: [...out.imageOffsets] };
})()`

for (const vp of [{ name: 'desktop', w: 1440, h: 1000 }, { name: 'mobile', w: 390, h: 844 }]) {
  await pSend('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 640 })
  await pSend('Page.navigate', { url: `${SITE}/?view=dashboard` })
  await waitFor(`(document.body?.innerText||'').includes('Point of Sale')`)
  await waitFor(`document.querySelectorAll('[role="button"][tabindex="0"] h4').length > 3`)
  await sleep(1500)
  const a = await evaluate(AUDIT)
  console.log(`\n── ${vp.name} — ${a.cards} cards ──`)
  check(`${vp.name}: nothing escapes its card`, a.escapes.length === 0, a.escapes.slice(0, 3))
  check(`${vp.name}: no band overlaps another`, a.overlaps.length === 0, a.overlaps.slice(0, 3))
  check(`${vp.name}: no chip overflows its button`, a.stripOverflow.length === 0, a.stripOverflow.slice(0, 3))
  check(`${vp.name}: no description prints outside its slot`, a.inkOverflow.length === 0, a.inkOverflow.slice(0, 3))
  check(`${vp.name}: the tag stays inside the name block`, a.tagOutside.length === 0, a.tagOutside.slice(0, 3))
  check(`${vp.name}: every price sits on one baseline`, a.priceOffsets.length === 1, a.priceOffsets)
  check(`${vp.name}: every time row sits at one height`, a.metaOffsets.length === 1, a.metaOffsets)
  check(`${vp.name}: every name starts at one height`, a.nameOffsets.length === 1, a.nameOffsets)
  check(`${vp.name}: every image starts at one height`, a.imageOffsets.length === 1, a.imageOffsets)
  console.log(`        names cut by the two-line cap: ${a.clipped.length}${a.clipped.length ? ' — ' + JSON.stringify(a.clipped.slice(0, 6)) : ''}`)
  console.log(`        descriptions needing >2 lines: ${a.truncatedDescs.length}${a.truncatedDescs.length ? ' — ' + JSON.stringify(a.truncatedDescs.slice(0, 4)) : ''}`)
  const shot = await pSend('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`/tmp/pos-compact-${vp.name}.png`, Buffer.from(shot.data, 'base64'))
}
console.log(`\n${pass} passed, ${fails.length} failed`)
chrome.kill('SIGKILL')
process.exit(fails.length ? 1 : 0)
