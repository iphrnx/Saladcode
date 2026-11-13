/**
 * Smart table activation, checked without a database.
 *
 * The rules that matter here are the ones an implementer can get wrong
 * silently: a held order reaching the kitchen, a held order counting as money,
 * an approval that releases a price nobody agreed, an approval applied twice,
 * and a scan that needs staff before a menu opens.
 *
 *   npm run test:table-activation
 */
import { existsSync, readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};
const read = (p: string) => {
  if (existsSync(p)) return readFileSync(p, "utf8");
  const fallback = p.replace("supabase/migrations/", "supabase/legacy_migrations_archive/");
  return readFileSync(fallback, "utf8");
};

const mig = read("supabase/migrations/0076_smart_table_activation.sql");

console.log("\n── a scan opens the menu, not a queue for staff ──");
{
  check("the scan still creates a session", /insert into public\.table_sessions/.test(mig));
  check("…born PENDING when the table is not yet open",
    /case when v_open then 'ACTIVE' else 'PENDING' end/.test(mig));
  check("…and ACTIVE when a sitting is already open",
    /activation_status = 'ACTIVE'[\s\S]{0,120}v_open/.test(mig) || /s\.activation_status = 'ACTIVE'/.test(mig));
  check("the four states are constrained",
    /check \(activation_status in \('ACTIVE', 'PENDING', 'REJECTED', 'EXPIRED'\)\)/.test(mig));
}

