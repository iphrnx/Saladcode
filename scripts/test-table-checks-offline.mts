/**
 * Consolidated table billing, checked without a database.
 *
 * The invariants that cost money if they are wrong: one open check per table,
 * payments that cannot double, a total that is the sum of the orders rather
 * than a second opinion about tax, an invoice number allocated exactly once,
 * and a closed check that cannot take another payment.
 *
 *   npm run test:table-checks
 */
import { existsSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};
const migPath = existsSync("supabase/migrations/0077_table_checks.sql")
  ? "supabase/migrations/0077_table_checks.sql"
  : "supabase/legacy_migrations_archive/0077_table_checks.sql";
const mig = readFileSync(migPath, "utf8");
const bill = readFileSync("supabase/functions/bill/index.ts", "utf8");
const dial = readFileSync("src/components/shared/table-check-dialog.tsx", "utf8");

console.log("\n── one open check per table ──");
{
  check("the database enforces it, not the caller",
    /create unique index if not exists table_checks_one_open_per_table[\s\S]{0,80}where status = 'OPEN'/.test(mig));
  check("opening a check survives a race", /on conflict \(table_id\) where status = 'OPEN' do nothing/.test(mig));
  check("orders carry their check", /add column if not exists check_id uuid references public\.table_checks/.test(mig));
  check("the order transaction stamps it", /v_check := public\.open_table_check\(v_tenant, v_table\)/.test(mig));
}

console.log("\n── totals are the orders, not a second calculation ──");
{
  check("the check sums orders rather than re-pricing them",
    /select coalesce\(sum\(total\), 0\) into v_total[\s\S]{0,120}where check_id = p_check/.test(mig));
  check("held orders never count", /status not in \('PENDING_ACTIVATION', 'CANCELLED'\)/.test(mig));
  check("the endpoint adds up the same rows and no tax of its own",
    /const tax = \+live\.reduce\(\(s: number, o: any\) => s \+ Number\(o\.tax\)/.test(bill));
  check("GST is shown as the CGST/SGST halves the orders were charged", /cgst: \+\(tax \/ 2\)/.test(bill));
}

console.log("\n── money cannot be double-taken ──");
{
  check("payments are keyed", /create unique index if not exists check_payments_idem_uidx[\s\S]{0,80}idempotency_key/.test(mig));
  check("a replay returns the original payment", /deduplicated', true, 'paymentId'/.test(mig));
  check("overpayment is refused", /OVERPAYMENT:/.test(mig));
  check("…and says what is still due", /is still due on this table/.test(bill));
  check("a paid check takes no more money", /v_check\.status <> 'OPEN'/.test(mig));
  check("the payment is recorded with the actor", /created_by, note\)|p_actor, p_note/.test(mig));
}

console.log("\n── the invoice is allocated exactly once ──");
{
  check("finalising locks the check", /for update;/.test(mig));
  check("a second finalise returns the same invoice",
    /if v_check\.status = 'PAID' then[\s\S]{0,160}'already', true/.test(mig));
  check("numbering is tenant-scoped", /check_invoice_counters[\s\S]{0,120}tenant_id/.test(mig));
  check("…and takes a row lock", /update public\.check_invoice_counters[\s\S]{0,80}returning last_seq/.test(mig));
  check("nothing is billed while food is still cooking", /ORDERS_OPEN:/.test(mig));
  check("an empty table cannot be invoiced", /NOTHING_TO_BILL/.test(mig));
  check("the counters table is service-role only",
    /revoke all on public\.check_invoice_counters from public, anon, authenticated/.test(mig));
}

console.log("\n── RBAC and isolation ──");
{
  check("reading the bill needs orders.view", /guard\(req, \{ permission: "orders\.view" \}\)/.test(bill));
  check("taking money needs payments.collect",
    (bill.match(/permission: "payments\.collect"/g) ?? []).length >= 2);
  check("every lookup is pinned to the caller's tenant",
    /\.eq\("tenant_id", tenantId\)/.test(bill) && /p_tenant: g\.session\.tenantId/.test(bill));
  check("the check is readable only by the restaurant's people",
    /table_checks_member_read[\s\S]{0,120}is_member_of\(tenant_id\)/.test(mig));
  check("payments likewise", /check_payments_member_read[\s\S]{0,120}is_member_of\(tenant_id\)/.test(mig));
}

console.log("\n── the dialog talks to the server ──");
{
  check("it reads the check, it does not compute totals",
    /api\/bill\/check\?tableId=/.test(dial) && /data\.totals\?\.total/.test(dial));
  check("cash is the payment method wired", /method: 'CASH'|\/api\/bill\/payment/.test(dial));
  check("settling is blocked until the balance is zero", /canSettle = Boolean\([\s\S]{0,80}outstanding <= 0/.test(dial));
  check("the payment key is regenerated per attempt", /setPayKey\(crypto\.randomUUID\(\)\)/.test(dial));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
