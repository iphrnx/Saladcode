import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("── Testing POS Dashboard Active Sessions & Inactivity Expiry Invariants ──\n");

let pass = 0;
let fail = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err: any) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    fail++;
  }
};

const dashboardPath = path.resolve("src/components/views/dashboard.tsx");
const dashboardCode = fs.readFileSync(dashboardPath, "utf-8");

const tableSessionPath = path.resolve("supabase/functions/table-session/index.ts");
const tableSessionCode = fs.readFileSync(tableSessionPath, "utf-8");

const migrationPath = path.resolve("supabase/migrations/20261120000000_align_session_lifecycle_30m_idle.sql");
const migrationCode = fs.readFileSync(migrationPath, "utf-8");

// ── 1. POS Dashboard UI Section Refactoring ──
test("POS dashboard renders 'Active Sessions' header instead of 'Awaiting payment'", () => {
  assert.match(dashboardCode, /<h3[^>]*>\s*Active Sessions\s*<\/h3>/i);
  assert.doesNotMatch(dashboardCode, /<h3[^>]*>\s*Awaiting payment\s*<\/h3>/i);
});

test("POS dashboard completely removed the large Active Sessions floor cards", () => {
  // Previously had 'Table bill' button and 'End session' button inside large floor cards
  assert.doesNotMatch(dashboardCode, /<Button[^>]*>\s*<Receipt[^>]*\/>\s*Table bill\s*<\/Button>/);
  assert.doesNotMatch(dashboardCode, /data-session-state=/);
  assert.doesNotMatch(dashboardCode, /End All Sittings/);
  assert.doesNotMatch(dashboardCode, /End Selected Sitting/);
});

test("POS dashboard compact cards are fixed-size (w-56) and toggle session load/unload on click", () => {
  assert.match(dashboardCode, /data-active-session-card/);
  assert.match(dashboardCode, /w-56 shrink-0 rounded-2xl border/);
  assert.match(dashboardCode, /onClick=\{\(\) => handleSessionCardClick\(card\)\}/);
});

test("POS dashboard renders compact loaded session strip with × unload button and no heavy picker", () => {
  assert.match(dashboardCode, /Adding to \$\{tableName\}/);
  assert.match(dashboardCode, /title="Unload session"/);
  assert.match(dashboardCode, /aria-label="Unload session"/);
  assert.doesNotMatch(dashboardCode, /<span>Diner Sitting \(Required\)<\/span>/);
});

test("POS dashboard renders 4-zone active session card with compact identifier, elapsed time, dynamic stage pills, context line, and strict 2-decimal financial values", () => {
  // Zone 1: Compact identifier + elapsed time indicator
  assert.match(dashboardCode, /card\.compactIdentifier/);
  assert.match(dashboardCode, /card\.elapsedText/);
  assert.match(dashboardCode, /card\.elapsedMinutes > 45/);

  // Zone 2: Contextual order-stage badges
  assert.match(dashboardCode, /card\.statusStage === 'New KOT'/);
  assert.match(dashboardCode, /card\.statusStage === 'Preparing'/);
  assert.match(dashboardCode, /card\.statusStage === 'Served'/);
  assert.match(dashboardCode, /card\.statusStage === 'Bill Requested'/);
  assert.match(dashboardCode, /card\.statusStage === 'Verifying'/);

  // Zone 3: Context line (zone + item summary, or 'Editing in Cart')
  assert.match(dashboardCode, /Editing in Cart/);
  assert.match(dashboardCode, /card\.itemSummary/);

  // Zone 4: Smart financial footer with strict 2-decimal formatting, 0-paid suppression, and verifying state
  assert.match(dashboardCode, /\{formatCurrency\(card\.outstanding,\s*currencySymbol\)\}\s*due/);
  assert.match(dashboardCode, /card\.paid > 0 && card\.paid < card\.total/);
  assert.match(dashboardCode, /formatCurrency\(card\.paid,\s*currencySymbol\)/);
  assert.match(dashboardCode, /Verifying payment\.\.\./);
});

