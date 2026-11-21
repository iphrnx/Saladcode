// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard, tableSession } from "../_shared/auth.ts";
import { publishToDiner, publishToStaff } from "../_shared/realtime.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/bill/:orderId
 *   GET   finalized bill data for an order
 *
 * Ported from src/app/api/bill/[orderId]/route.ts. The Next version looked the
 * order up by `id` alone — every read here is scoped to the caller's tenant.
 *
 * Two callers are legitimate:
 *   * an owner or staff member with `orders.view` — the POS Bill button
 *   * the diner whose table session produced the order — the "View Bill" link
 *     on the session-ended screen. `window.open` cannot attach an auth header,
 *     so that path passes `?sessionToken=` instead, and the lookup is pinned to
 *     that session so a diner can only ever read their own bill.
 */

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const url = new URL(req.url);
  const segments = subPath(req, "bill");
  const orderId = segments[0] ?? url.searchParams.get("orderId") ?? url.searchParams.get("id");

  try {
    // The consolidated check lives beside the single-order bill. Same function
    // because they are the same subject — money owed for food — and splitting
    // them would mean two places that must agree about tax and totalling.
    if (segments[0] === "settle-cash") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      return await settleCash(req);
    }
    if (segments[0] === "check") {
      if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
      return await getCheck(req);
    }
    if (segments[0] === "payment") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      return await recordPayment(req);
    }
    if (segments[0] === "refund") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      return await refund(req);
    }
    if (segments[0] === "finalize") {
      if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
      return await finalize(req);
    }

    if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);
    return await get(req, orderId);
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

/**
 * The table's open check, with everything the bill needs.
 *
 * Resolved from a session id or a table id, always inside the caller's tenant.
 * The totals are the orders that are actually on the bill: held orders are
 * excluded, cancelled ones too, so a check can never quote food that was not
 * accepted or was called off.
 */
async function checkForTenant(
  tenantId: string,
  sessionId: string | null,
  tableId: string | null,
  checkId: string | null = null,
): Promise<{ check: any; orders: any[]; payments: any[]; gstin: string | null; fssai: string | null; tenant: any; table: any } | null> {
  const db = admin();

  // A named check wins, and does not need the table at all. Resolving by
  // table returns that table's *newest* check, which is the wrong sitting
  // whenever two parties have sat at the same table: the Orders board groups
  // by sitting, and its bill must be that sitting's bill.
  if (checkId) {
    const { data: named } = await db
      .from("table_checks")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("id", checkId)
      .maybeSingle();
    if (!named) return null;
    return await loadCheck(tenantId, named);
  }

  // A session-scoped check takes precedence over table-level resolution
  // so each diner session at the same table has its own independent bill
  if (sessionId) {
    const { data: sessionCheck } = await db
      .from("table_checks")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("session_id", sessionId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sessionCheck) {
      return await loadCheck(tenantId, sessionCheck);
    }
  }

  let table = tableId;
  if (!table && sessionId) {
    const { data: session } = await db
      .from("table_sessions")
      .select("table_id, tenant_id")
      .eq("id", sessionId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    table = session?.table_id ?? null;
  }
  if (!table) return null;

  // The open check, or the most recently settled one for that table.
  const { data: open } = await db
    .from("table_checks")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("table_id", table)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!open) return null;

  return await loadCheck(tenantId, open);
}

/**
 * Controlled backfill: attach unassigned legacy orders for this session to the check.
 * Surfaces any failure so that bills and settlements are never computed with missing orders.
 */
async function backfillSessionOrders(
  db: any,
  tenantId: string,
  checkId: string,
  sessionId: string,
): Promise<void> {
  const { data: unassigned, error: checkErr } = await db
    .from("orders")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("table_session_id", sessionId)
    .is("check_id", null)
    .neq("status", "CANCELLED");

  if (checkErr) {
    throw new Error(`Failed to verify unassigned session orders: ${checkErr.message}`);
  }

  if (unassigned && unassigned.length > 0) {
    const { error: updateErr } = await db
      .from("orders")
      .update({ check_id: checkId })
      .eq("tenant_id", tenantId)
      .eq("table_session_id", sessionId)
      .is("check_id", null);

    if (updateErr) {
      throw new Error(`Failed to attach unassigned orders to bill: ${updateErr.message}`);
    }
  }
}

