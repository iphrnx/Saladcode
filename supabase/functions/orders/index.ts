// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { evaluatePromo } from "../_shared/promo.ts";
import { hasEffectivePermission, ORDER_STATUS_KEYS } from "../_shared/permissions.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";
import { resolveOrderUnitPrice } from "../_shared/portions.ts";
import { orderEvent, publishToDiner, publishToStaff } from "../_shared/realtime.ts";
import { bucketKey, rateLimit } from "../_shared/rate-limit.ts";

/**
 * /functions/v1/orders
 *   GET                       list orders (orders.view)
 *   GET    /sync              incremental poll + summary (orders.view)
 *   GET    /:id               single order (orders.view)
 *   POST                      create order — PUBLIC diner path when the body
 *                             carries `tableSessionToken`, otherwise POS path
 *                             guarded by (orders.manage)
 *   PATCH  /:id               update order (orders.manage)
 *   DELETE /:id               delete order (orders.manage)
 *   POST   /:id/items         add item to order (orders.manage)
 *   PATCH  /:id/items         update/remove item (orders.manage)
 *
 * Ported from src/app/api/orders/*. Responses keep the legacy camelCase shape
 * (mapOrder/mapOrderItem) — the views depend on it.
 *
 * Tenant scoping fix: the Next.js [id] routes filtered PATCH/DELETE/GET and the
 * order_items writes by `id` alone, letting a signed-in user of one restaurant
 * mutate another restaurant's orders. Every read/write here is scoped by the
 * tenant returned by guard() (or by the table session on the public path).
 */

const ORDER_SELECT = "*, items:order_items(*), table:tables(*), servedBy:profiles(id,name)";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The checkout key a client sends with every attempt of one checkout. Only a
 * well-formed uuid earns idempotency — anything else silently degrades to the
 * old behaviour rather than failing an otherwise valid order.
 */
function cleanIdempotencyKey(v: any): string | null {
  const s = String(v ?? "").trim();
  return UUID_RE.test(s) ? s.toLowerCase() : null;
}

function mapOrderItem(row: any) {
  return {
    id: row.id,
    orderId: row.order_id,
    menuItemId: row.menu_item_id,
    name: row.name,
    portionId: row.portion_id ?? null,
    portion: row.portion ?? null,
    price: row.price,
    quantity: row.quantity,
    notes: row.notes,
    status: row.status,
    kotNumber: row.kot_number ?? 1,
  };
}

function mapOrder(row: any) {
  const table = Array.isArray(row.table) ? row.table[0] : row.table;
  const servedBy = Array.isArray(row.servedBy) ? row.servedBy[0] : row.servedBy;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    orderNumber: row.order_number,
    tableId: row.table_id,
    tableSessionId: row.table_session_id,
    checkId: row.check_id,
    orderType: row.order_type,
    status: row.status,
    itemsTotal: row.items_total,
    discount: row.discount,
    tax: row.tax,
    serviceCharge: row.service_charge,
    total: row.total,
    promoCodeId: row.promo_code_id,
    promoCode: row.promo_code,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    notes: row.notes,
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    servedById: row.served_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    items: Array.isArray(row.items) ? row.items.map(mapOrderItem) : [],
    table: table
      ? {
          id: table.id,
          tenantId: table.tenant_id,
          name: table.name,
          seats: table.seats,
          area: table.area,
          qrToken: table.qr_token,
          active: table.active,
          createdAt: table.created_at,
        }
      : null,
    servedBy: servedBy ? { id: servedBy.id, name: servedBy.name } : null,
  };
}

/**
 * Fan one order change out to the two parties that need it.
 *
 * The staff topic carries a per-tenant secret; the diner topic carries that
 * diner's own session token. The payload is `orderEvent()` — identifiers,
 * money and status only — so nothing personal travels over a channel, and the
 * table's QR token (which used to ride along inside the nested table object)
 * is gone entirely.
 *
 * Fire-and-forget: the write has already committed by the time this runs.
 */
async function publishOrderEvent(event: {
  type: string;
  tenantId: string;
  order: any;
  /** The diner whose context should hear about it, when there is one. */
  sessionToken?: string | null;
}): Promise<void> {
  const facts = { order: orderEvent(event.order) };
  await publishToStaff(event.tenantId, event.type, facts);
  if (event.sessionToken) publishToDiner(event.sessionToken, event.type, facts);
}

/** Every order on a session, in the shape the clients expect. */
async function releasedSiblings(tenantId: string, sessionId: string): Promise<any[]> {
  const { data } = await admin()
    .from("orders")
    .select(ORDER_SELECT)
    .eq("tenant_id", tenantId)
    .eq("table_session_id", sessionId)
    .eq("status", "PENDING");
  return (data ?? []).map(mapOrder);
}

/** The session token behind an order, so its diner can be told. */
async function sessionTokenFor(order: any): Promise<string | null> {
  const sessionId = order?.tableSessionId ?? order?.table_session_id ?? null;
  if (!sessionId) return null;
  const { data } = await admin()
    .from("table_sessions")
    .select("token")
    .eq("id", sessionId)
    .maybeSingle();
  return (data?.token as string | undefined) ?? null;
}

/** Public diner session check. Same error contract as validateTableSession(). */
async function validateDinerSession(
  token: string,
): Promise<
  | { ok: true; tenantId: string; tableId: string | null; sessionId: string; activation: string }
  | { ok: false; error: string; status: number }
> {
  if (!token) {
    return { ok: false, error: "Missing session credentials. Please scan the table QR code.", status: 401 };
  }
  const { data: row } = await admin()
    .from("table_sessions")
    // `*` rather than a column list on purpose: this function is deployed
    // independently of migration 0076, and naming a column that does not exist
    // yet makes PostgREST fail the whole query — which would read as "invalid
    // session" and break every diner order in the window between the two.
    .select("*, table:tables(id, active)")
    .eq("token", token)
    .maybeSingle();
  if (!row) {
    return { ok: false, error: "Invalid session. Please scan the table QR code.", status: 401 };
  }
  if (row.status !== "ACTIVE") {
    return {
      ok: false,
      error: "Session ended. Please scan the table QR code again to continue.",
      status: 403,
    };
  }
  const rel = (row as any).table;
  const table = Array.isArray(rel) ? rel[0] : rel;
  if (!table || table.active === false) {
    return { ok: false, error: "This table is no longer available.", status: 403 };
  }
  // The table and the session travel with the tenant: an order written without
  // them is an order that cannot be traced back to where it was placed — the
  // card shows no table, and the bill and the review prompt lose their link.
  return {
    ok: true,
    tenantId: row.tenant_id,
    tableId: row.table_id ?? null,
    sessionId: row.id,
    // PENDING means the table has not been accepted yet: the order is created
    // and priced, but held out of the kitchen and out of the bill.
    activation: String((row as any).activation_status ?? "ACTIVE"),
  };
}

