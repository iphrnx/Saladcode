// Run via TEST_ENDED_CHECK_RETRY=1 bash scripts/test-launch-migrations-local.sh upgrade
// Real Bill handler and PostgREST/RPCs on a disposable DB. Only auth, delivery and broadcasts are fixtures.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createClient } from '@supabase/supabase-js'
import { createEndedCheckAttempt, sendEndedCheckPayment } from '../src/lib/ended-check-payment'

const container = process.argv[2]
assert.match(container ?? '', /^saladcode-launch-(fresh|upgrade)-\d+-db$/)
assert.equal(execFileSync('docker', ['inspect', '-f', '{{.HostConfig.NetworkMode}}', container], { encoding: 'utf8' }).trim(), 'none')
const sql = (query: string) => execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim()
const rest = 'http://127.0.0.1:3000'
const encode = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
const claims = `${encode({ alg: 'HS256' })}.${encode({ role: 'service_role' })}`
const token = `${claims}.${createHmac('sha256', 'ended-check-test-local-only-not-a-production-secret').update(claims).digest('base64url')}`
const run = promisify(execFile)
const db = createClient(rest, token, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
  const url = new URL(String(input))
  assert.equal(url.origin, rest)
  assert.ok(url.pathname.startsWith('/rest/v1/'))
  url.pathname = url.pathname.slice('/rest/v1'.length)
  const args = ['exec', container, 'curl', '-sS', '--max-time', '10', '-w', '\n%{http_code}', '-X', init?.method ?? 'GET']
  new Headers(init?.headers).forEach((value, name) => args.push('-H', `${name}: ${value}`))
  if (init?.body != null) args.push('--data-binary', String(init.body))
  const { stdout } = await run('docker', [...args, String(url)])
  const separator = stdout.lastIndexOf('\n')
  const status = Number(stdout.slice(separator + 1))
  return new Response(status === 204 || status === 304 ? null : stdout.slice(0, separator), { status, headers: { 'content-type': 'application/json' } })
} } })

const tenant = randomUUID(), otherTenant = randomUUID(), table = randomUUID()
let actorTenant = tenant, permitted = true
let route!: (req: Request) => Promise<Response>
const stubs: Record<string, string> = {
  runtime: '',
  'db.ts': 'export const admin = () => fixture.db',
  'auth.ts': 'export const guard = (_req, opts) => fixture.guard(opts); export const tableSession = () => null;',
  'realtime.ts': 'export const publishToStaff = () => {}; export const publishToDiner = () => {};',
}
const baseline = process.env.BILL_BASELINE_REF
const source = baseline ? execFileSync('git', ['show', `${baseline}:supabase/functions/bill/index.ts`], { encoding: 'utf8' }) : undefined
const bundle = await build({
  ...(source ? { stdin: { contents: source, resolveDir: `${process.cwd()}/supabase/functions/bill`, loader: 'ts' as const } }
    : { entryPoints: ['supabase/functions/bill/index.ts'] }),
  bundle: true, write: false, plugins: [{ name: 'bill-test-transport', setup(b) {
    b.onResolve({ filter: /^jsr:/ }, () => ({ path: 'runtime', namespace: 'fixture' }))
    b.onResolve({ filter: /^\.\.\/_shared\/(auth|db|realtime)\.ts$/ }, a => ({ path: a.path.split('/').at(-1)!, namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: stubs[a.path] }))
  } }],
})
runInNewContext(bundle.outputFiles[0].text, {
  URL, Request, Response, Headers, console,
  Deno: { serve: (handler: typeof route) => { route = handler }, env: { get: () => undefined } },
  fixture: { db, guard: (opts: { permission: string }) => {
    assert.equal(opts.permission, 'payments.collect')
    return permitted ? { ok: true, session: { tenantId: actorTenant } } : { ok: false, response: Response.json({}, { status: 403 }) }
  } },
})
const call = (path: string, init: RequestInit) => route(new Request(`${rest}/functions/v1${path.replace(/^\/api/, '')}`, init))
const snapshot = (id: string) => JSON.parse(sql(`select json_build_object('status', c.status, 'invoice', c.invoice_number, 'session', s.status,
  'ledger', (select coalesce(json_agg(json_build_object('id', p.id, 'method', p.method, 'key', p.idempotency_key, 'amount', p.amount)), '[]')
    from public.check_payments p where p.check_id=c.id),
  'sequence', (select last_seq from public.check_invoice_counters where tenant_id=c.tenant_id))
  from public.table_checks c join public.table_sessions s on s.id=c.session_id where c.id='${id}'`))
