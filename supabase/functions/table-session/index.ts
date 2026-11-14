// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard, tableSession } from "../_shared/auth.ts";
import { orderEvent, publishToDiner, publishToStaff } from "../_shared/realtime.ts";
import { admin } from "../_shared/db.ts";
import { normaliseMenuTheme } from "../_shared/menu-theme.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";
import { effectiveDishBasePrice, normalizeStoredPortions } from "../_shared/portions.ts";
import { bucketKey, rateLimit } from "../_shared/rate-limit.ts";
import { clientIp } from "../_shared/ip.ts";

/**
 * /functions/v1/table-session
 *   POST               diner QR handshake — PUBLIC (scoped by the anon QR token)
 *   GET  /validate     PUBLIC session check + menu payload
 *   GET  /active       active sessions grouped by table (tables.view)
 *   GET  /end          list recent sessions for a table (tables.view)
 *   POST /end          end session(s) (orders.manage)
 *   GET  /bill         resolve the latest bill for a session (orders.view)
 *
 * Ported from src/app/api/table-session/*. The diner routes carry no Supabase
 * JWT and are authenticated by the session/QR token itself, so they must not
 * call guard(). Everything else is tenant-scoped to the guard() session.
 */

interface SessionShape {
  session: {
    id: string;
    token: string;
    status: string;
    /** ACTIVE | PENDING | REJECTED | EXPIRED — whether the table is open. */
    activationStatus: string;
    tenantId: string;
    tableId: string;
    createdAt: Date;
    endedAt: Date | null;
  };
  tenant: {
    id: string;
    name: string;
    currencySymbol: string;
    taxRate: number;
    serviceCharge: number;
  };
  table: { id: string; name: string; seats: number; area: string; active: boolean };
}

/** Mirrors shape() from src/lib/table-session.ts. Dates serialise to ISO JSON. */
function shape(row: any): SessionShape {
  const tenant = Array.isArray(row.tenant) ? row.tenant[0] : row.tenant;
  const table = Array.isArray(row.table) ? row.table[0] : row.table;
  return {
    session: {
      id: row.id,
      token: row.token,
      status: row.status,
      activationStatus: String(row.activation_status ?? "ACTIVE"),
      tenantId: row.tenant_id,
      tableId: row.table_id,
      createdAt: new Date(row.created_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : null,
    },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      currencySymbol: tenant.currency_symbol,
      taxRate: Number(tenant.tax_rate),
      serviceCharge: Number(tenant.service_charge),
    },
    table: {
      id: table.id,
      name: table.name,
      seats: table.seats,
      area: table.area,
      active: table.active,
    },
  };
}

/** Mirrors validateTableSession() from src/lib/table-session.ts. */
async function validateTableSession(params: {
  tenantId?: string | null;
  tableId?: string | null;
  sessionToken?: string | null;
}): Promise<{ ok: true; data: SessionShape } | { ok: false; error: string; status: number }> {
  const { tenantId, tableId, sessionToken } = params;

  if (!sessionToken) {
    return {
      ok: false,
      error: "Missing session credentials. Please scan the table QR code.",
      status: 401,
    };
  }

  const { data: row } = await admin()
    .from("table_sessions")
    .select("*, tenant:tenants(*), table:tables(*)")
    .eq("token", sessionToken)
    .maybeSingle();

  if (!row) {
    return { ok: false, error: "Invalid session. Please scan the table QR code.", status: 401 };
  }
  if (tenantId && row.tenant_id !== tenantId) {
    return {
      ok: false,
      error: "Session does not match this restaurant. Please scan the table QR code.",
      status: 403,
    };
  }
  if (tableId && row.table_id !== tableId) {
    return {
      ok: false,
      error: "Session does not match this table. Please scan the table QR code.",
      status: 403,
    };
  }
  if (row.status !== "ACTIVE") {
    return {
      ok: false,
      error: "Session ended. Please scan the table QR code again to continue.",
      status: 403,
    };
  }

  // This route never ends a session on its own.
  //
  // Two earlier rules that did were removed for guessing wrong: a `closing_at`
  // stamp acted on three seconds after `pagehide`, and a three-minute idle
  // rule. `pagehide` fires on refresh, app switches and phone locks, and
  // mobile throttles background timers — both rules ended sessions of diners
  // who were still at the table.
  //
  // What replaced them, and what stands now:
  //  - the restaurant ends a session from the POS (POST /table-session/end);
  //  - the sweep ends one nobody ordered at after thirty minutes of silence
  //    (`session_is_abandoned`, below);
  //  - the sweep ends one whose page said goodbye two minutes ago and never
  //    heartbeated again (`session_close_expired`, migration 0058). The
  //    heartbeat this route writes is exactly the proof-of-life that keeps a
  //    refreshed or backgrounded page's session alive.
  //
  // All three share one protection: a session with an order on it, in any
  // state, is never ended by a clock or a browser — only by the restaurant.
  const now = Date.now();
  const lastSeen = new Date(row.last_seen_at ?? row.created_at).getTime();

  // The one rule that can end a session without the restaurant asking.
  //
  // A diner who scans the QR, never orders, and whose page has been gone for
  // thirty minutes is releasing the table back to the floor. The definition
  // lives in the database (`session_is_abandoned`), and the sweep uses the same
  // one, so the board and this route cannot disagree about it.
  //
  // Note what the predicate requires: *no order at all*. A session with an
  // order on it, in any state, is never abandoned — it ends when the restaurant
  // ends it.
  //
  // This has to be asked before the heartbeat below is written: refreshing
  // `last_seen_at` first would make every session look busy, including the one
  // being tested.
  if (now - lastSeen > 30 * 60_000) {
    const { data: abandoned } = await admin().rpc("session_is_abandoned", { p_session_id: row.id });
    if (abandoned === true) {
      await admin()
        .from("table_sessions")
        .update({ status: "ENDED", ended_at: new Date().toISOString() })
        .eq("id", row.id);
      return {
        ok: false,
        error: "This table session has expired. Please scan the table QR code again to continue.",
        status: 403,
      };
    }
  }

  // Record the heartbeat, but only when it has gone stale. Writing on every
  // poll would be a row update per diner per 1.5s for no extra information.
  if (now - lastSeen > 20_000) {
    await admin()
      .from("table_sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", row.id);
  }

  const data = shape(row);
  if (!data.table || !data.table.active) {
    return { ok: false, error: "This table is no longer available.", status: 403 };
  }
  return { ok: true, data };
}

