import {
  formatActionLabel,
  formatActionColor,
  formatExactDateTime,
  enrichSecurityLog,
  mergeSecurityLogs,
  type MergedSecurityLog,
} from '../src/components/views/security'
import type { SecurityLog } from '../src/components/app/data-context'

let passCount = 0
let failCount = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`)
    passCount++
  } else {
    console.error(`  ✗ FAIL: ${msg}`)
    failCount++
  }
}

console.log('\n--- 1. Testing Event Code Label & Color Formatting ---')
assert(formatActionLabel('CHECK_SETTLED_CASH') === 'Cash Payment Completed', 'CHECK_SETTLED_CASH formats to "Cash Payment Completed"')
assert(formatActionLabel('CHECK_FINALISED') === 'Bill Finalized', 'CHECK_FINALISED formats to "Bill Finalized"')
assert(formatActionLabel('ORDER_CANCELLED') === 'Order Cancelled', 'ORDER_CANCELLED formats to "Order Cancelled"')
assert(formatActionLabel('SETTINGS_CHANGE') === 'Settings Updated', 'SETTINGS_CHANGE formats to "Settings Updated"')
assert(formatActionLabel('LOGIN') === 'Sign In', 'LOGIN formats to "Sign In"')
assert(formatActionLabel('LOGIN_FAILED') === 'Failed Login', 'LOGIN_FAILED formats to "Failed Login"')
assert(formatActionLabel('UNKNOWN_TEST_EVENT') === 'Unknown Test Event', 'UNKNOWN_TEST_EVENT formats to Title Case')

assert(formatActionColor('CHECK_SETTLED_CASH') === '#16a34a', 'CHECK_SETTLED_CASH color is green (#16a34a)')
assert(formatActionColor('ORDER_CANCELLED') === '#ea580c', 'ORDER_CANCELLED color is orange (#ea580c)')

console.log('\n--- 2. Testing Exact Date & Time Formatting ---')
const dt = formatExactDateTime('2026-11-15T16:55:27.069Z', 'Asia/Kolkata')
console.log('Formatted exact datetime:', dt)
assert(dt.includes('15 Nov 2026') && dt.includes('10:25 PM'), 'Formats to exact restaurant timezone date and time (15 Nov 2026, 10:25 PM)')

console.log('\n--- 3. Testing UUID Scrubbing & Enrichment ---')
const mockData = {
  tenant: { currencySymbol: '₹' },
  tables: [
    { id: '03fcd8a5-def5-4351-a35d-de4acc499d16', name: 'Table 2' },
    { id: 'e4bf6a61-4fc4-4cc1-94b2-8fbdf1c4c6a6', name: 'Table 4' },
  ],
  orders: [
    {
      id: '9e48ea61-dbb7-46bd-90b5-dba522c1e432',
      orderNumber: 62,
      tableId: '03fcd8a5-def5-4351-a35d-de4acc499d16',
      table: { id: '03fcd8a5-def5-4351-a35d-de4acc499d16', name: 'Table 2' },
      checkId: '657929fd-5dea-43e4-8cfc-40511483659e',
      total: 157.5,
      paymentMethod: 'Cash',
    },
    {
      id: '8d2a6a61-4fc4-4cc1-94b2-8fbdf1c4c6a7',
      orderNumber: 9,
      tableId: 'e4bf6a61-4fc4-4cc1-94b2-8fbdf1c4c6a6',
      table: { id: 'e4bf6a61-4fc4-4cc1-94b2-8fbdf1c4c6a6', name: 'Table 4' },
      checkId: '64c507a3-a646-4f85-8fce-72c896229b81',
      total: 525.0,
      paymentMethod: 'Cash',
    },
  ],
  checks: {
    '657929fd-5dea-43e4-8cfc-40511483659e': { total: 157.5, invoiceNumber: 'INV-0000014' },
    '64c507a3-a646-4f85-8fce-72c896229b81': { total: 525.0, invoiceNumber: 'INV-0000013' },
  },
}

const rawLogs: SecurityLog[] = [
  // Pair 1: Cash settlement for INV-0000014 (from screenshot)
  {
    id: '5692081f-d56f-43e7-850c-e33810a45a72',
    userId: '7b8317bd-287c-4d3f-acc6-d9ebb98e87b1',
    action: 'CHECK_SETTLED_CASH',
    ip: null,
    userAgent: null,
    meta: 'check 657929fd-5dea-43e4-8cfc-40511483659e settled in cash, invoice INV-0000014',
    createdAt: '2026-11-15T16:55:27.286Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
  {
    id: '9433c734-cf95-4b66-8160-689dd42a5456',
    userId: '7b8317bd-287c-4d3f-acc6-d9ebb98e87b1',
    action: 'CHECK_SETTLED_CASH',
    ip: null,
    userAgent: null,
    meta: 'Check 657929fd-5dea-43e4-8cfc-40511483659e settled in cash: INV-0000014 (₹157.50)',
    createdAt: '2026-11-15T16:55:27.069Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
  // Order Cancelled (from screenshot)
  {
    id: 'c71df3e2-6135-4b8b-86c0-e51409b86087',
    userId: '7b8317bd-287c-4d3f-acc6-d9ebb98e87b1',
    action: 'ORDER_CANCELLED',
    ip: null,
    userAgent: null,
    meta: 'Order #62 (9e48ea61-dbb7-46bd-90b5-dba522c1e432) cancelled: Customer changed mind',
    createdAt: '2026-11-15T16:53:14.118Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
  // Pair 2: Cash settlement for INV-0000013 (from screenshot)
  {
    id: 'f5022b20-4ab5-42b9-93b8-9564aa429e0c',
    userId: '7b8317bd-287c-4d3f-acc6-d9ebb98e87b1',
    action: 'CHECK_SETTLED_CASH',
    ip: null,
    userAgent: null,
    meta: 'check 64c507a3-a646-4f85-8fce-72c896229b81 settled in cash, invoice INV-0000013',
    createdAt: '2026-11-15T16:44:13.306Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
  {
    id: '5c78821e-6644-4862-bbcb-8154045a76c2',
    userId: '7b8317bd-287c-4d3f-acc6-d9ebb98e87b1',
    action: 'CHECK_SETTLED_CASH',
    ip: null,
    userAgent: null,
    meta: 'Check 64c507a3-a646-4f85-8fce-72c896229b81 settled in cash: INV-0000013 (₹525.00)',
    createdAt: '2026-11-15T16:44:13.220Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
  // Pair 3: Duplicate settings updates 1.4s apart
  {
    id: 'c59bed1c-2d62-45bb-b4b4-48a2b50fd945',
    userId: null,
    action: 'SETTINGS_CHANGE',
    ip: '152.59.185.245',
    userAgent: null,
    meta: 'Updated restaurant settings',
    createdAt: '2026-11-15T07:29:19.750Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
  {
    id: 'e407bb0a-5a48-46bf-8108-fdf2bb212dec',
    userId: null,
    action: 'SETTINGS_CHANGE',
    ip: '152.59.185.245',
    userAgent: null,
    meta: 'Updated restaurant settings',
    createdAt: '2026-11-15T07:29:18.370Z',
    actor: { kind: 'owner', name: 'My cafe', role: 'Owner' },
  },
]

console.log('\n--- 4. Testing Deduplication / Merging ---')
const merged = mergeSecurityLogs(rawLogs, mockData, 'Asia/Kolkata')
console.log(`Original raw logs count: ${rawLogs.length}, Merged logs count: ${merged.length}`)

assert(merged.length === 4, `Merged 7 logs down to 4 distinct events (expected 4, got ${merged.length})`)

// Check item 1 (INV-0000014)
const item1 = merged[0]
console.log('Item 1 (INV-0000014):', item1.cleanDetails)
assert(item1.action === 'CHECK_SETTLED_CASH', 'Item 1 action is CHECK_SETTLED_CASH')
assert(item1.cleanDetails?.includes('Invoice INV-0000014'), 'Item 1 has Invoice INV-0000014')
assert(item1.cleanDetails?.includes('Table 2'), 'Item 1 resolved Table 2')
assert(item1.cleanDetails?.includes('Order #62'), 'Item 1 resolved Order #62')
assert(item1.cleanDetails?.includes('₹157.50'), 'Item 1 resolved ₹157.50')
assert(item1.cleanDetails?.includes('Cash'), 'Item 1 shows Cash payment method')
assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(item1.cleanDetails || ''), 'Item 1 contains ZERO UUIDs')

// Check item 2 (Order #62 cancelled)
const item2 = merged[1]
console.log('Item 2 (Order Cancelled):', item2.cleanDetails)
assert(item2.action === 'ORDER_CANCELLED', 'Item 2 action is ORDER_CANCELLED')
assert(item2.cleanDetails?.includes('Order #62'), 'Item 2 has Order #62')
assert(item2.cleanDetails?.includes('Table 2'), 'Item 2 resolved Table 2')
assert(item2.cleanDetails?.includes('Customer changed mind'), 'Item 2 has cancellation reason')
assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(item2.cleanDetails || ''), 'Item 2 contains ZERO UUIDs')

// Check item 3 (INV-0000013)
const item3 = merged[2]
console.log('Item 3 (INV-0000013):', item3.cleanDetails)
assert(item3.cleanDetails?.includes('Invoice INV-0000013'), 'Item 3 has Invoice INV-0000013')
assert(item3.cleanDetails?.includes('Table 4'), 'Item 3 resolved Table 4')
assert(item3.cleanDetails?.includes('Order #9'), 'Item 3 resolved Order #9')
assert(item3.cleanDetails?.includes('₹525.00'), 'Item 3 resolved ₹525.00')
assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(item3.cleanDetails || ''), 'Item 3 contains ZERO UUIDs')

// Check item 4 (Settings change)
const item4 = merged[3]
console.log('Item 4 (Settings):', item4.cleanDetails)
assert(item4.action === 'SETTINGS_CHANGE', 'Item 4 action is SETTINGS_CHANGE')
assert(item4.cleanDetails === 'Updated restaurant profile and settings', 'Item 4 displays clean settings update')

console.log(`\nResults: ${passCount} passed, ${failCount} failed.`)
if (failCount > 0) process.exit(1)