const newCheck = (ended: boolean, amount: number) => {
  const session = randomUUID(), check = randomUUID()
  sql(`insert into public.table_sessions (id,tenant_id,table_id,status) values ('${session}','${tenant}','${table}','ACTIVE');
    insert into public.table_checks (id,tenant_id,table_id,session_id,anchor_session_id,total) values ('${check}','${tenant}','${table}','${session}','${session}',${amount});
    insert into public.orders(tenant_id,table_id,table_session_id,check_id,status,total,items_total) values ('${tenant}','${table}','${session}','${check}','SERVED',${amount},${amount});
    ${ended ? `update public.table_sessions set status='ENDED', ended_at=now() where id='${session}';` : ''}`)
  return { session, check }
}
sql(`insert into public.tenants (id,name,slug) values ('${tenant}','Retry Cafe','retry-cafe'),('${otherTenant}','Other Cafe','other-retry-cafe');
  insert into public.tables (id,tenant_id,name,qr_token) values ('${table}','${tenant}','Fixture table','retry-fixture');`)
const sibling = newCheck(false, 77)
const { sequence: _sequence, ...siblingBefore } = snapshot(sibling.check)

for (const method of ['CASH', 'UPI', 'CARD'] as const) {
  for (const fault of ['after-commit', 'before-commit'] as const) {
    const { session, check } = newCheck(true, 125)
    const attempt = createEndedCheckAttempt(check, session, method, 125)
    const previousSequence = snapshot(check).sequence ?? 0
    let originalInvoice: string | null = null
    const wireKeys: string[] = []
    const observe = (init: RequestInit) => wireKeys.push(JSON.parse(String(init.body)).idempotencyKey)
    await assert.rejects(sendEndedCheckPayment(async (path, init) => {
      observe(init)
      if (fault === 'after-commit') {
        const completed = await call(path, init)
        assert.equal(completed.ok, true, await completed.clone().text())
        originalInvoice = snapshot(check).invoice
        assert.ok(originalInvoice, 'the invoice committed before the response was dropped')
      }
      throw new Error('simulated transport drop')
    }, attempt), /simulated transport drop/)
    const afterDrop = snapshot(check)
    assert.equal(afterDrop.ledger.length, fault === 'after-commit' ? 1 : 0)
    if (fault === 'before-commit') assert.equal(afterDrop.invoice, null)
    if (fault === 'after-commit') {
      // A second, ambiguous gateway response must not be treated as a receipt.
      await assert.rejects(sendEndedCheckPayment(async () => new Response('', { status: 502 }), attempt), /could not be confirmed/)
      assert.deepEqual(snapshot(check), afterDrop)
    }
    const receipt = await sendEndedCheckPayment(async (path, init) => {
      observe(init)
      return call(path, init)
    }, attempt)
    const saved = snapshot(check)
    assert.equal(receipt.invoiceNumber, originalInvoice ?? saved.invoice)
    assert.ok(receipt.invoiceNumber)
    assert.equal(receipt.paymentMethod, method)
    assert.equal(receipt.paid, 125)
    assert.deepEqual(saved.ledger, [{ id: receipt.paymentId, method, key: attempt.idempotencyKey, amount: 125 }])
    assert.equal(saved.sequence, previousSequence + 1, 'only one invoice sequence was allocated')
    assert.deepEqual(wireKeys, [attempt.idempotencyKey, attempt.idempotencyKey])
    const { sequence: _seq, ...siblingAfter } = snapshot(sibling.check)
    assert.deepEqual(siblingAfter, siblingBefore)
    console.log(`PASS ${method}: ${fault}, same key, original invoice, one ledger row, sibling unchanged`)

    const post = (body: object) => call(method === 'CASH' ? '/api/bill/settle-cash' : '/api/bill/payment', { method: 'POST', body: JSON.stringify(body) })
    assert.equal((await post({ ...attempt, idempotencyKey: randomUUID() })).status, 409)
    assert.equal((await post({ ...attempt, checkId: sibling.check })).status, 409)
    assert.equal((await post({ ...attempt, sessionId: sibling.session, endedSessionId: sibling.session })).status, 409)
    permitted = false
    assert.equal((await post(attempt)).status, 403)
    permitted = true
    actorTenant = otherTenant
    assert.equal((await post(attempt)).status, 409)
    actorTenant = tenant
    assert.deepEqual(snapshot(check), saved)
  }
}

for (const state of ['void', 'cancelled', 'shared'] as const) {
  const { session, check } = newCheck(true, 125)
  if (state === 'void') sql(`update public.table_checks set status='VOID' where id='${check}'`)
  if (state === 'cancelled') sql(`update public.orders set status='CANCELLED' where check_id='${check}'`)
  if (state === 'shared') sql(`update public.table_checks set anchor_session_id='${sibling.session}' where id='${check}'`)
  const before = snapshot(check)
  for (const method of ['CASH', 'UPI', 'CARD'] as const) {
    await assert.rejects(sendEndedCheckPayment(async (path, init) => {
      const response = await call(path, init)
      assert.equal(response.status, 409)
      return response
    }, createEndedCheckAttempt(check, session, method, 125)))
  }
  assert.deepEqual(snapshot(check), before)
  console.log(`PASS ${state} check still refuses new payment for all methods`)
}