async function endTableSession(tenantId: string, tableId?: string, sessionId?: string) {
  let query = admin()
    .from("table_sessions")
    .update({ status: "ENDED", ended_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("status", "ACTIVE");
  if (sessionId) query = query.eq("id", sessionId);
  if (tableId) query = query.eq("table_id", tableId);
  await query;
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "orders");
  const url = new URL(req.url);

  try {
    switch (req.method) {
      case "GET":
        if (segments[0] === "sync") return await sync(req);
        if (segments[0] === "by-key" && segments[1]) return await getByKey(req, segments[1]);
        if (segments[0]) return await getOne(req, segments[0]);
        if (url.searchParams.get("id")) return await getOne(req, url.searchParams.get("id")!);
        return await list(req);
      case "POST":
        if (segments[0] && segments[1] === "items") return await addItem(req, segments[0]);
        if (segments[0] && segments[1] === "accept") return await acceptHeldOrder(req, segments[0]);
        if (segments[0] && segments[1] === "reject") return await rejectHeldOrder(req, segments[0]);
        return await create(req);
      case "PATCH":
      case "PUT":
        if (segments[0] && segments[1] === "items") return await patchItem(req, segments[0]);
        return await update(req, segments[0] ?? url.searchParams.get("id"));
      case "DELETE":
        return await remove(req, segments[0] ?? url.searchParams.get("id"));
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

/**
 * "Did my checkout commit?" — the reconciliation read behind every uncertain
 * retry in the client queue. Staff/owner callers are scoped to their tenant;
 * a diner's session must own the order. Anything else is a 404, not a 403 —
 * the existence of a key is itself information a stranger should not get.
 */
async function getByKey(req: Request, key: string): Promise<Response> {
  if (!UUID_RE.test(key)) return json(req, { error: "Not found" }, 404);
  const db = admin();

  const g = await guard(req, { permission: "orders.view" }).catch(() => null);
  if (g?.ok) {
    const { data, error } = await db
      .from("orders")
      .select(ORDER_SELECT)
      .eq("idempotency_key", key)
      .eq("tenant_id", g.session.tenantId)
      .maybeSingle();
    if (error) return json(req, { error: error.message }, 500);
    if (!data) return json(req, { error: "Not found" }, 404);
    return json(req, mapOrder(data));
  }

  const token = new URL(req.url).searchParams.get("tableSessionToken") ?? "";
  const session = await validateDinerSession(token);
  if (!session.ok) return json(req, { error: session.error }, session.status);
  const { data, error } = await db
    .from("orders")
    .select(ORDER_SELECT)
    .eq("idempotency_key", key)
    .eq("table_session_id", session.sessionId)
    .maybeSingle();
  if (error) return json(req, { error: error.message }, 500);
  if (!data) return json(req, { error: "Not found" }, 404);
  return json(req, mapOrder(data));
}

async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "orders.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");

  let query = admin()
    .from("orders")
    .select(ORDER_SELECT)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (status && status !== "all") query = query.eq("status", status);
  if (type && type !== "all") query = query.eq("order_type", type);

  const { data, error } = await query;
  if (error) return json(req, { error: error.message }, 500);

  return json(req, (data || []).map(mapOrder));
}

async function getOne(req: Request, id: string): Promise<Response> {
  const g = await guard(req, { permission: "orders.view" });
  if (!g.ok) return g.response;

  const { data, error } = await admin()
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId) // tenant scoping — see header
    .maybeSingle();

  if (error) return json(req, { error: error.message }, 500);
  if (!data) return json(req, { error: "Not found" }, 404);
  return json(req, mapOrder(data));
}

/**
 * Price an order's lines from the database and write it.
 *
 * Shared by the till and the diner's QR page, deliberately: this is where a
 * dish's portion decides the price, and having one implementation is what stops
 * the two paths charging differently — which is exactly what happened when the
 * public path went through the legacy `place_order` function instead, and a
 * diner's Half was billed at the base price.
 *
 * Client prices are never trusted; every line is re-read and re-priced here.
 */
/**
 * Price, then commit — retrying the whole price+commit cycle once when the
 * transaction's in-commit guards report that the menu or the promo changed
 * underneath us. The same idempotency key is reused for the retry: the failed
 * attempt rolled back completely, so the key is still free.
 */
async function priceAndCreateOrder(
  db: ReturnType<typeof admin>,
  args: {
    tenantId: string;
    tableId: string | null;
    tableSessionId: string | null;
    items: any[];
    orderType?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    notes?: string | null;
    promoCode?: string | null;
    servedById?: string | null;
    /** PENDING (default) or PENDING_ACTIVATION while the table awaits approval. */
    status?: "PENDING" | "PENDING_ACTIVATION";
  },
  idempotencyKey: string | null = null,
): Promise<
  | { ok: true; order: any; promoApplied: boolean; promoReason?: string; deduplicated?: boolean }
  | { ok: false; error: string; status: number; reason?: "empty" | "unavailable" }
> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await priceAndCommitOnce(db, args, idempotencyKey);
    if (result.ok) return result;
    if ((result as any).retry && attempt === 0) continue;
    if ((result as any).retry) {
      // Second refusal: the menu or promo genuinely does not fit this cart.
      // Say it plainly instead of looping.
      return { ok: false, error: "The order could not be completed as priced. Please review the cart and try again.", status: 409 };
    }
    return result;
  }
  return { ok: false, error: "Failed to place order", status: 500 };
}

async function priceAndCommitOnce(
  db: ReturnType<typeof admin>,
  args: {
    tenantId: string;
    tableId: string | null;
    tableSessionId: string | null;
    items: any[];
    orderType?: string | null;
    customerName?: string | null;
    customerPhone?: string | null;
    notes?: string | null;
    promoCode?: string | null;
    servedById?: string | null;
  },
  idempotencyKey: string | null,
): Promise<
  | { ok: true; order: any; promoApplied: boolean; promoReason?: string; deduplicated?: boolean }
  | { ok: false; error: string; status: number; reason?: "empty" | "unavailable"; retry?: boolean }
