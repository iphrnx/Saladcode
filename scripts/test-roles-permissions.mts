/**
 * Every built-in role, signed in for real, against the real endpoints.
 *
 * The permission matrix is asserted from the outside: log in with a staff PIN
 * as each role and call each module's API. A module the role holds must answer
 * (anything but 401/403); a module it does not hold must answer 403. That is the
 * layer that matters — the sidebar only decides what is on screen, and the API
 * decides what is allowed.
 *
 * It also checks the two things easily broken by a permission change: that the
 * defaults a new restaurant is seeded with are the ones intended, and that a
 * custom role keeps exactly the permissions the owner gave it.
 *
 *   npm run test:roles
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
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
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
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

/** Each module, the permission it needs, and the route the check calls. */
const MODULES: { key: string; label: string; path: string; permission: string }[] = [
  { key: "orders", label: "Orders", path: "orders", permission: "orders.view" },
  { key: "menu", label: "Menu", path: "menu", permission: "menu.view" },
  { key: "tables", label: "Tables", path: "tables", permission: "tables.view" },
  { key: "qr", label: "QR codes", path: "qr", permission: "qr.manage" },
  { key: "promos", label: "Promos", path: "promos", permission: "promos.view" },
  { key: "analytics", label: "Analytics", path: "analytics", permission: "analytics.view" },
  { key: "roles", label: "Roles", path: "roles", permission: "roles.view" },
  { key: "security", label: "Security", path: "security", permission: "security.view" },
  { key: "settings", label: "Settings", path: "settings", permission: "settings.view" },
  { key: "staff", label: "Staff", path: "staff/manage", permission: "staff.view" },
  { key: "billing", label: "Billing", path: "subscriptions", permission: "settings.manage" },
];

/** What each built-in role should hold, from the specification. */
const EXPECTED: Record<string, string[]> = {
  Owner: MODULES.map((m) => m.permission),
  Manager: ["orders.view", "menu.view", "tables.view", "qr.manage", "promos.view", "analytics.view", "staff.view"],
  Cashier: ["orders.view", "tables.view"],
  Kitchen: ["orders.view"],
  Waiter: ["orders.view", "tables.view"],
};

const CANONICAL: Record<string, string> = {
  Owner: "dashboard.view,orders.view,orders.create,orders.edit,orders.cancel,orders.complete,orders.prepare,orders.ready,orders.serve,orders.discount,payments.collect,payments.refund,menu.view,menu.manage,tables.view,tables.manage,table-sessions.manage,promos.view,promos.manage,analytics.view,qr.manage,settings.view,settings.manage,security.view,security.manage,roles.view,roles.manage,staff.view,staff.manage",
  Manager: "dashboard.view,orders.view,orders.create,orders.edit,orders.cancel,orders.complete,orders.prepare,orders.ready,orders.serve,orders.discount,payments.collect,payments.refund,menu.view,menu.manage,tables.view,tables.manage,table-sessions.manage,promos.view,promos.manage,analytics.view,qr.manage,staff.view,staff.manage",
  Cashier: "dashboard.view,orders.view,orders.create,orders.edit,orders.complete,orders.discount,payments.collect,tables.view,table-sessions.manage",
  Kitchen: "dashboard.view,orders.view,orders.prepare,orders.ready",
  Waiter: "dashboard.view,orders.view,orders.create,orders.edit,orders.serve,tables.view,table-sessions.manage",
};

const email = `roles-test-${stamp}@example.com`;
const password = "roles-test-123456";
let tenantId: string | null = null;