test("POS dashboard includes expandable active sessions modal dialog with search and zone filtering", () => {
  assert.match(dashboardCode, /activeSessionsModalOpen/);
  assert.match(dashboardCode, /modalSearch/);
  assert.match(dashboardCode, /modalZoneFilter/);
  assert.match(dashboardCode, /<Dialog open=\{activeSessionsModalOpen\}/);
});

test("POS dashboard supports stateful cart session persistence and dynamic update order CTA", () => {
  assert.match(dashboardCode, /savePosActiveSessionId/);
  assert.match(dashboardCode, /getPosActiveSessionId/);
  assert.match(dashboardCode, /clearPosActiveSessionId/);
  assert.match(dashboardCode, /Update Order · \+/);
  assert.match(dashboardCode, /Already Ordered/);
});

// ── 2. Independent Diner Session Aggregation & De-duplication ──
test("POS dashboard computes activeSessionCards with deduplication and multi-sitting support", () => {
  assert.match(dashboardCode, /const activeSessionCards = useMemo\(\(\) => \{/);
  assert.match(dashboardCode, /const seenCheckIds = new Set<string>\(\)/);
  assert.match(dashboardCode, /const seenSessionIds = new Set<string>\(\)/);
  // Handles multiple independent sittings at the same table
  assert.match(dashboardCode, /sessionNumber = totalLiveAtTable > 1 && group\.tableId \? idx \+ 1 : null/);
  // Merges or skips already represented pending bills
  assert.match(dashboardCode, /b\.checkId && seenCheckIds\.has\(b\.checkId\)/);
});

// ── 3. Edge Function Active Sessions & Inactivity Expiry ──
test("table-session Edge Function attaches session-level checks for independent diner sessions", () => {
  assert.match(tableSessionCode, /checkBySession\[c\.session_id\]/);
  assert.match(tableSessionCode, /\(s as any\)\.check = \(s\.id && checkBySession\[s\.id\]\) \|\| \(s\.tableId && checkByTable\[s\.tableId\]\) \|\| null/);
  assert.match(tableSessionCode, /sessionId: c\.session_id/);
});

test("table-session Edge Function checks session abandonment at 30 minutes of inactivity", () => {
  assert.match(tableSessionCode, /now - lastSeen > 30 \* 60_000/);
});

// ── 4. 30-Minute Session Lifecycle Database Migration ──
test("session_is_abandoned function requires 30 minutes of silence and ZERO orders/checks", () => {
  assert.match(migrationCode, /create or replace function public\.session_is_abandoned/);
  assert.match(migrationCode, /p_window interval default interval '30 minutes'/);
  assert.match(migrationCode, /coalesce\(s\.last_seen_at, s\.updated_at, s\.created_at\) < now\(\) - p_window/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.orders o\s*where o\.table_session_id = s\.id\s*\)/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.table_checks c\s*join public\.check_payments cp on cp\.check_id = c\.id\s*where \(c\.session_id = s\.id or c\.anchor_session_id = s\.id\)\s*and cp\.status = 'SUCCEEDED'\s*\)/);
});

test("expire_stale_table_sessions protects all sessions with orders or unpaid checks and defaults to 30 minutes", () => {
  assert.match(migrationCode, /create or replace function public\.expire_stale_table_sessions/);
  assert.match(migrationCode, /p_after interval default interval '30 minutes'/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.orders o\s*where o\.table_session_id = s\.id\s*\)/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.table_checks c\s*join public\.check_payments cp on cp\.check_id = c\.id\s*where \(c\.session_id = s\.id or c\.anchor_session_id = s\.id\)\s*and cp\.status = 'SUCCEEDED'\s*\)/);
});

test("migration schedules expire_stale_table_sessions via pg_cron every 10 minutes", () => {
  assert.match(migrationCode, /cron\.schedule\(\s*'expire-stale-table-sessions',\s*'\*\/10 \* \* \* \*'/);
});

console.log("\n=================================================================");
console.log(`  TOTAL: ${pass} PASSED, ${fail} FAILED`);
console.log("=================================================================\n");

if (fail > 0) {
  process.exit(1);
}