/** Everything a bill needs, for one check that has already been resolved. */
async function loadCheck(tenantId: string, open: any) {
  const db = admin();
  // Controlled backfill: if unassigned legacy orders exist in this session,
  // attach them to the open check and strictly surface any failure before computing totals.
  if (open.id && open.session_id && open.status === "OPEN") {
    await backfillSessionOrders(db, tenantId, open.id, open.session_id);
  }

  let orderQuery = db
    .from("orders")
    .select("*, items:order_items(*)")
    .neq("status", "PENDING_ACTIVATION")
    .neq("status", "CANCELLED");

  if (open.id) {
    orderQuery = orderQuery.eq("check_id", open.id);
  } else if (open.session_id) {
    orderQuery = orderQuery.eq("table_session_id", open.session_id);
  }

  const [{ data: orders }, { data: payments }, { data: settings }] = await Promise.all([
    orderQuery.order("created_at", { ascending: true }),
    // Every payment, including reversed ones: a refund is a line on the bill,
    // not a number that quietly disappeared from it.
    db
      .from("check_payments")
      .select("id, amount, method, status, created_at, note")
      .eq("check_id", open.id)
      .order("created_at", { ascending: true }),
    db.from("settings").select("key, value").eq("tenant_id", tenantId),
  ]);

  const { data: tenant } = await db.from("tenants").select("*").eq("id", tenantId).maybeSingle();

  const settingsMap: Record<string, string> = {};
  for (const row of settings ?? []) settingsMap[row.key] = row.value;

  // Resolve table information:
  // 1. check.table_id directly
  // 2. check.session_id -> table_sessions(table_id)
  // 3. check's orders -> order.table_id or order.table_session_id -> table_sessions(table_id)
  let resolvedTableId = open.table_id ?? null;
  if (!resolvedTableId && open.session_id) {
    const { data: sess } = await db
      .from("table_sessions")
      .select("table_id")
      .eq("id", open.session_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    resolvedTableId = sess?.table_id ?? null;
  }
  if (!resolvedTableId && orders && orders.length > 0) {
    for (const ord of orders) {
      if (ord.table_id) {
        resolvedTableId = ord.table_id;
        break;
      }
      if (ord.table_session_id) {
        const { data: sess } = await db
          .from("table_sessions")
          .select("table_id")
          .eq("id", ord.table_session_id)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (sess?.table_id) {
          resolvedTableId = sess.table_id;
          break;
        }
      }
    }
  }

  let tableRecord: { id: string; name: string; seats: number; area: string } | null = null;
  if (resolvedTableId) {
    const { data: t } = await db
      .from("tables")
      .select("id, name, seats, area")
      .eq("id", resolvedTableId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (t) {
      tableRecord = t;
    }
  }

  return {
    check: open,
    orders: orders ?? [],
    payments: payments ?? [],
    gstin: settingsMap.gstin || null,
    fssai: settingsMap.fssai || null,
    tenant,
    table: tableRecord,
  };
}

/**
 * The consolidated check, rendered in the same shape as the single-order bill.
 *
 * The diner's bill has always been one document; the only thing that changes
 * here is what it is about — the whole sitting, not the last order placed.
 * Keeping the shape identical means the same dialog draws it, the same print
 * template prints it, and nothing has to be maintained twice.
 */
function dinerDocument(
  check: any,
  orders: any[],
  payments: any[],
  gstin: string | null,
  tenant: any,
  table: { name: string; seats?: number; area?: string } | null = null,
  fssai: string | null = null,
) {
  const isPaidCheck = check.status === "PAID" && check.total != null && Number(check.total) > 0;
  const total = isPaidCheck ? Number(check.total) : +orders.reduce((s: number, o: any) => s + Number(o.total), 0).toFixed(2);
  const tax = isPaidCheck && check.tax != null ? Number(check.tax) : +orders.reduce((s: number, o: any) => s + Number(o.tax), 0).toFixed(2);
  const subtotal = isPaidCheck && check.subtotal != null ? Number(check.subtotal) : +orders.reduce((s: number, o: any) => s + Number(o.items_total), 0).toFixed(2);
  const discount = isPaidCheck && check.discount != null ? Number(check.discount) : +orders.reduce((s: number, o: any) => s + Number(o.discount), 0).toFixed(2);
  const serviceCharge = isPaidCheck && check.service_charge != null ? Number(check.service_charge) : +orders.reduce((s: number, o: any) => s + Number(o.service_charge), 0).toFixed(2);
  // Only succeeded money counts as paid; a voided payment is money that went
  // back, and it is reported separately rather than silently netted off.
  const paid = isPaidCheck && check.paid_total != null
    ? Number(check.paid_total)
    : +payments
        .filter((p: any) => p.status === "SUCCEEDED")
        .reduce((s: number, p: any) => s + Number(p.amount), 0)
        .toFixed(2);
  const refundedTotal = +payments
    .filter((p: any) => p.status === "VOID")
    .reduce((s: number, p: any) => s + Number(p.amount), 0)
    .toFixed(2);

  const taxRate = Number(tenant?.tax_rate ?? 0);
  const gstTotalPaise = Math.round(tax * 100);
  const cgstPaise = Math.ceil(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;
  const cgstAmount = +(cgstPaise / 100).toFixed(2);
  const sgstAmount = +(sgstPaise / 100).toFixed(2);

  const items = orders.flatMap((o: any) =>
    (o.items ?? []).map((it: any) => ({
      name: it.name,
      portionId: it.portion_id ?? null,
      portion: it.portion ?? null,
      quantity: it.quantity,
      unitPrice: Number(it.price),
      total: +(Number(it.price) * Number(it.quantity)).toFixed(2),
      notes: it.notes,
      // Which order this line came from, so a diner can reconcile their own.
      orderNumber: o.order_number,
    })),
  );

  return {
    restaurant: {
      name: tenant?.name ?? "Restaurant",
      tagline: tenant?.tagline ?? null,
      logo: tenant?.logo ?? null,
      address: tenant?.address ?? null,
      phone: tenant?.phone ?? null,
      email: tenant?.email ?? null,
      currency: tenant?.currency ?? "INR",
      currencySymbol: tenant?.currency_symbol ?? "₹",
      gstin,
      fssai: fssai ?? null,
    },
    billNumber: check.invoice_number ?? `TABLE-${String(check.id).slice(0, 6).toUpperCase()}`,
    orderNumber: orders.length === 1 ? orders[0].order_number : null,
    orderNumbers: orders.map((o: any) => o.order_number),
    orders: orders.map((o: any) => ({
      id: o.id,
      orderNumber: o.order_number,
      total: Number(o.total),
      subtotal: Number(o.items_total),
      tax: Number(o.tax),
      discount: Number(o.discount),
      createdAt: o.created_at,
      status: o.status,
      items: (o.items ?? []).map((it: any) => ({
        name: it.name,
        portion: it.portion ?? null,
        quantity: it.quantity,
        unitPrice: Number(it.price),
        total: +(Number(it.price) * Number(it.quantity)).toFixed(2),
        notes: it.notes,
        orderNumber: o.order_number,
      })),
    })),
    invoiceDate: check.invoice_date ?? check.opened_at,
    completedAt: check.closed_at,
    table: table && table.name?.trim()
      ? { name: table.name.trim(), seats: Number(table.seats ?? 0), area: table.area?.trim() ?? "" }
      : null,
    orderType: orders[0]?.order_type ?? (table ? "DINE_IN" : "TAKEAWAY"),
    // No customer identity on a shared table bill.
    customerName: null,
    customerPhone: null,
    servedBy: null,
    items,
    subtotal,
    discount,
    promoCode: null,
    taxableAmount: +(subtotal - discount).toFixed(2),
    taxBreakup: {
      rate: taxRate,
      cgstRate: taxRate / 2,
      sgstRate: taxRate / 2,
      cgstAmount,
      sgstAmount,
      totalTax: tax,
    },
    serviceCharge,
    grandTotal: total,
    paidTotal: paid,
    refundedTotal: +payments.filter((p: any) => p.status === "VOID")
      .reduce((s: number, p: any) => s + Number(p.amount), 0).toFixed(2),
    outstanding: +Math.max(0, total - paid).toFixed(2),
    payments: payments.map((p: any) => ({
      amount: Number(p.amount),
      method: p.method,
      status: p.status,
      createdAt: p.created_at,
    })),
    paymentMethod: payments.length ? payments[payments.length - 1].method : null,
    paymentStatus: total - paid <= 0.005 ? "PAID" : "UNPAID",
    orderStatus: check.status,
    checkStatus: check.status,
    invoiceNumber: check.invoice_number,
    terms: [
      "This is a session bill, covering every accepted order for this session.",
      "Tax is charged as it was applied to each order at the time it was placed.",
    ],
  };
}

async function getCheck(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Two callers, one document. Staff authenticate; a diner presents the
  // session token they were given at the table, and the lookup is pinned to
  // that session's table — so a diner can only ever read the bill for the
  // table they are sitting at, never another one and never another tenant.
  const g = await guard(req, { permission: "orders.view" });
  let tenantId: string;
  let sessionId: string | null = url.searchParams.get("sessionId");
  let tableId: string | null = url.searchParams.get("tableId");
  // A sitting, named outright. Staff only — the diner path below pins the
  // lookup to their own session and never reads this.
  let checkId: string | null = url.searchParams.get("checkId");

  if (g.ok) {
    tenantId = g.session.tenantId;
  } else {
    const token = req.headers.get("x-session-token") ?? url.searchParams.get("sessionToken");
    const session = token ? await tableSession(token) : null;
    if (!session) return g.response;
    tenantId = session.tenantId;
    sessionId = session.id;
    tableId = null;
    checkId = null;
  }

  let data;
  try {
    data = await checkForTenant(tenantId, sessionId, tableId, checkId);
  } catch (err) {
    return json(req, { error: `Could not load bill: ${(err as Error).message}` }, 500);
  }
  if (!data) return json(req, { error: "No bill for that table yet." }, 404);

  const { check, orders, payments, gstin } = data;
  const live = orders.filter((o: any) => o.status !== "CANCELLED");
  const isPaidCheck = check.status === "PAID" && check.total != null && Number(check.total) > 0;
  const total = isPaidCheck ? Number(check.total) : +live.reduce((s: number, o: any) => s + Number(o.total), 0).toFixed(2);
  const tax = isPaidCheck && check.tax != null ? Number(check.tax) : +live.reduce((s: number, o: any) => s + Number(o.tax), 0).toFixed(2);
  const subtotal = isPaidCheck && check.subtotal != null ? Number(check.subtotal) : +live.reduce((s: number, o: any) => s + Number(o.items_total), 0).toFixed(2);
  const discount = isPaidCheck && check.discount != null ? Number(check.discount) : +live.reduce((s: number, o: any) => s + Number(o.discount), 0).toFixed(2);
  const serviceCharge = isPaidCheck && check.service_charge != null ? Number(check.service_charge) : +live.reduce((s: number, o: any) => s + Number(o.service_charge), 0).toFixed(2);
  // Only succeeded money is paid; a voided payment is money that went back,
  // and it is reported separately rather than silently netted off.
  const paid = isPaidCheck && check.paid_total != null
    ? Number(check.paid_total)
    : +payments
        .filter((p: any) => p.status === "SUCCEEDED")
        .reduce((s: number, p: any) => s + Number(p.amount), 0)
        .toFixed(2);
  const refundedTotal = +payments
    .filter((p: any) => p.status === "VOID")
    .reduce((s: number, p: any) => s + Number(p.amount), 0)
    .toFixed(2);

  if (url.searchParams.get("format") === "document") {
    return json(req, dinerDocument(check, live, payments, gstin, data.tenant, data.table, data.fssai));
  }

  // Tax is the sum of what each order was charged at the time it was
  // placed — never re-derived here, because a second calculation is a
  // second opinion about money. Split deterministically in integer paise.
  const gstTotalPaise = Math.round(tax * 100);
  const cgstPaise = Math.ceil(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;
  const cgstAmount = +(cgstPaise / 100).toFixed(2);
  const sgstAmount = +(sgstPaise / 100).toFixed(2);
  const taxRate = Number(data.tenant?.tax_rate ?? 5);
  const serviceRate = Number(data.tenant?.service_charge ?? 0);

  return json(req, {
    checkId: check.id,
    status: check.status,
    tableId: check.table_id ?? data.table?.id ?? null,
    tableName: data.table?.name ?? null,
    tableArea: data.table?.area ?? null,
    table: data.table && data.table.name?.trim()
      ? { name: data.table.name.trim(), seats: Number(data.table.seats ?? 0), area: data.table.area?.trim() ?? "" }
      : null,
    openedAt: check.opened_at,
    closedAt: check.closed_at,
    invoiceNumber: check.invoice_number,
    invoiceDate: check.invoice_date,
    gstin,
    taxRate,
    serviceRate,
    totals: {
      subtotal,
      discount,
      tax,
      serviceCharge,
      total,
      paid,
      refunded: refundedTotal,
      outstanding: +Math.max(0, total - paid).toFixed(2),
      cgst: cgstAmount,
      sgst: sgstAmount,
      taxRate,
      serviceRate,
      roundOff: 0,
    },
    orderCount: live.length,
    orders: live.map((o: any) => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      total: Number(o.total),
      createdAt: o.created_at,
      items: (o.items ?? []).map((i: any) => ({
        id: i.id,
        name: i.name,
        portion: i.portion ?? null,
        quantity: i.quantity,
        price: Number(i.price),
        total: +(Number(i.price) * Number(i.quantity)).toFixed(2),
        notes: i.notes,
      })),
    })),
    payments: payments.map((p: any) => ({
      id: p.id,
      amount: Number(p.amount),
      method: p.method,
      status: p.status,
      createdAt: p.created_at,
      note: p.note,
    })),
  });
}

/** Cash against the table's check. Idempotent on the client's key. */
async function recordPayment(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "payments.collect" });
  if (!g.ok) return g.response;

  const b = await req.json().catch(() => ({} as any));
  let data;
  try {
    data = await checkForTenant(
      g.session.tenantId,
      b.sessionId ? String(b.sessionId) : null,
      b.tableId ? String(b.tableId) : null,
      b.checkId ? String(b.checkId) : null,
    );
  } catch (err) {
    return json(req, { error: `Could not prepare payment: ${(err as Error).message}` }, 500);
  }
  if (!data) return json(req, { error: "No open bill for that table." }, 404);

  const live = data.orders.filter((o: any) => o.status !== "CANCELLED");
  const computedTotal = +live.reduce((s: number, o: any) => s + Number(o.total), 0).toFixed(2);
  const checkTotal = Number(data.check.total) > 0 ? Number(data.check.total) : computedTotal;
  const currentPaid = Number(data.check.paid_total || 0);
  const outstanding = +Math.max(0, checkTotal - currentPaid).toFixed(2);

  // App supports full settlement only: enforce full settlement and reject underpayment
  if (b.amount !== undefined && b.amount !== null) {
    const requestedAmount = Number(b.amount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      return json(req, { error: "Enter an amount greater than zero." }, 400);
    }
    if (outstanding > 0 && requestedAmount < outstanding - 0.005) {
      return json(
        req,
        {
          error: "Partial payment is not supported. Full settlement is required.",
          code: "partial_payment_not_supported",
          outstanding,
        },
        400,
      );
    }
  }

  const amount = b.amount !== undefined && b.amount !== null ? Number(b.amount) : outstanding;
  if (!Number.isFinite(amount) || amount <= 0) {
    return json(req, { error: "Enter an amount greater than zero." }, 400);
  }

  // How the money arrived. The dialog has offered Cash / UPI / Card all along
  // and this endpoint recorded every one of them as CASH — widening the ledger
  // (0085) makes the stored method match the one the cashier pressed.
  const METHOD_ALIASES: Record<string, string> = {
    CASH: "CASH", UPI: "UPI", CARD: "CARD",
    WALLET: "UPI",          // the old dialog's third button
  };
  const method = METHOD_ALIASES[String(b.method ?? "CASH").toUpperCase()] ?? "CASH";

  const { data: result, error } = await admin().rpc("record_check_payment", {
    p_tenant: g.session.tenantId,
    p_check: data.check.id,
    p_amount: amount,
    p_method: method,
    p_idempotency_key: b.idempotencyKey ? String(b.idempotencyKey) : null,
    p_actor: g.session.subjectId ?? null,
    p_note: b.note ? String(b.note).slice(0, 200) : null,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("OVERPAYMENT:")) {
      const [, outstanding] = message.split("OVERPAYMENT:")[1].split(":");
      return json(
        req,
        { error: `${outstanding} is still due on this table — check the amount.`, code: "overpayment" },
        409,
      );
    }
    if (message.includes("CHECK_PAID")) {
      return json(req, { ok: true, already: true, deduplicated: true, message: "This bill is already settled." }, 200);
    }
    return json(req, { error: message || "Could not record the payment." }, 500);
  }

  if ((result as any)?.already) {
    return json(req, { ok: true, already: true, deduplicated: true, ...(result as any) }, 200);
  }

  await auditMoney(req, g.session, "CHECK_PAYMENT", g.session.tenantId, `${amount} ${method} on check ${data.check.id}`);
  await broadcastCheck(g.session.tenantId, data.check.id, "PAYMENT");
  return json(req, result, 201);
}

