// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { resolvePlan, checkFeature } from "../_shared/plans.ts";

/**
 * /functions/v1/analytics
 *   GET   aggregated analytics for the caller's tenant (analytics.view)
 *
 * All active plans (Starter and Pro) have full access to advanced analytics:
 * revenue trend, hourly distribution, order types, top selling items, top tables,
 * category breakdown, and payment method analytics.
 */

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  if (req.method !== "GET") return json(req, { error: "Method not allowed" }, 405);

  try {
    return await get(req);
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

/* -------------------------------------------------------------------------- */
/*  Date ranges & Timezone helpers (Asia/Kolkata boundary precision)         */
/* -------------------------------------------------------------------------- */

/** Offset in minutes of `timeZone` at the given instant. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - at.getTime()) / 60000;
}

/** The instant at which the given YYYY-MM-DD begins, in `timeZone`. */
function zonedStart(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000);
}

/** YYYY-MM-DD for an instant, as seen in `timeZone`. */
function zonedDateStr(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

/** Get hour of day (0-23) in restaurant's timeZone using 24-hour cycle. */
function zonedHour(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
    }).formatToParts(at);
    const hourPart = parts.find((p) => p.type === "hour");
    if (hourPart) {
      const val = parseInt(hourPart.value, 10);
      return (val === 24 ? 0 : val) % 24;
    }
  } catch {
    // fallback
  }
  return at.getUTCHours();
}

