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
  : "supabase/migrations/20261113000000_baseline_schema.sql";
const mig = [
  readFileSync(migPath, "utf8"),
  existsSync("supabase/migrations/20261114000003_independent_diner_sessions.sql")
    ? readFileSync("supabase/migrations/20261114000003_independent_diner_sessions.sql", "utf8")
    : "",
  existsSync("supabase/migrations/20261117000001_production_schema_hardening.sql")
    ? readFileSync("supabase/migrations/20261117000001_production_schema_hardening.sql", "utf8")
    : "",
].join("\n");
const bill = readFileSync("supabase/functions/bill/index.ts", "utf8");
const dial = readFileSync("src/components/shared/table-check-dialog.tsx", "utf8");

console.log("\n── one open check per table ──");
{
  check("the database enforces it, not the caller",
    /create unique index if not exists table_checks_one_open_per_table[\s\S]{0,80}where status = 'OPEN'/.test(mig));
  check("opening a check survives a race",
    /pg_advisory_xact_lock/.test(mig) && (/on conflict \(table_id\) where status = 'OPEN' do nothing/.test(mig) || /for update/.test(mig)));
  check("orders carry their check", /check_id uuid references public\.table_checks/.test(mig));
  check("the order transaction stamps it", /v_check := public\.open_(?:table|session)_check\(v_tenant, v_table/.test(mig));
}

console.log("\n── totals are the orders, not a second calculation ──");
{
  check("the check sums orders rather than re-pricing them",
    /select coalesce\(sum\(total\), 0\) into v_total[\s\S]{0,120}where check_id = p_check/.test(mig));
  check("held orders never count", /PENDING_ACTIVATION/.test(mig) && /CANCELLED/.test(mig));
  check("the endpoint adds up the same rows and no tax of its own",
    /const tax = \+live\.reduce\(\(s: number, o: any\) => s \+ Number\(o\.tax\)/.test(bill));
  check("GST is shown as the CGST/SGST halves the orders were charged",
    /const gstTotalPaise = Math\.round\(tax \* 100\)[\s\S]{0,120}cgstPaise[\s\S]{0,120}sgstPaise[\s\S]{0,120}cgst/.test(bill));
}

console.log("\n── money cannot be double-taken ──");
{
  check("payments are keyed", /create unique index if not exists check_payments_idem_uidx[\s\S]{0,80}idempotency_key/.test(mig));
  check("a replay returns the original payment", /deduplicated', true, 'paymentId'/.test(mig));
  check("overpayment is refused", /OVERPAYMENT:/.test(mig));
  check("…and says what is still due", /is still due on this table/.test(bill));
  check("a paid check takes no more money", /v_check\.status <> 'OPEN'/.test(mig));
  check("the payment is recorded with the actor", /created_by, note\)|p_actor, p_note|v_profile_actor/.test(mig));
}

console.log("\n── the invoice is allocated exactly once ──");
{
  check("finalising locks the check", /for update;/.test(mig));
  check("a second finalise returns the same invoice",
    /if v_check\.status = 'PAID' then[\s\S]{0,160}'already', true/.test(mig));
  check("numbering is tenant-scoped", /check_invoice_counters[\s\S]{0,120}tenant_id/.test(mig));
  check("…and takes a row lock", /update public\.check_invoice_counters[\s\S]{0,120}returning last_seq/.test(mig));
  check("nothing is billed while food is still cooking", /ORDERS_OPEN:/.test(mig));
  check("an empty table cannot be invoiced", /NOTHING_TO_BILL/.test(mig));
  check("the counters table is service-role only",
    /alter table public\.check_invoice_counters enable row level security/.test(mig)
    && !/on public\.check_invoice_counters for/.test(mig));
}

console.log("\n── RBAC and isolation ──");
{
  check("reading the bill needs orders.view", /guard\(req, \{ permission: "orders\.view" \}\)/.test(bill));
  check("taking money needs payments.collect",
    (bill.match(/permission: "payments\.collect"/g) ?? []).length >= 2);
  check("every lookup is pinned to the caller's tenant",
    /\.eq\("tenant_id", tenantId\)/.test(bill) && /p_tenant: g\.session\.tenantId/.test(bill));
  check("the check is readable only by the restaurant's people",
    /alter table public\.table_checks enable row level security/.test(mig)
    && !/on public\.table_checks for select to anon/.test(mig));
  check("payments likewise",
    /alter table public\.check_payments enable row level security/.test(mig)
    && !/on public\.check_payments for select to anon/.test(mig));
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