/**
 * Tell the floor and the diner that the bill changed.
 *
 * The diner's own bill is a live document — a payment taken at the counter has
 * to appear on their phone — and the POS card shows the same balance.
 */
/**
 * Money movements are audited. Taking cash, reversing it and invoicing a bill
 * are the three records that answer "who settled this, and when" — the same
 * standard the table-accept and table-close paths already hold themselves to.
 */
async function auditMoney(
  req: Request,
  session: any,
  action: string,
  tenantId: string,
  meta: string,
) {
  try {
    await admin()
      .from("security_logs")
      .insert({
        tenant_id: tenantId,
        user_id: session?.kind === "owner" ? session.subjectId : null,
        actor_staff_id: session?.kind === "staff" ? session.subjectId : null,
        action,
        user_agent: req.headers.get("user-agent") || "unknown",
        meta,
      });
  } catch {}
}

async function broadcastCheck(tenantId: string, checkId: string, reason: string) {
  const { data: check } = await admin()
    .from("table_checks")
    .select("table_id, session_id, anchor_session_id, status, invoice_number")
    .eq("id", checkId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!check) return;

  const targetSessionId = check.session_id || check.anchor_session_id;
  const isPaid = reason === "FINALISED" || check.status === "PAID";

  await publishToStaff(tenantId, "CHECK_UPDATED", {
    checkId,
    tableId: check.table_id,
    sessionId: targetSessionId,
    status: isPaid ? "PAID" : check.status,
    reason,
    invoiceNumber: check.invoice_number ?? null,
  });

  if (check.session_id) {
    if (reason === "FINALISED") {
      await publishToStaff(tenantId, "SESSION_ENDED", {
        tableId: check.table_id,
        sessionId: check.session_id,
        status: "ENDED",
        endedAt: new Date().toISOString(),
        invoiceNumber: check.invoice_number ?? null,
        order: { sessionId: check.session_id, status: "ENDED" },
      });
      await publishToStaff(tenantId, "SESSION_UPDATED", {
        tableId: check.table_id,
        sessionId: check.session_id,
        status: "ENDED",
      });
    }
    const { data: s } = await admin()
      .from("table_sessions")
      .select("token")
      .eq("id", check.session_id)
      .maybeSingle();
    if (s?.token) {
      publishToDiner(s.token, "CHECK_UPDATED", { checkId, reason, status: isPaid ? "PAID" : check.status });
      if (reason === "FINALISED") {
        publishToDiner(s.token, "SESSION_ENDED", {
          tableId: check.table_id,
          sessionId: check.session_id,
          status: "ENDED",
        });
      }
    }
  } else if (targetSessionId) {
    if (reason === "FINALISED") {
      await publishToStaff(tenantId, "SESSION_ENDED", {
        tableId: check.table_id,
        sessionId: targetSessionId,
        status: "ENDED",
        endedAt: new Date().toISOString(),
        invoiceNumber: check.invoice_number ?? null,
        order: { sessionId: targetSessionId, status: "ENDED" },
      });
      await publishToStaff(tenantId, "SESSION_UPDATED", {
        tableId: check.table_id,
        sessionId: targetSessionId,
        status: "ENDED",
      });
    }
    const { data: s } = await admin()
      .from("table_sessions")
      .select("token")
      .eq("id", targetSessionId)
      .maybeSingle();
    if (s?.token) {
      publishToDiner(s.token, "CHECK_UPDATED", { checkId, reason, status: isPaid ? "PAID" : check.status });
      if (reason === "FINALISED") {
        publishToDiner(s.token, "SESSION_ENDED", {
          tableId: check.table_id,
          sessionId: targetSessionId,
          status: "ENDED",
        });
      }
    }
  } else if (check.table_id) {
    const { data: sessions } = await admin()
      .from("table_sessions")
      .select("id, token")
      .eq("table_id", check.table_id)
      .eq("tenant_id", tenantId)
      .eq("status", "ACTIVE");
    for (const s of sessions ?? []) {
      publishToDiner(s.token, "CHECK_UPDATED", { checkId, reason });
      if (reason === "FINALISED") {
        publishToDiner(s.token, "SESSION_ENDED", {
          tableId: check.table_id,
          sessionId: s.id,
          status: "ENDED",
        });
      }
    }
  }
}