/**
 * POST /table-session/release — PUBLIC.
 *
 * The diner's menu calls this as the tab goes away, so a session with nothing
 * on it ends in seconds instead of waiting out the idle window. The session
 * token is the credential: a caller can only release the session they hold.
 */
async function releaseSession(req: Request): Promise<Response> {
  const b = await body(req);
  const token = String(b.sessionToken ?? "");
  if (!token) return json(req, { error: "Missing session token" }, 400);

  const db = admin();
  const { data: mine } = await db
    .from("table_sessions")
    .select("id, tenant_id, table_id")
    .eq("token", token)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (!mine) return json(req, { success: true, ended: 0 });

  // Stamp, never end.
  //
  // A page unloading is not a diner leaving — it can be a refresh, an app
  // switch, a locked phone, or the browser reclaiming a backgrounded tab. So
  // this route only records that the page said goodbye; the sweep
  // (`session_close_expired`, migration 0058) ends the session when the stamp
  // is two minutes old, no heartbeat landed after it, and the session has no
  // order. A refresh heartbeats again within seconds and disproves the stamp;
  // an ordered table is untouched no matter what the browser does.
  await db
    .from("table_sessions")
    .update({ close_pending_at: new Date().toISOString() })
    .eq("id", mine.id)
    .eq("status", "ACTIVE");

  return json(req, { success: true, stamped: true });
}

/** Mirrors activateTableSession() from src/lib/table-session.ts. */
async function activateTableSession(params: { qrToken: string; deviceFp?: string }) {
  const { qrToken, deviceFp } = params;
  if (!qrToken) {
    return {
      ok: false as const,
      error: "Missing QR token. Please scan the table QR code.",
      status: 400,
    };
  }

  await admin().rpc("expire_stale_table_sessions");
  await admin().rpc("expire_pending_activations");

  const { data, error } = await admin().rpc("start_table_session", {
    p_qr_token: qrToken,
    p_device_fp: deviceFp || null,
  });

  if (error) {
    if (error.message.includes("INVALID_QR")) {
      return {
        ok: false as const,
        error: "Invalid QR code. Please scan the QR code on your table.",
        status: 404,
      };
    }
    if (error.message.includes("RESTAURANT_UNAVAILABLE")) {
      return { ok: false as const, error: "This restaurant is currently unavailable.", status: 403 };
    }
    return {
      ok: false as const,
      error: "Could not start your table session. Please try again.",
      status: 500,
    };
  }

  const { data: row } = await admin()
    .from("table_sessions")
    .select("*, tenant:tenants(*), table:tables(*)")
    .eq("token", (data as any).session_token)
    .maybeSingle();

  if (!row) {
    return {
      ok: false as const,
      error: "Could not start your table session. Please try again.",
      status: 500,
    };
  }
  return { ok: true as const, data: shape(row) };
}

/** Mirrors endTableSession() from src/lib/table-session.ts. */
async function endTableSession(params: { tenantId: string; sessionId?: string; tableId?: string }) {
  const { tenantId, sessionId, tableId } = params;
  let query = admin()
    .from("table_sessions")
    .update({ status: "ENDED", ended_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("status", "ACTIVE");
  if (sessionId) query = query.eq("id", sessionId);
  if (tableId) query = query.eq("table_id", tableId);

  const { data, error } = await query.select("id");
  if (error) return { ok: false as const, error: error.message, status: 500 };
  return { ok: true as const, ended: data?.length ?? 0 };
}

/**
 * Tell the floor and the diner that a session has ended.
 *
 * Two topics, because they are two audiences: staff get the restaurant's
 * capability topic, and the diner is told on their own session topic — the
 * token they already hold. The old code used one tenant-wide public topic,
 * which every diner could also read.
 */
async function publishSessionEnded(tenantId: string, payload: any, sessionToken?: string | null) {
  await publishToStaff(tenantId, "SESSION_ENDED", { order: payload });
  if (sessionToken) publishToDiner(sessionToken, "SESSION_ENDED", { order: payload });
}

function mapTable(row: any) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    seats: row.seats,
    area: row.area,
    qrToken: row.qr_token,
    active: row.active,
    createdAt: row.created_at,
  };
}

