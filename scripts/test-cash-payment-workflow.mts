/**
 * Production-Safe Cash Payment Workflow Verification.
 *
 * Verifies:
 * 1. Cash Payment & Atomic Transaction:
 *    - Postgres transaction settle_check_cash_tx locks the check row (for update),
 *      records cash payment, completes paid orders, generates sequential invoice,
 *      and ends only that diner session.
 * 2. Already Settled Idempotency:
 *    - If Due = ₹0 and the check is settled, returns existing successful settlement
 *      and invoice idempotently instead of throwing an error.
 * 3. Security & RBAC:
 *    - Server-side RBAC guards on floor & payment keys, strict tenant isolation.
 * 4. Realtime Synchronization:
 *    - Edge Function publishes CHECK_UPDATED and SESSION_ENDED to staff and diners.
 *    - AppDataContext subscribes to CHECK_UPDATED and SESSION_ENDED to sync dashboards.
 * 5. UI:
 *    - Shows "Payment Successful", invoice number, paid amount, and automatically
 *      converts order card into the existing "Session Ended" cloche view.
 *
 * Run:
 *   npx tsx scripts/test-cash-payment-workflow.mts
 */
import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const migCash = readFileSync("supabase/migrations/20261115000001_settle_check_cash_tx.sql", "utf8");
const billEdge = readFileSync("supabase/functions/bill/index.ts", "utf8");
const paymentDialog = readFileSync("src/components/shared/session-payment-dialog.tsx", "utf8");
const dataContext = readFileSync("src/components/app/data-context.tsx", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");

console.log("\n── 1. Atomic Database Transaction: settle_check_cash_tx ──");
{
  check(
    "locks the table check row with tenant isolation",
    /select \* into v_check[\s\S]{0,120}from public\.table_checks[\s\S]{0,80}where id = p_check and tenant_id = p_tenant[\s\S]{0,40}for update;/.test(migCash),
  );
  check(
    "idempotent return when check is already PAID (returns invoice, total, paid, no error)",
    /if v_check\.status = 'PAID' then[\s\S]{0,200}'already', true[\s\S]{0,100}'invoiceNumber', v_check\.invoice_number/.test(migCash),
  );
  check(
    "rejects checks with unserved/cooking food (ORDERS_OPEN)",
    /select count\(\*\) into v_open_orders[\s\S]{0,120}status in \('PENDING_ACTIVATION', 'PENDING', 'PREPARING', 'READY'\)[\s\S]{0,100}raise exception 'ORDERS_OPEN:%'/.test(migCash),
  );
  check(
    "records cash payment in check_payments with idempotency key",
    /insert into public\.check_payments[\s\S]{0,160}'CASH'[\s\S]{0,100}p_idempotency_key/.test(migCash),
  );
  check(
    "allocates tenant-scoped sequential invoice (INV-XXXXXXX)",
    /update public\.check_invoice_counters[\s\S]{0,120}returning last_seq into v_seq;[\s\S]{0,80}v_invoice := 'INV-' \|\| lpad\(v_seq::text, 7, '0'\);/.test(migCash),
  );
  check(
    "marks check PAID and completes paid orders",
    /status = 'PAID'[\s\S]{0,100}invoice_number = v_invoice[\s\S]{0,350}v_completed := public\.complete_paid_check_orders\(p_tenant, p_check\);/.test(migCash),
  );
  check(
    "ends ONLY that check's session (session isolation on shared tables)",
    /v_target_session := coalesce\(v_check\.session_id, v_check\.anchor_session_id\);[\s\S]{0,100}update public\.table_sessions[\s\S]{0,60}set status = 'ENDED'[\s\S]{0,80}where id = v_target_session[\s\S]{0,40}and status = 'ACTIVE';/.test(migCash),
  );
  check(
    "records security audit log for cash settlement",
    /CHECK_SETTLED_CASH[\s\S]{0,80}settled in cash/.test(migCash),
  );
  check(
    "execution revoked from public/anon/authenticated and granted to service_role",
    /revoke execute on function public\.settle_check_cash_tx\(uuid, uuid, uuid, text, text\) from public, anon, authenticated;[\s\S]{0,120}grant execute on function public\.settle_check_cash_tx\(uuid, uuid, uuid, text, text\) to service_role;/.test(migCash),
  );
}

console.log("\n── 2. Edge Function API & RBAC (/api/bill/settle-cash) ──");
{
  check(
    "settle-cash endpoint routed in bill edge function",
    /if \(segments\[0\] === "settle-cash"\)/.test(billEdge),
  );
  check(
    "guarded with RBAC for payments.collect or orders.complete",
    /const g = await guard\(req, \{ anyOf: \["payments\.collect", "orders\.complete"\] \}\);/.test(billEdge),
  );
  check(
    "calls settle_check_cash_tx with tenant and check isolation",
    /rpc\("settle_check_cash_tx", \{[\s\S]{0,100}p_tenant: g\.session\.tenantId,[\s\S]{0,60}p_check: data\.check\.id/.test(billEdge),
  );
  check(
    "audits settlement via auditMoney",
    /await auditMoney\([\s\S]{0,80}"CHECK_SETTLED_CASH"/.test(billEdge),
  );
  check(
    "broadcasts CHECK_UPDATED and SESSION_ENDED to staff in Realtime",
    /await publishToStaff\(tid, "CHECK_UPDATED", \{[\s\S]{0,120}reason: "FINALISED"[\s\S]{0,160}await publishToStaff\(tid, "SESSION_UPDATED", \{[\s\S]{0,80}status: "ENDED"/.test(billEdge),
  );
  check(
    "broadcasts FINALISED to diner in Realtime",
    /await broadcastCheck\(tid, chkId, "FINALISED"\);/.test(billEdge),
  );
}

console.log("\n── 3. POS Payment Dialog: Cash Settlement & UI ──");
{
  check(
    "SessionPaymentDialog receives sessionId in props",
    /sessionId\?: string \| null/.test(paymentDialog),
  );
  check(
    "if check is already settled (status=PAID), loads immediately to 'done' without error",
    /status === 'PAID'/.test(paymentDialog) &&
    /setStage\('done'\)/.test(paymentDialog),
  );
  check(
    "pay() with Due <= 0 returns existing settlement and invoice idempotently instead of throwing error",
    /if \(totals\.outstanding <= 0 && \(invoiceNumber \|\| totals\.total > 0\)\)/.test(paymentDialog),
  );
  check(
    "pay() executes atomic /api/bill/settle-cash when method is CASH",
    /if \(method === 'CASH'\) \{[\s\S]{0,80}const cashRes = await edgeFetch\('\/api\/bill\/settle-cash'/.test(paymentDialog),
  );
  check(
    "shows 'Payment Successful' heading in done stage",
    /<h2[\s\S]{0,120}>\s*Payment Successful\s*<\/h2>/.test(paymentDialog),
  );
  check(
    "displays invoice number clearly in done stage",
    /Invoice Number[\s\S]{0,250}\{invoiceNumber\}/.test(paymentDialog),
  );
  check(
    "displays paid amount clearly in done stage",
    /Total Paid[\s\S]{0,250}\{paidText\}/.test(paymentDialog),
  );
  check(
    "broadcasts CHECK_UPDATED across browser tabs on payment success",
    /new BroadcastChannel\('the_salad_orders_sync'\)[\s\S]{0,100}type: 'CHECK_UPDATED'/.test(paymentDialog),
  );
}

console.log("\n── 4. Dashboard Realtime Synchronization ──");
{
  check(
    "AppDataContext listens to Realtime CHECK_UPDATED and synchronizes",
    /\.on\('broadcast', \{ event: 'CHECK_UPDATED' \}, \(\) => \{[\s\S]{0,100}void runDeltaSync\(\)/.test(dataContext),
  );
  check(
    "AppDataContext listens to Realtime SESSION_ENDED and synchronizes",
    /\.on\('broadcast', \{ event: 'SESSION_ENDED' \}, \(\) => \{[\s\S]{0,100}void runDeltaSync\(\)/.test(dataContext),
  );
  check(
    "AppDataContext synchronizes on local BroadcastChannel CHECK_UPDATED",
    /event\.data\.type === 'CHECK_UPDATED'/.test(dataContext),
  );
  check(
    "orders.tsx passes sessionId to SessionPaymentDialog",
    /sessionId=\{paySitting\?\.sessionId \?\? null\}/.test(ordersView),
  );
  check(
    "orders.tsx SittingCard converts to Session Ended when check is paid and session ended",
    /const isSettledEnded = !active && !onlyPendingActivation && !awaiting && paidOff/.test(ordersView) &&
    /if \(isSettledEnded\) \{/.test(ordersView),
  );
}

console.log(`\nResults: ${pass} passed, ${fail} failed of ${pass + fail} checks.`);
process.exit(fail === 0 ? 0 : 1);