try {
  // ---- a brand new restaurant --------------------------------------------
  //
  // Provisioned through the admin API rather than `auth/register`. Email
  // confirmation is on and the sending domain is not verified yet, so a real
  // signup answers 429 — which left this whole suite, the one that pins the
  // built-in role defaults, testing nothing at all. The rows written here are
  // the ones the register route writes, `DEFAULT_ROLES` included.
  console.log("\n── a new restaurant's seeded roles ──");
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name: "Roles Test" },
  });
  check("the restaurant's owner account was created", !createError && Boolean(created?.user), createError?.message ?? "");
  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: `Roles Test ${stamp}`, slug: `roles-test-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true })
    .select()
    .single();
  tenantId = tenant?.id ?? null;
  check("it created a tenant", Boolean(tenantId), tenantError?.message ?? "");
  const { data: seeded } = await admin
    .from("roles")
    .insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenantId })))
    .select();
  await admin.from("profiles").insert({
    id: created!.user!.id, tenant_id: tenantId, name: "Roles Test", email,
    role: "OWNER", role_id: (seeded ?? []).find((r) => r.name === "Owner")?.id ?? null, active: true,
  });

  const { data: roles } = await admin
    .from("roles")
    .select("id, name, permissions, is_system")
    .eq("tenant_id", tenantId!)
    .eq("is_system", true);
  const byName = new Map((roles ?? []).map((r: any) => [r.name, r]));
  for (const [name, expected] of Object.entries(CANONICAL)) {
    const row: any = byName.get(name);
    check(`the new ${name} role has the intended permissions`, row?.permissions === expected,
      row ? `${name}: ${row.permissions}` : `${name} missing`);
  }

  // ---- the owner, who is not a staff member ------------------------------
  // The Owner role cannot be assigned to a staff row — the staff route refuses
  // it outright — so there is no PIN to sign in with. Its access is checked
  // through the owner's own session, and the refusal is checked as well,
  // because it is the protection that keeps an owner from being handed out.
  console.log("\n── the owner's own session ──");
  const { data: ownerLink } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const ownerClient = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: ownerSession } = await ownerClient.auth.verifyOtp({
    token_hash: ownerLink!.properties.hashed_token,
    type: "magiclink",
  });
  const ownerHeaders = { authorization: `Bearer ${ownerSession?.session?.access_token}` };
  const ownerBoot = await call("bootstrap", { headers: ownerHeaders });
  const ownerHeld: string[] = ownerBoot.body?.permissions ?? [];
  for (const m of MODULES) {
    check(`the owner may open ${m.label}`, ownerHeld.includes(m.permission), JSON.stringify(ownerHeld));
  }
  const ownerAsStaff = await call("staff/manage", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ name: "Owner Tester", employeeId: `OWN${stamp.toString().slice(-6)}`, pin: "1234", roleId: byName.get("Owner")!.id }),
  });
  check("the Owner role cannot be handed to a staff member", ownerAsStaff.status === 400,
    `${ownerAsStaff.status} ${JSON.stringify(ownerAsStaff.body).slice(0, 140)}`);

  // ---- sign in as each role and try every module -------------------------
  for (const roleName of Object.keys(CANONICAL).filter((n) => n !== "Owner")) {
    console.log(`\n── signed in as ${roleName} ──`);
    const role: any = byName.get(roleName);
    const employeeId = `R${stamp.toString().slice(-6)}${roleName.slice(0, 2).toUpperCase()}`;

    // Create the staff member as the owner would, straight in the database, so
    // this test is about permissions and not about the staff form.
    const { data: staffRow, error: staffErr } = await admin
      .from("staff")
      .insert({
        tenant_id: tenantId!,
        name: `${roleName} Tester`,
        employee_id: employeeId,
        role_id: role.id,
        pin_hash: "x",
        pin_salt: "x",
        active: true,
      })
      .select()
      .single();
    if (staffErr) {
      check(`${roleName}: a staff member could be created`, false, staffErr.message);
      continue;
    }
    // The PIN hashing lives in the edge function; set it through the real route
    // so the login below is a real staff login.
    const { error: pinErr } = await admin
      .from("staff")
      .update({ employee_id: employeeId })
      .eq("id", staffRow.id);
    if (pinErr) check(`${roleName}: staff row ready`, false, pinErr.message);

    // Hash a known PIN the same way the function does, using the function's own
    // path: create it through /staff/manage with a temporary owner session.
    const ownerToken = ownerSession?.session?.access_token;

    await admin.from("staff").delete().eq("id", staffRow.id);
    const created = await call("staff/manage", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: `${roleName} Tester`, employeeId, pin: "1234", roleId: role.id }),
    });
    check(`${roleName}: the staff member could be created`, created.status < 400,
      `${created.status} ${JSON.stringify(created.body).slice(0, 140)}`);

    const login = await call("staff/login", {
      method: "POST",
      body: JSON.stringify({ tenantId, employeeId, pin: "1234" }),
    });
    if (login.status !== 200 || !login.body?.token) {
      check(`${roleName}: signed in with a PIN`, false, `${login.status} ${JSON.stringify(login.body).slice(0, 160)}`);
      continue;
    }
    check(`${roleName}: signed in with a PIN`, true);
    const asStaff = { "x-staff-session": login.body.token as string };

    // What bootstrap says this role holds — this is what the sidebar filters on.
    const boot = await call("bootstrap", { headers: asStaff });
    const held: string[] = boot.body?.permissions ?? [];
    check(`${roleName}: bootstrap reports its permissions`, boot.status === 200 && Array.isArray(held),
      `${boot.status} ${JSON.stringify(boot.body).slice(0, 140)}`);
    check(`${roleName}: it can load the dashboard at all`, held.includes("dashboard.view"), JSON.stringify(held));

    for (const m of MODULES) {
      const allowed = EXPECTED[roleName].includes(m.permission);
      const res = await call(m.path, { headers: asStaff });
      if (allowed) {
        check(`${roleName} may open ${m.label}`, res.status !== 401 && res.status !== 403,
          `expected to be allowed, got ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      } else {
        check(`${roleName} is refused ${m.label}`, res.status === 403,
          `expected 403, got ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }

    // ---- the change survives signing out and back in ---------------------
    await call("staff/logout", { method: "POST", headers: asStaff });
    const again = await call("staff/login", {
      method: "POST",
      body: JSON.stringify({ tenantId, employeeId, pin: "1234" }),
    });
    const secondBoot = await call("bootstrap", { headers: { "x-staff-session": again.body?.token ?? "" } });
    check(`${roleName}: the same permissions after signing in again`,
      JSON.stringify(secondBoot.body?.permissions ?? []) === JSON.stringify(held),
      `${JSON.stringify(held)} vs ${JSON.stringify(secondBoot.body?.permissions)}`);
    const { data: after } = await admin.from("roles").select("permissions").eq("id", role.id).maybeSingle();
    check(`${roleName}: the stored role is unchanged by signing in`, after?.permissions === CANONICAL[roleName],
      String(after?.permissions));
  }

  // ---- a custom role keeps exactly what the owner gave it ----------------
  console.log("\n── a custom role the owner configured ──");
  const { data: custom } = await admin
    .from("roles")
    .insert({
      tenant_id: tenantId!,
      name: "Menu Reader",
      description: "Custom",
      permissions: "dashboard.view,menu.view",
      is_system: false,
    })
    .select()
    .single();
  const { data: link2 } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const c2 = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: session2 } = await c2.auth.verifyOtp({ token_hash: link2!.properties.hashed_token, type: "magiclink" });
  const ownerToken2 = session2?.session?.access_token;
  await call("staff/manage", {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken2}` },
    body: JSON.stringify({ name: "Menu Reader", employeeId: `MR${stamp.toString().slice(-6)}`, pin: "1234", roleId: custom!.id }),
  });
  const customLogin = await call("staff/login", {
    method: "POST",
    body: JSON.stringify({ tenantId, employeeId: `MR${stamp.toString().slice(-6)}`, pin: "1234" }),
  });
  const customHeaders = { "x-staff-session": customLogin.body?.token ?? "" };
  const customBoot = await call("bootstrap", { headers: customHeaders });
  check("a custom role's permissions are what the owner set",
    JSON.stringify(customBoot.body?.permissions ?? []) === JSON.stringify(["dashboard.view", "menu.view"]),
    JSON.stringify(customBoot.body?.permissions));
  const menuAsCustom = await call("menu", { headers: customHeaders });
  const ordersAsCustom = await call("orders", { headers: customHeaders });
  check("its holder can reach what it grants", menuAsCustom.status !== 403, `${menuAsCustom.status}`);
  check("and is refused what it does not", ordersAsCustom.status === 403, `${ordersAsCustom.status}`);
} catch (e) {
  check("the role checks ran", false, (e as Error).message);
} finally {
  if (tenantId) {
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId).eq("is_system", false);
    for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs"]) {
      await admin.from(t).delete().eq("tenant_id", tenantId);
    }
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  const { data: list } = await admin.auth.admin.listUsers();
  const u = list?.users?.find((x) => x.email === email);
  if (u) await admin.auth.admin.deleteUser(u.id).catch(() => {});
  const { data: left } = await admin.from("tenants").select("id").eq("id", tenantId ?? "00000000-0000-0000-0000-000000000000");
  check("the scratch restaurant was removed", (left ?? []).length === 0);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
