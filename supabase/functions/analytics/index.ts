import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { json, preflight } from "../_shared/http.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { resolvePlan, checkFeature } from "../_shared/plans.ts";

const DAY_MS = 86_400_000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  const p = preflight(req);
  if (p) return p;

  if (req.method !== "GET") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  // 1. Enforce analytics.view permission and derive tenant from authenticated session
  const g = await guard(req, { permission: "analytics.view" });
  if (!g.ok) return g.response;

  const tenantId = g.session.tenantId;
  const db = admin();

  // 2. Restore tenant timezone lookup via settings.key = 'timezone' and settings.value
  const { data: tzRow } = await db
    .from("settings")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("key", "timezone")
    .maybeSingle();

  const timeZone = tzRow?.value || "Asia/Kolkata";

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
  /* Pre-load tables and categories for menu items mapping                      */
  /* -------------------------------------------------------------------------- */
  const { data: allTenantTables } = await db
    .from("tables")
    .select("id, name, location_id")
    .eq("tenant_id", tenantId);
  const tableMap = new Map<string, { id: string; name: string; location_id: string | null }>();
  for (const t of allTenantTables ?? []) {
    tableMap.set(t.id, t);
  }

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
  /* Durable Location Resolver                                                  */
  /* -------------------------------------------------------------------------- */
  function resolveEntityLocation(
    entity: {
      location_id?: string | null;
      table_id?: string | null;
      check_id?: string | null;
    },
    checkLookup?: Map<string, any>
  ): string | null {
    // 1. Direct location on entity (persisted transaction data)
    if (entity.location_id) return entity.location_id;
    // 2. From table (Dine-in physically anchored to a location)
    if (entity.table_id && tableMap.has(entity.table_id)) {
      const loc = tableMap.get(entity.table_id)?.location_id;
      if (loc) return loc;
    }
    // 3. From associated check
    if (entity.check_id && checkLookup && checkLookup.has(entity.check_id)) {
      const chk = checkLookup.get(entity.check_id);
      if (chk.location_id) return chk.location_id;
      if (chk.table_id && tableMap.has(chk.table_id)) {
        const loc = tableMap.get(chk.table_id)?.location_id;
        if (loc) return loc;
      }
    }
    // 4. Unverifiable historical location data: left unassigned (never guessed)
    return null;
  }

  /* -------------------------------------------------------------------------- */
  /* Reusable Reconciliation Engine: Counts each settlement once                */
  /* -------------------------------------------------------------------------- */
  interface ReconciledEvent {
    checkId: string | null;
    orderId?: string;
    amount: number;
    settledAt: Date;
    method: "CASH" | "UPI" | "CARD" | "OTHER";
    locationId: string | null;
    isLedger: boolean;
  }

  async function getReconciledEventsForWindow(
    winStart: Date,
    winEnd: Date
  ): Promise<{ events: ReconciledEvent[]; checkMap: Map<string, any>; orders: any[] }> {
    // A. Query payments recorded in or near the window
    const payments = await fetchAllPages<any>(async (from, to) => {
      return await db
        .from("check_payments")
        .select("id, check_id, amount, method, status, staff_id, location_id, created_at")
        .eq("tenant_id", tenantId)
        .eq("status", "SUCCEEDED")
        .gte("created_at", winStart.toISOString())
        .lt("created_at", winEnd.toISOString())
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });

    // B. Query checks closed in or near the window
    const checks = await fetchAllPages<any>(async (from, to) => {
      return await db
        .from("table_checks")
        .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, location_id, created_at")
        .eq("tenant_id", tenantId)
        .eq("status", "PAID")
        .gte("closed_at", winStart.toISOString())
        .lt("closed_at", winEnd.toISOString())
        .order("closed_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });

    const localCheckMap = new Map<string, any>();
    for (const c of checks) localCheckMap.set(c.id, c);

    // Identify all candidate checks
    const candidateCheckIds = Array.from(
      new Set([...payments.map((p) => p.check_id), ...checks.map((c) => c.id)].filter(Boolean))
    );

    // Fetch missing check metadata if needed
    const missingCheckIds = candidateCheckIds.filter((cid) => !localCheckMap.has(cid));
    if (missingCheckIds.length > 0) {
      for (let i = 0; i < missingCheckIds.length; i += 100) {
        const chunk = missingCheckIds.slice(i, i + 100);
        const { data: extraChecks } = await db
          .from("table_checks")
          .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, location_id, created_at")
          .eq("tenant_id", tenantId)
          .in("id", chunk);
        for (const c of extraChecks ?? []) localCheckMap.set(c.id, c);
      }
    }

    // Determine ledger ownership across each candidate check's FULL payment history
    const allHistoryLedgerPaymentsByCheck = new Map<string, any[]>();
    if (candidateCheckIds.length > 0) {
      for (let i = 0; i < candidateCheckIds.length; i += 100) {
        const chunk = candidateCheckIds.slice(i, i + 100);
        const { data: historyPayments } = await db
          .from("check_payments")
          .select("id, check_id, amount, method, status, staff_id, location_id, created_at")
          .eq("tenant_id", tenantId)
          .eq("status", "SUCCEEDED")
          .in("check_id", chunk)
          .order("created_at", { ascending: true });

        for (const p of historyPayments ?? []) {
          if (!allHistoryLedgerPaymentsByCheck.has(p.check_id)) {
            allHistoryLedgerPaymentsByCheck.set(p.check_id, []);
          }
          allHistoryLedgerPaymentsByCheck.get(p.check_id)!.push(p);
        }
      }
    }

    // Determine authoritative settlement event per check
    const candidateEvents: ReconciledEvent[] = [];
    for (const cid of candidateCheckIds) {
      const chk = localCheckMap.get(cid);
      const historyPayments = allHistoryLedgerPaymentsByCheck.get(cid);

      if (historyPayments && historyPayments.length > 0) {
        // Authoritative Ledger-backed settlement: take the final full-settlement payment record
        const finalPayment = historyPayments[historyPayments.length - 1];
        const rawMethod = String(finalPayment.method || "").toUpperCase();
        const method: "CASH" | "UPI" | "CARD" | "OTHER" =
          rawMethod === "CASH" ? "CASH" : rawMethod === "UPI" ? "UPI" : rawMethod === "CARD" ? "CARD" : "OTHER";

        const locId = finalPayment.location_id || chk?.location_id || (chk?.table_id ? tableMap.get(chk.table_id)?.location_id : null) || null;

        candidateEvents.push({
          checkId: cid,
          amount: Number(finalPayment.amount || 0),
          settledAt: new Date(finalPayment.created_at),
          method,
          locationId: locId,
          isLedger: true,
        });
      } else if (chk && chk.status === "PAID") {
        // Authoritative Legacy settlement fallback (no ledger settlement exists anywhere across history)
        const amt = Number(chk.paid_total > 0 ? chk.paid_total : chk.total || 0);
        if (amt > 0) {
          const settleTime = chk.closed_at
            ? new Date(chk.closed_at)
            : (chk.invoice_date ? new Date(chk.invoice_date) : new Date(chk.created_at));

          const locId = chk.location_id || (chk.table_id ? tableMap.get(chk.table_id)?.location_id : null) || null;

          candidateEvents.push({
            checkId: cid,
            amount: amt,
            settledAt: settleTime,
            method: "OTHER",
            locationId: locId,
            isLedger: false,
          });
        }
      }
    }

    // C. Query settled orders in the window
    const paidAtOrders = await fetchAllPages<any>(async (from, to) => {
      return await db
        .from("orders")
        .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, tax, service_charge, total, paid_at, completed_at, created_at, served_by_id, payment_method, location_id, items:order_items(id, menu_item_id, name, price, quantity)")
        .eq("tenant_id", tenantId)
        .neq("status", "CANCELLED")
        .neq("status", "REJECTED")
        .neq("payment_status", "REFUNDED")
        .neq("payment_status", "refunded")
        .gte("paid_at", winStart.toISOString())
        .lt("paid_at", winEnd.toISOString())
        .order("paid_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });

    // Also include orders linked to closed checks where paid_at was null
    let extraOrders: any[] = [];
    if (candidateCheckIds.length > 0) {
      for (let i = 0; i < candidateCheckIds.length; i += 100) {
        const chunk = candidateCheckIds.slice(i, i + 100);
        const chunkOrders = await fetchAllPages<any>(async (from, to) => {
          return await db
            .from("orders")
            .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, tax, service_charge, total, paid_at, completed_at, created_at, served_by_id, payment_method, location_id, items:order_items(id, menu_item_id, name, price, quantity)")
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
        extraOrders.push(...chunkOrders);
      }
    }

    const orderMap = new Map<string, any>();
    for (const o of paidAtOrders) orderMap.set(o.id, o);
    for (const o of extraOrders) {
      if (!orderMap.has(o.id)) orderMap.set(o.id, o);
    }
    const allWindowOrders = Array.from(orderMap.values());

    // Standalone orders (no check)
    for (const o of allWindowOrders) {
      if (!o.check_id) {
        const settleTime = o.paid_at ? new Date(o.paid_at) : new Date(o.completed_at || o.created_at);
        const rawMethod = String(o.payment_method || "").toUpperCase();
        const method: "CASH" | "UPI" | "CARD" | "OTHER" =
          rawMethod === "CASH" ? "CASH" : rawMethod === "UPI" ? "UPI" : rawMethod === "CARD" ? "CARD" : "OTHER";

        candidateEvents.push({
          checkId: null,
          orderId: o.id,
          amount: Number(o.total || 0),
          settledAt: settleTime,
          method,
          locationId: resolveEntityLocation(o, localCheckMap),
          isLedger: false,
        });
      }
    }

    // Apply the window date filter to the single authoritative settlement timestamp
    const windowEvents = candidateEvents.filter(
      (e) => e.settledAt >= winStart && e.settledAt < winEnd
    );

    return { events: windowEvents, checkMap: localCheckMap, orders: allWindowOrders };
  }

  /* -------------------------------------------------------------------------- */
  /* Reconcile Main Reporting Window                                            */
  /* -------------------------------------------------------------------------- */
  const { events: mainEvents, checkMap: mainCheckMap, orders: mainOrders } =
    await getReconciledEventsForWindow(rangeStart, rangeEnd);

  // Apply location filter uniformly
  const filteredEvents = mainEvents.filter((e) => {
    if (!selectedLocationId) return true;
    return e.locationId === selectedLocationId;
  });

  const qualifyingOrders: any[] = [];
  for (const o of mainOrders) {
    const locId = resolveEntityLocation(o, mainCheckMap);
    if (selectedLocationId && locId !== selectedLocationId) continue;

    // Check if order belongs to a check that settled in this window
    let settlementTime: Date | null = null;
    if (o.check_id) {
      // Find the check's authoritative settlement event
      const chkEvent = mainEvents.find((e) => e.checkId === o.check_id);
      if (chkEvent) settlementTime = chkEvent.settledAt;
    } else if (o.paid_at) {
      settlementTime = new Date(o.paid_at);
    } else if (o.completed_at) {
      settlementTime = new Date(o.completed_at);
    }

    if (!settlementTime || isNaN(settlementTime.getTime())) continue;
    if (settlementTime < rangeStart || settlementTime >= rangeEnd) continue;

    const chk = o.check_id ? mainCheckMap.get(o.check_id) : null;
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

  // Payment method breakdowns (Cash, UPI, Card, Other accurately reported)
  let cashAmount = 0, cashCount = 0;
  let upiAmount = 0, upiCount = 0;
  let cardAmount = 0, cardCount = 0;
  let otherAmount = 0, otherCount = 0;

  for (const e of filteredEvents) {
    if (e.method === "CASH") {
      cashAmount += e.amount;
      cashCount++;
    } else if (e.method === "UPI") {
      upiAmount += e.amount;
      upiCount++;
    } else if (e.method === "CARD") {
      cardAmount += e.amount;
      cardCount++;
    } else {
      otherAmount += e.amount;
      otherCount++;
    }
  }

  /* -------------------------------------------------------------------------- */
  /* Daily Revenue Aggregation (Asia/Kolkata timezone boundaries)               */
  /* -------------------------------------------------------------------------- */
  const dailyRevenue: { date: string; label: string; revenue: number; orders: number }[] = [];
  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += DAY_MS) {
    const dayStart = new Date(t);
    const dayEnd = new Date(t + DAY_MS);

    const dayEvents = filteredEvents.filter(
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
  /* Top Items, Types, Tables, Hourly, Categories                               */
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

  const hourly: number[] = new Array(24).fill(0);
  for (const o of qualifyingOrders) {
    const h = zonedHour(o.settledAt, timeZone);
    if (h >= 0 && h < 24) hourly[h]++;
  }

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
  /* Independent Today & Yesterday Queries (Run through identical reconciliation)*/
  /* -------------------------------------------------------------------------- */
  const todayStart = zonedStart(todayStr, timeZone);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);

  // Today's independent reconciliation
  const { events: todayEvents } = await getReconciledEventsForWindow(todayStart, tomorrowStart);
  const filteredTodayEvents = todayEvents.filter((e) => {
    if (!selectedLocationId) return true;
    return e.locationId === selectedLocationId;
  });
  const todaysRevenue = +(filteredTodayEvents.reduce((s, e) => s + e.amount, 0)).toFixed(2);
  const todaysOrders = filteredTodayEvents.length;

  // Yesterday's independent reconciliation
  const { events: yestEvents } = await getReconciledEventsForWindow(yesterdayStart, todayStart);
  const filteredYestEvents = yestEvents.filter((e) => {
    if (!selectedLocationId) return true;
    return e.locationId === selectedLocationId;
  });
  const yestRevenue = +(filteredYestEvents.reduce((s, e) => s + e.amount, 0)).toFixed(2);

  let revenueChange = 0;
  if (yestRevenue > 0) {
    revenueChange = +(((todaysRevenue - yestRevenue) / yestRevenue) * 100).toFixed(1);
  }

  /* -------------------------------------------------------------------------- */
  /* Plan Entitlements & Locations                                              */
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

  const paymentBreakdownTotal = +(cashAmount + upiAmount + cardAmount + otherAmount).toFixed(2);

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
      other: { amount: +otherAmount.toFixed(2), count: otherCount },
      total: paymentBreakdownTotal > 0 ? paymentBreakdownTotal : totalRevenue,
    },
    locations: (locRows ?? []).map((l: any) => ({ id: l.id, name: l.name, isPrimary: l.is_primary })),
    multiLocationEnabled,
  });
});
