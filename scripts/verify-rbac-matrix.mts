/**
 * What every role can actually reach.
 *
 * The permission matrix is claimed in three places — the client's
 * `VIEW_PERMISSIONS`, the server's `guard()` calls, and the roles table — and
 * they are written by hand and can drift. This asks the running API instead:
 * it builds a restaurant, gives it one staff member per role, and calls every
 * endpoint as each of them, recording whether the answer was "allowed" or
 * "refused".
 *
 * It checks both directions, which is the part that matters:
 *
 *   * a role is not refused something it holds (the app would look broken), and
 *   * a role is not allowed something it does not hold (the app would be
 *     insecure) — this is the half that catches an over-grant, and it is the
 *     half a UI test cannot see.
 *
 * Two of the roles are custom, built with combinations no system role has, so
 * the check is not just re-reading the five seeded defaults.
 *
 *   npm run test:rbac-matrix
 */
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
// Point the suite at the local edge harness instead of the deployed functions,
// so a change can be verified before it ships:
//   RBAC_BASE_URL=http://127.0.0.1:8787 npm run test:rbac-matrix
const BASE = (process.env.RBAC_BASE_URL ?? SB).replace(/\/$/, "");
const admin = createClient(SB, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else {
    fail++;
    failures.push(label);
  }
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * Every endpoint a view calls, with the permission the server guards it by.
 *
 * `permission: null` means authenticated-but-ungated — bootstrap, which loads
 * the shell for every signed-in session. Writes carry an empty body on purpose:
 * a validation error still proves the guard let the request through, and it
 * cannot mutate anything.
 */
const PROBES: { label: string; method: string; path: string; permission: string | null; body?: unknown }[] = [
  { label: "bootstrap", method: "GET", path: "/api/bootstrap", permission: null },
  { label: "orders list", method: "GET", path: "/api/orders", permission: "orders.view" },
  { label: "orders sync", method: "GET", path: "/api/orders/sync", permission: "orders.view" },
  // The coarse orders.manage is split into one action per transition; each is
  // probed with its own key, against a non-existent order id — the gate fires
  // before the existence check, so a role without the key must get 403 while a
  // role with it gets past the guard (404 on the ghost order, which the matrix
  // reads as allowed).
  { label: "order prepare", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "orders.prepare", body: { status: "PREPARING" } },
  { label: "order ready", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "orders.ready", body: { status: "READY" } },
  { label: "order serve", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "orders.serve", body: { status: "SERVED" } },
  { label: "order complete", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "orders.complete", body: { status: "COMPLETED" } },
  { label: "order cancel", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "orders.cancel", body: { status: "CANCELLED" } },
  { label: "order collect payment", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "payments.collect", body: { paymentStatus: "PAID", paymentMethod: "CASH" } },
  { label: "order edit", method: "PATCH", path: "/api/orders/00000000-0000-0000-0000-000000000000", permission: "orders.edit", body: { tableId: "00000000-0000-0000-0000-000000000000" } },
  { label: "order create", method: "POST", path: "/api/orders", permission: "orders.create", body: {} },
  { label: "order items", method: "POST", path: "/api/orders/00000000-0000-0000-0000-000000000000/items", permission: "orders.edit", body: {} },
  { label: "menu list", method: "GET", path: "/api/menu", permission: "menu.view" },
  { label: "menu create", method: "POST", path: "/api/menu", permission: "menu.manage", body: {} },
  { label: "categories list", method: "GET", path: "/api/categories", permission: "menu.view" },
  { label: "categories create", method: "POST", path: "/api/categories", permission: "menu.manage", body: {} },
  { label: "tables list", method: "GET", path: "/api/tables", permission: "tables.view" },
  { label: "tables create", method: "POST", path: "/api/tables", permission: "tables.manage", body: {} },
  { label: "table sessions", method: "GET", path: "/api/table-session/active", permission: "tables.view" },
  { label: "end table session", method: "POST", path: "/api/table-session/end", permission: "table-sessions.manage", body: {} },
  { label: "qr list", method: "GET", path: "/api/qr", permission: "qr.manage" },
  { label: "promos list", method: "GET", path: "/api/promos", permission: "promos.view" },
  { label: "promos create", method: "POST", path: "/api/promos", permission: "promos.manage", body: {} },
  { label: "promo validate", method: "POST", path: "/api/promos/validate", permission: "orders.discount", body: {} },
  { label: "analytics", method: "GET", path: "/api/analytics", permission: "analytics.view" },
  { label: "reservations", method: "GET", path: "/api/reservations", permission: "tables.view" },
  { label: "reviews", method: "GET", path: "/api/reviews", permission: "settings.view" },
  { label: "roles list", method: "GET", path: "/api/roles", permission: "roles.view" },
  { label: "roles create", method: "POST", path: "/api/roles", permission: "roles.manage", body: {} },
  { label: "staff list", method: "GET", path: "/api/staff/manage", permission: "staff.view" },
  { label: "staff create", method: "POST", path: "/api/staff/manage", permission: "staff.manage", body: {} },
  { label: "security", method: "GET", path: "/api/security", permission: "security.view" },
  { label: "settings read", method: "GET", path: "/api/settings", permission: "settings.view" },
  { label: "settings write", method: "PUT", path: "/api/settings", permission: "settings.manage", body: {} },
  { label: "tenants list", method: "GET", path: "/api/tenants", permission: "settings.view" },
  { label: "subscriptions", method: "GET", path: "/api/subscriptions", permission: "settings.manage" },
];

/** Roles to build, on top of the seeded Owner. */
const CUSTOM_ROLES: { name: string; permissions: string[] }[] = [
  // A front-of-house role: can see the floor and the order book, cannot ring
  // anything up. No system role has this shape — the closest, Waiter, also
  // holds orders.manage — so it is the one that tests the write gates.
  { name: "Host", permissions: ["dashboard.view", "tables.view", "orders.view"] },
  // A read-only administrator: every *view* key that has a matching view, and
  // no manage key at all. This is the combination that catches an over-grant.
  {
    name: "Auditor",
    permissions: [
      "dashboard.view", "orders.view", "menu.view", "tables.view", "promos.view",
      "analytics.view", "settings.view", "security.view", "roles.view", "staff.view",
    ],
  },
];

const email = `rbac-matrix-${stamp}@example.com`;
let tenantId: string | null = null;
let ownerUserId: string | null = null;

type Session = { role: string; kind: "owner" | "staff"; token?: string; permissions: string[] };

try {
  // ---- a restaurant ---------------------------------------------------------
  //
  // Provisioned through the admin API rather than `auth/register`. Email
  // confirmation is on, and the sending domain is not verified yet, so a real
  // signup answers 429 — which would make this check unrunnable for a reason
  // that has nothing to do with permissions. The rows created here are the
  // rows register creates, from the same `DEFAULT_ROLES`.
  const password = "rbac-matrix-123456";
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: "RBAC Matrix" },
  });
  if (authError || !created?.user) throw new Error(`createUser: ${authError?.message}`);
  ownerUserId = created.user.id;

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: `RBAC Matrix ${stamp}`, slug: `rbac-matrix-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true })
    .select()
    .single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  tenantId = tenant.id;

  const { data: seeded, error: rolesError } = await admin
    .from("roles")
    .insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenant.id })))
    .select();
  if (rolesError) throw new Error(`roles: ${rolesError.message}`);

  const { error: profileError } = await admin.from("profiles").insert({
    id: ownerUserId,
    tenant_id: tenant.id,
    name: "RBAC Matrix",
    email,
    role: "OWNER",
    role_id: (seeded ?? []).find((r) => r.name === "Owner")?.id ?? null,
    active: true,
  });
  if (profileError) throw new Error(`profile: ${profileError.message}`);

  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await c.auth.signInWithPassword({ email, password });
  if (signInError || !signIn?.session) throw new Error(`signIn: ${signInError?.message}`);
  const ownerHeaders = { authorization: `Bearer ${signIn.session.access_token}` };

  const { data: roleRows } = await admin.from("roles").select("id, name, is_system, permissions").eq("tenant_id", tenantId);
  const systemRoles = new Map((roleRows ?? []).map((r) => [r.name, r]));

  // ---- the custom roles -----------------------------------------------------
  for (const spec of CUSTOM_ROLES) {
    const created = await call("roles", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: spec.name, permissions: spec.permissions.join(",") }),
    });
    check(`the custom role ${spec.name} was created`, created.status < 400, `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  }

  const { data: allRoles } = await admin.from("roles").select("id, name, is_system, permissions").eq("tenant_id", tenantId);
  const roleByName = new Map((allRoles ?? []).map((r) => [r.name, r]));

  // ---- one staff member per role -------------------------------------------
  const sessions: Session[] = [
    { role: "Owner", kind: "owner", permissions: (systemRoles.get("Owner")?.permissions ?? "").split(",").filter(Boolean) },
  ];

  const staffRoles = ["Manager", "Cashier", "Kitchen", "Waiter", ...CUSTOM_ROLES.map((r) => r.name)];
  for (const [i, name] of staffRoles.entries()) {
    const role = roleByName.get(name);
    if (!role) {
      check(`the ${name} role exists`, false);
      continue;
    }
    const employeeId = `M${String(stamp).slice(-5)}${i}`;
    const pin = `10${String(i).padStart(2, "0")}`;
    const created = await call("staff/manage", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: `${name} Tester`, employeeId, pin, roleId: role.id }),
    });
    check(`a ${name} staff member was created`, created.status < 400, `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
    if (created.status >= 400) continue;

    const login = await call("staff/login", { method: "POST", body: JSON.stringify({ tenantId, employeeId, pin }) });
    check(`${name} can sign in with a PIN`, login.status === 200 && Boolean(login.body?.token), `${login.status}`);
    if (login.status !== 200) continue;

    sessions.push({
      role: name,
      kind: "staff",
      token: login.body.token,
      permissions: String(role.permissions ?? "").split(",").map((p: string) => p.trim()).filter(Boolean),
    });
  }

  // ---- the matrix -----------------------------------------------------------
  console.log("\n  role        " + PROBES.map((p) => p.label.padEnd(0)).length);
  const header = ["endpoint".padEnd(18), ...sessions.map((s) => s.role.padEnd(9))].join(" ");
  console.log(`\n  ${header}`);
  console.log(`  ${"-".repeat(header.length)}`);

  for (const probe of PROBES) {
    const cells: string[] = [];
    for (const s of sessions) {
      const headers: Record<string, string> = s.token ? { "x-staff-session": s.token } : ownerHeaders;
      // `/api/...` is the client's name for the function; the gateway path is
      // the function name on its own. Getting this wrong answers 404 for every
      // probe, which reads as "allowed" — hence the guard below.
      const res = await call(probe.path.replace(/^\/api\//, ""), {
        method: probe.method,
        headers,
        ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
      });

      const expected = probe.permission === null || s.permissions.includes(probe.permission);
      const refused = res.status === 403;
      const unauth = res.status === 401;

      if (res.status === 404 && (res.body as any)?.code === "NOT_FOUND") {
        check(`${probe.label} reached its function`, false, `gateway 404 — the probe path is wrong`);
        cells.push("path!".padEnd(9));
        continue;
      }

      if (unauth) {
        check(`${s.role} was recognised on ${probe.label}`, false, `401 — the session was not accepted`);
        cells.push("401".padEnd(9));
        continue;
      }

      // The whole point: refused exactly when the role does not hold the key.
      if (expected && refused) {
        check(`${s.role} may reach ${probe.label} (${probe.permission})`, false, `403 — under-granted`);
        cells.push("403!".padEnd(9));
      } else if (!expected && !refused) {
        check(
          `${s.role} is refused ${probe.label} (${probe.permission})`,
          false,
          `${res.status} — OVER-GRANTED  ${JSON.stringify(res.body).slice(0, 140)}`,
        );
        cells.push(`${res.status}!`.padEnd(9));
      } else {
        pass++;
        cells.push((refused ? "deny" : "allow").padEnd(9));
      }
    }
    console.log(`  ${probe.label.padEnd(18)} ${cells.join(" ")}`);
  }
} catch (e) {
  check("the matrix ran", false, (e as Error).message);
} finally {
  if (tenantId) {
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId).eq("is_system", false);
    for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs"]) {
      await admin.from(t).delete().eq("tenant_id", tenantId);
    }
    await admin.from("profiles").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(() => {});
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