> {
  const {
    tenantId, tableId, tableSessionId, items, orderType,
    customerName, customerPhone, notes, promoCode, servedById,
  } = args;

  // One read for every dish on the order rather than one per line. Malformed ids
  // are dropped first so one bad line cannot fail the whole query — it reads as
  // a dish that was not found.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const wantedIds = Array.from(
    new Set(
      (items || [])
        .map((it: any) => String(it?.menuItemId ?? ""))
        .filter((id) => UUID.test(id)),
    ),
  );
  const menuById = new Map<string, any>();
  if (wantedIds.length > 0) {
    const { data: menuRows, error: menuError } = await db
      .from("menu_items")
      .select("id, tenant_id, name, price, portions, available")
      .in("id", wantedIds);
    if (menuError) return { ok: false, error: menuError.message, status: 500 };
    for (const row of (menuRows ?? []) as any[]) menuById.set(row.id, row);
  }

  let sawUnavailable = false;
  const itemData: any[] = [];
  for (const it of items || []) {
    const mi = menuById.get(String(it?.menuItemId ?? ""));
    if (!mi) continue;
    if (mi.tenant_id !== tenantId) continue; // ensure item belongs to this tenant
    if (mi.available === false) {
      // The dish was taken off the menu between the menu being read and the
      // order arriving. Its line is dropped, and the caller is told why.
      sawUnavailable = true;
      continue;
    }
    const unit = resolveOrderUnitPrice(mi, it.portion, it.portionId);
    if (!unit.ok) return { ok: false, error: unit.error, status: 400 };
    const qty = Math.max(1, Number(it.quantity) || 1);
    const cleanNotes = String(it.notes ?? "").trim() || null;

    // Merge duplicate lines for the same dish + portion + note so an order
    // never creates duplicate order_items rows or double-charges a line.
    const existing = itemData.find(
      (row) =>
        row.menu_item_id === mi.id &&
        (row.portion_id ?? null) === (unit.portionId ?? null) &&
        (row.notes ?? null) === cleanNotes,
    );
    if (existing) {
      existing.quantity += qty;
    } else {
      itemData.push({
        menu_item_id: mi.id,
        name: mi.name,
        price: unit.price,
        portion_id: unit.portionId,
        portion: unit.portion,
        quantity: qty,
        notes: cleanNotes,
        status: "PENDING",
      });
    }
  }

  if (itemData.length === 0) {
    return sawUnavailable
      ? { ok: false, error: "One or more items are no longer available", status: 400, reason: "unavailable" }
      : { ok: false, error: "No valid items in order", status: 400, reason: "empty" };
  }

  const itemsTotal = itemData.reduce((s, row) => s + row.price * row.quantity, 0);

  const { data: tenant, error: tenantError } = await db
    .from("tenants")
    .select("tax_rate, service_charge, currency_symbol")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) return { ok: false, error: tenantError.message, status: 500 };

  const taxRate = (tenant?.tax_rate ?? 8) / 100;
  const serviceRate = (tenant?.service_charge ?? 0) / 100;

  // One authority on whether the code applies, and why not if it does not.
  const promoEval = await evaluatePromo(db, tenantId, promoCode, itemsTotal, {
    currencySymbol: tenant?.currency_symbol ?? "₹",
  });

  const discount = promoEval.discount;
  const promoCodeId = promoEval.applied ? promoEval.promo.id : undefined;
  const promoCodeStr = promoEval.applied ? promoEval.code : undefined;

  const tax = +((itemsTotal - discount) * taxRate).toFixed(2);
  const serviceCharge = +(itemsTotal * serviceRate).toFixed(2);
  const total = +(itemsTotal - discount + tax + serviceCharge).toFixed(2);

  // One transaction writes order, items and the promo usage increment (see
  // migration 0056): a failure anywhere rolls all three back together, so an
  // order can no longer exist without its items, and a promo use can no
  // longer be burned on an order that never committed. The idempotency key
  // rides along — a replay returns the original order instead of a duplicate.
  const { data: tx, error: txError } = await db.rpc("create_order_tx", {
    p_order: {
      tenant_id: tenantId,
      table_id: tableId,
      table_session_id: tableSessionId,
      order_type: orderType || "DINE_IN",
      items_total: +itemsTotal.toFixed(2),
      discount: +discount.toFixed(2),
      tax,
      service_charge: serviceCharge,
      total,
      promo_code_id: promoCodeId ?? null,
      promo_code: promoCodeStr,
      customer_name: customerName || null,
      customer_phone: customerPhone || null,
      notes: notes || null,
      served_by_id: servedById ?? null,
    },
    p_items: itemData,
    p_promo_code_id: promoCodeId ?? null,
    p_idempotency_key: idempotencyKey,
    // The status argument is omitted unless it is the new value: before
    // migration 0076 only the four-argument function exists, and passing a
    // fifth would fail the call outright. A held order cannot occur until the
    // migration has run, so this is exactly the right split.
    ...(args.status === "PENDING_ACTIVATION" ? { p_status: "PENDING_ACTIVATION" } : {}),
  });

  if (txError) {
    const msg = String(txError.message ?? "");
    // The in-transaction guards rejected a line or the promo after pricing —
    // something changed in the few milliseconds since. The caller re-prices
    // and retries once with the same key; the first attempt left nothing.
    if (msg.includes("PROMO_REJECTED") || msg.includes("ITEM_UNAVAILABLE")) {
      return { ok: false, error: msg, status: 409, retry: true };
    }
    return { ok: false, error: txError.message || "Failed to place order", status: 500 };
  }

  const orderId = (tx as any)?.order_id as string | undefined;
  const deduplicated = (tx as any)?.deduplicated === true;
  if (!orderId) return { ok: false, error: "Failed to place order", status: 500 };

  const { data: orderRow, error: fetchError } = await db
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .single();
  if (fetchError || !orderRow) {
    return { ok: false, error: fetchError?.message || "Failed to load order", status: 500 };
  }

  return {
    ok: true,
    order: mapOrder(orderRow),
    promoApplied: promoEval.applied,
    promoReason: promoEval.reason,
    deduplicated,
  };
}

