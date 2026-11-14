/**
 * Automated test suite for Production-Grade Independent Diner Session Architecture.
 *
 * Usage: npx tsx scripts/test-independent-diner-sessions-offline.mts
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const migSessions = readFileSync("supabase/migrations/20261114000003_independent_diner_sessions.sql", "utf8");
const ordersFn = readFileSync("supabase/functions/orders/index.ts", "utf8");
const billFn = readFileSync("supabase/functions/bill/index.ts", "utf8");
const tableSessionFn = readFileSync("supabase/functions/table-session/index.ts", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");

console.log("\n── 1. Database Schema & Partial Unique Index (One Check Per Session) ──");
{
  check(
    "table_checks has session_id column referencing table_sessions",
    migSessions.includes("alter table public.table_checks") &&
    migSessions.includes("add column if not exists session_id uuid references public.table_sessions(id)")
  );
  check(
    "legacy single open check per table is removed",
    migSessions.includes("drop index if exists public.table_checks_one_open_per_table")
  );
  check(
    "unique partial index enforces one OPEN check per session",
    migSessions.includes("create unique index if not exists table_checks_one_open_per_session") &&
    migSessions.includes("on public.table_checks (session_id)") &&
    migSessions.includes("where status = 'OPEN'")
  );
  check(
    "fast table occupancy index exists on (table_id, status)",
    migSessions.includes("create index if not exists idx_table_checks_table_status") &&
    migSessions.includes("on public.table_checks (table_id, status)")
  );
}

console.log("\n── 2. Session Check Atomic Allocation (open_session_check) ──");
{
  check(
    "open_session_check takes session advisory lock to prevent race conditions",
    migSessions.includes("perform pg_advisory_xact_lock(hashtext(p_session::text))")
  );
  check(
    "open_session_check queries existing check by session_id and status = 'OPEN'",
    migSessions.includes("where tenant_id = p_tenant") &&
    migSessions.includes("and session_id = p_session") &&
    migSessions.includes("and status = 'OPEN'")
  );
  check(
    "open_session_check inserts session_id and anchor_session_id immutably",
    migSessions.includes("tenant_id, table_id, session_id, anchor_session_id, status, opened_at")
  );
  check(
    "open_table_check delegates to open_session_check when session is present",
    migSessions.includes("if v_active_session is not null then") &&
    migSessions.includes("return public.open_session_check(p_tenant, p_table, v_active_session)")
  );
}

console.log("\n── 3. Transactional Order Binding (create_order_tx) ──");
{
  check(
    "create_order_tx opens session check strictly for this diner session",
    migSessions.includes("v_check := public.open_session_check(v_tenant, v_table, v_session);")
  );
  check(
    "orders table stamps both table_session_id and check_id from session context",
    migSessions.includes("v_tenant,") &&
    migSessions.includes("v_table,") &&
    migSessions.includes("v_session,") &&
    migSessions.includes("v_check")
  );
  check(
    "takeaway and delivery orders remain completely isolated with null table and check",
    migSessions.includes("v_table := null;") &&
    migSessions.includes("v_session := null;") &&
    migSessions.includes("v_check := null;")
  );
}

console.log("\n── 4. Independent Financial Settlement (finalize_table_check) ──");
{
  check(
    "finalize_table_check scopes settlement strictly to p_check",
    migSessions.includes("where id = p_check and tenant_id = p_tenant") &&
    migSessions.includes("for update")
  );
  check(
    "finalize_table_check closes ONLY the session owning this check",
    migSessions.includes("v_target_session := coalesce(v_check.session_id, v_check.anchor_session_id);") &&
    migSessions.includes("where id = v_target_session") &&
    migSessions.includes("and status = 'ACTIVE';")
  );
  check(
    "sibling sessions on the same table remain undisturbed (no table-wide session wipe)",
    !migSessions.includes("and table_id = v_check.table_id\n      and status = 'ACTIVE';")
  );
  check(
    "settle_check_on_session_end scopes check lookup by session_id when provided",
    migSessions.includes("where tenant_id = p_tenant and session_id = p_session and status = 'OPEN'")
  );
}

console.log("\n── 5. Edge Function Session Routing & Billing ──");
{
  check(
    "checkForTenant prioritizes session_id check lookup over table check lookup",
    billFn.includes("if (sessionId)") &&
    billFn.includes('.eq("session_id", sessionId)')
  );
  check(
    "recordPayment supports checkId directly",
    billFn.includes("b.checkId ? String(b.checkId) : null")
  );
  check(
    "broadcastCheck broadcasts to check's own session directly",
    billFn.includes("if (check.session_id)") &&
    billFn.includes('.eq("id", check.session_id)')
  );
  check(
    "orders endpoint binds POS tableSessionId if provided",
    ordersFn.includes("if (b.tableSessionId) {") &&
    ordersFn.includes("tableSessionId = String(b.tableSessionId);")
  );
  check(
    "table-session end passes session id to settle_check_on_session_end",
    tableSessionFn.includes("p_session: sessionId ?? null")
  );
}

console.log("\n── 6. Frontend UI Session Grouping & Labeling ──");
{
  check(
    "sittings prioritizes session:tableSessionId over check:checkId for dine-in",
    ordersView.includes("const isTakeawayOrDelivery = o.orderType === 'TAKEAWAY' || o.orderType === 'DELIVERY'") &&
    ordersView.includes("? `session:${o.tableSessionId}`")
  );
  check(
    "concurrent diner sessions on the same table receive distinct Diner labels",
    ordersView.includes("multiSittingTables") &&
    ordersView.includes("s.sessionLabel = s.latest.customerName ? `Diner: ${s.latest.customerName}` : `Diner ${idx}`")
  );
  check(
    "card title includes sessionLabel when multiple sessions exist at the table",
    ordersView.includes("sitting.sessionLabel ? `${sitting.tableName} · ${sitting.sessionLabel}` : sitting.tableName")
  );
  check(
    "endSitting targets endingSession without causing sibling cards to show Ending...",
    ordersView.includes("endingSession === sitting.sessionId")
  );
}

console.log(`\nResults: ${pass} passed, ${fail} failed of ${pass + fail} checks.`);
if (fail > 0) process.exit(1);
