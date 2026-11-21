import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { resolvePlan, checkFeature } from "../_shared/plans.ts";

const DAY_MS = 86_400_000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - at.getTime()) / 60000;
}

function zonedStart(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000);
}

function zonedDateStr(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function zonedHour(at: Date, timeZone: string): number {
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
  return at.getUTCHours();
}

/**
 * Deterministically paginate all matching rows from PostgREST
 */
async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<{ data: T[] | null; error: any }>,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "GET") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, supabaseKey);

  const tenantId = req.headers.get("x-tenant-id");
  if (!tenantId) {
    return json(req, { error: "Missing x-tenant-id header" }, 400);
  }

  // Pre-fetch tenant settings for timezone
  const { data: tenantSettings } = await db
    .from("settings")
    .select("timezone")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const timeZone = tenantSettings?.timezone || "Asia/Kolkata";

  const url = new URL(req.url);
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

  const selectedLocationId = url.searchParams.get("location_id") || url.searchParams.get("locationId") || null;

  /* -------------------------------------------------------------------------- */
  /* Pre-load metadata for location resolution, tables, staff, and categories    */
  /* -------------------------------------------------------------------------- */
  // 1. Tables for tenant
  const { data: allTenantTables } = await db
    .from("tables")
    .select("id, name, location_id")
    .eq("tenant_id", tenantId);
  const tableMap = new Map<string, { id: string; name: string; location_id: string | null }>();
  for (const t of allTenantTables ?? []) {
    tableMap.set(t.id, t);
  }

  // 2. Staff for tenant (to resolve Takeaway / Delivery location from staff profile)
  const { data: tenantStaff } = await db
    .from("staff")
    .select("id, profile_id, location_id")
    .eq("tenant_id", tenantId);
  const staffLocMap = new Map<string, string>();
  for (const s of tenantStaff ?? []) {
    if (s.location_id) {
      staffLocMap.set(s.id, s.location_id);
      if (s.profile_id) staffLocMap.set(s.profile_id, s.location_id);
    }
  }

  // 3. Menu categories
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
  /* Location Resolver: verifies location without guessing missing data        */
  /* -------------------------------------------------------------------------- */
  const checkMap = new Map<string, any>();

  function resolveLocation(entity: {
    location_id?: string | null;
    table_id?: string | null;
    check_id?: string | null;
    staff_id?: string | null;
    created_by?: string | null;
    served_by_id?: string | null;
  }): string | null {
    if (entity.location_id) return entity.location_id;
    if (entity.table_id && tableMap.has(entity.table_id)) {
      const loc = tableMap.get(entity.table_id)?.location_id;
      if (loc) return loc;
    }
    if (entity.check_id && checkMap.has(entity.check_id)) {
      const chk = checkMap.get(entity.check_id);
      if (chk.location_id) return chk.location_id;
      if (chk.table_id && tableMap.has(chk.table_id)) {
        const loc = tableMap.get(chk.table_id)?.location_id;
        if (loc) return loc;
      }
    }
    const staffId = entity.staff_id || entity.served_by_id || entity.created_by;
    if (staffId && staffLocMap.has(staffId)) {
      return staffLocMap.get(staffId) ?? null;
    }
    return null;
  }

  function matchesSelectedLocation(entity: any): boolean {
    if (!selectedLocationId) return true;
    const resolved = resolveLocation(entity);
    return resolved === selectedLocationId;
  }

  /* -------------------------------------------------------------------------- */
  /* 1. Database Settlement Queries with Deterministic Pagination               */
  /* -------------------------------------------------------------------------- */
  // A. Table checks closed within [rangeStart, rangeEnd)
  let rangeChecks: any[] = [];
  try {
    rangeChecks = await fetchAllPages(async (from, to) => {
      return await db
        .from("table_checks")
        .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, created_at")
        .eq("tenant_id", tenantId)
        .eq("status", "PAID")
        .gte("closed_at", rangeStart.toISOString())
        .lt("closed_at", rangeEnd.toISOString())
        .order("closed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });
  } catch (err: any) {
    return json(req, { error: err.message }, 500);
  }

  for (const c of rangeChecks) checkMap.set(c.id, c);

  // B. Authoritative Settlement Payments (check_payments) within [rangeStart, rangeEnd)
  let paymentRows: any[] = [];
  try {
    paymentRows = await fetchAllPages(async (from, to) => {
      return await db
        .from("check_payments")
        .select("id, check_id, amount, method, status, staff_id, created_by, created_at")
        .eq("tenant_id", tenantId)
        .eq("status", "SUCCEEDED")
        .gte("created_at", rangeStart.toISOString())
        .lt("created_at", rangeEnd.toISOString())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });
  } catch (err: any) {
    return json(req, { error: err.message }, 500);
  }

  // Pre-load any checks linked to payments that were not closed in the same window
  const missingCheckIds = Array.from(
    new Set(paymentRows.map((p) => p.check_id).filter((cid) => cid && !checkMap.has(cid)))
  );
  if (missingCheckIds.length > 0) {
    for (let i = 0; i < missingCheckIds.length; i += 100) {
      const chunk = missingCheckIds.slice(i, i + 100);
      const { data: extraChecks } = await db
        .from("table_checks")
        .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, created_at")
        .eq("tenant_id", tenantId)
        .in("id", chunk);
      for (const c of extraChecks ?? []) checkMap.set(c.id, c);
    }
  }

  // C. Settled Orders filtered by verified settlement timestamps directly in DB
  let paidAtOrders: any[] = [];
  try {
    paidAtOrders = await fetchAllPages(async (from, to) => {
      return await db
        .from("orders")
        .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, tax, service_charge, total, paid_at, completed_at, created_at, served_by_id, payment_method, items:order_items(id, menu_item_id, name, price, quantity)")
        .eq("tenant_id", tenantId)
        .neq("status", "CANCELLED")
        .neq("status", "REJECTED")
        .neq("payment_status", "REFUNDED")
        .neq("payment_status", "refunded")
        .gte("paid_at", rangeStart.toISOString())
        .lt("paid_at", rangeEnd.toISOString())
        .order("paid_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });
  } catch (err: any) {
    return json(req, { error: err.message }, 500);
  }

  // Also include orders linked to closed checks in range where paid_at was null
  let extraCheckOrders: any[] = [];
  const rangeCheckIds = rangeChecks.map((c) => c.id);
  if (rangeCheckIds.length > 0) {
    try {
      for (let i = 0; i < rangeCheckIds.length; i += 100) {
        const chunk = rangeCheckIds.slice(i, i + 100);
        const chunkOrders = await fetchAllPages(async (from, to) => {
          return await db
            .from("orders")
            .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, tax, service_charge, total, paid_at, completed_at, created_at, served_by_id, payment_method, items:order_items(id, menu_item_id, name, price, quantity)")
            .eq("tenant_id", tenantId)
            .neq("status", "CANCELLED")
            .neq("status", "REJECTED")
            .neq("payment_status", "REFUNDED")
            .neq("payment_status", "refunded")
            .is("paid_at", null)
            .in("check_id", chunk)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
        });
        extraCheckOrders.push(...chunkOrders);
      }
    } catch (err: any) {
      return json(req, { error: err.message }, 500);
    }
  }

  const orderMap = new Map<string, any>();
  for (const o of paidAtOrders) orderMap.set(o.id, o);
  for (const o of extraCheckOrders) {
    if (!orderMap.has(o.id)) orderMap.set(o.id, o);
  }
  const allRangeOrders = Array.from(orderMap.values());

  /* -------------------------------------------------------------------------- */
  /* 2. Location Scoping across Collections and Orders                           */
  /* -------------------------------------------------------------------------- */
  const filteredPayments = paymentRows.filter((p) => matchesSelectedLocation(p));
  const filteredChecks = rangeChecks.filter((c) => matchesSelectedLocation(c));

  const qualifyingOrders: any[] = [];
  for (const o of allRangeOrders) {
    if (!matchesSelectedLocation(o)) continue;

    // Determine authoritative settlement timestamp
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
    if (settlementTime < rangeStart || settlementTime >= rangeEnd) continue;

    const chk = o.check_id ? checkMap.get(o.check_id) : null;
    const effectiveTableId = o.table_id || chk?.table_id || null;
    const resolvedTable = effectiveTableId ? tableMap.get(effectiveTableId) : null;

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
      checkId: o.check_id || null,
      paymentMethod: o.payment_method || null,
      items: (o.items ?? []).map((it: any) => ({
        menuItemId: it.menu_item_id,
        name: it.name,
        price: Number(it.price || 0),
        quantity: Number(it.quantity || 0),
      })),
    });
  }

  /* -------------------------------------------------------------------------- */
  /* 3. Unified Financial Reconciliation (Entity Level: Checks & Orders)        */
  /* -------------------------------------------------------------------------- */
  // Find which checks have ledger records (check_payments)
  const checksWithLedger = new Set<string>();
  for (const p of filteredPayments) {
    if (p.check_id) checksWithLedger.add(p.check_id);
  }

  let cashAmount = 0, cashCount = 0;
  let upiAmount = 0, upiCount = 0;
  let cardAmount = 0, cardCount = 0;

  // 1. Process ledger payments
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

  // 2. Identify verified legacy settlements without ledger records
  interface ReconciledRevenueEvent {
    amount: number;
    settledAt: Date;
    method?: string;
  }
  const reconciledEvents: ReconciledRevenueEvent[] = [];

  // A. All ledger payments are authoritative events
  for (const p of filteredPayments) {
    reconciledEvents.push({
      amount: Number(p.amount || 0),
      settledAt: new Date(p.created_at),
      method: String(p.method || "").toUpperCase(),
    });
  }

  // B. Legacy checks without ledger payments
  for (const c of filteredChecks) {
    if (!checksWithLedger.has(c.id)) {
      const checkAmt = Number(c.paid_total > 0 ? c.paid_total : c.total || 0);
      if (checkAmt > 0) {
        const checkSettleTime = c.closed_at
          ? new Date(c.closed_at)
          : (c.invoice_date ? new Date(c.invoice_date) : new Date(c.created_at));
        reconciledEvents.push({
          amount: checkAmt,
          settledAt: checkSettleTime,
          method: "LEGACY",
        });
      }
    }
  }

  // C. Standalone qualifying orders without checks
  for (const o of qualifyingOrders) {
    if (!o.checkId) {
      reconciledEvents.push({
        amount: Number(o.total || 0),
        settledAt: o.settledAt,
        method: o.paymentMethod ? String(o.paymentMethod).toUpperCase() : "CASH",
      });
      // Attribute standalone payment method to cash/upi/card counters
      const m = (o.paymentMethod || "CASH").toUpperCase();
      if (m === "CASH") { cashAmount += o.total; cashCount++; }
      else if (m === "UPI") { upiAmount += o.total; upiCount++; }
      else if (m === "CARD") { cardAmount += o.total; cardCount++; }
    }
  }

  // Fallback for environments with orders only and no checks/payments created yet
  if (reconciledEvents.length === 0 && qualifyingOrders.length > 0) {
    for (const o of qualifyingOrders) {
      reconciledEvents.push({
        amount: Number(o.total || 0),
        settledAt: o.settledAt,
        method: o.paymentMethod ? String(o.paymentMethod).toUpperCase() : "CASH",
      });
      const m = (o.paymentMethod || "CASH").toUpperCase();
      if (m === "CASH") { cashAmount += o.total; cashCount++; }
      else if (m === "UPI") { upiAmount += o.total; upiCount++; }
      else if (m === "CARD") { cardAmount += o.total; cardCount++; }
    }
  }

  /* -------------------------------------------------------------------------- */
  /* 4. Daily Revenue Aggregation (Asia/Kolkata timezone boundaries)           */
  /* -------------------------------------------------------------------------- */
  const dailyRevenue: { date: string; label: string; revenue: number; orders: number }[] = [];
  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += DAY_MS) {
    const dayStart = new Date(t);
    const dayEnd = new Date(t + DAY_MS);

    // Filter authoritative reconciled events in this day bucket
    const dayEvents = reconciledEvents.filter(
      (e) => e.settledAt >= dayStart && e.settledAt < dayEnd
    );
    const dayRevenue = dayEvents.reduce((s, e) => s + e.amount, 0);

    const dayOrders = qualifyingOrders.filter(
      (o) => o.settledAt >= dayStart && o.settledAt < dayEnd
    );

    const dateStr = zonedDateStr(dayStart, timeZone);
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();

    dailyRevenue.push({
      date: dateStr,
      label: DAY_LABELS[dayOfWeek],
      revenue: +dayRevenue.toFixed(2),
      orders: dayOrders.length,
    });
  }

  // Gross Collected is the EXACT sum of daily reconciled revenues
  const totalRevenue = +(dailyRevenue.reduce((s, d) => s + d.revenue, 0)).toFixed(2);
  const totalOrders = qualifyingOrders.length;
  const avgOrder = totalOrders > 0 ? +(totalRevenue / totalOrders).toFixed(2) : 0;

  const netSales = qualifyingOrders.reduce((s: number, o: any) => s + Math.max(0, o.itemsTotal - o.discount), 0);
  const taxCollected = qualifyingOrders.reduce((s: number, o: any) => s + o.tax, 0);
  const serviceChargeCollected = qualifyingOrders.reduce((s: number, o: any) => s + o.serviceCharge, 0);

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
  /* 10. Today vs Yesterday (scoped to selected location and reconciled)       */
  /* -------------------------------------------------------------------------- */
  const todayStart = zonedStart(todayStr, timeZone);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);

  // Today's reconciled revenue and orders
  const todayReconciledEvents = reconciledEvents.filter(
    (e) => e.settledAt >= todayStart && e.settledAt < tomorrowStart
  );
  let todaysRevenue = +(todayReconciledEvents.reduce((s, e) => s + e.amount, 0)).toFixed(2);

  const todaysOrdersList = qualifyingOrders.filter(
    (o) => o.settledAt >= todayStart && o.settledAt < tomorrowStart
  );
  const todaysOrders = todaysOrdersList.length;

  if (todaysRevenue === 0 && todaysOrdersList.length > 0) {
    todaysRevenue = +(todaysOrdersList.reduce((s, o) => s + o.total, 0)).toFixed(2);
  }

  // Yesterday's reconciled revenue
  const yestReconciledEvents = reconciledEvents.filter(
    (e) => e.settledAt >= yesterdayStart && e.settledAt < todayStart
  );
  let yestRevenue = +(yestReconciledEvents.reduce((s, e) => s + e.amount, 0)).toFixed(2);

  // If yesterday is outside the main queried range, query DB with the same location scope
  if (yesterdayStart < rangeStart) {
    const { data: yestDbPayments } = await db
      .from("check_payments")
      .select("id, check_id, amount, method, status, staff_id, created_by, created_at")
      .eq("tenant_id", tenantId)
      .eq("status", "SUCCEEDED")
      .gte("created_at", yesterdayStart.toISOString())
      .lt("created_at", todayStart.toISOString());

    const filteredYestPayments = (yestDbPayments ?? []).filter((p: any) => matchesSelectedLocation(p));
    yestRevenue = +(filteredYestPayments.reduce((s: number, p: any) => s + Number(p.amount || 0), 0)).toFixed(2);
  }

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

  const paymentBreakdownTotal = +(cashAmount + upiAmount + cardAmount).toFixed(2);

  return json(req, {
    range: { from: fromStr, to: toStr, days: dailyRevenue.length, timezone: timeZone },
    totalRevenue,
    totalOrders,
    avgOrder: +avgOrder.toFixed(2),
    netSales: +netSales.toFixed(2),
    taxCollected: +taxCollected.toFixed(2),
    serviceChargeCollected: +serviceChargeCollected.toFixed(2),
    dailyRevenue,
    topItems: isAdvanced ? topItems : [],
    categoryBreakdown: isAdvanced ? categoryBreakdown : [],
    advanced: isAdvanced,
    todaysRevenue,
    todaysOrders,
    revenueChange,
    typeBreakdown: isAdvanced ? typeBreakdown : [],
    topTables: isAdvanced ? topTables : [],
    hourly: isAdvanced ? hourly : [],
    paymentMethods: {
      cash: { amount: +cashAmount.toFixed(2), count: cashCount },
      upi: { amount: +upiAmount.toFixed(2), count: upiCount },
      card: { amount: +cardAmount.toFixed(2), count: cardCount },
      total: paymentBreakdownTotal > 0 ? paymentBreakdownTotal : totalRevenue,
    },
    locations: (locRows ?? []).map((l: any) => ({ id: l.id, name: l.name, isPrimary: l.is_primary })),
    multiLocationEnabled,
  });
});