async function create(req: Request): Promise<Response> {
  try {
    const b = await body(req) as any;
    const {
      orderType,
      items,
      promoCode,
      customerName,
      customerPhone,
      notes,
      servedById,
      tableSessionToken,
    } = b;
    const idempotencyKey = cleanIdempotencyKey(b.idempotencyKey);

    const db = admin();

    // ── 1. Public: customer order via scanned table QR code ────────────────
    // The same pricing path the POS uses, from the same code. This branch used
    // to hand the lines to the legacy `place_order` function in the database,
    // which knows nothing about portions: a diner who chose Half was recorded
    // with no portion at all and charged the dish's base price. The session is
    // still validated first, so the public menu keeps its exact 401/403
    // contract, and each refusal is reported in the words that page expects.
    if (tableSessionToken) {
      const session = await validateDinerSession(tableSessionToken);
      if (!session.ok) return json(req, { error: session.error }, session.status);

      // Ordering is the expensive anonymous write. Bounded per session: a
      // diner re-tapping because the button felt slow cannot flood the
      // kitchen, and the idempotency key still collapses a genuine double
      // submit into one order.
      const gate = await rateLimit(await bucketKey("order:session", tableSessionToken), 30, 60);
      if (!gate.allowed) {
        return json(
          req,
          { error: "Too many orders just now. Please wait a moment." },
          429,
        );
      }

      // Single source of truth: check auto_accept_orders from tenant settings
      const { data: autoAcceptSetting } = await db
        .from("settings")
        .select("value")
        .eq("tenant_id", session.tenantId)
        .eq("key", "auto_accept_orders")
        .maybeSingle();

      const autoAccept = autoAcceptSetting?.value === "true";
      // If Auto Accept is ON, send directly to kitchen (held = false)
      // If Auto Accept is OFF, incoming table orders are held awaiting acceptance
      const held = !autoAccept;

      if (autoAccept && session.activation === "PENDING") {
        await db
          .from("table_sessions")
          .update({
            activation_status: "ACTIVE",
            activated_at: new Date().toISOString(),
          })
          .eq("id", session.sessionId);
      }

      const created = await priceAndCreateOrder(db, {
        tenantId: session.tenantId,
        tableId: session.tableId,
        tableSessionId: session.sessionId,
        items,
        orderType,
        customerName,
        customerPhone,
        notes,
        promoCode,
        servedById: null,
        status: held ? "PENDING_ACTIVATION" : "PENDING",
      }, idempotencyKey);

      if (!created.ok) {
        return json(
          req,
          {
            error:
              created.reason === "unavailable"
                ? "One or more items are no longer available"
                : created.error,
          },
          created.status,
        );
      }

      // A replay carries the original order but must not rebroadcast it — the
      // kitchen already has the card; a second event only risks a duplicate.
      if (!created.deduplicated) {
        if (held) {
          // The kitchen must not hear this one: a held order is not being
          // cooked. The floor hears it instead, so it can accept the table.
          await publishToStaff(created.order.tenantId, "ACTIVATION_REQUESTED", {
            order: orderEvent(created.order),
          });
          publishToDiner(tableSessionToken, "ACTIVATION_REQUESTED", {
            order: orderEvent(created.order),
          });
        } else {
          await publishOrderEvent({
            type: "ORDER_CREATED",
            tenantId: created.order.tenantId,
            order: created.order,
            sessionToken: tableSessionToken,
          });
        }
      }
      // `held` travels with the order so the menu can show the waiting state
      // without a second round trip.
      return json(req, { ...created.order, pendingActivation: held }, 201);
    }

    // ── 2. POS / Staff / Dashboard order ───────────────────────────────────
    const g = await guard(req, { permission: "orders.create" });
    if (!g.ok) return g.response;
    const tenantId = g.session.tenantId;

    let tableId: string | null = null;
    let tableSessionId: string | null = null;

    if (b.tableId) {
      tableId = b.tableId;
      if (b.tableSessionId) {
        tableSessionId = String(b.tableSessionId);
      } else {
        const { data: activeSession } = await db
          .from("table_sessions")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("table_id", tableId)
          .eq("status", "ACTIVE")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (activeSession) tableSessionId = activeSession.id;
      }
    }

    // Verify servedById if provided
    let validServedById: string | null = null;
    if (servedById) {
      const { data: user } = await db
        .from("profiles")
        .select("id")
        .eq("id", servedById)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (user) validServedById = user.id;
    }

    const created = await priceAndCreateOrder(db, {
      tenantId,
      tableId,
      tableSessionId,
      items,
      orderType,
      customerName,
      customerPhone,
      notes,
      promoCode,
      servedById: validServedById,
    }, idempotencyKey);

    if (!created.ok) return json(req, { error: created.error }, created.status);

    if (!created.deduplicated) {
      await publishOrderEvent({
        type: "ORDER_CREATED",
        tenantId,
        order: created.order,
        sessionToken: await sessionTokenFor(created.order),
      });
    }
    // The promo verdict travels with the order so the POS can tell the
    // cashier why a code did not apply, instead of silently charging full
    // price on a total the cashier had already seen discounted.
    return json(
      req,
      {
        ...created.order,
        promoApplied: created.promoApplied,
        promoReason: created.promoReason,
        ...(created.deduplicated ? { deduplicated: true } : {}),
      },
      201,
    );
  } catch (error: any) {
    console.error("Order creation error:", error);
    return json(req, { error: error?.message || "Failed to place order" }, 500);
  }
}

/**
 * POST /orders/:id/accept — accept one held order.
 *
 * Acceptance belongs to the table, but it is *expressed* on the order, and the
 * two had been fused into one button: a held card offered "Start Preparing",
 * which had to accept the table and start cooking in the same press. That left
 * no way to accept without cooking, and no way to refuse a single order at all.
 *
 * So this is the step that was missing. It runs the same table-wide RPC the POS
 * Accept button uses — a second diner's held orders are released with it, which
 * is the behaviour that already existed and is preserved — and then the order
 * is Pending, not Preparing. Cooking stays a separate, deliberate press.
 *
 * Idempotent: accepting an order that is no longer held answers what it is now.
 */