/**
 * Reverse a cash payment before the bill is invoiced.
 *
 * The row is kept and marked VOID — the money going back out is a fact worth
 * recording — and the balance goes back up. Once an invoice exists this is a
 * credit note, which this system does not issue, so it refuses rather than
 * pretending.
 */
async function refund(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "payments.refund" });
  if (!g.ok) return g.response;

  const b = await req.json().catch(() => ({} as any));
  const paymentId = b.paymentId ? String(b.paymentId) : "";
  if (!paymentId) return json(req, { error: "paymentId is required" }, 400);

  const { data: payment } = await admin()
    .from("check_payments")
    .select("id, check_id")
    .eq("id", paymentId)
    .eq("tenant_id", g.session.tenantId)
    .maybeSingle();
  if (!payment) return json(req, { error: "That payment is not yours." }, 404);

  const { data: result, error } = await admin().rpc("void_check_payment", {
    p_tenant: g.session.tenantId,
    p_payment: paymentId,
    p_reason: b.reason ? String(b.reason).slice(0, 200) : null,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("INVOICED")) {
      return json(req, { error: "This bill is already invoiced — a refund needs a credit note." }, 409);
    }
    return json(req, { error: message || "Could not reverse the payment." }, 500);
  }

  await auditMoney(req, g.session, "CHECK_PAYMENT_REVERSED", g.session.tenantId, `payment ${paymentId} voided`);
  await broadcastCheck(g.session.tenantId, payment.check_id, "REFUND");
  return json(req, result);
}

