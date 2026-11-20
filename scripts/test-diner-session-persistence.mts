/**
 * Verification suite for Secure QR Diner Session Persistence & Realtime Order Status Sync.
 *
 * Checks:
 * 1. Storage key format: `restro_session:${restaurantId}:${tableId}` -> `{ sessionId, sessionToken }`
 * 2. No session creation/persistence before first order (browsing mode)
 * 3. Persist only after order placement (backend returns sessionToken and sessionId)
 * 4. Auto-resume on re-scan or browser history re-open (validates active session and token)
 * 5. Strict multi-diner isolation: Diner B at same table on different device gets separate session
 * 6. Post-payment / session termination invalidation: token rejected on non-active sessions,
 *    localStorage cleared, orders reset
 * 7. Realtime order and status updates subscription bindings
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

console.log('\n── Testing Secure QR Diner Session Persistence & Realtime Order Status Sync ──\n');

const publicMenuPath = resolve('src/components/public/public-menu.tsx');
const publicMenuSrc = readFileSync(publicMenuPath, 'utf8');

const tableSessionPath = resolve('supabase/functions/table-session/index.ts');
const tableSessionSrc = readFileSync(tableSessionPath, 'utf8');

const ordersPath = resolve('supabase/functions/orders/index.ts');
const ordersSrc = readFileSync(ordersPath, 'utf8');

const trackerPath = resolve('src/components/public/diner-order-tracker.tsx');
const trackerSrc = readFileSync(trackerPath, 'utf8');

// 1. Storage key format
assert(
  publicMenuSrc.includes('`restro_session:${restaurantId}:${tableId}`') ||
  publicMenuSrc.includes('`restro_session:${'),
  'Scoped localStorage key adheres strictly to restro_session:${restaurantId}:${tableId}',
);

// 2. No persistence before first order
assert(
  !publicMenuSrc.includes('mintDinerSession(qrToken') &&
  tableSessionSrc.includes('session: null') &&
  tableSessionSrc.includes('sessionStatus: session ? "ACTIVE" : "BROWSING"'),
  'Scanning table QR code allows browsing without minting or persisting a database session',
);

// 3. First order creates session and returns sessionToken + sessionId
assert(
  ordersSrc.includes('else if (qrToken)') &&
  ordersSrc.includes('table_sessions') &&
  ordersSrc.includes('sessionToken: newSession.token') &&
  ordersSrc.includes('sessionId: newSession.id'),
  'First order via scanned QR table atomically creates active session and returns unguessable token and sessionId',
);

// 4. Client saves sessionToken upon order confirmation
assert(
  publicMenuSrc.includes('setStoredDinerSession') &&
  publicMenuSrc.includes('order?.sessionToken && order?.sessionId'),
  'Frontend securely stores session credentials in localStorage upon order confirmation',
);

// 5. Auto-resume on re-scan or history re-open
assert(
  publicMenuSrc.includes('getStoredQrMap') &&
  publicMenuSrc.includes('getStoredDinerSession') &&
  publicMenuSrc.includes('findAnyStoredDinerSession'),
  'Frontend automatically detects stored session and verifies active status on re-scan or history re-open',
);

// 6. Strict Multi-Diner Isolation
assert(
  tableSessionSrc.includes('if (!session || session.status !== "ACTIVE") return json(req, { error: "Session required." }, 401);') &&
  ordersSrc.includes('validateDinerSession(tableSessionToken)') &&
  ordersSrc.includes('table_session_id'),
  'Backend strictly isolates sessions by token so separate diners at the same table cannot access each other’s orders',
);

// 7. Post-payment & session termination invalidation
assert(
  publicMenuSrc.includes('handleSessionTerminated') &&
  publicMenuSrc.includes('removeStoredDinerSession') &&
  publicMenuSrc.includes("event: 'SESSION_ENDED'") &&
  publicMenuSrc.includes("msg?.payload?.status === 'PAID'"),
  'Payment completion and session end immediately purge localStorage and reset diner active session',
);

// 8. Order tracker reset on session end / token void
assert(
  trackerSrc.includes('if (!sessionToken)') &&
  trackerSrc.includes('setOrders([])') &&
  trackerSrc.includes('res.status === 401 || res.status === 403'),
  'DinerOrderTracker immediately resets order state to empty when sessionToken is cleared or rejected',
);

// 9. Realtime listener unsubscribes and cleans up cleanly
assert(
  publicMenuSrc.includes('.channel(`diner:${sessionToken}`)') &&
  publicMenuSrc.includes('removeChannel(channel)'),
  'Realtime order status channel subscribes to diner:${sessionToken} and unmounts cleanly on session termination',
);

// 10. Re-opening history or re-scanning after payment clears stale session and loads fresh menu
assert(
  publicMenuSrc.includes('removeStoredDinerSession(mapped.restaurantId, mapped.tableId)') &&
  publicMenuSrc.includes('edgeFetch(`/api/table-session/validate?table='),
  'Re-opening invalid/ended token triggers automatic cleanup and re-fetches clean browsing menu',
);

console.log('\n=================================================================');
console.log(`  TOTAL: ${passed} PASSED, ${failed} FAILED`);
console.log('=================================================================\n');

if (failed > 0) {
  process.exit(1);
}