async function acceptHeldOrder(req: Request, id: string): Promise<Response> {
  const g = await guard(req, { permission: "table-sessions.manage" });
  if (!g.ok) return g.response;

  const db = admin();
  const { data: current } = await db
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();

  if (!current) return json(req, { error: "Order not found" }, 404);
  if (current.status !== "PENDING_ACTIVATION") {
    // Already accepted, already cooking, already done: nothing to do, and
    // saying so is better than pretending to accept it again.
    return json(req, { ok: true, already: true, status: current.status });
  }

  const sessionId = (current as any).table_session_id as string | null;

  if (sessionId) {
    const { error: activateError } = await admin().rpc("approve_table_activation", {
      p_tenant: g.session.tenantId,
      p_session: sessionId,
      p_actor: g.session.kind === "owner" ? g.session.subjectId : null,
    });

    if (activateError) {
      const message = String(activateError.message ?? "");
      if (message.includes("ITEMS_UNAVAILABLE:")) {
        return json(
          req,
          { error: `These dishes are no longer available: ${message.split("ITEMS_UNAVAILABLE:")[1]}`, code: "items_unavailable" },
          409,
        );
      }
      if (message.includes("SESSION_")) {
        return json(req, { error: "That table session has already ended.", code: "session_ended" }, 409);
      }
      return json(req, { error: message || "Could not accept the order." }, 500);
    }
  } else {
    // Rung up at the till: no diner session, so nobody to accept and nothing to
    // release. The staff member pressing the button is the acceptance.
    const { error: promoteError } = await db
      .from("orders")
      .update({ status: "PENDING", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", g.session.tenantId)
      .eq("status", "PENDING_ACTIVATION");
    if (promoteError) return json(req, { error: promoteError.message }, 500);
  }

  const { data: fresh } = await db
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();
  const order = fresh ? mapOrder(fresh) : null;

  if (order) {
    await publishOrderEvent({
      type: "ORDER_UPDATED",
      tenantId: g.session.tenantId,
      order,
      sessionToken: await sessionTokenFor(order),
    });
  }

  // The table may have released siblings too; tell the room about those.
  if (sessionId) {
    for (const sibling of await releasedSiblings(g.session.tenantId, sessionId)) {
      if (sibling.id === id) continue;
      await publishOrderEvent({
        type: "ORDER_UPDATED",
        tenantId: g.session.tenantId,
        order: sibling,
        sessionToken: await sessionTokenFor(sibling),
      });
    }
  }

  return json(req, { ok: true, already: false, status: order?.status ?? "PENDING", order });
}

/**
 * POST /orders/:id/reject — refuse one held order.
 *
 * Scoped to the order, not the table: a table can have three held orders and
 * one of them be wrong. The session and the other orders are untouched, and
 * the rejected order never enters the bill — it is CANCELLED, and every total
 * already excludes that.
 *
 * Gated on the floor key rather than `orders.cancel`: nothing was cooked and
 * nothing was charged, so this is a decision about a table, not the
 * cancellation of a live order.
 */
async function rejectHeldOrder(req: Request, id: string): Promise<Response> {
  const g = await guard(req, { permission: "table-sessions.manage" });
  if (!g.ok) return g.response;

  const b = await body(req).catch(() => ({} as any));
  const reason = b?.reason ? String(b.reason).slice(0, 200) : null;

  const db = admin();
  const { data: current } = await db
    .from("orders")
    .select("id, status, table_session_id")
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();

  if (!current) return json(req, { error: "Order not found" }, 404);
  if (current.status !== "PENDING_ACTIVATION") {
    return json(
      req,
      { error: "This order has already been accepted — cancel it instead.", code: "already_accepted" },
      409,
    );
  }

  const { error } = await db
    .from("orders")
    .update({
      status: "CANCELLED",
      updated_at: new Date().toISOString(),
      cancellation_reason: reason ?? "Order not accepted by the restaurant",
    })
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId)
    .eq("status", "PENDING_ACTIVATION");

  if (error) return json(req, { error: error.message }, 500);

  await db.from("security_logs").insert({
    tenant_id: g.session.tenantId,
    user_id: g.session.kind === "owner" ? g.session.subjectId : null,
    actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
    action: "ORDER_REJECTED",
    user_agent: req.headers.get("user-agent") || "unknown",
    meta: `Held order ${id} rejected${reason ? `: ${reason}` : ""}`,
  }).then(() => {}).catch(() => {});

  const { data: fresh } = await db
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();
  const order = fresh ? mapOrder(fresh) : null;

  if (order) {
    await publishOrderEvent({
      type: "ORDER_UPDATED",
      tenantId: g.session.tenantId,
      order,
      sessionToken: await sessionTokenFor(order),
    });
  }

  return json(req, { ok: true, status: "CANCELLED", order });
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req);
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);

  const b = await body(req) as any;
  const perms = g.session.permissions;
  const refuse = (permission: string) =>
    json(req, { error: "Forbidden", required: permission }, 403);

  // ── Action gates, decided from the fields BEFORE the order is looked up ──
  // Each action has its own permission (orders.prepare / .ready / .serve /
  // .complete / .cancel, payments.collect, orders.edit). Gating first means a
  // refused action answers 403 even when the order does not exist — and an
  // unknown order stays unguessable to a caller without the action's key.
  if (b.status !== undefined) {
    const targetKey = ORDER_STATUS_KEYS[String(b.status).toUpperCase()];
    if (targetKey && !hasEffectivePermission(perms, targetKey)) {
      return refuse(targetKey);
    }
  }
  const wantsPayment = b.paymentMethod !== undefined || b.paymentStatus !== undefined;
  if (wantsPayment && !hasEffectivePermission(perms, "payments.collect")) {
    return refuse("payments.collect");
  }
  const wantsEdit =
    b.tableId !== undefined || b.customerName !== undefined || b.notes !== undefined;
  if (wantsEdit && !hasEffectivePermission(perms, "orders.edit")) {
    return refuse("orders.edit");
  }
  // An empty no-write request still has to belong to someone who may read.
  if (
    b.status === undefined && !wantsPayment && !wantsEdit &&
    !hasEffectivePermission(perms, "orders.view")
  ) {
    return refuse("orders.view");
  }

  // Load the current row first: every rule below is checked against what the
  // database says the order is, never against what the caller hopes it is.
  const db = admin();
  // `let` because accepting a table re-reads this row inside the request.
  let { data: current, error: currentError } = await db
    .from("orders")
    .select("id, status, payment_status, payment_method")
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId) // tenant scoping — see header
    .maybeSingle();
  if (currentError) return json(req, { error: currentError.message }, 500);
  if (!current) return json(req, { error: "Order not found" }, 404);


  /**
   * The status machine. An order only ever moves forward — a stale screen or
   * a second staff member cannot pull a completed order back to READY, and a
   * retry of the move the order already made is a no-op, not an error.
   */
  const NEXT: Record<string, string[]> = {
    PENDING: ["PREPARING", "CANCELLED"],
    PREPARING: ["READY", "CANCELLED"],
    READY: ["SERVED", "CANCELLED"],
    SERVED: ["COMPLETED", "CANCELLED"],
    COMPLETED: [],
    CANCELLED: [],
  };
  const ORDER_STATUSES = Object.keys(NEXT);

  const data: any = {};
  if (b.status) {
    const target = String(b.status).toUpperCase();
    if (!ORDER_STATUSES.includes(target)) {
      return json(req, { error: `Unknown order status ${target}.` }, 400);
    }
    if (!hasEffectivePermission(perms, ORDER_STATUS_KEYS[target])) {
      return refuse(ORDER_STATUS_KEYS[target]);
    }
    // ── Start Preparing on a held order accepts the table first ────────────
    // A held order is one nobody has accepted the table for. The kitchen
    // pressing "Start Preparing" is that acceptance, so it runs the same
    // table-wide RPC the POS Accept button uses: atomic, idempotent, and it
    // releases every held order on the table — not just this one.
    //
    // It needs the floor key as well as the kitchen key: cooking food nobody
    // accepted is exactly the decision this guard exists for.
    if (target === "PREPARING" && current.status === "PENDING_ACTIVATION") {
      // An order rung up at the till has a table but no diner session: there
      // is nobody to accept, and nothing to release — the staff member holding
      // the button is the acceptance. It is simply promoted.
      const sessionId = (current as any).table_session_id;
      if (!sessionId) {
        const { error: promoteError } = await db
          .from("orders")
          .update({ status: "PENDING", updated_at: new Date().toISOString() })
          .eq("id", id)
          .eq("tenant_id", g.session.tenantId)
          .eq("status", "PENDING_ACTIVATION");
        if (promoteError) return json(req, { error: promoteError.message }, 500);

        const { data: promoted } = await db
          .from("orders")
          .select(ORDER_SELECT)
          .eq("id", id)
          .eq("tenant_id", g.session.tenantId)
          .maybeSingle();
        if (promoted) current = promoted;
      } else {
        if (!hasEffectivePermission(perms, "table-sessions.manage")) {
          return json(
            req,
            {
              error: "This table has not been accepted yet. Ask someone who can manage the floor to accept it.",
              code: "activation_required",
            },
            403,
          );
        }
      }

      if (sessionId) {
        const { error: activateError } = await admin().rpc("approve_table_activation", {
          p_tenant: g.session.tenantId,
          p_session: sessionId,
          p_actor: g.session.kind === "owner" ? g.session.subjectId : null,
        });

        if (activateError) {
          const message = String(activateError.message ?? "");
          if (message.includes("ITEMS_UNAVAILABLE:")) {
            return json(
              req,
              { error: `These dishes are no longer available: ${message.split("ITEMS_UNAVAILABLE:")[1]}`, code: "items_unavailable" },
              409,
            );
          }
          if (message.includes("SESSION_")) {
            return json(req, { error: "That table session has already ended.", code: "session_ended" }, 409);
          }
          return json(req, { error: message || "Could not accept the table." }, 500);
        }

        // The approval released this order (and its siblings) to PENDING; read
        // the row again so the transition below runs against the new state.
        const { data: fresh, error: freshError } = await db
          .from("orders")
          .select(ORDER_SELECT)
          .eq("id", id)
          .eq("tenant_id", g.session.tenantId)
          .maybeSingle();
        if (freshError) return json(req, { error: freshError.message }, 500);
        if (fresh) current = fresh;

        for (const sibling of (await releasedSiblings(g.session.tenantId, sessionId))) {
          await publishOrderEvent({
            type: "ORDER_UPDATED",
            tenantId: g.session.tenantId,
            order: sibling,
            sessionToken: await sessionTokenFor(sibling),
          });
        }
      }
    }

    if (b.kotNumber) {
      await db
        .from("order_items")
        .update({ status: target })
        .eq("order_id", id)
        .eq("kot_number", Number(b.kotNumber));

      const { data: allItems } = await db
        .from("order_items")
        .select("status")
        .eq("order_id", id);

      const statuses = (allItems ?? []).map((i) => i.status);
      let aggregate = target;
      if (statuses.includes("PENDING")) aggregate = "PENDING";
      else if (statuses.includes("PREPARING")) aggregate = "PREPARING";
      else if (statuses.includes("READY")) aggregate = "READY";
      else if (statuses.length > 0 && statuses.every((s) => s === "SERVED")) aggregate = "SERVED";
      else if (statuses.length > 0 && statuses.every((s) => s === "COMPLETED")) aggregate = "COMPLETED";

      data.status = aggregate;
      data.updated_at = new Date().toISOString();
    } else if (target !== current.status) {
      if (!(NEXT[current.status] ?? []).includes(target)) {
        return json(
          req,
          {
            error: `Order #${id} is ${current.status}; it cannot move to ${target}.`,
            currentStatus: current.status,
          },
          409,
        );
      }
      data.status = target;
      await db
        .from("order_items")
        .update({ status: target })
        .eq("order_id", id);
      if (target === "CANCELLED") {
        // Auditable cancellation — recorded only when the transition is real:
        // the order row stays (status CANCELLED) and the actor is logged, so
        // history is preserved without hard deletion.
        await db.from("security_logs").insert({
          tenant_id: g.session.tenantId,
          user_id: g.session.kind === "owner" ? g.session.subjectId : null,
          actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
          action: "ORDER_CANCELLED",
          user_agent: req.headers.get("user-agent") || "unknown",
          meta: `Order #${id} cancelled`,
        }).catch(() => {});
      }
      if (target === "COMPLETED") {
        data.completed_at = new Date().toISOString();
        // Payment is NOT touched here. Completing an order and being paid for
        // it are different facts: a dine-in bill is settled at the counter,
        // after the meal, and an unpaid order must never become "paid" as a
        // side effect of moving through the kitchen.
      }
    }
  }
  if (b.paymentMethod) data.payment_method = b.paymentMethod;
  if (b.paymentStatus) {
    const target = String(b.paymentStatus).toUpperCase();
    if (target === "PAID") {
      if (current.payment_status !== "PAID") {
        // Recording a payment requires saying how it was paid — otherwise the
        // bill can never show a method, and the books cannot be reconciled.
        const method = b.paymentMethod || current.payment_method;
        if (!method) {
          return json(req, { error: "A payment method is required to record a payment." }, 400);
        }
        data.payment_status = "PAID";
        data.payment_method = method;
      }
      // Already PAID → idempotent no-op (a double-tap on Pay is safe).
    } else if (target === "UNPAID") {
      if (current.payment_status === "PAID") {
        // Money never un-flows through a status write; a refund is a ledger
        // event, not a flag flip.
        return json(
          req,
          { error: "A paid order cannot be marked unpaid.", currentPaymentStatus: "PAID" },
          409,
        );
      }
      // Already UNPAID → no-op.
    } else {
      return json(req, { error: `Unknown payment status ${target}.` }, 400);
    }
  }
  if (b.tableId !== undefined) data.table_id = b.tableId || null;
  if (b.customerName !== undefined) data.customer_name = b.customerName;
  if (b.notes !== undefined) data.notes = b.notes;

  // A no-op (same-status retry, already-paid re-send) must not reach PostgREST
  // as an empty update — that errors instead of returning the row.
  if (Object.keys(data).length === 0) {
    const { data: unchanged, error: rereadError } = await db
      .from("orders")
      .select(ORDER_SELECT)
      .eq("id", id)
      .eq("tenant_id", g.session.tenantId)
      .single();
    if (rereadError || !unchanged) {
      return json(req, { error: rereadError?.message || "Failed to update order" }, 500);
    }
    return json(req, mapOrder(unchanged));
  }

  // The status write is conditional on the status we validated against, so two
  // staff moving the same order concurrently cannot both win: the second write
  // matches zero rows and is told what the order actually became. Payment-only
  // writes are deliberately NOT status-gated — payment and fulfillment are
  // independent facts.
  const statusGuarded = data.status !== undefined;
  let query = db
    .from("orders")
    .update(data)
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId); // tenant scoping — see header
  if (statusGuarded) query = query.eq("status", current.status);
  const { data: updated, error: updateError } = await query.select(ORDER_SELECT).single();

  if (updateError || !updated) {
    // `data` must be destructured. The builder resolves to the whole PostgREST
    // response — `{ data, error, count, status, statusText }` — so reading
    // `fresh.status` off the builder gives the HTTP status, 200, not the
    // order's status. That made every lost race report "Order #x is 200" and
    // stopped the idempotency check below from ever matching.
    const { data: fresh } = await db
      .from("orders")
      .select("id, status, payment_status")
      .eq("id", id)
      .eq("tenant_id", g.session.tenantId)
      .maybeSingle();
    // Another caller moved the order to exactly where we were moving it —
    // the outcome we wanted exists, so this is a success, not a conflict.
    if (fresh && statusGuarded && fresh.status === data.status) {
      const { data: winner } = await db
        .from("orders")
        .select(ORDER_SELECT)
        .eq("id", id)
        .eq("tenant_id", g.session.tenantId)
        .single();
      return json(req, mapOrder(winner));
    }
    // Zero rows updated means somebody else moved the order between our read
    // and our write. Tell the caller what the order is now, not a 500.
    if (fresh && statusGuarded) {
      return json(
        req,
        {
          error: `Order #${id} is ${fresh.status}; it cannot move to ${data.status}.`,
          currentStatus: fresh.status,
        },
        409,
      );
    }
    return json(req, { error: updateError?.message || "Failed to update order" }, 500);
  }

  const order = mapOrder(updated);

  // If order was marked COMPLETED for a table, instantly end any active session
  // for that table. Best-effort — a failure must not fail the request.
  if (order.status === "COMPLETED" && order.tableId) {
    try {
      // End THIS order's session, not the whole table — and only once nothing
      // else on that session is still outstanding. A diner can place several
      // orders in one visit; completing the first must not close their menu
      // while the second is still being cooked.
      if (order.tableSessionId) {
        const { count: unresolved } = await admin()
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", order.tenantId)
          .eq("table_session_id", order.tableSessionId)
          .not("status", "in", "(COMPLETED,CANCELLED)");

        if (!unresolved) {
          await endTableSession(order.tenantId, undefined, order.tableSessionId);
        }
      }
      // Ending the sitting does not end the bill: a settled check is closed
      // and numbered here, an unpaid one is left open and flagged.
      await admin().rpc("settle_check_on_session_end", {
        p_tenant: order.tenantId,
        p_table: order.tableId,
        p_actor: null,
        p_session: order.tableSessionId ?? null,
      });
    } catch (e) {
      console.error("Failed to end table session on order completion:", e);
    }
  }

  await publishOrderEvent({
    type: "ORDER_UPDATED",
    tenantId: order.tenantId,
    order,
    sessionToken: await sessionTokenFor(order),
  });
  if (order.status === "COMPLETED" && order.tableId) {
    await publishToStaff(order.tenantId, "SESSION_ENDED", {
      order: { id: order.id, tableId: order.tableId, status: "COMPLETED" },
    });
  }

  return json(req, order);
}