/** Allocate the invoice number and close the check. Idempotent. */
async function finalize(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "payments.collect" });
  if (!g.ok) return g.response;

  const b = await req.json().catch(() => ({} as any));
  let data;
  try {
    data = await checkForTenant(
      g.session.tenantId,
      b.sessionId ? String(b.sessionId) : null,
      b.tableId ? String(b.tableId) : null,
      b.checkId ? String(b.checkId) : null,
    );
  } catch (err) {
    return json(req, { error: `Could not prepare payment: ${(err as Error).message}` }, 500);
  }
  if (!data) return json(req, { error: "No open bill for that table." }, 404);

  const { data: result, error } = await admin().rpc("finalize_table_check", {
    p_tenant: g.session.tenantId,
    p_check: data.check.id,
    p_actor: g.session.subjectId ?? null,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("ORDERS_OPEN:")) {
      return json(
        req,
        { error: "Something is still being prepared on this table.", code: "orders_open" },
        409,
      );
    }
    if (message.includes("NOTHING_TO_BILL")) return json(req, { error: "There is nothing to bill." }, 409);
    if (message.includes("UNPAID:")) {
      const due = message.split("UNPAID:")[1];
      return json(
        req,
        { error: `${due} is still to be collected on this table.`, code: "unpaid" },
        409,
      );
    }
    return json(req, { error: message || "Could not close the bill." }, 500);
  }

  const live = data.orders.filter((o: any) => o.status !== "CANCELLED");
  const subtotal = +live.reduce((s: number, o: any) => s + Number(o.items_total), 0).toFixed(2);
  const discount = +live.reduce((s: number, o: any) => s + Number(o.discount), 0).toFixed(2);
  const tax = +live.reduce((s: number, o: any) => s + Number(o.tax), 0).toFixed(2);
  const serviceCharge = +live.reduce((s: number, o: any) => s + Number(o.service_charge), 0).toFixed(2);
  const total = Number((result as any)?.total ?? +live.reduce((s: number, o: any) => s + Number(o.total), 0).toFixed(2));
  const paid = Number((result as any)?.paid ?? total);
  const gstTotalPaise = Math.round(tax * 100);
  const cgstPaise = Math.ceil(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;
  const cgst = +(cgstPaise / 100).toFixed(2);
  const sgst = +(sgstPaise / 100).toFixed(2);
  const lastPayment = data.payments.length ? data.payments[data.payments.length - 1] : null;
  const paymentMethod = lastPayment?.method ?? "CASH";

  await auditMoney(
    req,
    g.session,
    "CHECK_FINALISED",
    g.session.tenantId,
    `check ${data.check.id} invoiced ${(result as any)?.invoiceNumber ?? ""}`,
  );
  await broadcastCheck(g.session.tenantId, data.check.id, "FINALISED");
  return json(req, {
    ...(result as any),
    subtotal,
    discount,
    tax,
    cgst,
    sgst,
    serviceCharge,
    total,
    paid,
    outstanding: 0,
    paymentMethod,
  });
}

