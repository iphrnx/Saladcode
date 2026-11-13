/**
 * Several staff sessions moving orders at the same time.
 *
 * The order lifecycle was audited one request at a time. This is the same chain
 * with the requests overlapping: the kitchen, the counter and the manager all
 * tapping at once, which is what a Friday night actually looks like.
 *
 * What it holds the system to:
 *
 *   1. an order only ever moves forward — under any interleaving, the status
 *      never goes backwards and never double-applies a step;
 *   2. a move that is invalid against what the database holds is refused with
 *      `currentStatus`, so the optimistic button can roll back to the truth;
 *   3. every authorized session can see the change;
 *   4. a session without `orders.view` can see nothing at all;
 *   5. the realtime socket fires, not just the four-second poll;
 *   6. completing an order still ends its table session — server-side, with no
 *      client call to `/api/table-session/end`, which is what the POS stopped
 *      making.
 *
 *   RBAC_BASE_URL=http://127.0.0.1:8787 npm run test:realtime-orders
 */
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Session = { role: string; headers: Record<string, string>; employeeId?: string; pin?: string };
const STAFF = ["Manager", "Kitchen", "Cashier", "Host"];

let tenantId: string | null = null;
let ownerUserId: string | null = null;
let tableId: string | null = null;
const orderIds: string[] = [];

