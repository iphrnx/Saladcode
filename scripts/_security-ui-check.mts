/** The Security page as a person sees it: rows, counters, and live updates. */
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const SITE = process.env.SEC_SITE ?? 'http://localhost:3000'
const PORT = 9351
const EMAIL = 'thesaladsoft@gmail.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const tenantId = (await admin.from('profiles').select('tenant_id').eq('email', EMAIL).single()).data!.tenant_id

let pass = 0
const fails: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok    ${label}`) }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`) }
}

const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const desktopAnon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  global: { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } },
})
const { data: otp } = await desktopAnon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
const session = (otp as any).session

const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/chrome-sec-${Date.now()}`, '--no-sandbox', '--disable-gpu', 'about:blank'], { stdio: 'ignore', detached: true })
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
const errors: string[] = []
pws.onmessage = (e: any) => {
  const m = JSON.parse(e.data)
  if (m.id && pp.has(m.id)) { pp.get(m.id)!(m.result); pp.delete(m.id) }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 160))
}
const pSend = (method: string, params: any = {}) => new Promise<any>((res) => { const i = ++pid; pp.set(i, res); pws.send(JSON.stringify({ id: i, method, params })) })
await pSend('Runtime.enable'); await pSend('Page.enable')
await pSend('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
const evaluate = (expr: string) => pSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r: any) => r?.result?.value)
const waitFor = async (expr: string, tries = 60, gap = 500) => { for (let i = 0; i < tries; i++) { const v = await evaluate(expr); if (v) return v; await sleep(gap) } return undefined }

const ref = new URL(SB).hostname.split('.')[0]
await pSend('Network.setCookie', { name: `sb-${ref}-auth-token`, value: 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url'), domain: new URL(SITE).hostname, path: '/', secure: SITE.startsWith('https'), sameSite: 'Lax' })

await pSend('Page.navigate', { url: `${SITE}/?view=security` })
await waitFor(`(document.body?.innerText||'').includes('Active Sessions')`, 90)
await sleep(2500)

const read = () => evaluate(`(() => {
  const text = document.body.innerText || '';
  const stat = (label) => { const m = text.match(new RegExp('(\\\\d+)\\\\s*' + label)); return m ? Number(m[1]) : null };
  const card = [...document.querySelectorAll('h3')].find(h => h.innerText.includes('Active Sessions'))?.closest('div[class*="card"], div.rounded-2xl');
  const rows = [...document.querySelectorAll('article, div')].filter(() => false).length;
  const badges = [...document.querySelectorAll('span,div')].filter(e => /^\\d+$/.test((e.innerText||'').trim())).length;
  return {
    sessions: stat('Active Sessions'),
    failed: stat('Failed Logins'),
    audit: stat('Audit Events'),
    detailsToggles: (text.match(/Details/g) || []).length,
    hideDetails: (text.match(/Hide details/g) || []).length,
    ipShown: /\\b\\d{1,3}(\\.\\d{1,3}){3}\\b/.test(text),
    signIns: (text.match(/sign-ins/g) || []).length,
    body: text.slice(0, 1200),
  };
})()`)

const first = await read()
const listCount = await evaluate(`document.querySelectorAll('[data-session-row]').length`)
const logCount = await evaluate(`document.querySelectorAll('[data-log-row]').length`)
check('the page rendered', (first?.sessions ?? 0) > 0, first?.sessions)
check('no "Details" / "Hide details" control anywhere', first?.detailsToggles === 0 && first?.hideDetails === 0, { d: first?.detailsToggles, h: first?.hideDetails })
check('no raw IP address on the page', first?.ipShown === false)
check('each row is one device', listCount > 0, listCount)
check('the activity log rendered too', logCount > 0, logCount)
check('the stat card equals the rows shown', first?.sessions === listCount, { stat: first?.sessions, rows: listCount })

// live: another device signs in while the page is open
const phoneAnon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  global: { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } },
})
const { data: phoneLink } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
const { data: phoneOtp } = await phoneAnon.auth.verifyOtp({ email: EMAIL, token: phoneLink!.properties!.email_otp!, type: 'magiclink' })
const beforeLive = await evaluate(`document.body.innerText`)

let live = false
for (let i = 0; i < 26; i++) {
  await sleep(1000)
  const now = await evaluate(`document.body.innerText`)
  if (now !== beforeLive && /Phone|iPhone|Safari · iOS/.test(now)) { live = true; break }
}
check('a new device appears without a refresh', live)
const after = await read()
check('the session counter followed the new device', (after?.sessions ?? 0) === (first?.sessions ?? 0) + 1, { before: first?.sessions, after: after?.sessions })

const shot = await pSend('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync('/tmp/security-page.png', Buffer.from(shot.data, 'base64'))
check('no page exceptions', errors.length === 0, errors.slice(0, 3))

// leave nothing behind
if ((phoneOtp as any)?.session) {
  await admin.rpc('security_revoke_session', {
    p_tenant_id: tenantId,
    p_session_id: JSON.parse(Buffer.from((phoneOtp as any).session.access_token.split('.')[1], 'base64url').toString()).session_id,
  })
}

console.log(`\n${pass} passed, ${fails.length} failed`)
chrome.kill('SIGKILL')
process.exit(fails.length ? 1 : 0)
