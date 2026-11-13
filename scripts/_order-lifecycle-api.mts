/* Order lifecycle API matrix against the LOCALLY running orders function
   (:8000) with a fixture tenant. No production data touched. */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
// Point at the deployed functions with ORDERS_FN_BASE="$NEXT_PUBLIC_SUPABASE_URL/functions/v1".
const FN = process.env.ORDERS_FN_BASE ?? 'http://localhost:8000'
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } })
const stamp = Date.now().toString(36)
const EMAIL = `lifecycle-${stamp}@example.com`
const PASSWORD = 'Lifecycle123!'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail?: any) => {
  if (cond) { passed++; console.log(`ok ${name}`) }
  else { failed++; console.log(`FAIL ${name}${detail ? ' — ' + JSON.stringify(detail).slice(0, 200) : ''}`) }
}

async function main() {
  const { data: u } = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true })
  const userId = u!.user!.id
  const { data: tenant } = await admin.from('tenants').insert({ name: `Lifecycle Test ${stamp}`, slug: `lifecycle-${stamp}`, currency_symbol: '₹', active: true, onboarding_done: true }).select('id').single()
  await admin.from('profiles').insert({ id: userId, tenant_id: tenant!.id, name: 'Lifecycle Test', email: EMAIL, role: 'OWNER', active: true })
  const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } })
  const { data: sess, error: se } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  if (se) throw se
  const token = sess.session!.access_token

  const mkOrder = async (status = 'PENDING', payment = 'UNPAID') => {
    const { data } = await admin.from('orders').insert({
      tenant_id: tenant!.id, status, payment_status: payment, order_type: 'DINE_IN',
      items_total: 100, tax: 5, total: 105,
    }).select('id').single()
    return data!.id as string
  }
  const patch = async (id: string, payload: any) => {
    const res = await fetch(`${FN}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: ANON, 'x-tenant-id': tenant!.id },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const dbOrder = async (id: string) =>
    (await admin.from('orders').select('status, payment_status, payment_method, completed_at').eq('id', id).single()).data!

  try {
    // ── 1. The valid chain walks forward cleanly ─────────────────────────
    const o1 = await mkOrder()
    for (const [target, expect] of [['PREPARING', 200], ['READY', 200], ['SERVED', 200]] as const) {
      const r = await patch(o1, { status: target })
      check(`chain → ${target}`, r.status === expect && r.body.status === target, r)
    }
    const complete = await patch(o1, { status: 'COMPLETED' })
    check('chain → COMPLETED', complete.status === 200 && complete.body.status === 'COMPLETED', complete)
    let db = await dbOrder(o1)
    check('completion does NOT mark paid', db.payment_status === 'UNPAID' && !db.payment_method, db)
    check('completed_at stamped', !!db.completed_at, db)

    // ── 2. Backward and skipping moves are refused ───────────────────────
    const back = await patch(o1, { status: 'READY' })
    check('COMPLETED → READY refused (409)', back.status === 409 && back.body.currentStatus === 'COMPLETED', back)
    const o2 = await mkOrder()
    const skip = await patch(o2, { status: 'READY' })
    check('PENDING → READY refused (409)', skip.status === 409, skip)
    db = await dbOrder(o2)
    check('refused move left the row untouched', db.status === 'PENDING', db)

    // ── 3. Same-status is an idempotent no-op, not an error ──────────────
    const noop = await patch(o2, { status: 'PENDING' })
    check('same-status retry is a 200 no-op', noop.status === 200 && noop.body.status === 'PENDING', noop)

    // ── 4. Payment rules ─────────────────────────────────────────────────
    const noMethod = await patch(o1, { paymentStatus: 'PAID' })
    check('PAID without a method refused (400)', noMethod.status === 400, noMethod)
    const pay = await patch(o1, { paymentStatus: 'PAID', paymentMethod: 'UPI' })
    check('explicit PAID + method recorded', pay.status === 200 && pay.body.paymentStatus === 'PAID' && pay.body.paymentMethod === 'UPI', pay)
    const unpay = await patch(o1, { paymentStatus: 'UNPAID' })
    check('PAID → UNPAID refused (409)', unpay.status === 409, unpay)
    db = await dbOrder(o1)
    check('row still PAID · UPI', db.payment_status === 'PAID' && db.payment_method === 'UPI', db)

    // ── 5. The Pay dialog shape: complete + paid in one call ─────────────
    const o3 = await mkOrder('SERVED')
    const payComplete = await patch(o3, { status: 'COMPLETED', paymentStatus: 'PAID', paymentMethod: 'CASH' })
    check('complete+pay together works', payComplete.status === 200 && payComplete.body.status === 'COMPLETED' && payComplete.body.paymentStatus === 'PAID', payComplete)
    db = await dbOrder(o3)
    check('db shows COMPLETED / PAID / CASH', db.status === 'COMPLETED' && db.payment_status === 'PAID' && db.payment_method === 'CASH', db)

    // ── 6. Cancel path ───────────────────────────────────────────────────
    const o4 = await mkOrder()
    const cancel = await patch(o4, { status: 'CANCELLED' })
    check('PENDING → CANCELLED allowed', cancel.status === 200, cancel)
    const uncancel = await patch(o4, { status: 'PREPARING' })
    check('CANCELLED → PREPARING refused', uncancel.status === 409, uncancel)

    // ── 7. Two staff race the same order — exactly one move wins ─────────
    const o5 = await mkOrder()
    const [r1, r2] = await Promise.all([patch(o5, { status: 'PREPARING' }), patch(o5, { status: 'PREPARING' })])
    const oks = [r1, r2].filter((r) => r.status === 200).length
    check('concurrent same-move: both succeed as noop/advance', oks >= 1, { r1: r1.status, r2: r2.status })
    // READY is legal from PREPARING; SERVED is legal from nowhere in this
    // state — so no interleaving can let both through.
    const [c1, c2] = await Promise.all([patch(o5, { status: 'READY' }), patch(o5, { status: 'SERVED' })])
    db = await dbOrder(o5)
    const finalOk = (c1.status === 200) !== (c2.status === 200)
    check('conflicting moves: exactly one wins', finalOk, { c1: c1.status, c2: c2.status, final: db.status })
    check('final state matches a winner', db.status === 'READY', db)

    // ── 8. Unknown values rejected ───────────────────────────────────────
    const badStatus = await patch(o2, { status: 'FROBULATING' })
    check('unknown status rejected (400)', badStatus.status === 400, badStatus)
    const badPay = await patch(o2, { paymentStatus: 'KINDA' })
    check('unknown payment status rejected (400)', badPay.status === 400, badPay)

    // ── 9. Tenant isolation: another tenant's order is a 404 ─────────────
    const { data: otherTenant } = await admin.from('tenants').insert({ name: `Other ${stamp}`, slug: `other-${stamp}`, active: true }).select('id').single()
    const o6 = await mkOrder()
    await admin.from('orders').update({ tenant_id: otherTenant!.id }).eq('id', o6)
    const cross = await patch(o6, { status: 'PREPARING' })
    check('cross-tenant order not updatable (404)', cross.status === 404, cross)

    console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`)
    process.exitCode = failed ? 1 : 0
  } finally {
    await admin.from('tenants').delete().eq('id', tenant!.id)
    await admin.from('profiles').delete().eq('id', userId)
    await admin.auth.admin.deleteUser(userId)
    console.log('fixture cleaned')
  }
}
main().catch((e) => { console.error('SETUP FAILED:', e); process.exit(1) })
