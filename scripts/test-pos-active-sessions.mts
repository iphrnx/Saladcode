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

const migrationPath = path.resolve("supabase/migrations/20261117000008_safe_session_inactivity_expiry.sql");
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

test("POS dashboard compact cards are fixed-size (w-56) and non-clickable (div, not button)", () => {
  assert.match(dashboardCode, /data-active-session-card/);
  assert.match(dashboardCode, /<div[^>]*data-active-session-card[^>]*className=\{cn\(\s*'w-56 shrink-0 rounded-2xl border/);
  // Must NOT be a button or have onClick on the card
  assert.doesNotMatch(dashboardCode, /<button[^>]*data-active-session-card/);
  assert.doesNotMatch(dashboardCode, /data-active-session-card[^>]*onClick=/);
});

test("POS dashboard dynamically displays table name, sitting number, due, paid, and status", () => {
  assert.match(dashboardCode, /\{card\.tableName\}/);
  assert.match(dashboardCode, /card\.sessionNumber \? ` · Sitting #\$\{card\.sessionNumber\}` : ''/);
  assert.match(dashboardCode, /\{Number\(card\.outstanding\)\.toLocaleString\('en-IN'\)\} due/);
  assert.match(dashboardCode, /\{Number\(card\.paid\)\.toLocaleString\('en-IN'\)\} of/);
  assert.match(dashboardCode, /\{Number\(card\.total\)\.toLocaleString\('en-IN'\)\} paid/);
  assert.match(dashboardCode, /\{card\.statusLabel\}/);
});

// ── 2. Independent Diner Session Aggregation & De-duplication ──
test("POS dashboard computes activeSessionCards with deduplication and multi-sitting support", () => {
  assert.match(dashboardCode, /const activeSessionCards = useMemo\(\(\) => \{/);
  assert.match(dashboardCode, /const seenCheckIds = new Set<string>\(\)/);
  assert.match(dashboardCode, /const seenSessionIds = new Set<string>\(\)/);
  // Handles multiple independent sittings at the same table
  assert.match(dashboardCode, /sessionNumber: totalLiveAtTable > 1 \? idx \+ 1 : null/);
  // Merges or skips already represented pending bills
  assert.match(dashboardCode, /b\.checkId && seenCheckIds\.has\(b\.checkId\)/);
});

// ── 3. Edge Function Active Sessions & Inactivity Expiry ──
test("table-session Edge Function attaches session-level checks for independent diner sessions", () => {
  assert.match(tableSessionCode, /checkBySession\[c\.session_id\]/);
  assert.match(tableSessionCode, /\(s as any\)\.check = \(s\.id && checkBySession\[s\.id\]\) \|\| checkByTable\[s\.tableId\] \|\| null/);
  assert.match(tableSessionCode, /sessionId: c\.session_id/);
});

test("table-session Edge Function checks session abandonment at 15 minutes of inactivity", () => {
  assert.match(tableSessionCode, /now - lastSeen > 15 \* 60_000/);
});

// ── 4. Safe 15-Minute Session Inactivity Expiry Database Migration ──
test("Database migration ensures last_seen_at and close_pending_at columns exist on table_sessions", () => {
  assert.match(migrationCode, /alter table public\.table_sessions\s+add column if not exists last_seen_at/);
  assert.match(migrationCode, /add column if not exists close_pending_at/);
});

test("session_is_abandoned function requires 15 minutes of silence and ZERO orders/checks", () => {
  assert.match(migrationCode, /create or replace function public\.session_is_abandoned/);
  assert.match(migrationCode, /coalesce\(s\.last_seen_at, s\.updated_at, s\.created_at\) < now\(\) - p_window/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.orders o\s*where o\.table_session_id = s\.id\s*\)/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.table_checks c\s*where \(c\.session_id = s\.id or c\.anchor_session_id = s\.id\)\s*and c\.status in \('OPEN', 'UNSETTLED'\)\s*\)/);
});

test("expire_stale_table_sessions protects all sessions with orders or unpaid checks", () => {
  assert.match(migrationCode, /create or replace function public\.expire_stale_table_sessions/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.orders o\s*where o\.table_session_id = s\.id\s*\)/);
  assert.match(migrationCode, /not exists \(\s*select 1\s*from public\.table_checks c\s*where \(c\.session_id = s\.id or c\.anchor_session_id = s\.id\)\s*and c\.status in \('OPEN', 'UNSETTLED'\)\s*\)/);
});

console.log("\n=================================================================");
console.log(`  TOTAL: ${pass} PASSED, ${fail} FAILED`);
console.log("=================================================================\n");

if (fail > 0) {
  process.exit(1);
}

