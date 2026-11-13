/** Drive one Menu Management card: toggle, edit dialog, delete dialog, hidden state. */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
const SITE = process.env.POS_SITE ?? 'http://localhost:3000'
const PORT = 9367, EMAIL = 'thesaladsoft@gmail.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-mbeh-${Date.now()}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
let version: any = null
for (let i = 0; i < 60 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() } catch { await sleep(250) } }
const ws = new WebSocket(version.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r))
let id = 0; const pend = new Map<number, (v: any) => void>()
ws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result); pend.delete(m.id) } }
const send = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const { targetId } = await send('Target.createTarget', { url: `${SITE}/` })
let pageWs: string | undefined
for (let i = 0; i < 40 && !pageWs; i++) { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() as any[]; pageWs = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl; if (!pageWs) await sleep(250) }
const pws = new WebSocket(pageWs!); await new Promise((r) => (pws.onopen = r))
let pid = 0; const pp = new Map<number, (v: any) => void>()
pws.onmessage = (e: any) => { const m = JSON.parse(e.data); if (m.id && pp.has(m.id)) { pp.get(m.id)!(m.result); pp.delete(m.id) } }
const pSend = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++pid; pp.set(i, res); pws.send(JSON.stringify({ id: i, method, params })) })
await pSend('Runtime.enable'); await pSend('Page.enable')
const evaluate = (expr: string) => pSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r: any) => r?.result?.value)
const ref = new URL(SB).hostname.split('.')[0]
await pSend('Network.setCookie', { name: `sb-${ref}-auth-token`, value: 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url'), domain: new URL(SITE).hostname, path: '/', secure: SITE.startsWith('https'), sameSite: 'Lax' })
await pSend('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
await pSend('Page.navigate', { url: `${SITE}/?view=menu` })
for (let i = 0; i < 60; i++) { if (await evaluate(`document.querySelectorAll('[data-menu-card]').length > 0`)) break; await sleep(500) }
await sleep(1200)
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /accept all/i.test(x.textContent || '')); if (b) b.click(); return true })()`)
await sleep(400)

const gone = async (expr: string) => { for (let i = 0; i < 30; i++) { if (!(await evaluate(expr))) return true; await sleep(300) } return false }
let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? `\n        ${extra}` : ''}`) }

const cardState = `(() => {
  const c = document.querySelector('[data-menu-card]');
  const sw = c.querySelector('[role="switch"]');
  return JSON.stringify({
    name: c.querySelector('h3').textContent,
    label: sw.closest('label').textContent.trim(),
    checked: sw.getAttribute('aria-checked') || sw.getAttribute('data-state'),
    opacity: getComputedStyle(c).opacity,
    overlay: /Hidden/.test(c.textContent),
    edit: !!c.querySelector('[aria-label="Edit item"]'),
    del: !!c.querySelector('[aria-label="Delete item"]'),
    img: !!c.querySelector('img, [class*="rounded-full"]'),
  });
})()`

const before = JSON.parse(String(await evaluate(cardState)))
console.log(`\ncard: ${before.name}  label="${before.label}"  checked=${before.checked}  opacity=${before.opacity}`)
check('the card renders a switch, edit and delete button', before.edit && before.del)
check('the card renders its picture', before.img)

const clickSwitch = `(() => { document.querySelector('[data-menu-card] [role="switch"]').click(); return true })()`
const settle = async (want: string) => {
  for (let i = 0; i < 45; i++) {
    const st = JSON.parse(String(await evaluate(cardState)))
    if (st.label === want) return st
    await sleep(400)
  }
  return JSON.parse(String(await evaluate(cardState)))
}
// The switch disables itself while the write is in flight, so a click can be
// swallowed — wait for it to be enabled before clicking, and for the label to
// settle before reading.
const flip = async (want: string) => {
  for (let i = 0; i < 40; i++) {
    if (!(await evaluate(`document.querySelector('[data-menu-card] [role="switch"]').disabled`))) break
    await sleep(300)
  }
  await evaluate(clickSwitch)
  return settle(want)
}

// The card fades over a CSS transition, so the opacity trails the label.
const settleOpacity = async (want: (o: string) => boolean) => {
  for (let i = 0; i < 30; i++) {
    const o = String(await evaluate(`getComputedStyle(document.querySelector('[data-menu-card]')).opacity`))
    if (want(o)) return o
    await sleep(300)
  }
  return String(await evaluate(`getComputedStyle(document.querySelector('[data-menu-card]')).opacity`))
}
const other = before.label === 'Available' ? 'Hidden' : 'Available'
const mid = await flip(other)
const midOpacity = await settleOpacity((o) => (other === 'Hidden' ? Number(o) < 1 : o === before.opacity))
check('toggling flips the label', mid.label === other, `"${before.label}" → "${mid.label}"`)
check('toggling flips aria-checked', mid.checked !== before.checked, `${before.checked} → ${mid.checked}`)
check('an unavailable card dims', other === 'Hidden' ? Number(midOpacity) < 1 : midOpacity === before.opacity, `opacity ${before.opacity} → ${midOpacity}`)
check('the Hidden overlay shows on an unavailable card', other === 'Hidden' ? mid.overlay : true)

const after = await flip(before.label)
const settledOpacity = await settleOpacity((o) => o === before.opacity)
check('toggling back restores the original state', after.label === before.label && after.checked === before.checked, `"${after.label}" checked=${after.checked}`)
check('toggling back restores the opacity', settledOpacity === before.opacity, `${settledOpacity} vs ${before.opacity}`)

// Edit dialog
await evaluate(`(() => { document.querySelector('[data-menu-card] [aria-label="Edit item"]').click(); return true })()`)
await sleep(1200)
const editOpen = await evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.textContent.slice(0, 90) : null })()`)
check('the edit button opens the Edit Item dialog', !!editOpen && /Edit Item/.test(String(editOpen)), String(editOpen).replace(/\s+/g, ' ').slice(0, 70))
await evaluate(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => /cancel/i.test(x.textContent || '')); if (b) b.click(); return true })()`)
check('the edit dialog closes on Cancel', await gone(`!!document.querySelector('[role="dialog"]')`))

// Delete dialog
await evaluate(`(() => { document.querySelector('[data-menu-card] [aria-label="Delete item"]').click(); return true })()`)
await sleep(900)
const delOpen = await evaluate(`(() => { const d = document.querySelector('[role="alertdialog"], [role="dialog"]'); return d ? d.textContent.slice(0, 80) : null })()`)
check('the delete button opens the confirm dialog', !!delOpen && /Delete menu item/.test(String(delOpen)), String(delOpen).replace(/\s+/g, ' ').slice(0, 70))
await evaluate(`(() => { const b = [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')].find((x) => /cancel/i.test(x.textContent || '')); if (b) b.click(); return true })()`)
check('the delete dialog closes on Cancel', await gone(`!!document.querySelector('[role="alertdialog"]')`))

const final = JSON.parse(String(await evaluate(cardState)))
check('the card is left exactly as it was found', final.label === before.label && final.checked === before.checked && final.opacity === before.opacity)
console.log(`\n${pass} passed, ${fail} failed`)
try { process.kill(-chrome.pid, 'SIGKILL') } catch {}
process.exit(fail ? 1 : 0)