console.log("\n── a held order is not kitchen work ──");
{
  check("the held state exists", /PENDING_ACTIVATION/.test(mig));
  check("create_order_tx refuses any other starting status",
    /p_status not in \('PENDING', 'PENDING_ACTIVATION'\)/.test(mig));
  check("…and writes the status it is given, not a literal",
    /\n    p_status,\n/.test(mig) && !/order_type', 'DINE_IN'\),\s*\n\s*'PENDING',/.test(mig));

  const ordersView = read("src/components/views/orders.tsx");
  check("a held order is labelled Awaiting Acceptance",
    /PENDING_ACTIVATION'[\s\S]{0,90}Awaiting Acceptance/.test(read("src/components/shared/badges.tsx")));
  check("a held order offers no forward transition",
    /case 'PENDING_ACTIVATION':\s*\n\s*return null/.test(ordersView));
  check("…it offers Accept and Reject instead",
    /onAccept|Accept</.test(ordersView) && /onReject|Reject</.test(ordersView));

  const orders = read("supabase/functions/orders/index.ts");
  check("the server has a dedicated order-level accept",
    /async function acceptHeldOrder/.test(orders));
  check("…which runs the same table-wide RPC as the POS Accept button",
    /acceptHeldOrder[\s\S]{0,1800}approve_table_activation/.test(orders));
  check("…leaves the order Pending, not Preparing",
    /already: false, status: order\?\.status \?\? "PENDING"/.test(orders));
  check("…needs the floor key", /acceptHeldOrder[\s\S]{0,160}table-sessions\.manage/.test(orders));
  check("and a dedicated reject, scoped to one order",
    /async function rejectHeldOrder/.test(orders) && /ORDER_REJECTED/.test(orders));
  check("rejecting only touches a held order",
    /current\.status !== "PENDING_ACTIVATION"[\s\S]{0,300}already_accepted/.test(orders));

  const bill = read("supabase/functions/bill/index.ts");
  check("a held order is never a bill", /status === "PENDING_ACTIVATION"/.test(bill) && /409/.test(bill));

  const session = read("supabase/functions/table-session/index.ts");
  check("nor is it the session's latest billable order",
    /\.neq\("status", "PENDING_ACTIVATION"\)/.test(session));

  const analytics = read("supabase/functions/analytics/index.ts");
  check("revenue only counts COMPLETED orders", /\.eq\("status", "COMPLETED"\)/.test(analytics));
}

console.log("\n── approval is atomic, idempotent and re-validated ──");
{
  check("the session row is locked for the whole decision",
    /from public\.table_sessions\s+where id = p_session and tenant_id = p_tenant\s+for update/.test(mig));
  check("approving twice reports, and releases nothing twice",
    /activation_status = 'ACTIVE' then[\s\S]{0,400}'already', true/.test(mig));
  check("a dish that vanished blocks the approval",
    /mi\.id is null or mi\.tenant_id <> p_tenant or mi\.available = false/.test(mig));
  check("…and names the dishes", /ITEMS_UNAVAILABLE:/.test(mig));
  check("activation and release happen inside one function body",
    /function public\.approve_table_activation[\s\S]*update public\.table_sessions[\s\S]*update public\.orders[\s\S]*end;\n\$\$;/.test(mig));
  check("a second tenant cannot approve someone else's session",
    /where id = p_session and tenant_id = p_tenant/.test(mig));
  check("refusal cancels the held orders rather than leaving them",
    /set status = 'CANCELLED'[\s\S]{0,200}PENDING_ACTIVATION/.test(mig));
  check("expiry exists and is bounded", /expire_pending_activations\(p_after interval default '15 minutes'\)/.test(mig));
  check("every definer function is revoked from anon",
    (mig.match(/revoke execute on function public\.(approve|refuse)_table_activation/g) ?? []).length === 2);
}

console.log("\n── several diners, one table ──");
{
  check("accepting is a decision about the table, not one browser",
    /table_id = v_table[\s\S]{0,80}activation_status = 'PENDING'/.test(mig));
  check("…so every pending session on it is activated together",
    /update public\.table_sessions[\s\S]{0,200}and table_id = v_table[\s\S]{0,120}activation_status = 'PENDING'/.test(mig));
  check("…and every held order on the table is released",
    /from public\.table_sessions s[\s\S]{0,160}s\.table_id = v_table[\s\S]{0,80}o\.status = 'PENDING_ACTIVATION'/.test(mig));
  check("a stale line anywhere on the table refuses the approval",
    /s\.table_id = v_table[\s\S]{0,200}mi\.available = false/.test(mig));
  check("expiry skips a session an approval already locked",
    /for update skip locked/.test(mig));
  check("expiry cancels the held orders rather than orphaning them",
    /function public\.expire_pending_activations[\s\S]*set status = 'CANCELLED'[\s\S]*activation_status = 'EXPIRED'/.test(mig));
}

console.log("\n── deployable before the migration, and after it ──");
{
  const orders = read("supabase/functions/orders/index.ts");
  check("the session lookup does not name a column the old schema lacks",
    /select\("\*, table:tables\(id, active\)"\)/.test(orders) && !/select\("[^"]*activation_status/.test(orders));
  check("the status argument is only sent when it is the new value",
    /args\.status === "PENDING_ACTIVATION" \? \{ p_status: "PENDING_ACTIVATION" \} : \{\}/.test(orders));

  check("the RPC keeps its old signature working",
    /p_idempotency_key uuid default null,\s*\n\s*p_status text default 'PENDING'/.test(mig));
  check("session minting is service-role only",
    /revoke execute on function public\.start_table_session\(text, text\) from public, anon, authenticated/.test(mig));
  check("the new functions are explicitly granted to service_role",
    (mig.match(/grant execute on function public\./g) ?? []).length >= 4);
}

console.log("\n── the server routes are guarded ──");
{
  const session = read("supabase/functions/table-session/index.ts");
  check("approve is routed", /route === "approve"/.test(session));
  check("refuse is routed", /route === "refuse"/.test(session));
  check("both require the floor write key",
    (session.match(/guard\(req, \{ permission: "table-sessions\.manage" \}\)/g) ?? []).length >= 3);
  check("accepting is audited", /TABLE_ACTIVATED/.test(session));
  check("declining is audited", /TABLE_ACTIVATION_REFUSED/.test(session));
  check("a stale cart is surfaced, not swallowed", /items_unavailable/.test(session));
  check("closing a table over an outstanding balance is audited",
    /TABLE_CLOSED_FORCED/.test(session) && /TABLE_CLOSED"/.test(session));
  check("the override is a deliberate flag, not the default",
    /const force = b\.force === true/.test(session));
}

console.log("\n── and the clients say the right thing ──");
{
  const menu = read("src/components/public/public-menu.tsx");
  check("the diner reads the activation state", /activationStatus/.test(menu));
  check("a held order shows a waiting state", /pendingActivation/.test(menu));
  check("…that is non-blocking", /data-awaiting-activation/.test(menu) && /role="status"/.test(menu));
  check("…and clears itself when the table is accepted",
    /prev === 'PENDING' && next === 'ACTIVE'/.test(menu));

  const dash = read("src/components/views/dashboard.tsx");
  check("the POS shows an unaccepted table", /activationStatus === 'PENDING'/.test(dash));
  check("…with accept and decline", /activateTable\(pending\.id, true/.test(dash) && /activateTable\(pending\.id, false/.test(dash));
  check("…gated on the floor permission", /!canEndSessions/.test(dash));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
