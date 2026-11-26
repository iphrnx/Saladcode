import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

const qrFn = read('supabase/functions/qr/index.ts')
const qrView = read('src/components/views/qr.tsx')
const publicMenu = read('src/components/public/public-menu.tsx')
const orderQueue = read('src/lib/order-queue.ts')
const ordersFn = read('supabase/functions/orders/index.ts')
const tableSessionFn = read('supabase/functions/table-session/index.ts')

let pass = 0
let fail = 0

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ok    ${name}`)
    pass++
  } catch (err) {
    console.error(`  FAIL  ${name}:`, err instanceof Error ? err.message : err)
    fail++
  }
}

console.log('QR Ordering & Independent Diner Session Audit Regression Checks:')

check('qr/index.ts guards against empty origin vars and .supabase.co fallback', () => {
  assert.ok(qrFn.includes('.endsWith(".supabase.co")'))
  assert.ok(qrFn.includes('QR origin is not configured'))
  assert.ok(qrFn.includes('encodeURIComponent(String(table.qr_token ?? ""))'))
})

check('qr.tsx resolveQrUrl rejects .supabase.co URLs', () => {
  assert.ok(qrView.includes(".endsWith('.supabase.co')"))
})

check('public-menu.tsx persists browsing cart before first order and migrates on confirm', () => {
  assert.ok(publicMenu.includes('browsing:${table.id}'))
  assert.ok(publicMenu.includes("removeStored('cart', `browsing:${tblId}`)"))
})

check('public-menu.tsx handleSessionTerminated locks session while keeping credential for bill', () => {
  const block = publicMenu.slice(
    publicMenu.indexOf('const handleSessionTerminated = () => {'),
    publicMenu.indexOf('useEffect(() => {\n    if (!sessionToken) return'),
  )
  assert.ok(block.includes('lockDinerSession(setSessionState)'))
  assert.ok(!block.includes('setSessionToken(null)'))
})

check('public-menu.tsx preserves billOrderId and sessionToken when recovering ended session', () => {
  assert.ok(publicMenu.includes('if (data?.orderId) setBillOrderId(data.orderId)'))
  assert.ok(publicMenu.includes('lockButKeepCredential('))
})

check('public-menu.tsx adopts existing stored session in placeOrder before minting new one', () => {
  assert.ok(publicMenu.includes('const existingStoredSession ='))
  assert.ok(publicMenu.includes('payload.tableSessionToken = activeToken'))
})

check('order-queue.ts and orders/index.ts support first-order by-key reconciliation via qrToken', () => {
  assert.ok(orderQueue.includes('?qrToken=${encodeURIComponent(qrToken)}'))
  assert.ok(ordersFn.includes('const qrToken = reqUrl.searchParams.get("qrToken")'))
})

check('orders/index.ts and table-session/index.ts enforce tenant.active !== false', () => {
  assert.ok(ordersFn.includes('This restaurant is currently unavailable.'))
  assert.ok(tableSessionFn.includes('if (!tenantRow || tenantRow.active === false)'))
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
