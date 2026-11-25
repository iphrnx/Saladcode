/**
 * Comprehensive verification and regression suite for all 16 audit findings (P0–P3).
 *
 * Usage: npx tsx scripts/test-audit-fixes-p0-p3.mts
 */
import { existsSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

console.log("\n=======================================================");
console.log("  THE SALAD AUDIT REMEDIATION VERIFICATION (P0 - P3)  ");
console.log("=======================================================\n");

// Read code & migration artifacts
const settingsFn = readFileSync("supabase/functions/settings/index.ts", "utf8");
const ordersFn = readFileSync("supabase/functions/orders/index.ts", "utf8");
const staffFn = readFileSync("supabase/functions/staff/index.ts", "utf8");
const billFn = readFileSync("supabase/functions/bill/index.ts", "utf8");
const publicMenu = readFileSync("src/components/public/public-menu.tsx", "utf8");
const sessionPaymentDlg = readFileSync("src/components/shared/session-payment-dialog.tsx", "utf8");
const billDlg = readFileSync("src/components/shared/bill-dialog.tsx", "utf8");
const dataContext = readFileSync("src/components/app/data-context.tsx", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");

const migAuditFixes = readFileSync("supabase/migrations/20261116000003_fix_audit_findings.sql", "utf8");
const migSessionRootCauses = readFileSync("supabase/migrations/20261116000001_fix_session_ended_card_root_causes.sql", "utf8");
const migAddItems = readFileSync("supabase/migrations/20261114000002_tighten_takeaway_delivery_add_items.sql", "utf8");
const migIndepSessions = readFileSync("supabase/migrations/20261114000003_independent_diner_sessions.sql", "utf8");
const migTightenSessions = readFileSync("supabase/migrations/20261114000001_tighten_table_sessions.sql", "utf8");

console.log("── P0 Findings (Critical / Blocker) ──");

// P0-1: Cross-tenant order_items activation
{
  const scopedOrderUpdate = settingsFn.includes('.eq("tenant_id", tenantId)') &&
    settingsFn.includes('.eq("status", "PENDING_ACTIVATION")') &&
    settingsFn.includes('.select("id")');
  const scopedItemsUpdate = settingsFn.includes('.in("order_id", orderIds)') &&
    settingsFn.includes('.eq("status", "PENDING_ACTIVATION")');
  const unconstrainedUpdate = settingsFn.includes('.from("order_items")\n          .update({ status: "PENDING" })\n          .eq("status", "PENDING_ACTIVATION");');

  check("P0-1: Settings auto-accept queries order IDs strictly scoped to tenantId", scopedOrderUpdate);
  check("P0-1: Settings auto-accept updates order_items strictly matching tenant's order IDs", scopedItemsUpdate && !unconstrainedUpdate);
}

// P0-2: Non-existent `subtotal` column insertion in `order_items`
{
  const migAuditNoSubtotal = !migAuditFixes.includes("subtotal, kot_number") && !migAuditFixes.includes("subtotal\n      )");
  const migAuditProperColumns = migAuditFixes.includes("order_id, menu_item_id, name, portion_id, portion,");
  const migRootNoSubtotal = !migSessionRootCauses.includes(", subtotal\n      )");

  check("P0-2: create_order_tx in canonical fix migration omits non-existent subtotal column", migAuditProperColumns && migAuditNoSubtotal);
  check("P0-2: create_order_tx in 20261116000001 migration omits non-existent subtotal column", migRootNoSubtotal);
}

// P0-3: Non-existent `valid_until` column check on coupons
{
  check("P0-3: 20261116000003 migration references valid_to (not valid_until)",
    migAuditFixes.includes("(valid_to is null or valid_to >= now())") && !migAuditFixes.includes("valid_until")
  );
  check("P0-3: 20261116000001 migration references valid_to (not valid_until)",
    migSessionRootCauses.includes("(valid_to is null or valid_to >= now())") && !migSessionRootCauses.includes("valid_until")
  );
  check("P0-3: 20261114000003 migration references valid_to (not valid_until)",
    migIndepSessions.includes("(valid_to is null or valid_to >= now())") && !migIndepSessions.includes("valid_until")
  );
  check("P0-3: 20261114000001 migration references valid_to (not valid_until)",
    migTightenSessions.includes("(valid_to is null or valid_to >= now())") && !migTightenSessions.includes("valid_until")
  );
}

// P0-4: Client-controlled price injection in add_items_to_order_tx
{
  check("P0-4: add_items_to_order_tx in canonical fix looks up authoritative price from dish_portions & menu_items",
    migAuditFixes.includes("v_item_price := coalesce(v_portion_price, v_menu.price);") &&
    migAuditFixes.includes("from public.menu_items") &&
    migAuditFixes.includes("from public.dish_portions")
  );
  check("P0-4: add_items_to_order_tx in 20261114000002 looks up authoritative price from dish_portions & menu_items",
    migAddItems.includes("v_item_price := coalesce(v_portion_price, v_menu.price);") &&
    migAddItems.includes("from public.menu_items") &&
    migAddItems.includes("from public.dish_portions")
  );
}

console.log("\n── P1 Findings (High / Security / Stability) ──");

// P1-1: Manager and Cashier RBAC Lockout in orders/addItem
{
  check("P1-1: orders/addItem uses roleName from session rather than non-existent role property",
    ordersFn.includes('const callerRole = g.session.kind === "owner" ? "Owner" : (g.session.roleName ?? "");')
  );
  check("P1-1: orders/addItem grants permission to owner, manager, and cashier",
    ordersFn.includes('const allowedRoles = ["owner", "manager", "cashier"];') &&
    ordersFn.includes('allowedRoles.includes(callerRole.toLowerCase())')
  );
}

// P1-2: Premature diner lockout on multi-course order completion
{
  const hasPrematureOrderCompletedLockout = publicMenu.includes("msg.type === 'ORDER_UPDATED' &&\n          msg.order?.status === 'COMPLETED'");
  const hasExplicitSessionEndedLockout = publicMenu.includes("msg.type === 'SESSION_ENDED'");

  check("P1-2: public-menu BroadcastChannel does NOT lock session on individual order COMPLETED", !hasPrematureOrderCompletedLockout);
  check("P1-2: public-menu BroadcastChannel locks session on explicit SESSION_ENDED", hasExplicitSessionEndedLockout);
}

// P1-3: Realtime subscriptions for CHECK_UPDATED, SESSION_ENDED, TABLE_ACTIVATED
{
  check("P1-3: Diner Realtime channel subscribes to CHECK_UPDATED",
    publicMenu.includes(".on('broadcast', { event: 'CHECK_UPDATED' }")
  );
  check("P1-3: Diner Realtime channel subscribes to SESSION_ENDED",
    publicMenu.includes(".on('broadcast', { event: 'SESSION_ENDED' }")
  );
  check("P1-3: Diner Realtime channel subscribes to TABLE_ACTIVATED",
    publicMenu.includes(".on('broadcast', { event: 'TABLE_ACTIVATED' }")
  );
}

// P1-4: Staff PIN brute force TOCTOU race condition
{
  check("P1-4: record_staff_login_attempt in SQL acquires row lock with FOR UPDATE",
    migAuditFixes.includes("select * into v_staff\n    from public.staff\n   where id = p_staff_id and tenant_id = p_tenant\n   for update;")
  );
  check("P1-4: staff Edge Function delegates failed/success attempts to atomic record_staff_login_attempt RPC",
    staffFn.includes('.rpc("record_staff_login_attempt"')
  );
  check("P1-4: legacy src/lib/staff-auth.ts adapter is removed",
    !existsSync("src/lib/staff-auth.ts")
  );
}

// P1-5: Payment tender mutation on retried finalize
{
  const callsSettleCashWhenZeroDue = sessionPaymentDlg.includes("if (totals.outstanding <= 0 && (invoiceNumber || totals.total > 0)) {\n        const settleRes = await edgeFetch('/api/bill/settle-cash'");
  const callsFinalizeWhenZeroDue = sessionPaymentDlg.includes("if (totals.outstanding <= 0 && (invoiceNumber || totals.total > 0)) {\n        const settleRes = await edgeFetch('/api/bill/finalize'");

  check("P1-5: Retrying payment dialog when outstanding <= 0 calls /api/bill/finalize directly", callsFinalizeWhenZeroDue);
  check("P1-5: Retrying payment dialog does not divert card/UPI to /api/bill/settle-cash", !callsSettleCashWhenZeroDue);
}

// P1-6: Restaurant-wide table session termination risk
{
  check("P1-6: endTableSession in orders Edge Function has guard (!sessionId && !tableId)",
    ordersFn.includes("async function endTableSession(tenantId: string, tableId?: string, sessionId?: string) {\n  if (!sessionId && !tableId) return;")
  );
  check("P1-6: legacy src/lib/table-session.ts adapter is removed",
    !existsSync("src/lib/table-session.ts")
  );
}

console.log("\n── P2 Findings (Medium / Data Integrity / UI) ──");

// P2-1: Order recalculation totals clamp & check synchronization
{
  check("P2-1: recalcOrderTotals clamps discount to itemsTotal",
    ordersFn.includes("const discount = Math.min(rawDiscount, itemsTotal);")
  );
  check("P2-1: recalcOrderTotals clamps taxable amount to at least 0",
    ordersFn.includes("const taxable = Math.max(0, itemsTotal - discount);")
  );
  check("P2-1: recalcOrderTotals synchronizes table_checks totals if check_id exists",
    ordersFn.includes("if (order.check_id) {") &&
    ordersFn.includes('.from("table_checks")\n        .update({')
  );
}

// P2-2: Table availability state in frontend data context
{
  check("P2-2: data-context derives table OCCUPIED status by checking if ANY active order remains",
    dataContext.includes("const hasActiveOrders = nextOrders.some(") &&
    dataContext.includes("o.tableId === order.tableId &&") &&
    dataContext.includes("o.status !== 'COMPLETED' &&") &&
    dataContext.includes("o.status !== 'CANCELLED' &&") &&
    dataContext.includes("o.status !== 'REJECTED'")
  );
}

// P2-3: Active-only multi-diner counting in orders view
{
  check("P2-3: orders.tsx filters tableSittingCounts to active sittings only",
    ordersView.includes("if (s.tableId && s.state === 'Active') {")
  );
  check("P2-3: orders.tsx filters multiSittingTables to active sittings only",
    ordersView.includes(".filter((s) => s.tableId && s.state === 'Active' && (tableSittingCounts.get(s.tableId) ?? 0) > 1)")
  );
}

// P2-4: 1-Paisa GST tax rounding discrepancy
{
  check("P2-4: bill/index.ts ensures cgstAmount + sgstAmount strictly equals tax",
    billFn.includes("const cgstAmount = +(tax / 2).toFixed(2);") &&
    billFn.includes("const sgstAmount = +(tax - cgstAmount).toFixed(2);")
  );
}

console.log("\n── P3 Findings (Low / Compliance / Audit) ──");

// P3-1: Legal compliance in printed bill (no fake defaults)
{
  const hasAaravMehta = billDlg.includes("servedBy: 'Aarav Mehta'");
  const hasFakeConnaught = billDlg.includes("'Connaught Place, New Delhi, India'");
  const hasFakeGSTIN = billDlg.includes("'07AABCT2345K1Z8'");
  const hasFakeFSSAI = billDlg.includes("'13324001000123'");

  check("P3-1: bill-dialog does not hardcode fake waiter 'Aarav Mehta'", !hasAaravMehta);
  check("P3-1: bill-dialog does not hardcode fake address 'Connaught Place'", !hasFakeConnaught);
  check("P3-1: bill-dialog does not hardcode fake GSTIN '07AABCT2345K1Z8'", !hasFakeGSTIN);
  check("P3-1: bill-dialog does not hardcode fake FSSAI '13324001000123'", !hasFakeFSSAI);
  check("P3-1: bill-dialog correctly falls back to doc/tenant metadata or null",
    billDlg.includes("servedBy: doc.servedBy || primary?.servedBy || primary?.serverName || primary?.staffName || null") &&
    billDlg.includes("gstin: tenant.gstin || doc.gstin || null") &&
    billDlg.includes("fssai: tenant.fssai || doc.fssai || null")
  );
}

// P3-2: Cashier attribution in check settlement audit trail
{
  const recordCheckPassesActor = billFn.includes('p_actor: g.session.subjectId ?? null') &&
    !billFn.includes('p_actor: g.session.kind === "owner" ? g.session.subjectId : null');
  
  check("P3-2: bill/index.ts passes g.session.subjectId for record_check_payment",
    recordCheckPassesActor
  );
  check("P3-2: bill/index.ts passes g.session.subjectId for finalize_table_check and settle_check_cash_tx",
    billFn.includes('const { data: result, error } = await admin().rpc("finalize_table_check", {\n    p_tenant: g.session.tenantId,\n    p_check: data.check.id,\n    p_actor: g.session.subjectId ?? null,\n  });') &&
    billFn.includes('const { data: result, error } = await admin().rpc("settle_check_cash_tx", {\n    p_tenant: g.session.tenantId,\n    p_check: data.check.id,\n    p_actor: g.session.subjectId ?? null,')
  );
  check("P3-2: canonical migration handles both profile and staff actors in settle_check_cash_tx & record_check_payment",
    migAuditFixes.includes("select exists (select 1 from public.profiles where id = p_actor) into v_is_profile;") &&
    migAuditFixes.includes("select exists (select 1 from public.staff where id = p_actor) into v_is_staff;") &&
    migAuditFixes.includes("insert into public.security_logs")
  );
}

console.log("\n=======================================================");
console.log(`  SUMMARY: ${pass} PASSED, ${fail} FAILED`);
console.log("=======================================================\n");

if (fail > 0) {
  process.exit(1);
}
