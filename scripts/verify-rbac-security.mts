/**
 * The seven escalation routes, asked directly.
 *
 * The permission matrix (`verify-rbac-matrix.mts`) asks whether each role can
 * *reach* each endpoint. This asks the narrower and nastier question: can a
 * role reach past itself — hand itself a permission it was never given, take
 * over an account that outranks it, rewrite the role that defines an owner, or
 * read the guest book from the kitchen?
 *
 * Every probe is a real request against the running API, and each one states
 * the answer it expects. Run against code without the fixes, the escalations
 * come back 200/201 and the suite fails — which is what makes it evidence
 * rather than assertion.
 *
 *   RBAC_BASE_URL=http://127.0.0.1:8787 npm run test:rbac-security   # local harness
 *   npm run test:rbac-security                                       # deployed
 *
 * The local harness runs the *modified* function code without deploying it, so
 * this can be run before anything reaches production.
 */
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES, PERMISSION_KEYS } from "../supabase/functions/_shared/permissions.ts";

const SB = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
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
  const res = await fetch(`${BASE}/functions/v1/${path.replace(/^\/api\//, "")}`, {
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
 * Roles built for this suite.
 *
 * `Accountant` is the escalation target: it holds `settings.manage`, which
 * Manager does not, so a Manager reaching it is a Manager becoming more than a
 * Manager. `RoleAdmin` can manage roles but holds almost nothing, so it is the
 * caller that would use role-writing itself as the escalation.
 */
const CUSTOM_ROLES: { name: string; permissions: string[] }[] = [
  { name: "Accountant", permissions: ["dashboard.view", "orders.view", "settings.view", "settings.manage"] },
  { name: "RoleAdmin", permissions: ["dashboard.view", "roles.view", "roles.manage", "staff.view", "staff.manage"] },
];

const STAFF_ROLES = ["Manager", "Cashier", "Kitchen", "Waiter", ...CUSTOM_ROLES.map((r) => r.name)];

const email = `rbac-security-${stamp}@example.com`;
const limitedEmail = `rbac-security-limited-${stamp}@example.com`;
let tenantId: string | null = null;
let ownerUserId: string | null = null;
let limitedUserId: string | null = null;

type Session = {
  role: string;
  kind: "owner" | "staff";
  headers: Record<string, string>;
  staffId?: string;
  employeeId?: string;
  pin?: string;
  permissions: string[];
};

try {
  // ---- a restaurant ---------------------------------------------------------
  const password = "rbac-security-123456";
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: "RBAC Security" },
  });
  if (authError || !created?.user) throw new Error(`createUser: ${authError?.message}`);
  ownerUserId = created.user.id;

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: `RBAC Security ${stamp}`, slug: `rbac-security-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true })
    .select()
    .single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  tenantId = tenant.id;

  const { data: seeded, error: rolesError } = await admin
    .from("roles")
    .insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenant.id })))
    .select();
  if (rolesError) throw new Error(`roles: ${rolesError.message}`);

  const ownerRole = (seeded ?? []).find((r) => r.name === "Owner");
  const { error: profileError } = await admin.from("profiles").insert({
    id: ownerUserId,
    tenant_id: tenant.id,
    name: "RBAC Security",
    email,
    role: "OWNER",
    role_id: ownerRole?.id ?? null,
    active: true,
  });
  if (profileError) throw new Error(`profile: ${profileError.message}`);

  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await c.auth.signInWithPassword({ email, password });
  if (signInError || !signIn?.session) throw new Error(`signIn: ${signInError?.message}`);
  const ownerHeaders = { authorization: `Bearer ${signIn.session.access_token}` };

  // ---- the custom roles -----------------------------------------------------
  for (const spec of CUSTOM_ROLES) {
    const res = await call("roles", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: spec.name, permissions: spec.permissions.join(",") }),
    });
    check(`the ${spec.name} role was created`, res.status < 400, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  }

  const { data: allRoles } = await admin.from("roles").select("id, name, is_system, permissions").eq("tenant_id", tenantId);
  const roleByName = new Map((allRoles ?? []).map((r) => [r.name, r]));
  const roleId = (name: string) => roleByName.get(name)?.id as string;

  // ---- one staff member per role -------------------------------------------
  const sessions: Session[] = [
    { role: "Owner", kind: "owner", headers: ownerHeaders, permissions: String(ownerRole?.permissions ?? "").split(",").filter(Boolean) },
  ];

  for (const [i, name] of STAFF_ROLES.entries()) {
    const role = roleByName.get(name);
    if (!role) {
      check(`the ${name} role exists`, false);
      continue;
    }
    const employeeId = `S${String(stamp).slice(-5)}${i}`;
    const pin = `20${String(i).padStart(2, "0")}`;
    const createdStaff = await call("staff/manage", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: `${name} Tester`, employeeId, pin, roleId: role.id }),
    });
    check(`a ${name} staff member was created`, createdStaff.status < 400, `${createdStaff.status} ${JSON.stringify(createdStaff.body).slice(0, 160)}`);
    if (createdStaff.status >= 400) continue;

    const login = await call("staff/login", { method: "POST", body: JSON.stringify({ tenantId, employeeId, pin }) });
    check(`${name} can sign in with a PIN`, login.status === 200 && Boolean(login.body?.token), `${login.status}`);
    if (login.status !== 200) continue;

    sessions.push({
      role: name,
      kind: "staff",
      headers: { "x-staff-session": login.body.token },
      staffId: createdStaff.body?.id ?? createdStaff.body?.staff?.id,
      employeeId,
      pin,
      permissions: String(role.permissions ?? "").split(",").map((p: string) => p.trim()).filter(Boolean),
    });
  }

  const as = (role: string) => sessions.find((s) => s.role === role)!;

  /**
   * Sign a staff member in again.
   *
   * `guard()` re-reads the staff row and its role on every request, so the
   * moment a probe changes someone's role, that session's permissions change
   * with it — including on unfixed code, where the self-promotion *succeeds*
   * and quietly turns the Manager into an Accountant for every later probe.
   * Re-logging in after repairing the row keeps each probe testing what its
   * label claims.
   */
  const relogin = async (role: string) => {
    const s = as(role);
    if (!s.employeeId || !s.pin) return;
    const res = await call("staff/login", { method: "POST", body: JSON.stringify({ tenantId, employeeId: s.employeeId, pin: s.pin }) });
    if (res.status === 200 && res.body?.token) s.headers = { "x-staff-session": res.body.token };
  };

  // ---- an owner-kind profile with a limited role ---------------------------
  //
  // The shell hands an owner-kind session its permission list, and `guard()`
  // re-derives it from the profile's role. When those two disagree, the app
  // offers modules the API refuses. This profile is the disagreement.
  const { data: limitedUser, error: limitedError } = await admin.auth.admin.createUser({
    email: limitedEmail,
    password,
    email_confirm: true,
    user_metadata: { name: "Limited Owner" },
  });
  if (limitedError || !limitedUser?.user) throw new Error(`createUser(limited): ${limitedError?.message}`);
  limitedUserId = limitedUser.user.id;

  await admin.from("profiles").insert({
    id: limitedUserId,
    tenant_id: tenant.id,
    name: "Limited Owner",
    email: limitedEmail,
    role: "ACCOUNTANT",
    role_id: roleId("Accountant"),
    active: true,
  });

  const cl = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: limitedSignIn } = await cl.auth.signInWithPassword({ email: limitedEmail, password });
  const limitedHeaders = { authorization: `Bearer ${limitedSignIn!.session!.access_token}` };

  // =========================================================================
  // A. A staff member may not change their own role
  // =========================================================================
  console.log("\n  A. self role change");
  {
    const me = as("Manager");
    const res = await call(`staff/manage/${me.staffId}`, {
      method: "PATCH",
      headers: me.headers,
      body: JSON.stringify({ roleId: roleId("Accountant") }),
    });
    check("a Manager cannot promote themselves to a role holding settings.manage", res.status === 403, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);

    const { data: after } = await admin.from("staff").select("role_id").eq("id", me.staffId!).maybeSingle();
    check("the Manager's role is unchanged in the database", after?.role_id === roleId("Manager"), `role_id is ${after?.role_id}`);

    // Repair the row before probing further: on unfixed code the promotion went
    // through, and leaving it would make every later Manager probe answer 403
    // for the wrong reason.
    await admin.from("staff").update({ role_id: roleId("Manager") }).eq("id", me.staffId!);
    await relogin("Manager");

    const rename = await call(`staff/manage/${me.staffId}`, {
      method: "PATCH",
      headers: me.headers,
      body: JSON.stringify({ name: "Manager Tester" }),
    });
    check("a Manager can still edit their own name (only the role is refused)", rename.status === 200, `${rename.status} ${JSON.stringify(rename.body).slice(0, 160)}`);
  }

  // =========================================================================
  // B. Nobody may grant a permission they do not hold
  // =========================================================================
  console.log("\n  B. granting past yourself");
  {
    const mgr = as("Manager");
    const escalate = await call("staff/manage", {
      method: "POST",
      headers: mgr.headers,
      body: JSON.stringify({ name: "Escalated", employeeId: `E${String(stamp).slice(-5)}`, pin: "4321", roleId: roleId("Accountant") }),
    });
    check("a Manager cannot create a staff member holding settings.manage", escalate.status === 403, `${escalate.status} ${JSON.stringify(escalate.body).slice(0, 160)}`);

    const within = await call("staff/manage", {
      method: "POST",
      headers: mgr.headers,
      body: JSON.stringify({ name: "New Cashier", employeeId: `C${String(stamp).slice(-5)}`, pin: "4322", roleId: roleId("Cashier") }),
    });
    check("a Manager can still create staff in a role they outrank (Cashier)", within.status < 400, `${within.status} ${JSON.stringify(within.body).slice(0, 160)}`);

    const owner = await call("staff/manage", {
      method: "POST",
      headers: mgr.headers,
      body: JSON.stringify({ name: "Fake Owner", employeeId: `O${String(stamp).slice(-5)}`, pin: "4323", roleId: roleId("Owner") }),
    });
    check("a Manager still cannot create a staff member holding the Owner role", owner.status === 400, `${owner.status} ${JSON.stringify(owner.body).slice(0, 160)}`);

    const roleAdmin = as("RoleAdmin");
    const strong = await call("roles", {
      method: "POST",
      headers: roleAdmin.headers,
      body: JSON.stringify({ name: "Backdoor", permissions: "dashboard.view,settings.manage" }),
    });
    check("a role that can manage roles cannot write one holding settings.manage", strong.status === 403, `${strong.status} ${JSON.stringify(strong.body).slice(0, 160)}`);

    const weak = await call("roles", {
      method: "POST",
      headers: roleAdmin.headers,
      body: JSON.stringify({ name: "Junior Admin", permissions: "dashboard.view,staff.view" }),
    });
    check("a role that can manage roles can still write one inside its own set", weak.status < 400, `${weak.status} ${JSON.stringify(weak.body).slice(0, 160)}`);
  }

  // =========================================================================
  // C. An account that outranks you is out of your reach
  // =========================================================================
  console.log("\n  C. acting on a stronger account");
  {
    const mgr = as("Manager");
    const accountant = as("Accountant");

    const pin = await call(`staff/manage/${accountant.staffId}/reset-pin`, {
      method: "POST",
      headers: mgr.headers,
      body: JSON.stringify({ pin: "9999" }),
    });
    check("a Manager cannot reset the PIN of an account holding settings.manage", pin.status === 403, `${pin.status} ${JSON.stringify(pin.body).slice(0, 160)}`);

    const takeover = await call("staff/login", { method: "POST", body: JSON.stringify({ tenantId, employeeId: accountant.employeeId, pin: "9999" }) });
    check("the refused PIN reset does not sign in as the Accountant", takeover.status !== 200, `${takeover.status} — the stolen PIN worked`);

    const disable = await call(`staff/manage/${accountant.staffId}`, {
      method: "PATCH",
      headers: mgr.headers,
      body: JSON.stringify({ active: false }),
    });
    check("a Manager cannot disable an account that outranks them", disable.status === 403, `${disable.status} ${JSON.stringify(disable.body).slice(0, 160)}`);

    const del = await call(`staff/manage/${accountant.staffId}`, { method: "DELETE", headers: mgr.headers });
    check("a Manager cannot delete an account that outranks them", del.status === 403, `${del.status} ${JSON.stringify(del.body).slice(0, 160)}`);

    const cashier = as("Cashier");
    const lower = await call(`staff/manage/${cashier.staffId}`, {
      method: "PATCH",
      headers: mgr.headers,
      body: JSON.stringify({ active: false }),
    });
    check("a Manager can still disable a Cashier", lower.status === 200, `${lower.status} ${JSON.stringify(lower.body).slice(0, 160)}`);
    await admin.from("staff").update({ active: true }).eq("id", cashier.staffId!);
  }

  // =========================================================================
  // D. A built-in role is not editable
  // =========================================================================
  console.log("\n  D. system roles");
  {
    // Snapshot first. On unfixed code the regrant below *succeeds*, which
    // rewrites the Manager role out from under every later section — and a
    // suite whose probes corrupt each other's fixtures reports nonsense. The
    // snapshot is what makes the two runs comparable.
    const { data: before } = await admin.from("roles").select("name, permissions, description").eq("id", roleId("Manager")).maybeSingle();

    const regrant = await call(`roles?id=${roleId("Manager")}`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ permissions: "settings.manage,security.manage" }),
    });
    check("the Manager role's permissions cannot be rewritten", regrant.status === 400, `${regrant.status} ${JSON.stringify(regrant.body).slice(0, 160)}`);

    const { data: managerRole } = await admin.from("roles").select("permissions").eq("id", roleId("Manager")).maybeSingle();
    check("the Manager role's permissions are unchanged in the database", !String(managerRole?.permissions ?? "").includes("settings.manage"), `${managerRole?.permissions}`);

    const rename = await call(`roles?id=${roleId("Manager")}`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ name: "Boss" }),
    });
    check("the Manager role cannot be renamed", rename.status === 400, `${rename.status} ${JSON.stringify(rename.body).slice(0, 160)}`);

    const describe = await call(`roles?id=${roleId("Manager")}`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ description: "Runs the shift" }),
    });
    check("a system role's description is still editable", describe.status === 200, `${describe.status} ${JSON.stringify(describe.body).slice(0, 160)}`);

    const custom = await call(`roles?id=${roleId("Accountant")}`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ permissions: "dashboard.view,orders.view,settings.view,settings.manage,security.view" }),
    });
    check("a custom role's permissions are still editable by the owner", custom.status === 200, `${custom.status} ${JSON.stringify(custom.body).slice(0, 160)}`);
    // Put it back: section F asserts on this role's permission list, and a probe
    // that changes a fixture the next section reads is a probe that lies.
    await admin.from("roles").update({ permissions: CUSTOM_ROLES[0].permissions.join(",") }).eq("id", roleId("Accountant"));

    const del = await call(`roles?id=${roleId("Manager")}`, { method: "DELETE", headers: ownerHeaders });
    check("a system role still cannot be deleted", del.status === 400, `${del.status}`);

    if (before) {
      await admin.from("roles").update({ name: before.name, permissions: before.permissions, description: before.description }).eq("id", roleId("Manager"));
    }
  }

  // =========================================================================
  // E. Onboarding is the owner's flow
  // =========================================================================
  console.log("\n  E. owner verification on setup");
  {
    const kitchen = as("Kitchen");
    const manager = as("Manager");

    const draft = await call("onboarding/draft", { headers: kitchen.headers });
    check("Kitchen cannot read the onboarding draft", draft.status === 403, `${draft.status} ${JSON.stringify(draft.body).slice(0, 160)}`);

    const write = await call("onboarding/draft", {
      method: "PUT",
      headers: kitchen.headers,
      body: JSON.stringify({ draft: { step: 1, restaurant: { name: "Kitchen Kitchen" } } }),
    });
    check("Kitchen cannot write the onboarding draft", write.status === 403, `${write.status} ${JSON.stringify(write.body).slice(0, 160)}`);

    const complete = await call("onboarding/complete", {
      method: "POST",
      headers: kitchen.headers,
      body: JSON.stringify({ restaurant: { name: "Kitchen Kitchen" }, categories: [], menuItems: [], tables: [] }),
    });
    check("Kitchen cannot complete setup", complete.status === 403, `${complete.status} ${JSON.stringify(complete.body).slice(0, 160)}`);

    const { count: phantom } = await admin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("id", kitchen.staffId!);
    check("no profile row was created for the kitchen's staff id", (phantom ?? 0) === 0, `${phantom} phantom profile(s)`);

    const mgrDraft = await call("onboarding/draft", { headers: manager.headers });
    check("a Manager cannot read the onboarding draft either", mgrDraft.status === 403, `${mgrDraft.status}`);

    const ownerDraft = await call("onboarding/draft", { headers: ownerHeaders });
    check("the owner can still read the onboarding draft", ownerDraft.status === 200, `${ownerDraft.status} ${JSON.stringify(ownerDraft.body).slice(0, 160)}`);

    const ownerWrite = await call("onboarding/draft", {
      method: "PUT",
      headers: ownerHeaders,
      body: JSON.stringify({ draft: { step: 1, restaurant: { name: "RBAC Security Kitchen" } } }),
    });
    check("the owner can still write the onboarding draft", ownerWrite.status === 200, `${ownerWrite.status} ${JSON.stringify(ownerWrite.body).slice(0, 160)}`);
  }

  // =========================================================================
  // F. The shell tells the truth about what the caller may do
  // =========================================================================
  console.log("\n  F. bootstrap");
  {
    const owner = await call("bootstrap", { headers: ownerHeaders });
    check("the owner's shell reports every permission in the catalogue", Array.isArray(owner.body?.permissions) && owner.body.permissions.length === PERMISSION_KEYS.length, `${owner.body?.permissions?.length} keys`);

    const limited = await call("bootstrap", { headers: limitedHeaders });
    const reported = [...(limited.body?.permissions ?? [])].sort();
    const expected = [...CUSTOM_ROLES[0].permissions].sort();
    check(
      "an owner-kind profile with a limited role reports only that role's permissions",
      JSON.stringify(reported) === JSON.stringify(expected),
      `reported ${JSON.stringify(reported)} — expected ${JSON.stringify(expected)}`,
    );

    const refused = await call("roles", { headers: limitedHeaders });
    check("the limited profile is refused an endpoint outside its reported list", refused.status === 403, `${refused.status}`);
    const allowed = await call("settings", { headers: limitedHeaders });
    check("the limited profile reaches an endpoint inside its reported list", allowed.status === 200, `${allowed.status}`);

    const kitchen = await call("bootstrap", { headers: as("Kitchen").headers });
    check("Kitchen's shell does not carry the onboarding draft", kitchen.body?.settings?.onboarding_draft === undefined, `draft present: ${JSON.stringify(kitchen.body?.settings?.onboarding_draft)?.slice(0, 80)}`);

    const ownerShell = await call("bootstrap", { headers: ownerHeaders });
    check("the owner's shell still carries the onboarding draft", ownerShell.body?.settings?.onboarding_draft !== undefined, "draft missing from the owner's shell");

    const mgrShell = await call("bootstrap", { headers: as("Manager").headers });
    check("a Manager's shell does not carry the onboarding draft", mgrShell.body?.settings?.onboarding_draft === undefined, "draft present in the Manager's shell");
  }

  // =========================================================================
  // G. Guards that borrowed another module's key
  // =========================================================================
  console.log("\n  G. borrowed guards");
  {
    const kitchen = as("Kitchen");
    const waiter = as("Waiter");
    const manager = as("Manager");

    const end = await call("table-session/end", {
      method: "POST",
      headers: kitchen.headers,
      body: JSON.stringify({ tableId: "00000000-0000-0000-0000-000000000000" }),
    });
    check("Kitchen cannot end a table session", end.status === 403, `${end.status} ${JSON.stringify(end.body).slice(0, 160)}`);

    const endOk = await call("table-session/end", {
      method: "POST",
      headers: waiter.headers,
      body: JSON.stringify({ tableId: "00000000-0000-0000-0000-000000000000" }),
    });
    check("a Waiter can still end a table session (tables.manage)", endOk.status !== 403, `${endOk.status} ${JSON.stringify(endOk.body).slice(0, 160)}`);

    const reservations = await call("reservations", { headers: kitchen.headers });
    check("Kitchen cannot read the guest book", reservations.status === 403, `${reservations.status} ${JSON.stringify(reservations.body).slice(0, 160)}`);

    const reservationsOk = await call("reservations", { headers: waiter.headers });
    check("a Waiter can still read the guest book (tables.view)", reservationsOk.status === 200, `${reservationsOk.status} ${JSON.stringify(reservationsOk.body).slice(0, 160)}`);

    const reviews = await call("reviews", { headers: kitchen.headers });
    check("Kitchen cannot read customer reviews", reviews.status === 403, `${reviews.status} ${JSON.stringify(reviews.body).slice(0, 160)}`);

    const reviewsMgr = await call("reviews", { headers: manager.headers });
    check("a Manager cannot read customer reviews (no settings.view)", reviewsMgr.status === 403, `${reviewsMgr.status}`);

    const reviewsOk = await call("reviews", { headers: ownerHeaders });
    check("the owner can still read customer reviews (settings.view)", reviewsOk.status === 200, `${reviewsOk.status} ${JSON.stringify(reviewsOk.body).slice(0, 160)}`);

    const orders = await call("orders", { headers: kitchen.headers });
    check("Kitchen can still read the order book", orders.status === 200, `${orders.status}`);
  }

  // =========================================================================
  // H. Intended capabilities that must not have moved
  // =========================================================================
  console.log("\n  H. unchanged capabilities");
  {
    const manager = as("Manager");
    const waiter = as("Waiter");
    const cashier = as("Cashier");

    const staff = await call("staff/manage", { headers: manager.headers });
    check("a Manager can still list staff", staff.status === 200, `${staff.status}`);

    const roles = await call("roles", { headers: manager.headers });
    check("a Manager is still refused the roles endpoint", roles.status === 403, `${roles.status}`);

    const menu = await call("menu", { headers: waiter.headers });
    check("a Waiter is still refused the menu endpoint", menu.status === 403, `${menu.status}`);

    const security = await call("security", { headers: ownerHeaders });
    check("the owner can still read the security dashboard", security.status === 200, `${security.status}`);

    const cashierTables = await call("tables", { headers: cashier.headers });
    check("a Cashier can still list tables", cashierTables.status === 200, `${cashierTables.status}`);
  }
} catch (e) {
  check("the suite ran", false, (e as Error).message);
} finally {
  if (tenantId) {
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId).eq("is_system", false);
    for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs", "settings"]) {
      await admin.from(t).delete().eq("tenant_id", tenantId);
    }
    await admin.from("profiles").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(() => {});
  if (limitedUserId) await admin.auth.admin.deleteUser(limitedUserId).catch(() => {});
}

console.log(`\n  ${pass} passed, ${fail} failed  (base: ${BASE === SB ? "deployed" : BASE})`);
if (failures.length) {
  console.log("\n  failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
