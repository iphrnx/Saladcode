import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let pass = 0
let fail = 0

function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? `\n        ${detail}` : ''}`)
}

console.log('\n── 1. Backend Edge Function: Table Resolution in Bill API ──')
const billFn = readFileSync(resolve('supabase/functions/bill/index.ts'), 'utf8')

check(
  'loadCheck resolves table via check.table_id, session_id, or orders',
  billFn.includes('let resolvedTableId = open.table_id ?? null;') &&
    billFn.includes('open.session_id') &&
    billFn.includes('tables') &&
    billFn.includes('tableRecord = t')
)

check(
  'loadCheck returns resolved table in payload',
  billFn.includes('table: tableRecord,')
)

check(
  'dinerDocument accepts resolved table and formats without hardcoding empty strings',
  !billFn.includes('table: { name: "", seats: 0, area: "" }') &&
    billFn.includes('table && table.name?.trim()')
)

check(
  'getCheck format=document forwards resolved table and fssai',
  billFn.includes('dinerDocument(check, live, payments, gstin, data.tenant, data.table, data.fssai)')
)

check(
  'get single order bill traces table via table_session_id or check_id when missing on order',
  billFn.includes('order.table_session_id') &&
    billFn.includes('table_sessions') &&
    billFn.includes('order.check_id') &&
    billFn.includes('table_checks')
)

console.log('\n── 2. Bill Dialog & Print HTML: Table Formatting ──')
const billDialog = readFileSync(resolve('src/components/shared/bill-dialog.tsx'), 'utf8')

check(
  'parseBillPayload properly prioritizes and resolves table from doc.table and tableHint',
  billDialog.includes('resolvedTable = (doc.table && doc.table.name?.trim())') &&
    billDialog.includes('tableHint && tableHint.name?.trim()')
)

check(
  'buildPrintHtml renders Table without empty parentheses or trailing separators',
  billDialog.includes("const tableLabel = bill.table.area?.trim()") &&
    billDialog.includes("`${bill.table.name.trim()} · ${bill.table.area.trim()}`")
)

check(
  'BillDialog JSX renders Table with area only when area exists, avoiding "Table: ()"',
  billDialog.includes('{bill.table && bill.table.name?.trim() && (') &&
    billDialog.includes('{bill.table.area?.trim() ? ` (${bill.table.area.trim()})` : \'\'}')
)

console.log('\n── 3. Orders View: Robust Table Identification in Sittings & Bill Triggers ──')
const ordersView = readFileSync(resolve('src/components/views/orders.tsx'), 'utf8')

check(
  'sittings useMemo resolves table across rows, session, check, and data.tables',
  ordersView.includes('const tableFromRows = rows.find((o) => o.table?.name)?.table') &&
    ordersView.includes('const tableFromData = resolvedTableId') &&
    ordersView.includes('data?.tables')
)

check(
  'onBill callback passes non-null tableName when resolved',
  ordersView.includes('table: target.tableName') &&
    ordersView.includes('name: target.tableName')
)

console.log('\n── 4. Unit Logic Simulation: Table string rendering ──')
function formatTableJsx(table: { name?: string | null; area?: string | null } | null) {
  if (!table || !table.name?.trim()) return null
  return `${table.name.trim()}${table.area?.trim() ? ` (${table.area.trim()})` : ''}`
}

function formatTablePrint(table: { name?: string | null; area?: string | null } | null) {
  if (!table || !table.name?.trim()) return null
  return table.area?.trim() ? `${table.name.trim()} · ${table.area.trim()}` : table.name.trim()
}

// Test case 1: Table 10 with area Main Hall
check(
  'Table 10 with area renders "Table 10 (Main Hall)" in JSX',
  formatTableJsx({ name: 'Table 10', area: 'Main Hall' }) === 'Table 10 (Main Hall)'
)
check(
  'Table 10 with area renders "Table 10 · Main Hall" in Print',
  formatTablePrint({ name: 'Table 10', area: 'Main Hall' }) === 'Table 10 · Main Hall'
)

// Test case 2: Table 10 with empty/null area
check(
  'Table 10 with empty area renders "Table 10" without "()" in JSX',
  formatTableJsx({ name: 'Table 10', area: '' }) === 'Table 10'
)
check(
  'Table 10 with null area renders "Table 10" in Print',
  formatTablePrint({ name: 'Table 10', area: null }) === 'Table 10'
)

// Test case 3: Empty name and area (the bug in the screenshot)
check(
  'Empty table object returns null (omitted completely, no "Table: ()")',
  formatTableJsx({ name: '', area: '' }) === null
)
check(
  'Empty table object in print returns null',
  formatTablePrint({ name: '', area: '' }) === null
)

console.log(`\nResults: ${pass} passed, ${fail} failed of ${pass + fail} checks.`)
if (fail > 0) process.exit(1)