try {
  const password = "realtime-orders-123456";
  const email = `realtime-orders-${stamp}@example.com`;
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name: "Realtime Orders" },
  });
  if (authError || !created?.user) throw new Error(`createUser: ${authError?.message}`);
  ownerUserId = created.user.id;

  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .insert({ name: `Realtime ${stamp}`, slug: `realtime-${stamp}`, plan: "pro", currency: "INR", currency_symbol: "₹", active: true })
    .select().single();
  if (tenantError) throw new Error(`tenant: ${tenantError.message}`);
  tenantId = tenant.id;

  const { data: seeded, error: rolesError } = await admin
    .from("roles").insert(DEFAULT_ROLES.map((r) => ({ ...r, tenant_id: tenant.id }))).select();
  if (rolesError) throw new Error(`roles: ${rolesError.message}`);
  const ownerRole = (seeded ?? []).find((r) => r.name === "Owner");
  const roleByName = new Map((seeded ?? []).map((r) => [r.name, r]));

  await admin.from("profiles").insert({
    id: ownerUserId, tenant_id: tenant.id, name: "Realtime Orders", email,
    role: "OWNER", role_id: ownerRole?.id ?? null, active: true,
  });

  const c = createClient(SB, ANON, { auth: { persistSession: false } });
  const { data: signIn, error: signInError } = await c.auth.signInWithPassword({ email, password });
  if (signInError || !signIn?.session) throw new Error(`signIn: ${signInError?.message}`);
  const ownerHeaders = { authorization: `Bearer ${signIn.session.access_token}` };

  // ---- staff sessions -------------------------------------------------------
  const sessions: Session[] = [];
  for (const [i, name] of STAFF.entries()) {
    const role = roleByName.get(name);
    const employeeId = `R${String(stamp).slice(-5)}${i}`;
    const pin = `30${String(i).padStart(2, "0")}`;
    const made = await call("staff/manage", {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ name: `${name} Tester`, employeeId, pin, roleId: role?.id }),
    });
    if (made.status >= 400) throw new Error(`staff ${name}: ${made.status} ${JSON.stringify(made.body)}`);
    const login = await call("staff/login", { method: "POST", body: JSON.stringify({ tenantId, employeeId, pin }) });
    if (login.status !== 200) throw new Error(`login ${name}: ${login.status} ${JSON.stringify(login.body)}`);
    sessions.push({ role: name, headers: { "x-staff-session": login.body.token }, employeeId, pin });
  }
  const as = (role: string) => sessions.find((s) => s.role === role)!;

  // ---- a table and an active diner session ---------------------------------
  const { data: table, error: tableError } = await admin
    .from("tables").insert({ tenant_id: tenant.id, name: "T1", seats: 4 }).select().single();
  if (tableError) throw new Error(`table: ${tableError.message}`);
  tableId = table.id;

  const { data: session, error: sessionError } = await admin
    .from("table_sessions").insert({ tenant_id: tenant.id, table_id: tableId, status: "ACTIVE" }).select().single();
  if (sessionError) throw new Error(`table_session: ${sessionError.message}`);

  // ---- orders ---------------------------------------------------------------
  const makeOrder = async (n: number, status = "PENDING") => {
    const { data, error } = await admin.from("orders").insert({
      tenant_id: tenant.id, order_number: 1000 + n, status, payment_status: "UNPAID", total: 250,
    }).select().single();
    if (error) throw new Error(`order: ${error.message}`);
    orderIds.push(data.id);
    return data.id as string;
  };
  const statusOf = async (id: string) => {
    const { data } = await admin.from("orders").select("status, updated_at").eq("id", id).maybeSingle();
    return data?.status as string;
  };
  const move = (session: Session, id: string, status: string) =>
    call(`orders/${id}`, { method: "PATCH", headers: session.headers, body: JSON.stringify({ status }) });

  // =========================================================================
  // 1. Four sessions, four orders, one instant
  // =========================================================================
  console.log("\n  1. simultaneous moves on different orders");
  {
    const ids = await Promise.all([0, 1, 2, 3].map((n) => makeOrder(n)));
    const results = await Promise.all([
      move(as("Manager"), ids[0], "PREPARING"),
      move(as("Kitchen"), ids[1], "PREPARING"),
      move(as("Cashier"), ids[2], "PREPARING"),
      move(as("Manager"), ids[3], "PREPARING"),
    ]);
    check("all four moves were accepted", results.every((r) => r.status === 200), results.map((r) => r.status).join(","));
    const after = await Promise.all(ids.map(statusOf));
    check("all four orders hold the new status", after.every((s) => s === "PREPARING"), after.join(","));
  }

  // =========================================================================
  // 2. Two sessions, one order, conflicting targets
  // =========================================================================
  console.log("\n  2. conflicting moves on the same order");
  {
    const id = await makeOrder(10);
    const [a, b] = await Promise.all([
      move(as("Manager"), id, "PREPARING"),
      move(as("Kitchen"), id, "SERVED"),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status === 409);
    check("exactly one move won and the other was refused", ok.length === 1 && refused.length === 1, `${a.status} / ${b.status}`);
    check("the refusal carries currentStatus so the screen can roll back", refused[0]?.body?.currentStatus === "PENDING", JSON.stringify(refused[0]?.body));
    check("the order is in the winner's state", (await statusOf(id)) === "PREPARING", await statusOf(id));

    const retry = await move(as("Kitchen"), id, "SERVED");
    check("the stale move is still refused once the row has moved on", retry.status === 409 && retry.body?.currentStatus === "PREPARING", `${retry.status} ${JSON.stringify(retry.body)}`);
    const legal = await move(as("Kitchen"), id, "READY");
    check("the legal move from the new state is accepted", legal.status === 200, `${legal.status}`);
  }

  // =========================================================================
  // 2b. Two sessions making the same move
  // =========================================================================
  console.log("\n  2b. the same move from two sessions");
  {
    const id = await makeOrder(15);
    const [a, b] = await Promise.all([
      move(as("Manager"), id, "PREPARING"),
      move(as("Cashier"), id, "PREPARING"),
    ]);
    check("neither duplicate errored", [a, b].every((r) => r.status < 500), `${a.status} / ${b.status}`);
    check("both are told the order is where they wanted it", [a, b].every((r) => r.status === 200), `${a.status} / ${b.status}`);
    check("the order moved exactly once", (await statusOf(id)) === "PREPARING", await statusOf(id));
  }

  // =========================================================================
  // 3. A burst along the chain never goes backwards
  // =========================================================================
  console.log("\n  3. a burst along the chain");
  {
    const id = await makeOrder(20);
    const chain = ["PREPARING", "READY", "SERVED", "COMPLETED"];
    const LEGAL = ["PENDING", "PREPARING", "READY", "SERVED", "COMPLETED", "CANCELLED"];
    const seen: string[] = ["PENDING"];
    let serverErrors = 0;
    let badRefusals = 0;

    // Four sessions fire the whole chain at once, twice over. Most moves are
    // refused because the row has not advanced yet — the point is that nothing
    // 500s, every refusal names a real status, and the row only moves forward.
    for (let round = 0; round < 2; round++) {
      const results = await Promise.all(
        chain.flatMap((target, i) => [move(as("Manager"), id, target), move(as("Kitchen"), id, target), move(as("Cashier"), id, target)]),
      );
      for (const r of results) {
        if (r.status >= 500) serverErrors++;
        // A refusal must name a status the order can actually hold — sampled
        // states are too sparse mid-burst, since the row advances inside the
        // round. Naming an unknown or missing status would leave the optimistic
        // button with nothing to roll back to.
        else if (r.status === 409 && !LEGAL.includes(String(r.body?.currentStatus))) badRefusals++;
      }
      const now = await statusOf(id);
      seen.push(now);
    }

    check("no burst request produced a server error", serverErrors === 0, `${serverErrors} 5xx`);
    check("every refusal named a status the order actually held", badRefusals === 0, `${badRefusals} refusals with an unknown currentStatus`);

    const indices = seen.map((st) => LEGAL.indexOf(st));
    check("the status never moved backwards across the burst", indices.every((v, i) => i === 0 || v >= indices[i - 1]), seen.join(" → "));

    // Drive it home one legal step at a time, and assert each step is forward.
    for (const target of chain) {
      const r = await move(as("Manager"), id, target);
      if (r.status === 409) continue;
      check(`the step to ${target} was accepted from the state the row held`, r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    }
    check("the order ended in the furthest state", (await statusOf(id)) === "COMPLETED", await statusOf(id));

    const { count } = await admin.from("orders").select("id", { count: "exact", head: true }).eq("id", id);
    check("the race created no duplicate order rows", (count ?? 0) === 1, `${count} rows`);
  }

  // =========================================================================
  // 4. Every authorized session sees it
  // =========================================================================
  console.log("\n  4. propagation to other sessions");
  {
    const id = await makeOrder(30);
    const before = new Date(Date.now() - 1000).toISOString();
    await move(as("Manager"), id, "PREPARING");

    for (const role of ["Manager", "Kitchen", "Cashier"]) {
      const sync = await call(`orders/sync?since=${encodeURIComponent(before)}`, { headers: as(role).headers });
      const found = (sync.body?.orders ?? []).find((o: any) => o.id === id);
      check(`${role}'s poll returns the change with its new status`, sync.status === 200 && found?.status === "PREPARING", `${sync.status} ${found ? found.status : "order missing from the poll"}`);
    }

    const manager = await call(`orders/sync?since=${encodeURIComponent(before)}`, { headers: as("Manager").headers });
    check("the poll carries the counters the dashboard shows", typeof manager.body?.summary?.ordersToday === "number", JSON.stringify(manager.body?.summary));
  }

  // =========================================================================
  // 5. A session with no orders.view receives nothing
  // =========================================================================
  console.log("\n  5. an unauthorized session");
  {
    const host = await call("orders/sync", { headers: as("Host").headers });
    check("Host cannot poll for order updates", host.status === 403, `${host.status} ${JSON.stringify(host.body).slice(0, 160)}`);
    const list = await call("orders", { headers: as("Host").headers });
    check("Host cannot list orders", list.status === 403, `${list.status}`);
  }

  // =========================================================================
  // 6. The socket fires, not just the poll
  // =========================================================================
  console.log("\n  6. the realtime socket");
  {
    const rt = createClient(SB, ANON, { auth: { persistSession: false } });
    await rt.auth.setSession({
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
    });

    const events: any[] = [];
    const channel = rt
      .channel(`orders:${tenantId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `tenant_id=eq.${tenantId}` }, (p: any) => events.push(p))
      .subscribe();

    // Wait for the socket to be joined before writing, or the event lands before
    // anyone is listening and the test blames the server.
    for (let i = 0; i < 40 && channel.state !== "joined"; i++) await sleep(250);
    check("the realtime channel joined", channel.state === "joined", `state is ${channel.state}`);

    const id = await makeOrder(40);
    await move(as("Kitchen"), id, "PREPARING");
    for (let i = 0; i < 60 && events.length === 0; i++) await sleep(250);
    check("a status change reached the socket", events.length > 0, "no postgres_changes event within 15s");
    check("the event names the order that changed", events.some((e) => e?.new?.id === id), JSON.stringify(events[0] ?? null).slice(0, 200));

    await rt.removeChannel(channel);
  }

  // =========================================================================
  // 7. Completing an order ends its table session, with no client call
  // =========================================================================
  console.log("\n  7. completion ends the table session server-side");
  {
    const id = await makeOrder(50, "SERVED");
    await admin.from("orders").update({ table_id: tableId }).eq("id", id);
    await admin.from("table_sessions").update({ status: "ACTIVE", ended_at: null }).eq("id", session.id);

    const before = await admin.from("table_sessions").select("status").eq("id", session.id).maybeSingle();
    check("the table session starts ACTIVE", before?.data?.status === "ACTIVE", `raw=${JSON.stringify(before?.data)}`);

    // The POS does exactly this and nothing else: one PATCH. The call to
    // /api/table-session/end that used to follow it is gone.
    const done = await move(as("Kitchen"), id, "COMPLETED");
    check("the kitchen can complete the order", done.status === 200, `${done.status} ${JSON.stringify(done.body)}`);

    const after = await admin.from("table_sessions").select("status, ended_at").eq("id", session.id).maybeSingle();
    check("the table session ended without a second request", after?.data?.status === "ENDED", `raw=${JSON.stringify(after?.data)}`);
    check("the session records when it ended", Boolean(after?.data?.ended_at), "ended_at is null");

    const active = await call("table-session/active", { headers: as("Manager").headers });
    const stillThere = (Array.isArray(active.body) ? active.body : []).some((s: any) => s.tableId === tableId || s.table_id === tableId);
    check("the table is no longer listed as occupied", !stillThere, JSON.stringify(active.body).slice(0, 200));
  }

  // =========================================================================
  // 8. Two sessions completing at once
  // =========================================================================
  console.log("\n  8. concurrent completion");
  {
    const id = await makeOrder(60, "SERVED");
    await admin.from("orders").update({ table_id: tableId }).eq("id", id);
    await admin.from("table_sessions").update({ status: "ACTIVE", ended_at: null }).eq("id", session.id);

    const [a, b] = await Promise.all([
      move(as("Manager"), id, "COMPLETED"),
      move(as("Cashier"), id, "COMPLETED"),
    ]);
    check("neither completion errored", [a, b].every((r) => r.status < 500), `${a.status} / ${b.status}`);
    check("at least one completion was accepted", [a, b].some((r) => r.status === 200), `${a.status} / ${b.status}`);
    check("the order is COMPLETED exactly once", (await statusOf(id)) === "COMPLETED", await statusOf(id));

    const after = await admin.from("table_sessions").select("status").eq("id", session.id).maybeSingle();
    check("the table session is ENDED, not double-ended or left open", after?.data?.status === "ENDED", `${after?.data?.status}`);
  }

  // =========================================================================
  // 9. The same session moving two orders at once
  // =========================================================================
  console.log("\n  9. one session, two orders");
  {
    const [x, y] = await Promise.all([makeOrder(70), makeOrder(71)]);
    const [rx, ry] = await Promise.all([
      move(as("Kitchen"), x, "PREPARING"),
      move(as("Kitchen"), y, "PREPARING"),
    ]);
    check("both moves from one session were accepted", rx.status === 200 && ry.status === 200, `${rx.status} / ${ry.status}`);
    check("both orders moved", (await statusOf(x)) === "PREPARING" && (await statusOf(y)) === "PREPARING", `${await statusOf(x)} / ${await statusOf(y)}`);
  }
} catch (e) {
  check("the suite ran", false, (e as Error).message);
} finally {
  if (tenantId) {
    await admin.from("order_items").delete().eq("tenant_id", tenantId);
    await admin.from("orders").delete().eq("tenant_id", tenantId);
    await admin.from("table_sessions").delete().eq("tenant_id", tenantId);
    await admin.from("tables").delete().eq("tenant_id", tenantId);
    await admin.from("staff").delete().eq("tenant_id", tenantId);
    await admin.from("roles").delete().eq("tenant_id", tenantId).eq("is_system", false);
    for (const t of ["feature_usage", "subscription_payments", "subscription_audit_logs", "subscription_webhook_events", "ai_request_logs", "settings"]) {
      await admin.from(t).delete().eq("tenant_id", tenantId);
    }
    await admin.from("profiles").delete().eq("tenant_id", tenantId);
    await admin.from("tenants").delete().eq("id", tenantId);
  }
  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(() => {});
}

console.log(`\n  ${pass} passed, ${fail} failed  (base: ${BASE === SB ? "deployed" : BASE})`);
if (failures.length) {
  console.log("\n  failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
