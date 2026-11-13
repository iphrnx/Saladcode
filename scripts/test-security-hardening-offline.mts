/**
 * The production-hardening list, checked against the code.
 *
 *   npm run test:security-hardening
 */
import { existsSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`);
};
const read = (p: string) => {
  if (existsSync(p)) return readFileSync(p, "utf8");
  const fallback = p.replace("supabase/migrations/", "supabase/legacy_migrations_archive/");
  return readFileSync(fallback, "utf8");
};

const mig = read("supabase/migrations/0080_rate_limits_and_audit.sql");
const limiter = read("supabase/functions/_shared/rate-limit.ts");
const session = read("supabase/functions/table-session/index.ts");
const orders = read("supabase/functions/orders/index.ts");
const bill = read("supabase/functions/bill/index.ts");

console.log("\n── anonymous paths are rate limited ──");
{
  check("the counter lives in the database, not in an isolate",
    /create table if not exists public\.rate_limits/.test(mig));
  check("the RPC is service-role only",
    /revoke execute on function public\.rate_limit_hit\(text, integer, integer\) from public, anon, authenticated/.test(mig));
  check("it counts atomically in one statement", /on conflict \(bucket\) do update/.test(mig));
  check("old buckets are pruned", /prune_rate_limits/.test(mig));
  check("session minting is limited per client and per table",
    /session:ip/.test(session) && /session:qr/.test(session));
  check("…and answers 429, not 400", /429/.test(session) && /Too many scans/.test(session));
  check("diner ordering is limited per session", /order:session/.test(orders));
  check("the limiter fails open rather than closed",
    /return \{ allowed: true \}/.test(limiter) && /Fails OPEN/.test(limiter));
  check("buckets are hashed, not raw IPs or tokens", /crypto\.subtle\.digest/.test(limiter));
}

console.log("\n── money movements are audited ──");
{
  check("taking cash", /CHECK_PAYMENT"/.test(bill));
  check("reversing it", /CHECK_PAYMENT_REVERSED/.test(bill));
  check("invoicing the bill", /CHECK_FINALISED/.test(bill));
  check("with the actor and the amount", /amount\} (\$\{method\}|CASH) on check/.test(bill));
  check("audit failures never fail the operation", /\.catch\(\(\) => \{\}\)/.test(bill));
}

console.log("\n── RBAC holds where the money is ──");
{
  const perms = read("supabase/functions/_shared/permissions.ts");
  const kitchen = perms.slice(perms.indexOf('name: "Kitchen"'), perms.indexOf('name: "Waiter"'));
  const waiter = perms.slice(perms.indexOf('name: "Waiter"'));
  check("Kitchen cannot collect payments", !/payments\.collect/.test(kitchen));
  check("Kitchen cannot manage tables", !/table-sessions\.manage/.test(kitchen));
  check("Waiter cannot collect or refund", !/payments\.(collect|refund)/.test(waiter));
  check("Waiter cannot complete or cancel", !/orders\.(complete|cancel)/.test(waiter));
  check("collecting money needs its own key", /permission: "payments\.collect"/.test(bill));
  check("refunding needs a different one", /permission: "payments\.refund"/.test(bill));
  check("accepting a held order needs the floor key, not the kitchen's",
    /async function acceptHeldOrder[\s\S]{0,200}table-sessions\.manage/.test(orders));
  check("rejecting one does too", /async function rejectHeldOrder[\s\S]{0,200}table-sessions\.manage/.test(orders));
  check("the kitchen cannot accept or reject held orders by starting to cook",
    /case 'PENDING_ACTIVATION':\s*\n\s*return null/.test(read("src/components/views/orders.tsx")));
}

console.log("\n── no false success in the UI ──");
{
  const dialog = read("src/components/shared/table-check-dialog.tsx");
  check("settle is disabled until the balance is zero", /outstanding <= 0/.test(dialog));
  check("the server refuses an unpaid settle regardless", /UNPAID:/.test(read("supabase/migrations/0078_check_sitting_binding.sql")));
  check("a failed payment is reported, not swallowed", /toast\.error/.test(dialog));
}

console.log("\n── a finalised invoice cannot be changed ──");
{
  const imm = read("supabase/migrations/0082_invoice_immutability.sql");
  check("the database refuses an edit to a PAID check", /guard_finalised_check/.test(imm));
  check("…including its total, tax, number and status", /new\.total is distinct from old\.total/.test(imm) && /new\.invoice_number is distinct from old\.invoice_number/.test(imm));
  check("…and refuses deleting it", /cannot be deleted/.test(imm));
  check("payments on an invoiced bill are frozen too", /guard_finalised_payment/.test(imm));
  check("the trigger is on the table, not on one code path", /create trigger table_checks_finalised_immutable/.test(imm));
}

console.log("\n── refunds are itemised ──");
{
  const bill = read("supabase/functions/bill/index.ts");
  const dialog = read("src/components/shared/table-check-dialog.tsx");
  const diner = read("src/components/shared/bill-dialog.tsx");
  check("the check returns what was refunded", /refunded: refundedTotal/.test(bill));
  check("voided payments are listed, not hidden", /status === "VOID"/.test(bill));
  check("the POS bill shows a refunded line", /Refunded/.test(dialog));
  check("the diner's bill does too", /refundedTotal/.test(diner));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
