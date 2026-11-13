/**
 * Real login tests, one per built-in role.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/test-roles-live.mts
 *
 * Creates five staff accounts on the demo tenant with a known PIN, signs each
 * in through the real endpoint, and checks both what the login returns and what
 * the endpoints actually allow — the difference between a permission list and
 * an enforced one. Everything it creates is deleted afterwards.
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "node:crypto";

const SB = "https://ygibmdkrslquamwflshb.supabase.co";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${l}${d && !ok ? `\n        ${d}` : ""}`);
};
const hashPin = (pin: string) => {
  const salt = randomBytes(16).toString("hex");
  return { hash: scryptSync(pin, salt, 64).toString("hex"), salt };
};

const { data: tenant } = await admin
  .from("tenants").select("id, name").eq("active", true).order("created_at").limit(1).maybeSingle();
const { data: roles } = await admin.from("roles").select("id, name").eq("tenant_id", tenant!.id);

const created: string[] = [];
const PIN = "4821";

async function login(employeeId: string) {
  const r = await fetch(`${SB}/functions/v1/staff/login`, {
    method: "POST",
    headers: { apikey: SERVICE, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: tenant!.id, employeeId, pin: PIN }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body, token: body?.token ?? null };
}

try {
  console.log(`\n── signing in as each role on "${tenant!.name}" ──`);
  const sessions: Record<string, any> = {};

  for (const roleName of ["Manager", "Cashier", "Kitchen", "Waiter"]) {
    const role = (roles ?? []).find((r) => r.name === roleName);
    if (!role) { check(`${roleName} role exists`, false); continue; }
    const { hash, salt } = hashPin(PIN);
    const employeeId = `TEST-${roleName.toUpperCase()}-${Date.now().toString().slice(-5)}`;
    const { data: staff } = await admin.from("staff").insert({
      tenant_id: tenant!.id, name: `Test ${roleName}`, employee_id: employeeId,
      role_id: role.id, pin_hash: hash, pin_salt: salt, active: true,
    }).select("id").single();
    created.push(staff!.id);

    const res = await login(employeeId);
    check(`${roleName} can sign in`, res.status === 200 || res.status === 201, `${res.status} ${res.body?.error ?? ""}`);
    // Permissions come from /staff/me — the login carries identity, not keys.
    const me = res.token
      ? await fetch(`${SB}/functions/v1/staff/me`, {
          headers: { apikey: SERVICE, "x-staff-session": res.token },
        }).then((r) => r.json().catch(() => null))
      : null;
    sessions[roleName] = { ...res, employeeId, permissions: me?.permissions ?? me?.staffPermissions ?? [] };
  }

  console.log("\n── the login returns that role's keys, not all of them ──");
  {
    const kitchen = sessions.Kitchen;
    check("Kitchen holds orders.prepare", (kitchen?.permissions ?? []).includes("orders.prepare"));
    check("Kitchen does not hold payments.collect", !(kitchen?.permissions ?? []).includes("payments.collect"));
    const waiter = sessions.Waiter;
    check("Waiter cannot complete orders", !(waiter?.permissions ?? []).includes("orders.complete"));
    const cashier = sessions.Cashier;
    check("Cashier can collect", (cashier?.permissions ?? []).includes("payments.collect"));
    check("Cashier cannot refund", !(cashier?.permissions ?? []).includes("payments.refund"));
  }

  console.log("\n── and the endpoints enforce it, not just the list ──");
  {
    const kitchenToken = sessions.Kitchen?.token;
    const pay = await fetch(`${SB}/functions/v1/bill/payment`, {
      method: "POST",
      headers: { apikey: SERVICE, "content-type": "application/json", "x-staff-session": kitchenToken ?? "" },
      body: JSON.stringify({ tableId: "00000000-0000-0000-0000-000000000000", amount: 10 }),
    });
    check("Kitchen is refused when taking money", pay.status === 401 || pay.status === 403, String(pay.status));

    const cashierToken = sessions.Cashier?.token;
    const refund = await fetch(`${SB}/functions/v1/bill/refund`, {
      method: "POST",
      headers: { apikey: SERVICE, "content-type": "application/json", "x-staff-session": cashierToken ?? "" },
      body: JSON.stringify({ paymentId: "00000000-0000-0000-0000-000000000000" }),
    });
    check("Cashier is refused a refund", refund.status === 401 || refund.status === 403, String(refund.status));

    const waiterToken = sessions.Waiter?.token;
    const close = await fetch(`${SB}/functions/v1/table-session/approve`, {
      method: "POST",
      headers: { apikey: SERVICE, "content-type": "application/json", "x-staff-session": waiterToken ?? "" },
      body: JSON.stringify({ sessionId: "00000000-0000-0000-0000-000000000000" }),
    });
    check("Waiter may accept a table (floor key), and gets a real answer", close.status !== 401 && close.status !== 403, String(close.status));
  }
} finally {
  for (const id of created) await admin.from("staff").delete().eq("id", id);
  await admin.from("staff_sessions").delete().eq("tenant_id", tenant!.id).like("staff_id", "%");
  console.log(`\ncleaned up ${created.length} test staff account(s)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
