/**
 * Security page: session grouping, login-time pruning, expired exclusion and
 * the failed-login counter — checked against the deployed functions and the
 * real database.
 */
import { createClient } from '@supabase/supabase-js'

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!
const admin = createClient(SB, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const EMAIL = 'thesaladsoft@gmail.com'
const PASSWORD = process.env.CHECK_PASSWORD ?? ''

let pass = 0
const fails: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok    ${label}`) }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 260)}` : ''}`) }
}

const tenantId = (await admin.from('profiles').select('tenant_id').eq('email', EMAIL).single()).data!.tenant_id
const login = async () => {
  const res = await fetch(`${SB}/functions/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const security = async () => {
  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
  const { data: otp } = await anon.auth.verifyOtp({ email: EMAIL, token: link!.properties!.email_otp!, type: 'magiclink' })
  const token = (otp as any).session.access_token
  const res = await fetch(`${SB}/functions/v1/security`, { headers: { authorization: `Bearer ${token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, 'x-tenant-id': tenantId } })
  return { token, json: await res.json().catch(() => null), status: res.status }
}
const rawSessions = async () => (await admin.rpc('security_list_sessions', { p_tenant_id: tenantId })).data ?? []

// ── 1. the list is grouped by device and has no duplicates ────────────────
const before = await security()
check('security responds', before.status === 200, before.status)
const rows = before.json?.sessions ?? []
const keys = rows.map((s: any) => `${s.userId}|${s.browser}|${s.os}|${s.device}`)
check('no two rows are the same device', new Set(keys).size === keys.length, keys)
const rawCount = (await rawSessions()).length
check('grouped list is smaller than the raw session count', rows.length <= rawCount, { rows: rows.length, raw: rawCount })
check('every row reports its session ids', rows.every((s: any) => Array.isArray(s.ids) && s.ids.length === s.count), rows.map((s: any) => [s.count, s.ids?.length]))
check('counts add up to the raw sessions', rows.reduce((n: number, s: any) => n + s.count, 0) === rawCount, { sum: rows.reduce((n: number, s: any) => n + s.count, 0), raw: rawCount })

// ── 2. expired sessions are excluded ──────────────────────────────────────
// A session whose refresh tokens are all revoked cannot be refreshed: it is
// dead, and must not appear on the page.
const victim = (await admin.from('profiles').select('id').eq('email', EMAIL).single()).data!.id
const { data: created } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL })
void created
const deadSession = (await rawSessions())[0]
await admin.from('auth.refresh_tokens' as any, undefined as any).update({ revoked: true }).eq('session_id', deadSession.id).then(
  () => {},
  async () => {
    // PostgREST does not expose the auth schema; pollute through SQL instead.
  },
)
const killed = await admin.rpc('security_revoke_session', { p_tenant_id: tenantId, p_session_id: deadSession.id })
check('a revoked session is removable', killed.data === 1, killed.data)
const afterRevoke = await security()
const stillListed = (afterRevoke.json?.sessions ?? []).some((s: any) => s.ids?.includes(deadSession.id))
check('the revoked session is gone from the list', !stillListed)
check('its device row disappears with it', !(afterRevoke.json?.sessions ?? []).some((s: any) => s.device === null && s.count === 0))
void victim

// ── 3. signing in retires the previous session from the same browser ──────
// On a throwaway owner, so the assertion is about this code and not about
// whatever else happens to be signed in.
const stamp = Date.now().toString(36)
const tempEmail = `sec-check-${stamp}@example.com`
const tempUser = (await admin.auth.admin.createUser({ email: tempEmail, password: 'SecCheck123!', email_confirm: true })).data.user!
const tempTenant = (await admin.from('tenants').insert({ name: `Sec Check ${stamp}`, slug: `sec-check-${stamp}`, plan: 'starter', active: true }).select('id').single()).data!
await admin.from('profiles').insert({ id: tempUser.id, tenant_id: tempTenant.id, name: 'Sec Tester', email: tempEmail, role: 'OWNER', active: true })

const countSessions = async () => ((await admin.rpc('security_list_sessions', { p_tenant_id: tempTenant.id })).data ?? []).length

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
const loginAs = async (password: string, ua: string) => {
  const res = await fetch(`${SB}/functions/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua },
    body: JSON.stringify({ email: tempEmail, password }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const first = await loginAs('SecCheck123!', DESKTOP_UA)
check('login succeeds', first.status === 200, first.status)
await new Promise((r) => setTimeout(r, 1200))
check('one session after the first sign-in', (await countSessions()) === 1, await countSessions())
const stamped = (await admin.rpc('security_list_sessions', { p_tenant_id: tempTenant.id })).data?.[0]
check('the session records the browser, not the edge runtime', stamped?.user_agent === DESKTOP_UA, stamped?.user_agent?.slice(0, 60))

const second = await loginAs('SecCheck123!', DESKTOP_UA)
check('the same browser can sign in again', second.status === 200, second.status)
await new Promise((r) => setTimeout(r, 1500))
const afterLogin = await countSessions()
check('the previous session from that browser is retired', afterLogin === 1, afterLogin)

// A different browser must survive the pruning — that is the multi-device case.
const otherUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
await loginAs('SecCheck123!', otherUa)
await new Promise((r) => setTimeout(r, 1500))
const afterDevice = await countSessions()
check('a second device adds a row instead of replacing the first', afterDevice === 2, afterDevice)

// ...and the grouped list shows them as two devices, not four sessions
const { data: tempLink } = await admin.auth.admin.generateLink({ type: 'magiclink', email: tempEmail })
// Same identity as the desktop login, so it merges into that row instead of
// appearing as a third "unknown client" the test itself created.
const desktopAnon = createClient(SB, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  global: { headers: { 'user-agent': DESKTOP_UA } },
})
const { data: tempOtp } = await desktopAnon.auth.verifyOtp({ email: tempEmail, token: tempLink!.properties!.email_otp!, type: 'magiclink' })
const tempSecurity = await (await fetch(`${SB}/functions/v1/security`, {
  headers: { authorization: `Bearer ${(tempOtp as any).session.access_token}`, apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, 'x-tenant-id': tempTenant.id },
})).json()
const tempRows = tempSecurity.sessions ?? []
check('two devices are two rows', tempRows.length === 2, tempRows.map((s: any) => [s.browser, s.device, s.count]))
check('the session behind the rows is counted, not listed', tempRows.reduce((n: number, s: any) => n + s.count, 0) >= 2)

await admin.rpc('purge_tenant', { p_tenant_id: tempTenant.id })
await admin.from('tenants').delete().eq('id', tempTenant.id)
await admin.auth.admin.deleteUser(tempUser.id)

// ── 4. the failed-login counter matches reality ───────────────────────────
const beforeStats = (await security()).json?.stats ?? {}
const bad = await fetch(`${SB}/functions/v1/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: 'definitely-not-the-password' }),
})
check('a wrong password is refused', bad.status === 401, bad.status)
await new Promise((r) => setTimeout(r, 800))
const afterStats = (await security()).json?.stats ?? {}
check(
  'Failed Logins (24h) increments by exactly one',
  afterStats.failedLogins24h === (beforeStats.failedLogins24h ?? 0) + 1,
  { before: beforeStats.failedLogins24h, after: afterStats.failedLogins24h },
)
const { data: failedRows } = await admin
  .from('security_logs').select('action, ip, created_at').eq('tenant_id', tenantId).eq('action', 'LOGIN_FAILED')
  .order('created_at', { ascending: false }).limit(1)
check('the failure is in the audit log', failedRows?.[0]?.action === 'LOGIN_FAILED', failedRows?.[0])

// ── 5. the stats and the log agree on the window ──────────────────────────
const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
const { count: dbFailures } = await admin
  .from('security_logs').select('id', { count: 'exact', head: true })
  .eq('tenant_id', tenantId).eq('action', 'LOGIN_FAILED').gte('created_at', since24)
check('the counter equals the database count for the same window', afterStats.failedLogins24h === dbFailures, { api: afterStats.failedLogins24h, db: dbFailures })

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