async function remove(req: Request, id: string | null): Promise<Response> {
  // Hard deletion of an order row is reserved for the owner tier and records
  // an audit line: cancellation (orders.cancel) preserves the row, which is
  // the path every staff member uses. Delete is data-repair, not a routine.
  const g = await guard(req, { permission: "roles.manage" });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);

  const db = admin();
  const { data: order } = await db
    .from("orders")
    .select("id, tenant_id, order_number")
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId) // tenant scoping — see header
    .maybeSingle();

  if (order) {
    await db.from("orders").delete().eq("id", id).eq("tenant_id", g.session.tenantId);
    await db.from("security_logs").insert({
      tenant_id: order.tenant_id,
      user_id: g.session.kind === "owner" ? g.session.subjectId : null,
      actor_staff_id: g.session.kind === "staff" ? g.session.subjectId : null,
      action: "ORDER_DELETED",
      ip: null,
      user_agent: req.headers.get("user-agent") || "unknown",
      meta: `Order #${order.order_number} permanently deleted`,
    }).catch(() => {});
    await publishOrderEvent({
      type: "ORDER_DELETED",
      tenantId: order.tenant_id,
      order: { id, tenantId: order.tenant_id, status: order.status },
      sessionToken: await sessionTokenFor(order),
    });
  }

  return json(req, { success: true });
}