const DAY_MS = 86400000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function get(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "analytics.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const url = new URL(req.url);
  const db = admin();

  // The restaurant's own timezone decides where a day starts (default Asia/Kolkata).
  const { data: tzRow } = await db
    .from("settings")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("key", "timezone")
    .maybeSingle();
  const timeZone = (tzRow as any)?.value || "Asia/Kolkata";

  const todayStr = zonedDateStr(new Date(), timeZone);
  const daysParam = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7"), 1), 366);
  let fromStr = url.searchParams.get("from") ?? "";
  let toStr = url.searchParams.get("to") ?? "";
  if (!fromStr || !toStr) {
    const to = new Date(`${todayStr}T00:00:00Z`);
    const from = new Date(to.getTime() - (daysParam - 1) * DAY_MS);
    fromStr = from.toISOString().slice(0, 10);
    toStr = todayStr;
  }
  if (fromStr > toStr) [fromStr, toStr] = [toStr, fromStr];

  const rangeStart = zonedStart(fromStr, timeZone);
  const rangeEnd = new Date(zonedStart(toStr, timeZone).getTime() + DAY_MS); // exclusive

  // Location filter resolution
  const locationId = url.searchParams.get("location_id") || url.searchParams.get("locationId");
  let locTableIds: string[] | null = null;
  if (locationId) {
    const { data: locTables } = await db
      .from("tables")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("location_id", locationId);
    locTableIds = (locTables ?? []).map((t: any) => t.id);
  }

  // Pre-load all tables for tenant so table names and references always resolve accurately
  const { data: allTenantTables } = await db
    .from("tables")
    .select("id, name, location_id")
    .eq("tenant_id", tenantId);
  const tableMap = new Map<string, { id: string; name: string; location_id: string | null }>();
  for (const t of allTenantTables ?? []) {
    tableMap.set(t.id, t);
  }

  // Pre-load categories for menu items mapping
  const { data: menuRows } = await db
    .from("menu_items")
    .select("id, category:categories(name)")
    .eq("tenant_id", tenantId)
    .limit(5000);
  const catMap: Record<string, string> = {};
  for (const m of menuRows ?? []) {
    const category = Array.isArray((m as any).category) ? (m as any).category[0] : (m as any).category;
    catMap[(m as any).id] = category?.name || "Other";
  }

  /* -------------------------------------------------------------------------- */
  /* 1. Authoritative Settlement Payments (check_payments)                      */
  /* -------------------------------------------------------------------------- */
  let paymentsQuery = db
    .from("check_payments")
    .select("id, check_id, amount, method, status, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "SUCCEEDED")
    .gte("created_at", rangeStart.toISOString())
    .lt("created_at", rangeEnd.toISOString())
    .order("created_at", { ascending: true })
    .limit(10000);

  const { data: paymentRows, error: paymentsError } = await paymentsQuery;
  if (paymentsError) return json(req, { error: paymentsError.message }, 500);

  // Pre-load table checks in range or linked to payments for session & table lookup
  const paymentCheckIds = Array.from(new Set((paymentRows ?? []).map((p: any) => p.check_id).filter(Boolean)));
  
  let checksQuery = db
    .from("table_checks")
    .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "PAID")
    .gte("closed_at", rangeStart.toISOString())
    .lt("closed_at", rangeEnd.toISOString());

  const { data: rangeChecks } = await checksQuery;
  const checkMap = new Map<string, any>();
  for (const c of rangeChecks ?? []) {
    checkMap.set(c.id, c);
  }

  if (paymentCheckIds.length > 0) {
    const missingCheckIds = paymentCheckIds.filter((cid) => !checkMap.has(cid));
    if (missingCheckIds.length > 0) {
      const { data: extraChecks } = await db
        .from("table_checks")
        .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, created_at")
        .eq("tenant_id", tenantId)
        .in("id", missingCheckIds);
      for (const c of extraChecks ?? []) {
        checkMap.set(c.id, c);
      }
    }
  }

  // Filter payments by location if specified
  const filteredPayments = (paymentRows ?? []).filter((p: any) => {
    if (!locTableIds) return true;
    const chk = checkMap.get(p.check_id);
    return chk && chk.table_id && locTableIds.includes(chk.table_id);
  });

  let cashAmount = 0, cashCount = 0;
  let upiAmount = 0, upiCount = 0;
  let cardAmount = 0, cardCount = 0;

  for (const p of filteredPayments) {
    const amt = Number(p.amount || 0);
    const m = String(p.method || "").toUpperCase();
    if (m === "CASH") {
      cashAmount += amt;
      cashCount++;
    } else if (m === "UPI") {
      upiAmount += amt;
      upiCount++;
    } else if (m === "CARD") {
      cardAmount += amt;
      cardCount++;
    }
  }

  const grossCollectedPayments = +(cashAmount + upiAmount + cardAmount).toFixed(2);

  /* -------------------------------------------------------------------------- */
  /* 2. Settled Orders Retrieval (paid_at / settlement timestamp aware)         */
  /* -------------------------------------------------------------------------- */
  // An order created yesterday and paid today must count toward today's revenue.
  // We query all non-cancelled orders that settled within [rangeStart, rangeEnd).
  let ordersQuery = db
    .from("orders")
    .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, tax, service_charge, total, paid_at, completed_at, created_at, items:order_items(id, menu_item_id, name, price, quantity)")
    .eq("tenant_id", tenantId)
    .neq("status", "CANCELLED")
    .neq("status", "REJECTED")
    .neq("payment_status", "REFUNDED")
    .neq("payment_status", "refunded")
    .order("created_at", { ascending: false })
    .limit(10000);

  const { data: candidateOrderRows, error: ordersError } = await ordersQuery;
  if (ordersError) return json(req, { error: ordersError.message }, 500);

  // Filter and normalize orders that were settled within the selected range
  const qualifyingOrders: any[] = [];
  for (const o of candidateOrderRows ?? []) {
    // Determine the actual settlement timestamp:
    // 1. orders.paid_at (settlement timestamp)
    // 2. orders.completed_at
    // 3. check's closed_at / invoice_date
    // 4. orders.created_at (only if status is COMPLETED or payment_status is PAID)
    let settlementTime: Date | null = null;
    const isPaidStatus = o.payment_status === "PAID" || o.payment_status === "paid";
    const isCompletedStatus = o.status === "COMPLETED";

    if (o.paid_at) {
      settlementTime = new Date(o.paid_at);
    } else if (o.check_id && checkMap.has(o.check_id)) {
      const chk = checkMap.get(o.check_id);
      if (chk.closed_at) settlementTime = new Date(chk.closed_at);
      else if (chk.invoice_date) settlementTime = new Date(chk.invoice_date);
    } else if (o.completed_at && (isPaidStatus || isCompletedStatus)) {
      settlementTime = new Date(o.completed_at);
    } else if ((isPaidStatus || isCompletedStatus) && o.created_at) {
      settlementTime = new Date(o.created_at);
    }

    if (!settlementTime || isNaN(settlementTime.getTime())) continue;

    // Check if settlement timestamp falls within [rangeStart, rangeEnd)
    if (settlementTime < rangeStart || settlementTime >= rangeEnd) continue;

    // Location filter check
    const chk = o.check_id ? checkMap.get(o.check_id) : null;
    const effectiveTableId = o.table_id || chk?.table_id || null;
    if (locTableIds && (!effectiveTableId || !locTableIds.includes(effectiveTableId))) {
      continue;
    }

    // Resolve table name
    const resolvedTable = effectiveTableId ? tableMap.get(effectiveTableId) : null;

    // Normalize order type: DINE_IN, TAKEAWAY, DELIVERY
    let normalizedType = String(o.order_type || chk?.order_type || (effectiveTableId ? "DINE_IN" : "TAKEAWAY"))
      .toUpperCase()
      .replace(/[-\s]/g, "_");
    if (!["DINE_IN", "TAKEAWAY", "DELIVERY"].includes(normalizedType)) {
      normalizedType = effectiveTableId ? "DINE_IN" : "TAKEAWAY";
    }

    qualifyingOrders.push({
      id: o.id,
      orderNumber: o.order_number,
      total: Number(o.total || 0),
      itemsTotal: Number(o.items_total || o.total || 0),
      discount: Number(o.discount || 0),
      tax: Number(o.tax || 0),
      serviceCharge: Number(o.service_charge || 0),
      orderType: normalizedType,
      tableId: effectiveTableId,
      tableName: resolvedTable?.name || (normalizedType === "DINE_IN" ? "Table" : normalizedType),
      settledAt: settlementTime,
      items: (o.items ?? []).map((it: any) => ({
        menuItemId: it.menu_item_id,
        name: it.name,
        price: Number(it.price || 0),
        quantity: Number(it.quantity || 0),
      })),
    });
  }

  /* -------------------------------------------------------------------------- */
  /* 3. Daily Revenue Aggregation (Asia/Kolkata timezone boundaries)           */
  /* -------------------------------------------------------------------------- */
  const dailyRevenue: { date: string; label: string; revenue: number; orders: number }[] = [];
  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += DAY_MS) {
    const dayStart = new Date(t);
    const dayEnd = new Date(t + DAY_MS);

    // Collect settled orders in this day bucket
    const dayOrders = qualifyingOrders.filter(
      (o: any) => o.settledAt >= dayStart && o.settledAt < dayEnd,
    );

    // Also check check_payments in this day bucket for financial reconciliation
    const dayPayments = filteredPayments.filter(
      (p: any) => new Date(p.created_at) >= dayStart && new Date(p.created_at) < dayEnd,
    );
    const dayPaymentTotal = dayPayments.reduce((s, p: any) => s + Number(p.amount || 0), 0);
    const dayOrderTotal = dayOrders.reduce((s, o: any) => s + Number(o.total || 0), 0);

    const dateStr = zonedDateStr(dayStart, timeZone);
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();

    dailyRevenue.push({
      date: dateStr,
      label: DAY_LABELS[dayOfWeek],
      revenue: +(dayPaymentTotal > 0 ? dayPaymentTotal : dayOrderTotal).toFixed(2),
      orders: dayOrders.length,
    });
  }

  /* -------------------------------------------------------------------------- */
  /* 4. Financial Metrics & Authoritative Reconciliation                       */
  /* -------------------------------------------------------------------------- */
  const orderRevenueSum = qualifyingOrders.reduce((s: number, o: any) => s + Number(o.total || 0), 0);
  const netSales = qualifyingOrders.reduce((s: number, o: any) => s + Math.max(0, o.itemsTotal - o.discount), 0);
  const taxCollected = qualifyingOrders.reduce((s: number, o: any) => s + o.tax, 0);
  const serviceChargeCollected = qualifyingOrders.reduce((s: number, o: any) => s + o.serviceCharge, 0);

  // Authoritative total revenue: prioritize actual settled check_payments when present
  const totalRevenue = grossCollectedPayments > 0 ? grossCollectedPayments : +orderRevenueSum.toFixed(2);
  const totalOrders = qualifyingOrders.length;
  const avgOrder = totalOrders > 0 ? +(totalRevenue / totalOrders).toFixed(2) : 0;

  /* -------------------------------------------------------------------------- */
  /* 5. Top Items Sold                                                          */
  /* -------------------------------------------------------------------------- */
  const itemCounts: Record<string, { name: string; qty: number; revenue: number }> = {};
  for (const o of qualifyingOrders) {
    for (const it of o.items) {
      const key = it.menuItemId || it.name;
      if (!itemCounts[key]) itemCounts[key] = { name: it.name, qty: 0, revenue: 0 };
      itemCounts[key].qty += it.quantity;
      itemCounts[key].revenue += it.price * it.quantity;
    }
  }
  const topItems = Object.values(itemCounts)
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
    .slice(0, 6)
    .map((t) => ({ ...t, revenue: +t.revenue.toFixed(2) }));

  /* -------------------------------------------------------------------------- */
  /* 6. Order Type Breakdown (DINE_IN, TAKEAWAY, DELIVERY)                      */
  /* -------------------------------------------------------------------------- */
  const typeMap: Record<string, { count: number; revenue: number }> = {};
  for (const o of qualifyingOrders) {
    const t = o.orderType;
    if (!typeMap[t]) typeMap[t] = { count: 0, revenue: 0 };
    typeMap[t].count++;
    typeMap[t].revenue += Number(o.total || 0);
  }
  const typeBreakdown = Object.entries(typeMap)
    .filter(([_, v]) => v.count > 0)
    .map(([type, v]) => ({
      type,
      count: v.count,
      revenue: +v.revenue.toFixed(2),
    }));

  /* -------------------------------------------------------------------------- */
  /* 7. Top Tables Performance                                                  */
  /* -------------------------------------------------------------------------- */
  const tablePerf: Record<string, { name: string; orders: number; revenue: number }> = {};
  for (const o of qualifyingOrders) {
    if (!o.tableId) continue;
    const name = o.tableName || tableMap.get(o.tableId)?.name || "Table";
    if (!tablePerf[o.tableId]) tablePerf[o.tableId] = { name, orders: 0, revenue: 0 };
    tablePerf[o.tableId].orders++;
    tablePerf[o.tableId].revenue += Number(o.total || 0);
  }
  const topTables = Object.values(tablePerf)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6)
    .map((t) => ({ ...t, revenue: +t.revenue.toFixed(2) }));

  /* -------------------------------------------------------------------------- */
  /* 8. Sales by Hour (0-23 in Asia/Kolkata)                                    */
  /* -------------------------------------------------------------------------- */
  const hourly: number[] = new Array(24).fill(0);
  for (const o of qualifyingOrders) {
    const h = zonedHour(o.settledAt, timeZone);
    if (h >= 0 && h < 24) hourly[h]++;
  }

  /* -------------------------------------------------------------------------- */
  /* 9. Revenue by Category                                                     */
  /* -------------------------------------------------------------------------- */
  const catRevenue: Record<string, number> = {};
  for (const o of qualifyingOrders) {
    for (const it of o.items) {
      const cat = catMap[it.menuItemId] || "Other";
      catRevenue[cat] = (catRevenue[cat] || 0) + Number(it.price || 0) * Number(it.quantity || 0);
    }
  }
  const categoryBreakdown = Object.entries(catRevenue)
    .map(([name, value]) => ({ name, value: +Number(value || 0).toFixed(2) }))
    .sort((a, b) => b.value - a.value);

  /* -------------------------------------------------------------------------- */
  /* 10. Today vs Yesterday (settlement-based KPI comparison)                   */
  /* -------------------------------------------------------------------------- */
  const todayStart = zonedStart(todayStr, timeZone);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);

  // Settlement payments today and yesterday
  const { data: todayPayments } = await db
    .from("check_payments")
    .select("amount, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "SUCCEEDED")
    .gte("created_at", todayStart.toISOString())
    .lt("tomorrowStart" in { tomorrowStart } ? tomorrowStart.toISOString() : tomorrowStart.toISOString());

  const { data: yestPayments } = await db
    .from("check_payments")
    .select("amount, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "SUCCEEDED")
    .gte("created_at", yesterdayStart.toISOString())
    .lt("created_at", todayStart.toISOString());

  let todaysRevenue = (todayPayments ?? []).reduce((s, p: any) => s + Number(p.amount || 0), 0);
  let yestRevenue = (yestPayments ?? []).reduce((s, p: any) => s + Number(p.amount || 0), 0);

  // Completed orders today
  const todaysOrdersList = qualifyingOrders.filter(
    (o) => o.settledAt >= todayStart && o.settledAt < tomorrowStart,
  );
  const todaysOrders = todaysOrdersList.length;

  // Fallback to order totals if payments table is empty (e.g. test fixtures without check_payments)
  if (todaysRevenue === 0 && todaysOrdersList.length > 0) {
    todaysRevenue = todaysOrdersList.reduce((s, o) => s + o.total, 0);
  }

  // Calculate revenue change percentage: neutral 0.0 when baseline is 0 or growth is 0
  let revenueChange = 0;
  if (yestRevenue > 0) {
    revenueChange = +(((todaysRevenue - yestRevenue) / yestRevenue) * 100).toFixed(1);
  }

  /* -------------------------------------------------------------------------- */
  /* 11. Plan Entitlements & Locations                                          */
  /* -------------------------------------------------------------------------- */
  const plan = await resolvePlan(tenantId);
  const isAdvanced = !plan.isRestricted && (plan.isPaid || plan.isTrial);
  const multiLocationEnabled = checkFeature(plan, "multi_location_reporting").ok;

  const { data: locRows } = await db
    .from("locations")
    .select("id, name, is_primary")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("is_primary", { ascending: false });

  return json(req, {
    range: { from: fromStr, to: toStr, days: dailyRevenue.length, timezone: timeZone },
    totalRevenue: +totalRevenue.toFixed(2),
    totalOrders,
    avgOrder: +avgOrder.toFixed(2),
    netSales: +netSales.toFixed(2),
    taxCollected: +taxCollected.toFixed(2),
    serviceChargeCollected: +serviceChargeCollected.toFixed(2),
    dailyRevenue,
    topItems: isAdvanced ? topItems : [],
    categoryBreakdown: isAdvanced ? categoryBreakdown : [],
    advanced: isAdvanced,
    todaysRevenue: +todaysRevenue.toFixed(2),
    todaysOrders,
    revenueChange,
    typeBreakdown: isAdvanced ? typeBreakdown : [],
    topTables: isAdvanced ? topTables : [],
    hourly: isAdvanced ? hourly : [],
    paymentMethods: {
      cash: { amount: +cashAmount.toFixed(2), count: cashCount },
      upi: { amount: +upiAmount.toFixed(2), count: upiCount },
      card: { amount: +cardAmount.toFixed(2), count: cardCount },
      total: grossCollectedPayments,
    },
    locations: (locRows ?? []).map((l: any) => ({ id: l.id, name: l.name, isPrimary: l.is_primary })),
    multiLocationEnabled,
  });
}
