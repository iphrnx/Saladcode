/**
 * The diner QR flow, end to end against the live database.
 *
 * This is the regression test for a bug that took the whole ordering path
 * down: a tracking trigger added in migration 0021 read a column that three
 * of the four tables it was attached to do not have, so every insert into
 * table_sessions raised and no diner session could ever be created. Every
 * scan landed on "Menu access requires a table session" and nothing in the
 * platform recorded an order.
 *
 * For each table it checks that a scan mints a session, that the session
 * validates, that the tenant and table in the response are the ones the QR
 * belongs to, and that ending a session really does end it.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
 *   SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/test-qr-flow.mts
 */
import { createClient } from "@supabase/supabase-js";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}

const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const { data: tables } = await admin
  .from("tables")
  .select("id, name, qr_token, active, tenant_id, tenants!inner(slug, active)")
  .order("created_at", { ascending: false })
  .limit(6);

if (!tables?.length) {
  console.log("no tables to test against");
  process.exit(0);
}

for (const t of tables) {
  const tenant: any = t.tenants;
  const label = `${tenant?.slug} / ${t.name}`;

  const start = await call("table-session", {
    method: "POST",
    body: JSON.stringify({ qrToken: t.qr_token }),
  });
  check(`${label} — a scan mints a session`, start.status, 201);
  if (start.status !== 201) {
    console.log(`        ${JSON.stringify(start.body).slice(0, 200)}`);
    continue;
  }

  const token = start.body.sessionToken;
  check(`${label} — the session is for this table`, start.body.table?.id, t.id);
  check(`${label} — the session is for this restaurant`, start.body.tenant?.id, t.tenant_id);
  check(`${label} — the session starts ACTIVE`, start.body.status, "ACTIVE");

  const validate = await call(
    `table-session/validate?tenantId=${encodeURIComponent(t.tenant_id)}` +
      `&tableId=${encodeURIComponent(t.id)}` +
      `&sessionToken=${encodeURIComponent(token)}`,
  );
  check(`${label} — the session validates`, validate.status, 200);
  check(`${label} — the menu payload comes back`, validate.body?.sessionStatus, "ACTIVE");
  check(
    `${label} — the menu is the right restaurant's`,
    validate.body?.tenant?.id,
    t.tenant_id,
  );
  check(
    `${label} — the menu is the right table's`,
    validate.body?.table?.id,
    t.id,
  );

  // A session that has been ended must not come back.
  await admin
    .from("table_sessions")
    .update({ status: "ENDED", ended_at: new Date().toISOString() })
    .eq("token", token);

  const afterEnd = await call(
    `table-session/validate?tenantId=${encodeURIComponent(t.tenant_id)}` +
      `&tableId=${encodeURIComponent(t.id)}` +
      `&sessionToken=${encodeURIComponent(token)}`,
  );
  check(`${label} — an ended session stays ended`, afterEnd.status, 403);
  check(
    `${label} — the refusal says so`,
    afterEnd.body?.sessionStatus,
    "INVALID",
  );

  // A session for one table must not open another table's menu.
  const other = tables.find((x: any) => x.id !== t.id);
  if (other) {
    const wrongTable = await call(
      `table-session/validate?tenantId=${encodeURIComponent(t.tenant_id)}` +
        `&tableId=${encodeURIComponent(other.id)}` +
        `&sessionToken=${encodeURIComponent(token)}`,
    );
    check(`${label} — a session cannot open another table`, wrongTable.status, 403);
  }

  // Clean up.
  await admin.from("table_sessions").delete().eq("token", token);
}

console.log("\n── an invalid QR token is refused ──");
{
  const r = await call("table-session", {
    method: "POST",
    body: JSON.stringify({ qrToken: "not-a-real-token" }),
  });
  check("a bad token is refused", r.status, 404);
  check("the refusal explains itself", r.body?.error, "Invalid QR code. Please scan the QR code on your table.");
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