/** Recompute an order's totals from its current items, matching the old logic. */
async function recalcOrderTotals(orderId: string, tenantId: string) {
  const db = admin();

  const { data: order } = await db
    .from("orders")
    .select("tenant_id, discount")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!order) return;

  const { data: items } = await db
    .from("order_items")
    .select("price, quantity")
    .eq("order_id", orderId);

  const itemsTotal = (items || []).reduce((s, i) => s + i.price * i.quantity, 0);

  const { data: tenant } = await db
    .from("tenants")
    .select("tax_rate, service_charge")
    .eq("id", order.tenant_id)
    .maybeSingle();

  const taxRate = (tenant?.tax_rate ?? 8) / 100;
  const serviceRate = (tenant?.service_charge ?? 0) / 100;
  const discount = order.discount || 0;
  const tax = +((itemsTotal - discount) * taxRate).toFixed(2);
  const serviceCharge = +(itemsTotal * serviceRate).toFixed(2);
  const total = +(itemsTotal - discount + tax + serviceCharge).toFixed(2);

  await db
    .from("orders")
    .update({
      items_total: +itemsTotal.toFixed(2),
      tax,
      service_charge: serviceCharge,
      total,
    })
    .eq("id", orderId)
    .eq("tenant_id", tenantId);
}

// Add items to existing order (Takeaway and Delivery only)
async function addItem(req: Request, orderId: string): Promise<Response> {
  const g = await guard(req, { permission: "orders.edit" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  // RBAC enforcement: Accessible only to Owner, Manager, Cashier
  const callerRole = g.session.kind === "owner" ? "Owner" : (g.session.role ?? "");
  const allowedRoles = ["owner", "manager", "cashier"];
  if (!allowedRoles.includes(callerRole.toLowerCase())) {
    return json(req, { error: "Forbidden: Only Owner, Manager, and Cashier can add items to orders." }, 403);
  }

  const b = await body(req) as any;
  const db = admin();

  const rawItems: any[] = Array.isArray(b.items) ? b.items : [b];
  if (rawItems.length === 0 || !rawItems[0].menuItemId) {
    return json(req, { error: "At least one valid menu item is required." }, 400);
  }

  const itemIds = [...new Set(rawItems.map((i) => i.menuItemId).filter(Boolean))];
  const { data: menuItems, error: miError } = await db
    .from("menu_items")
    .select("id, name, price, portions, available")
    .in("id", itemIds)
    .eq("tenant_id", tenantId);

  if (miError) return json(req, { error: miError.message }, 500);
  const miMap = new Map((menuItems ?? []).map((m) => [m.id, m]));

  const validatedLines: any[] = [];
  for (const raw of rawItems) {
    const mi = miMap.get(raw.menuItemId);
    if (!mi) return json(req, { error: `Menu item not found: ${raw.menuItemId}` }, 404);
    if (!mi.available) return json(req, { error: `Menu item "${mi.name}" is currently unavailable.` }, 400);

    const unit = resolveOrderUnitPrice(mi, raw.portion, raw.portionId);
    if (!unit.ok) return json(req, { error: unit.error }, 400);

    const qty = Math.max(1, Math.floor(Number(raw.quantity) || 1));
    validatedLines.push({
      menu_item_id: mi.id,
      name: mi.name,
      portion_id: unit.portionId,
      portion: unit.portion,
      price: unit.price,
      quantity: qty,
      notes: (raw.notes ? String(raw.notes).trim() : null) || null,
    });
  }

  const idemKey = cleanIdempotencyKey(b.idempotencyKey);

  // Atomic database transaction with row-level lock and separate KOT allocation
  const { data: txResult, error: txError } = await db.rpc("add_items_to_order_tx", {
    p_order_id: orderId,
    p_tenant: tenantId,
    p_items: validatedLines,
    p_idempotency_key: idemKey,
  });

  if (txError) {
    const msg = String(txError.message ?? "");
    if (msg.includes("ORDER_NOT_FOUND")) {
      return json(req, { error: "Order not found" }, 404);
    }
    if (msg.includes("INVALID_ORDER_TYPE")) {
      return json(req, { error: "Adding items is restricted to Takeaway and Delivery orders." }, 400);
    }
    if (msg.includes("ORDER_LIFECYCLE_CLOSED")) {
      return json(req, { error: "Cannot add items to a completed or cancelled order." }, 409);
    }
    if (msg.includes("ORDER_ALREADY_PAID")) {
      return json(req, { error: "Cannot add items to an order that is already paid and settled." }, 409);
    }
    if (msg.includes("ITEM_UNAVAILABLE")) {
      return json(req, { error: "One or more items are no longer available." }, 400);
    }
    return json(req, { error: txError.message || "Failed to add items" }, 500);
  }

  // Load the full updated order
  const { data: fullOrder, error: fullError } = await db
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .single();

  if (fullError || !fullOrder) {
    return json(req, { error: "Failed to reload updated order" }, 500);
  }

  const mapped = mapOrder(fullOrder);

  // If this was an idempotent deduplicated replay, return without rebroadcasting
  if ((txResult as any)?.deduplicated) {
    return json(req, mapped, 200);
  }

  // Broadcast Realtime events
  await publishOrderEvent({
    type: "ORDER_UPDATED",
    tenantId,
    order: mapped,
    sessionToken: await sessionTokenFor(mapped),
  });

  await publishToStaff(tenantId, "KOT_ADDED", {
    orderId,
    orderNumber: mapped.orderNumber,
    kotNumber: (txResult as any)?.kot_number,
    orderType: mapped.orderType,
    itemsCount: validatedLines.length,
  });

  return json(req, mapped, 201);
}

// Update item quantity / remove
async function patchItem(req: Request, orderId: string): Promise<Response> {
  const g = await guard(req, { permission: "orders.edit" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const b = await body(req) as any;
  const db = admin();

  const { data: orderRow } = await db
    .from("orders")
    .select("id")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!orderRow) return json(req, { error: "Order not found" }, 404);

  if (b.itemId) {
    if (b.action === "remove") {
      await db.from("order_items").delete().eq("id", b.itemId).eq("order_id", orderId);
    } else if (b.quantity) {
      await db
        .from("order_items")
        .update({ quantity: b.quantity })
        .eq("id", b.itemId)
        .eq("order_id", orderId);
    }
  }

  await recalcOrderTotals(orderId, tenantId);

  const { data: order } = await db
    .from("orders")
    .select("*, items:order_items(*), table:tables(*)")
    .eq("id", orderId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (order) return json(req, mapOrder(order));
  return json(req, { error: "Order not found" }, 404);
}

async function sync(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "orders.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const db = admin();

  // Incremental poll: orders changed after `since`.
  let changedQuery = db
    .from("orders")
    .select("*, items:order_items(*), table:tables(*), servedBy:profiles(id,name)")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      changedQuery = changedQuery.gt("updated_at", sinceDate.toISOString());
    }
  }

  // The summary is one aggregate row, not the newest 200 orders reduced in JS.
  // The old shape stopped counting at 200 orders — a busy day silently froze
  // "orders today" and "active orders" — and pulled 200 rows every four
  // seconds for three numbers (migration 0060).
  const [{ data: changedOrders }, { data: summaryRow, error: summaryError }] = await Promise.all([
    changedQuery,
    db.rpc("tenant_order_summary", { p_tenant: tenantId }),
  ]);

  // If the aggregate fails, fail the poll: the client keeps the last summary it
  // had. Returning zeros instead would put "₹0 revenue" in front of an owner.
  if (summaryError) return json(req, { error: summaryError.message }, 500);

  const orders = (changedOrders || []).map(mapOrder);

  // The authoritative figures for each table check these orders belong to.
  // `table_checks.total` is only written at finalisation, so an open bill has
  // to be summed from its orders and its ledger — the same truth the bill
  // dialog reads, so the Orders header and the bill cannot disagree.
  // Which checks to price.
  //
  // Not only the ones behind this poll's changed orders: the board groups by
  // sitting and shows a bill on every card, so a sitting whose orders have not
  // changed still needs its totals. Reading every bill that is still open (or
  // was touched in the last day) costs one small query and stops the cards
  // falling back to a local sum.
  const openCheckSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: openChecks } = await db
    .from("table_checks")
    .select("id")
    .eq("tenant_id", tenantId)
    .or(`status.in.(OPEN,UNSETTLED),opened_at.gte.${openCheckSince}`);
  const checkIds = [...new Set([
    ...(changedOrders ?? []).map((o: any) => o.check_id).filter(Boolean),
    ...(openChecks ?? []).map((c: any) => c.id),
  ])] as string[];
  const checks: Record<string, {
    orderCount: number;
    /** Before tax: the items, less discount. What the food cost. */
    subtotal: number;
    tax: number;
    total: number;
    paid: number;
    outstanding: number;
    status: string;
    invoiceNumber: string | null;
  }> = {};
  if (checkIds.length) {
    const [{ data: checkRows }, { data: checkOrders }, { data: checkPayments }] = await Promise.all([
      db.from("table_checks").select("id, status, invoice_number").in("id", checkIds).eq("tenant_id", tenantId),
      db.from("orders").select("check_id, total, items_total, discount, tax").in("check_id", checkIds)
        .eq("tenant_id", tenantId).not("status", "in", "(CANCELLED,PENDING_ACTIVATION)"),
      db.from("check_payments").select("check_id, amount").in("check_id", checkIds)
        .eq("tenant_id", tenantId).eq("status", "SUCCEEDED"),
    ]);
    for (const c of checkRows ?? []) {
      checks[c.id] = {
        orderCount: 0, subtotal: 0, tax: 0, total: 0, paid: 0, outstanding: 0,
        status: c.status, invoiceNumber: c.invoice_number ?? null,
      };
    }
    for (const o of checkOrders ?? []) {
      const c = checks[(o as any).check_id];
      if (!c) continue;
      // Pre-tax is the food: item prices, less any discount. Service charge and
      // tax are added on top of it, so it is never the same number as the total
      // and must not be labelled as one.
      c.orderCount += 1;
      c.subtotal += Number((o as any).items_total ?? 0) - Number((o as any).discount ?? 0);
      c.tax += Number((o as any).tax ?? 0);
      c.total += Number((o as any).total ?? 0);
    }
    for (const p of checkPayments ?? []) {
      const c = checks[(p as any).check_id];
      if (c) c.paid += Number((p as any).amount ?? 0);
    }
    for (const c of Object.values(checks)) {
      c.subtotal = +c.subtotal.toFixed(2);
      c.tax = +c.tax.toFixed(2);
      c.total = +c.total.toFixed(2);
      c.paid = +c.paid.toFixed(2);
      c.outstanding = +Math.max(0, c.total - c.paid).toFixed(2);
    }
  }

  const summary = (summaryRow ?? {}) as { revenue?: number; ordersToday?: number; activeOrders?: number };
  const revenue = Number(summary.revenue ?? 0);
  const ordersToday = Number(summary.ordersToday ?? 0);
  const activeOrders = Number(summary.activeOrders ?? 0);

  // The sittings themselves.
  //
  // An order carries `table_session_id`, but nothing about the sitting it
  // belongs to — so a screen grouping by session could say what was ordered
  // and nothing about when the table sat down, how long it has been there, or
  // whether it is still open. Reading those three facts from the row that owns
  // them is the only honest way to show them; deriving them from order
  // timestamps would call a table that is still open "closed" the moment its
  // last order is completed.
  //
  // Read-only, and deliberately separate from the `since` cursor: a session
  // ending writes no order, so a changed-orders poll would never report it.
  // Active sittings are always returned, plus anything that opened recently
  // enough to still be on the board.
  const recentSittings = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: sittingRows } = await db
    .from("table_sessions")
    .select("id, table_id, status, created_at, ended_at")
    .eq("tenant_id", tenantId)
    .or(`status.eq.ACTIVE,created_at.gte.${recentSittings}`);
  const tableSessions: Record<string, {
    id: string;
    tableId: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  }> = {};
  for (const row of sittingRows ?? []) {
    tableSessions[row.id] = {
      id: row.id,
      tableId: row.table_id,
      status: row.status,
      startedAt: row.created_at,
      endedAt: row.ended_at ?? null,
    };
  }

  return json(req, {
    orders,
    checks,
    tableSessions,
    summary: {
      revenue: +revenue.toFixed(2),
      ordersToday,
      activeOrders,
    },
    serverTime: new Date().toISOString(),
  });
}