/**
 * Atomic Cash settlement for a check:
 * 1. Takes cash for remaining due (if any)
 * 2. Settles the check
 * 3. Allocates sequential invoice
 * 4. Completes all paid check orders
 * 5. Ends ONLY that session
 * 6. Broadcasts CHECK_UPDATED and SESSION_ENDED in Realtime
 * 7. Idempotently returns existing invoice if already settled
 */
async function settleCash(req: Request): Promise<Response> {
  const g = await guard(req, { anyOf: ["payments.collect", "orders.complete"] });
  if (!g.ok) return g.response;

  const b = await req.json().catch(() => ({} as any));
  let data;
  try {
    data = await checkForTenant(
      g.session.tenantId,
      b.sessionId ? String(b.sessionId) : null,
      b.tableId ? String(b.tableId) : null,
      b.checkId ? String(b.checkId) : null,
    );
  } catch (err) {
    return json(req, { error: `Could not prepare payment: ${(err as Error).message}` }, 500);
  }
  if (!data) return json(req, { error: "No open bill for that table." }, 404);

  const { data: result, error } = await admin().rpc("settle_check_cash_tx", {
    p_tenant: g.session.tenantId,
    p_check: data.check.id,
    p_actor: g.session.subjectId ?? null,
    p_idempotency_key: b.idempotencyKey ? String(b.idempotencyKey) : null,
    p_note: b.note ? String(b.note).slice(0, 200) : null,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("ORDERS_OPEN:")) {
      return json(
        req,
        { error: "Something is still being prepared on this table.", code: "orders_open" },
        409,
      );
    }
    if (message.includes("NOTHING_TO_BILL")) return json(req, { error: "There is nothing to bill." }, 409);
    return json(req, { error: message || "Could not settle the bill." }, 500);
  }

  const tid = g.session.tenantId;
  const chkId = data.check.id;
  const tblId = data.check.table_id;
  const sessId = data.check.session_id ?? (result as any)?.endedSessionId ?? null;
  const invNum = (result as any)?.invoiceNumber ?? "";

  const live = data.orders.filter((o: any) => o.status !== "CANCELLED");
  const subtotal = +live.reduce((s: number, o: any) => s + Number(o.items_total), 0).toFixed(2);
  const discount = +live.reduce((s: number, o: any) => s + Number(o.discount), 0).toFixed(2);
  const tax = +live.reduce((s: number, o: any) => s + Number(o.tax), 0).toFixed(2);
  const serviceCharge = +live.reduce((s: number, o: any) => s + Number(o.service_charge), 0).toFixed(2);
  const total = Number((result as any)?.total ?? +live.reduce((s: number, o: any) => s + Number(o.total), 0).toFixed(2));
  const paid = Number((result as any)?.paid ?? total);
  const gstTotalPaise = Math.round(tax * 100);
  const cgstPaise = Math.ceil(gstTotalPaise / 2);
  const sgstPaise = gstTotalPaise - cgstPaise;
  const cgst = +(cgstPaise / 100).toFixed(2);
  const sgst = +(sgstPaise / 100).toFixed(2);

  await auditMoney(req, g.session, "CHECK_SETTLED_CASH", tid, `Check ${chkId} settled in cash: ${invNum}`);

  // Broadcast to Staff (Owner, Manager, Cashier dashboards)
  await publishToStaff(tid, "CHECK_UPDATED", {
    tableId: tblId,
    checkId: chkId,
    sessionId: sessId,
    status: "PAID",
    reason: "FINALISED",
    invoiceNumber: invNum,
    total,
    paid,
    subtotal,
    tax,
    serviceCharge,
    orderCount: live.length,
  });
  if (sessId) {
    await publishToStaff(tid, "SESSION_UPDATED", {
      tableId: tblId,
      sessionId: sessId,
      status: "ENDED",
      endedAt: new Date().toISOString(),
      invoiceNumber: invNum,
    });
    await publishToStaff(tid, "SESSION_ENDED", {
      tableId: tblId,
      sessionId: sessId,
      status: "ENDED",
      endedAt: new Date().toISOString(),
      invoiceNumber: invNum,
      order: { sessionId: sessId, status: "ENDED" },
    });
  }

  // Broadcast to Diner
  await broadcastCheck(tid, chkId, "FINALISED");

  return json(req, {
    ...(result as any),
    subtotal,
    discount,
    tax,
    cgst,
    sgst,
    serviceCharge,
    total,
    paid,
    outstanding: 0,
    paymentMethod: "CASH",
  }, 200);
}