function mapCategory(row: any) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function mapMenuItem(row: any) {
  const category = Array.isArray(row.category) ? row.category[0] : row.category;
  const portions = normalizeStoredPortions(row.portions);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    price: effectiveDishBasePrice(row.price, portions),
    portions,
    image: row.image,
    available: row.available,
    prepTime: row.prep_time,
    tags: row.tags,
    calories: row.calories,
    sortOrder: row.sort_order,
    rating: row.rating,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    category: category ? mapCategory(category) : null,
  };
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "table-session");
  const route = segments[0];

  try {
    if (req.method === "POST") {
      if (route === "end") return await endSession(req);
      if (route === "approve") return await approveActivation(req);
      if (route === "refuse") return await refuseActivation(req);
      if (route === "release") return await releaseSession(req);
      if (!route) return await startSession(req);
      return json(req, { error: "Not found" }, 404);
    }

    if (req.method === "GET") {
      if (route === "validate") return await validate(req);
      if (route === "active") return await active(req);
      if (route === "end") return await listSessions(req);
      if (route === "bill") return await bill(req);
      if (route === "orders") return await myOrders(req);
      return json(req, { error: "Not found" }, 404);
    }

    return json(req, { error: "Method not allowed" }, 405);
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

/** POST /table-session — PUBLIC. Customer scans a table QR code. */
async function startSession(req: Request): Promise<Response> {
  // Minting a session is the one anonymous write that creates a row. Bounded
  // per client and per table: a photographed QR must not become unlimited
  // ordering, and a script must not fill the table with sessions.
  const b = await body(req);
  const ip = clientIp(req) ?? "unknown";
  // 120 a minute, not 20. A restaurant's diners share ONE public IP behind the
  // venue's NAT: a table of eight scanning at once is eight hits, and a dinner
  // rush is dozens. A tight per-IP limit would refuse real diners while barely
  // inconveniencing the attacker it was aimed at — one photographed QR is
  // already bounded by the per-table limit below.
  const gate = await rateLimit(await bucketKey("session:ip", ip), 120, 60);
  if (!gate.allowed) {
    return json(
      req,
      { error: "Too many scans from this device. Please wait a moment and try again." },
      429,
      { "retry-after": String(gate.retryAfterSeconds ?? 60) },
    );
  }
  const tableGate = await rateLimit(await bucketKey("session:qr", String(b.qrToken ?? "")), 40, 60);
  if (!tableGate.allowed) {
    return json(
      req,
      { error: "This table has been scanned many times just now. Please ask a member of staff." },
      429,
    );
  }
  const result = await activateTableSession({
    qrToken: String(b.qrToken ?? ""),
    deviceFp: b.deviceFp ? String(b.deviceFp) : undefined,
  });
  if (!result.ok) return json(req, { error: result.error }, result.status);

  return json(
    req,
    {
      sessionToken: result.data.session.token,
      sessionId: result.data.session.id,
      status: result.data.session.status,
      // PENDING means "browsing is fine, the first order waits for the floor".
      activationStatus: result.data.session.activationStatus,
      tenant: result.data.tenant,
      table: result.data.table,
    },
    201,
  );
}

/**
 * The order a session produced, if any, plus the tenant it belongs to.
 *
 * A table session can be ended without a single order on it — the POS ends
 * sessions for tables that were abandoned. The diner's "session ended" screen
 * has to know whether there is anything to bill, and the only honest answer
 * comes from the orders table rather than from the browser's memory.
 *
 * The session is found by its token and the order by the session it belongs
 * to, so an order can never be attributed to the wrong table. The tenant id
 * rides along so the same lookup also serves the review summary below.
 */
async function orderForSession(sessionToken: string | null): Promise<{
  order: { id: string; order_number: string | null } | null;
  tenantId: string | null;
}> {
  if (!sessionToken) return { order: null, tenantId: null };

  const db = admin();

  const { data: session } = await db
    .from("table_sessions")
    .select("id, tenant_id")
    .eq("token", sessionToken)
    .maybeSingle();
  if (!session) return { order: null, tenantId: null };

  const { data: order } = await db
    .from("orders")
    .select("id, order_number")
    .eq("table_session_id", session.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return { order: order ?? null, tenantId: session.tenant_id };
}

/**
 * What the "session ended" screen needs to render the review block: whether
 * the restaurant collects reviews at all, and its live average so the badge
 * never has to invent a number. No rows yet means no badge number, not a
 * made-up five stars.
 */
async function reviewSummaryForTenant(tenantId: string | null): Promise<{
  enabled: boolean;
  averageRating: number | null;
  reviewCount: number;
}> {
  if (!tenantId) return { enabled: true, averageRating: null, reviewCount: 0 };

  const db = admin();
  const [{ data: setting }, { data: rows }] = await Promise.all([
    db.from("settings")
      .select("value")
      .eq("tenant_id", tenantId)
      .eq("key", "reviews_enabled")
      .maybeSingle(),
    db.from("customer_reviews").select("rating").eq("tenant_id", tenantId),
  ]);

  const ratings = (rows ?? [])
    .map((r) => Number(r.rating))
    .filter((n) => Number.isFinite(n) && n > 0);
  const count = ratings.length;
  const average = count > 0 ? +(ratings.reduce((a, b) => a + b, 0) / count).toFixed(1) : null;

  return { enabled: setting?.value !== "false", averageRating: average, reviewCount: count };
}

/** GET /table-session/validate — PUBLIC. Session check + menu payload. */
async function validate(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId");
  const tableId = url.searchParams.get("tableId");
  // The token travels as a header, not a query parameter: a bearer credential
  // in a URL lands in access logs and Referer/analytics. Kept the query
  // parameter as a fallback for any cached bundle from before this change.
  const sessionToken = req.headers.get("x-session-token") ?? url.searchParams.get("sessionToken");

  const result = await validateTableSession({ tenantId, tableId, sessionToken });
  if (!result.ok) {
    // The session is not usable, but the diner still needs to know whether
    // there is a bill waiting for them. Saying so here saves the page a
    // second round trip — and the same lookup feeds the review block that
    // sits on the "session ended" screen.
    const { order, tenantId: sessionTenantId } = await orderForSession(sessionToken);
    const reviewSummary = await reviewSummaryForTenant(sessionTenantId);
    return json(
      req,
      {
        error: result.error,
        sessionStatus: "INVALID",
        hasOrder: Boolean(order),
        orderId: order?.id ?? null,
        orderNumber: order?.order_number ?? null,
        reviewsEnabled: reviewSummary.enabled,
        averageRating: reviewSummary.averageRating,
        reviewCount: reviewSummary.reviewCount,
      },
      result.status,
    );
  }

  const { tenant, table } = result.data;
  const db = admin();

  const [{ data: categories }, { data: menuItems }, { data: socialSettings }] = await Promise.all([
    db.from("categories").select("*").eq("tenant_id", tenant.id).order("sort_order", { ascending: true }),
    db
      .from("menu_items")
      .select("*, category:categories(*)")
      .eq("tenant_id", tenant.id)
      .eq("available", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    db
      .from("settings")
      .select("*")
      .eq("tenant_id", tenant.id)
      .in("key", ["instagram", "facebook", "youtube", "menu_theme"]),
  ]);

  const social: Record<string, string> = {};
  for (const s of socialSettings || []) social[s.key] = s.value;

  return json(req, {
    sessionStatus: "ACTIVE",
    session: result.data.session,
    activationStatus: result.data.session.activationStatus,
    tenant,
    table,
    social,
    // The menu's theme. The diner sees the restaurant's choice, so it travels
    // with the menu rather than being read from the diner's device.
    theme: normaliseMenuTheme(social.menu_theme),
    categories: (categories || []).map(mapCategory),
    menuItems: (menuItems || []).map(mapMenuItem),
  });
}

/** GET /table-session/active — active sessions grouped by table (tables.view). */
async function active(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "tables.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  // Clear anything abandoned before reporting. A session whose menu was closed
  // stops heartbeating but is never revisited, so without this the board keeps
  // listing tables that are not in service until the six-hour cap.
  await admin().rpc("expire_stale_table_sessions");
  await admin().rpc("expire_pending_activations");

  // Live sessions, plus the ones that ended in the last few minutes. A card
  // that vanishes the instant a table is closed leaves the person who closed
  // it unsure whether it worked; showing it briefly as Closed is the
  // difference between "done" and "did that register?".
  const recentlyClosed = new Date(Date.now() - 3 * 60_000).toISOString();
  const { data, error } = await admin()
    .from("table_sessions")
    .select("*, table:tables(*), order_rows:orders(id, status, payment_status, total)")
    .eq("tenant_id", tenantId)
    .or(`status.eq.ACTIVE,and(status.eq.ENDED,ended_at.gte.${recentlyClosed})`)
    .order("created_at", { ascending: false });

  if (error) return json(req, { error: error.message }, 500);

  const sessions = (data || []).map((row: any) => {
    const table = Array.isArray(row.table) ? row.table[0] : row.table;
    const orders = row.order_rows || [];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      tableId: row.table_id,
      status: row.status,
      activationStatus: String(row.activation_status ?? "ACTIVE"),
      deviceFp: row.device_fp,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      endedAt: row.ended_at,
      table: table ? mapTable(table) : null,
      // Held orders are counted separately: they exist, but nothing is being
      // cooked and nothing is owed.
      _count: {
        orders: Array.isArray(orders)
          ? orders.filter((o: any) => o.status !== "PENDING_ACTIVATION").length
          : 0,
        held: Array.isArray(orders)
          ? orders.filter((o: any) => o.status === "PENDING_ACTIVATION").length
          : 0,
      },
      closedAt: row.ended_at,
    };
  });

  // The running bill for each table, so the floor card can show what is owed
  // rather than only how many orders there are.
  const tableIds = [...new Set(sessions.map((s) => s.tableId))];
  const checkByTable: Record<string, { total: number; paid: number; outstanding: number; status: string }> = {};
  if (tableIds.length) {
    const { data: checks } = await admin()
      .from("table_checks")
      .select("table_id, status, total, paid_total, opened_at")
      .eq("tenant_id", tenantId)
      .in("table_id", tableIds)
      .order("opened_at", { ascending: false });
    for (const c of checks ?? []) {
      if (checkByTable[c.table_id]) continue; // newest wins
      const total = Number(c.total ?? 0);
      const paid = Number(c.paid_total ?? 0);
      checkByTable[c.table_id] = { total, paid, outstanding: Math.max(0, total - paid), status: c.status };
    }
  }

  const byTable: Record<string, { id: string; tableId: string; table: any; sessions: any[] }> = {};
  for (const s of sessions) {
    if (!byTable[s.tableId]) {
      byTable[s.tableId] = { id: s.id, tableId: s.tableId, table: s.table, sessions: [] };
    }
    byTable[s.tableId].sessions.push(s);
  }

  // Attach the bill figures to each group.
  const groups = Object.values(byTable).map((g) => ({ ...g, check: checkByTable[g.tableId] ?? null }));

  // Bills with money still due, including sittings that have already ended.
  // A session that closes unpaid used to vanish from the floor board and leave
  // an outstanding balance nobody was ever shown — the row existed, the screen
  // did not mention it. Managers and cashiers see these until they are settled.
  // `table_checks.total` is only written when a check is finalised, so a bill
  // that is still open has 0 there — filtering on it would have hidden exactly
  // the bills this list exists for. The figures come from the orders and the
  // ledger, which are the truth while the sitting is live.
  const { data: owing } = await admin()
    .from("table_checks")
    .select("id, table_id, status, opened_at, unsettled_at, table:tables(name, area)")
    .eq("tenant_id", tenantId)
    .in("status", ["OPEN", "UNSETTLED"])
    .order("opened_at", { ascending: false })
    .limit(20);

  const checkIds = (owing ?? []).map((c: any) => c.id);
  const totalsByCheck: Record<string, { total: number; paid: number }> = {};
  if (checkIds.length) {
    const [{ data: orderRows }, { data: paymentRows }] = await Promise.all([
      admin()
        .from("orders")
        .select("check_id, total")
        .eq("tenant_id", tenantId)
        .in("check_id", checkIds)
        .neq("status", "CANCELLED")
        .neq("status", "PENDING_ACTIVATION"),
      admin()
        .from("check_payments")
        .select("check_id, amount")
        .eq("tenant_id", tenantId)
        .in("check_id", checkIds)
        .eq("status", "SUCCEEDED"),
    ]);
    for (const id of checkIds) totalsByCheck[id] = { total: 0, paid: 0 };
    for (const o of orderRows ?? []) {
      const k = (o as any).check_id;
      if (k && totalsByCheck[k]) totalsByCheck[k].total += Number((o as any).total ?? 0);
    }
    for (const p of paymentRows ?? []) {
      const k = (p as any).check_id;
      if (k && totalsByCheck[k]) totalsByCheck[k].paid += Number((p as any).amount ?? 0);
    }
  }

  const pendingBills = (owing ?? [])
    .map((c: any) => {
      const t = Array.isArray(c.table) ? c.table[0] : c.table;
      const sums = totalsByCheck[c.id] ?? { total: 0, paid: 0 };
      return {
        checkId: c.id,
        tableId: c.table_id,
        tableName: t?.name ?? "Table",
        area: t?.area ?? "",
        status: c.status,
        total: +sums.total.toFixed(2),
        paid: +sums.paid.toFixed(2),
        outstanding: +Math.max(0, sums.total - sums.paid).toFixed(2),
        openedAt: c.opened_at,
        unsettledAt: c.unsettled_at,
      };
    })
    .filter((c) => c.outstanding > 0.005);

  return json(req, { sessions: groups, pendingBills });
}

/** POST /table-session/end — end session(s) (orders.manage). */
async function endSession(req: Request): Promise<Response> {
  // Ending a session frees the table and closes the diner's QR session, so it
  // is a floor action and needs the floor's write key. It used to be guarded by
  // `orders.manage`, which Kitchen holds and which is a key to a different
  // module entirely — a role with no `tables.*` permission at all could close
  // every table in the restaurant.
  //
  // Completing an order still ends its table's session without this call: the
  // orders function does it itself, in the same request that completes the
  // order, and publishes the same SESSION_ENDED event. So the kitchen's flow is
  // unaffected — it never needed to reach this endpoint.
  const g = await guard(req, { permission: "table-sessions.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const b = await body(req);
  const tableId = b.tableId ? String(b.tableId) : undefined;
  const sessionId = b.sessionId ? String(b.sessionId) : undefined;

  // Read the tokens of the sessions about to end, so each diner can be told on
  // their own topic. Ending is by table, so this is every active session on it
  // — several diners can hold one table at once.
  let endedTokens: string[] = [];
  {
    let q = admin().from("table_sessions").select("token").eq("tenant_id", tenantId).eq("status", "ACTIVE");
    if (sessionId) q = q.eq("id", sessionId);
    if (tableId) q = q.eq("table_id", tableId);
    const { data } = await q;
    endedTokens = (data ?? []).map((r: any) => r.token).filter(Boolean);
  }

  // ── Safe closure ────────────────────────────────────────────────────────
  // Closing a table with food still on the pass, or with money still owed,
  // loses track of both: the card disappears, and the order that was never
  // paid for is now only findable in the orders list. So the closure is
  // refused, with what is outstanding, unless the caller explicitly forces it.
  //
  // Force exists because a restaurant must be able to close a table it has
  // decided to write off — but it is a second, deliberate click, never the
  // default.
  const force = b.force === true;
  if (!force) {
    let target = admin()
      .from("table_sessions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("status", "ACTIVE");
    if (sessionId) target = target.eq("id", sessionId);
    if (tableId) target = target.eq("table_id", tableId);
    const { data: openSessions } = await target;

    if ((openSessions ?? []).length > 0) {
      const { data: outstanding } = await admin()
        .from("orders")
        .select("id, order_number, status, payment_status")
        .in("table_session_id", (openSessions ?? []).map((r: any) => r.id))
        .not("status", "in", "(COMPLETED,CANCELLED)");

      const list = outstanding ?? [];
      if (list.length > 0) {
        const unpaid = list.filter((o: any) => !["PAID", "REFUNDED"].includes(String(o.payment_status)));
        return json(
          req,
          {
            error:
              `${list.length} order${list.length === 1 ? "" : "s"} on this table ` +
              `still ${list.length === 1 ? "is" : "are"} open` +
              (unpaid.length ? `, ${unpaid.length} unpaid` : "") +
              `. Settle them first, or close the table anyway.`,
            code: "outstanding",
            outstanding: list.map((o: any) => ({
              id: o.id,
              orderNumber: o.order_number,
              status: o.status,
              paymentStatus: o.payment_status,
            })),
          },
          409,
        );
      }
    }
  }

  const result = await endTableSession({ tenantId, tableId, sessionId });
  if (!result.ok) return json(req, { error: result.error }, result.status);

  // Closing a table — especially over an override — is an audited act: it is
  // the moment a sitting stops existing, and the only record that an unpaid
  // balance was closed on purpose rather than lost.
  await admin().from("security_logs").insert({
    tenant_id: tenantId,
    user_id: g.session.kind === "owner" ? g.session.subjectId : null,
    actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
    action: force ? "TABLE_CLOSED_FORCED" : "TABLE_CLOSED",
    user_agent: req.headers.get("user-agent") || "unknown",
    meta: force
      ? `Session closed over an outstanding balance (${tableId ?? sessionId ?? "table"})`
      : `Session closed (${tableId ?? sessionId ?? "table"})`,
  }).then(() => {}).catch(() => {});

  // The sitting is over — close or flag its bill. A settled check is numbered
  // and closed; one that still owes money stays OPEN, carrying what is due.
  // Never marked paid, never deleted.
  let settlement: any = null;
  if (tableId) {
    const { data } = await admin().rpc("settle_check_on_session_end", {
      p_tenant: tenantId,
      p_table: tableId,
      p_actor: g.session.kind === "owner" ? g.session.subjectId : null,
      p_session: sessionId ?? null,
    });
    settlement = data;
    if ((data as any)?.action === "finalized") {
      await publishToStaff(tenantId, "CHECK_UPDATED", { tableId, sessionId, reason: "FINALISED" });
    }
  }

  await publishSessionEnded(tenantId, { tableId, sessionId, status: "ENDED" }, null);
  for (const token of endedTokens) publishToDiner(token, "SESSION_ENDED", { tableId, status: "ENDED" });

  return json(req, { success: true, ended: result.ended, settlement });
}

/**
 * POST /table-session/approve — accept a table so its held orders are cooked.
 *
 * One permission (`table-sessions.manage`), one transaction
 * (`approve_table_activation`), and the released orders are revalidated inside
 * that transaction — a dish taken off the menu between the diner's tap and
 * this click refuses the approval instead of releasing a price nobody agreed.
 *
 * Idempotent: approving twice releases nothing twice and answers the same.
 */
async function approveActivation(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "table-sessions.manage" });
  if (!g.ok) return g.response;

  const b = await body(req);
  const sessionId = b.sessionId ? String(b.sessionId) : "";
  if (!sessionId) return json(req, { error: "sessionId is required" }, 400);

  const { data, error } = await admin().rpc("approve_table_activation", {
    p_tenant: g.session.tenantId,
    p_session: sessionId,
    p_actor: g.session.kind === "owner" ? g.session.subjectId : null,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("ITEMS_UNAVAILABLE:")) {
      return json(
        req,
        {
          error: `These dishes are no longer available: ${message.split("ITEMS_UNAVAILABLE:")[1]}`,
          code: "items_unavailable",
        },
        409,
      );
    }
    if (message.includes("SESSION_ENDED")) {
      return json(req, { error: "That table session has already ended.", currentStatus: "ENDED" }, 409);
    }
    if (message.includes("SESSION_NOT_FOUND")) {
      return json(req, { error: "That table session is not yours.", code: "not_found" }, 404);
    }
    return json(req, { error: message || "Could not accept the table" }, 500);
  }

  const released = Number((data as any)?.released ?? 0);

  // Audit: accepting a table is what lets cooked food and money exist.
  await admin().from("security_logs").insert({
    tenant_id: g.session.tenantId,
    user_id: g.session.kind === "owner" ? g.session.subjectId : null,
    actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
    action: "TABLE_ACTIVATED",
    user_agent: req.headers.get("user-agent") || "unknown",
    meta: `Session ${sessionId} activated, ${released} order(s) released`,
  }).then(() => {}).catch(() => {});

  // The kitchen only learns about these now, and one event per order is what
  // its board already knows how to render.
  const { data: orders } = await admin()
    .from("orders")
    .select("*, items:order_items(*), table:tables(*), servedBy:profiles(id,name)")
    .eq("tenant_id", g.session.tenantId)
    .eq("table_session_id", sessionId)
    .eq("status", "PENDING");

  for (const order of orders ?? []) {
    await publishToStaff(g.session.tenantId, "ORDER_CREATED", { order: orderEvent(order) });
  }

  const { data: session } = await admin()
    .from("table_sessions")
    .select("token")
    .eq("id", sessionId)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();

  if (session?.token) {
    publishToDiner(session.token, "TABLE_ACTIVATED", { sessionId, released });
  }

  return json(req, { ok: true, released, already: Boolean((data as any)?.already) });
}

/**
 * POST /table-session/refuse — decline a table.
 *
 * Nothing was cooked and nothing was charged, so there is nothing to refund:
 * the held orders are cancelled with a reason the diner is shown, and the
 * session ends.
 */
async function refuseActivation(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "table-sessions.manage" });
  if (!g.ok) return g.response;

  const b = await body(req);
  const sessionId = b.sessionId ? String(b.sessionId) : "";
  if (!sessionId) return json(req, { error: "sessionId is required" }, 400);
  const reason = b.reason ? String(b.reason).slice(0, 200) : null;

  // Token first: after the RPC the session is ENDED, and the diner still needs
  // to be told on their own topic.
  const { data: session } = await admin()
    .from("table_sessions")
    .select("token")
    .eq("id", sessionId)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();

  const { data, error } = await admin().rpc("refuse_table_activation", {
    p_tenant: g.session.tenantId,
    p_session: sessionId,
    p_reason: reason,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("SESSION_NOT_FOUND")) {
      return json(req, { error: "That table session is not yours.", code: "not_found" }, 404);
    }
    return json(req, { error: message || "Could not decline the table" }, 500);
  }

  await admin().from("security_logs").insert({
    tenant_id: g.session.tenantId,
    user_id: g.session.kind === "owner" ? g.session.subjectId : null,
    actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
    action: "TABLE_ACTIVATION_REFUSED",
    user_agent: req.headers.get("user-agent") || "unknown",
    meta: `Session ${sessionId} refused: ${reason ?? "no reason given"}`,
  }).then(() => {}).catch(() => {});

  if (session?.token) {
    publishToDiner(session.token, "SESSION_ENDED", {
      sessionId,
      status: "ENDED",
      reason: reason ?? "The restaurant could not accept this table.",
    });
  }

  return json(req, { ok: true, cancelled: Number((data as any)?.cancelled ?? 0) });
}

/** GET /table-session/end — recent sessions for a table (tables.view). */
async function listSessions(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "tables.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const url = new URL(req.url);
  const tableId = url.searchParams.get("tableId");

  let query = admin()
    .from("table_sessions")
    .select("*, table:tables(*)")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (tableId) query = query.eq("table_id", tableId);

  const { data, error } = await query;
  if (error) return json(req, { error: error.message }, 500);

  return json(
    req,
    (data || []).map((row: any) => {
      const table = Array.isArray(row.table) ? row.table[0] : row.table;
      return {
        id: row.id,
        tenantId: row.tenant_id,
        tableId: row.table_id,
        status: row.status,
        deviceFp: row.device_fp,
        createdAt: row.created_at,
        endedAt: row.ended_at,
        table: table ? mapTable(table) : null,
      };
    }),
  );
}

/**
 * GET /table-session/orders — this diner's own orders.
 *
 * The credential is the session token, and the query is pinned to that session,
 * so a diner sees exactly what they themselves ordered: not the table's other
 * diners, not another table, not another tenant. Statuses are the live order
 * statuses, so the list can show Pending → Preparing → Ready → Served without
 * the client deciding anything.
 */
async function myOrders(req: Request): Promise<Response> {
  const token = req.headers.get("x-session-token") ?? new URL(req.url).searchParams.get("sessionToken");
  const session = token ? await tableSession(token) : null;
  if (!session) return json(req, { error: "Session required." }, 401);

  const { data } = await admin()
    .from("orders")
    .select("id, order_number, status, total, created_at, items:order_items(name, quantity, portion, price, status)")
    .eq("tenant_id", session.tenantId)
    .eq("table_session_id", session.id)
    // A held order is still this diner's order — it is shown, marked as
    // waiting, because hiding it would look like the order was lost.
    .order("created_at", { ascending: true });

  const orders = (data ?? []).map((o: any) => ({
    id: o.id,
    orderNumber: o.order_number,
    status: o.status,
    total: Number(o.total),
    createdAt: o.created_at,
    items: (o.items ?? []).map((i: any) => ({
      name: i.name,
      quantity: i.quantity,
      portion: i.portion ?? null,
      total: +(Number(i.price) * Number(i.quantity)).toFixed(2),
      status: i.status,
    })),
  }));

  return json(req, { orders, sessionId: session.id });
}

/** GET /table-session/bill — resolve the latest order for a session (orders.view). */
async function bill(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sessionToken = req.headers.get("x-session-token") ?? url.searchParams.get("sessionToken");

  // Dual auth. Owners and staff need `orders.view`; a diner has no account at
  // all, so they present their table-session token instead — `window.open`
  // cannot attach an auth header, which is why the token travels in the query.
  const g = await guard(req, { permission: "orders.view" });
  let tenantId: string;
  let dinerSessionId: string | null = null;

  if (g.ok) {
    tenantId = g.session.tenantId;
  } else {
    const session = sessionToken ? await tableSession(sessionToken) : null;
    if (!session) return g.response; // 401 — neither an owner nor a live session
    tenantId = session.tenantId;
    dinerSessionId = session.id;
  }

  try {
    const db = admin();
    const orderIdParam = url.searchParams.get("orderId");
    const tableIdParam = url.searchParams.get("tableId");
    const qrTokenParam =
      url.searchParams.get("qrToken") || url.searchParams.get("qr") || url.searchParams.get("table");

    // Every lookup is anchored to the caller's tenant — the Next.js version had
    // an unscoped "latest order in the system" fallback that crossed tenants.
    const latestFor = async (filters: Record<string, string>) => {
      let q = db
        .from("orders")
        .select("id, order_number")
        .eq("tenant_id", tenantId)
        // A held order has no bill: the table was never accepted.
        .neq("status", "PENDING_ACTIVATION")
        .order("created_at", { ascending: false })
        .limit(1);
      for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
      const { data } = await q.maybeSingle();
      return data;
    };

    // A diner is pinned to their own session and gets exactly one lookup. They
    // must not be able to resolve an arbitrary order id or table, even within
    // the same restaurant.
    if (dinerSessionId) {
      const order = await latestFor({ table_session_id: dinerSessionId });
      if (order) {
        return json(req, { ok: true, orderId: order.id, orderNumber: order.order_number });
      }
      return json(req, { ok: false, error: "No bill found" }, 404);
    }

    // 1. Direct orderId lookup
    if (orderIdParam) {
      const { data: order } = await db
        .from("orders")
        .select("id, order_number")
        .eq("id", orderIdParam)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (order) {
        return json(req, { ok: true, orderId: order.id, orderNumber: order.order_number });
      }
    }

    // 1b. Direct qrToken lookup from QR scan
    if (qrTokenParam) {
      const { data: table } = await db
        .from("tables")
        .select("id, tenant_id")
        .eq("qr_token", qrTokenParam)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (table) {
        const order = await latestFor({ table_id: table.id });
        if (order) {
          return json(req, { ok: true, orderId: order.id, orderNumber: order.order_number });
        }
      }
    }

    // 2. Lookup by sessionToken
    if (sessionToken) {
      const { data: session } = await db
        .from("table_sessions")
        .select("id, tenant_id, table_id")
        .eq("token", sessionToken)
        .eq("tenant_id", tenantId)
        .maybeSingle();

      if (session) {
        let order = await latestFor({ table_session_id: session.id });
        if (!order) order = await latestFor({ table_id: session.table_id });
        if (order) {
          return json(req, { ok: true, orderId: order.id, orderNumber: order.order_number });
        }
      }
    }

    // 3. Lookup by tableId
    if (tableIdParam) {
      const order = await latestFor({ table_id: tableIdParam });
      if (order) {
        return json(req, { ok: true, orderId: order.id, orderNumber: order.order_number });
      }
    }

    // 4. Fallback: latest order for this tenant
    const latestOrder = await latestFor({});
    if (latestOrder) {
      return json(req, { ok: true, orderId: latestOrder.id, orderNumber: latestOrder.order_number });
    }

    return json(req, { ok: false, error: "No bill found" }, 404);
  } catch (error: any) {
    console.error("Error finding bill for session:", error);
    return json(req, { ok: false, error: "Failed to retrieve bill" }, 500);
  }
}
