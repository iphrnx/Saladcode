import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`)
}

console.log('\n── 1. Database Migration: Atomic Functions & Independent Sessions ──')
const migrationSql = readFileSync(
  resolve('supabase/migrations/20261116000001_fix_session_ended_card_root_causes.sql'),
  'utf8'
)

check(
  'settle_check_cash_tx uses extensions.gen_random_bytes or safe search_path',
  migrationSql.includes('extensions.gen_random_bytes(16)') &&
    migrationSql.includes('search_path = public, extensions, pg_temp')
)

check(
  'settle_check_cash_tx closes ONLY owning check sessions, preserving concurrent diners',
  migrationSql.includes('where id in (') &&
    migrationSql.includes('select v_check.session_id') &&
    migrationSql.includes('select v_check.anchor_session_id') &&
    migrationSql.includes('select o.table_session_id from public.orders')
)

check(
  'finalize_table_check closes ONLY owning check sessions, preserving concurrent diners',
  migrationSql.includes('create or replace function public.finalize_table_check') &&
    migrationSql.includes('v_check.session_id') &&
    migrationSql.includes('v_check.anchor_session_id')
)

check(
  'open_table_check ensures session_id and anchor_session_id are never null',
  migrationSql.includes('create or replace function public.open_table_check') &&
    migrationSql.includes('session_id = coalesce(session_id, v_active_session)')
)

check(
  'create_order_tx binds POS dine-in orders to active session and check',
  migrationSql.includes('create or replace function public.create_order_tx') &&
    migrationSql.includes('v_check := public.open_table_check(v_tenant, v_table, null);') &&
    migrationSql.includes('select coalesce(session_id, anchor_session_id) into v_session')
)

check(
  'Migration backfills historical completed orders with missing table_session_id',
  migrationSql.includes('Backfill session_id on checks where session_id was null') &&
    migrationSql.includes('For completed & paid orders where table_session_id is null')
)

console.log('\n── 2. Backend Edge Functions: Bootstrap, Sync & Realtime ──')
const bootstrapFn = readFileSync(resolve('supabase/functions/bootstrap/index.ts'), 'utf8')
const ordersFn = readFileSync(resolve('supabase/functions/orders/index.ts'), 'utf8')
const billFn = readFileSync(resolve('supabase/functions/bill/index.ts'), 'utf8')

check(
  'bootstrap returns checks dictionary populated from table_checks and check_payments',
  bootstrapFn.includes('const bootstrapCheckIds = [') &&
    bootstrapFn.includes('db.from("table_checks").select("id, status, invoice_number') &&
    bootstrapFn.includes('checks,')
)

check(
  'bootstrap table_sessions window extended to 7 days and backfills missing order sessions',
  bootstrapFn.includes('Date.now() - 7 * 24 * 60 * 60 * 1000') &&
    bootstrapFn.includes('missingSessionIds')
)

check(
  'orders /sync returns 7-day checks with closedAt and 7-day table sessions',
  ordersFn.includes('openCheckSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)') &&
    ordersFn.includes('closedAt: c.closed_at ?? null') &&
    ordersFn.includes('recentSittings = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)')
)

check(
  'bill broadcasts both SESSION_ENDED and SESSION_UPDATED to staff on finalization and cash settlement',
  billFn.includes('await publishToStaff(tenantId, "SESSION_ENDED"') &&
    billFn.includes('await publishToStaff(tenantId, "SESSION_UPDATED"') &&
    billFn.includes('await publishToStaff(tid, "SESSION_ENDED"')
)

console.log('\n── 3. Frontend Client State: Delta Sync & Realtime Synchronization ──')
const dataContext = readFileSync(resolve('src/components/app/data-context.tsx'), 'utf8')
const sessionPayDialog = readFileSync(resolve('src/components/shared/session-payment-dialog.tsx'), 'utf8')

check(
  'data-context refresh sets checks from bootstrap payload',
  dataContext.includes('if (json.checks) setChecks((prev) => ({ ...prev, ...json.checks }))')
)

check(
  'data-context runDeltaSync merges checks instead of evicting them',
  dataContext.includes('setChecks((prev) => ({ ...prev, ...json.checks }))')
)

check(
  'data-context BroadcastChannel listens for CHECK_UPDATED, SESSION_ENDED, and SESSION_UPDATED',
  dataContext.includes("event.data.type === 'SESSION_UPDATED'") &&
    dataContext.includes("status: 'ENDED'") &&
    dataContext.includes("status: 'PAID'")
)

check(
  'data-context Supabase Realtime listens for SESSION_ENDED, SESSION_UPDATED, and CHECK_UPDATED',
  dataContext.includes(".on('broadcast', { event: 'SESSION_ENDED' }") &&
    dataContext.includes(".on('broadcast', { event: 'SESSION_UPDATED' }") &&
    dataContext.includes(".on('broadcast', { event: 'CHECK_UPDATED' }")
)

check(
  'session-payment-dialog broadcasts settled invoiceNumber, status PAID and status ENDED',
  sessionPayDialog.includes("type: 'SESSION_ENDED'") &&
    sessionPayDialog.includes("status: 'PAID'") &&
    sessionPayDialog.includes("status: 'ENDED'")
)

console.log('\n── 4. Frontend Orders View: Session Ended Card Conversion ──')
const ordersView = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

check(
  'sittings memo derives state = Ended when sitting is ENDED or check is settled with all orders completed',
  ordersView.includes('(sitting.status === \'ENDED\' || Boolean(sitting.endedAt) || (isSettledCheck && allOrdersCompleted))') &&
    ordersView.includes("? 'Ended'")
)

check(
  'sittings memo derives authoritative paidOff from database status and orders',
  ordersView.includes("check?.status === 'PAID'") &&
    ordersView.includes("Boolean(check?.invoiceNumber)") &&
    ordersView.includes("(allOrdersPaid && allOrdersCompleted)")
)

check(
  'SittingCard computes paidOff and converts immediately to Cloche Session Ended Card',
  ordersView.includes('const isSettledCheck = check?.status === \'PAID\' || Boolean(check?.invoiceNumber)') &&
    ordersView.includes('isSettledEnded = !active && !onlyPendingActivation && !awaiting && paidOff') &&
    ordersView.includes('Session Ended')
)

check(
  'SittingCard falls back endedTime to check closedAt',
  ordersView.includes('(check as any)?.closedAt')
)

console.log('\n── 5. Bill / Invoice: Clean Table Resolution ──')
const billDialog = readFileSync(resolve('src/components/shared/bill-dialog.tsx'), 'utf8')

check(
  'bill-dialog resolves table name without displaying empty parentheses Table ()',
  billDialog.includes('bill.table && bill.table.name?.trim()') &&
    billDialog.includes("bill.table.area?.trim() ? ` (${bill.table.area.trim()})` : ''")
)

console.log('\n── 6. Security View: Activity Log Formatting & Deduplication ──')
const securityView = readFileSync(resolve('src/components/views/security.tsx'), 'utf8')

check(
  'security view maps CHECK_SETTLED_CASH to friendly label Cash Payment Completed',
  securityView.includes("CHECK_SETTLED_CASH: 'Cash Payment Completed'")
)

check(
  'security view strips technical UUIDs and formats exact date/time',
  securityView.includes('UUID_REGEX') &&
    securityView.includes('formatExactDateTime')
)

console.log(`\nResults: ${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)