async function get(req: Request, orderId: string | null): Promise<Response> {
  if (!orderId) return json(req, { error: "Order not found" }, 404);

  const db = admin();

  const g = await guard(req, { permission: "orders.view" });
  let tenantId: string;
  let sessionId: string | null = null;

  if (g.ok) {
    tenantId = g.session.tenantId;
  } else {
    const token = req.headers.get("x-session-token") ?? new URL(req.url).searchParams.get("sessionToken");
    const session = token ? await tableSession(token) : null;
    if (!session) return g.response; // 401 — neither an owner nor a live session
    tenantId = session.tenantId;
    sessionId = session.id;
  }

  let query = db
    .from("orders")
    .select("*, items:order_items(*), table:tables(*), tenant:tenants(*), servedBy:profiles(id,name)")
    .eq("id", orderId)
    .eq("tenant_id", tenantId); // tenant scoping — see header

  // A diner may only read the order their own session created.
  if (sessionId) query = query.eq("table_session_id", sessionId);

  const { data: order, error } = await query.maybeSingle();

  if (error) return json(req, { error: error.message }, 500);
  if (!order) return json(req, { error: "Order not found" }, 404);

  // A held order is not a bill. It has a price, but nobody has accepted the
  // table and nothing is owed — showing it would be a bill for food the
  // kitchen was never told to cook.
  if (order.status === "PENDING_ACTIVATION") {
    return json(req, { error: "This order is waiting for the restaurant to accept the table." }, 409);
  }

  const tenant = Array.isArray(order.tenant) ? order.tenant[0] : order.tenant;
  let table = Array.isArray(order.table) ? order.table[0] : order.table;

  // If table wasn't directly joined on order, trace via table_session_id or check_id
  if (!table && order.table_session_id) {
    const { data: sess } = await db
      .from("table_sessions")
      .select("table:tables(*)")
      .eq("id", order.table_session_id)
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    table = Array.isArray(sess?.table) ? sess.table[0] : sess?.table;
  }
  if (!table && order.check_id) {
    const { data: chk } = await db
      .from("table_checks")
      .select("table:tables(*)")
      .eq("id", order.check_id)
      .eq("tenant_id", tenant.id)
      .maybeSingle();
    table = Array.isArray(chk?.table) ? chk.table[0] : chk?.table;
  }

  const servedBy = Array.isArray(order.servedBy) ? order.servedBy[0] : order.servedBy;
  const items = Array.isArray(order.items) ? order.items : [];

  // Fetch GSTIN/FSSAI from settings (never fake these)
  const { data: settings } = await db
    .from("settings")
    .select("key, value")
    .eq("tenant_id", tenant.id);
  const settingsMap: Record<string, string> = {};
  for (const s of settings || []) settingsMap[s.key] = s.value;

  const gstin = settingsMap.gstin || null;
  const fssai = settingsMap.fssai || null;

  // Calculate GST breakup (CGST + SGST = half each of total tax, for intra-state)
  const taxRate = tenant.tax_rate;
  const cgstRate = taxRate / 2;
  const sgstRate = taxRate / 2;
  const cgstAmount = +(order.tax / 2).toFixed(2);
  const sgstAmount = +(order.tax - cgstAmount).toFixed(2);

  // Generate bill number (order number with prefix)
  const billNumber = `BILL-${String(order.order_number).padStart(6, "0")}`;

  const bill = {
    // Restaurant info
    restaurant: {
      name: tenant.name,
      tagline: tenant.tagline,
      logo: tenant.logo,
      address: tenant.address,
      phone: tenant.phone,
      email: tenant.email,
      currency: tenant.currency,
      currencySymbol: tenant.currency_symbol,
      gstin,
      fssai,
    },
    // Bill metadata
    billNumber,
    orderNumber: order.order_number,
    invoiceDate: order.created_at,
    completedAt: order.completed_at,
    // Table/session info
    table: table && table.name?.trim()
      ? { name: table.name.trim(), seats: Number(table.seats ?? 0), area: table.area?.trim() ?? "" }
      : null,
    orderType: order.order_type,
    customerName: order.customer_name,
    customerPhone: order.customer_phone,
    servedBy: servedBy?.name || null,
    // Itemized items
    items: items.map((it: any) => ({
      name: it.name,
      portionId: it.portion_id ?? null,
      portion: it.portion ?? null,
      quantity: it.quantity,
      unitPrice: it.price,
      total: +(it.price * it.quantity).toFixed(2),
      notes: it.notes,
    })),
    // Totals
    subtotal: order.items_total,
    discount: order.discount,
    promoCode: order.promo_code,
    taxableAmount: +(order.items_total - order.discount).toFixed(2),
    // Tax breakup
    taxBreakup: {
      rate: taxRate,
      cgstRate,
      sgstRate,
      cgstAmount,
      sgstAmount,
      totalTax: order.tax,
    },
    serviceCharge: order.service_charge,
    grandTotal: order.total,
    // Payment
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status ? String(order.payment_status).toUpperCase() : "UNPAID",
    orderStatus: order.status,
    // Footer terms
    terms: [
      "Thank you for dining with us!",
      "This is a computer-generated bill and does not require a signature.",
    ],
  };

  return json(req, bill);
}
