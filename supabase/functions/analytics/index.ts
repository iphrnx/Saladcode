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
    .select("id, name, is_active, category:categories(name)")
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

    // Fetch missing check metadata if needed with deterministic ordering and error propagation
    const missingCheckIds = candidateCheckIds.filter((cid) => !localCheckMap.has(cid));
    if (missingCheckIds.length > 0) {
      for (let i = 0; i < missingCheckIds.length; i += 100) {
        const chunk = missingCheckIds.slice(i, i + 100);
        const extraChecks = await fetchAllPages<any>(async (from, to) => {
          return await db
            .from("table_checks")
            .select("id, table_id, session_id, order_type, status, subtotal, discount, tax, service_charge, total, paid_total, closed_at, invoice_date, location_id, created_at")
            .eq("tenant_id", tenantId)
            .in("id", chunk)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
        });
        for (const c of extraChecks) localCheckMap.set(c.id, c);
      }
    }

    // Determine ledger ownership across each candidate check's FULL payment history
    // Paginate deterministically and propagate query errors
    const allHistoryLedgerPaymentsByCheck = new Map<string, any[]>();
    if (candidateCheckIds.length > 0) {
      for (let i = 0; i < candidateCheckIds.length; i += 100) {
        const chunk = candidateCheckIds.slice(i, i + 100);
        const historyPayments = await fetchAllPages<any>(async (from, to) => {
          return await db
            .from("check_payments")
            .select("id, check_id, amount, method, status, staff_id, location_id, created_at")
            .eq("tenant_id", tenantId)
            .eq("status", "SUCCEEDED")
            .in("check_id", chunk)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
        });

        for (const p of historyPayments) {
          if (!allHistoryLedgerPaymentsByCheck.has(p.check_id)) {
            allHistoryLedgerPaymentsByCheck.set(p.check_id, []);
          }
          allHistoryLedgerPaymentsByCheck.get(p.check_id)!.push(p);
        }
      }
    }

    // Determine authoritative settlement event per check using verified full settlement rule
    const candidateEvents: ReconciledEvent[] = [];
    for (const cid of candidateCheckIds) {
      const chk = localCheckMap.get(cid);
      const historyPayments = allHistoryLedgerPaymentsByCheck.get(cid) ?? [];
      const checkTotal = Number(chk?.total || 0);

      // Identify the verified full-settlement payment (requires verified total > 0 and ledger coverage)
      let fullSettlementPayment: any = null;
      let runningPaid = 0;
      for (const p of historyPayments) {
        runningPaid += Number(p.amount || 0);
        if (checkTotal > 0 && Math.round(runningPaid * 100) >= Math.round(checkTotal * 100)) {
          fullSettlementPayment = p;
          break;
        }
      }

      if (fullSettlementPayment) {
        // Authoritative verified full ledger settlement (checkTotal > 0 and cumulative payments >= checkTotal)
        const rawMethod = String(fullSettlementPayment.method || "").toUpperCase();
        const method: "CASH" | "UPI" | "CARD" | "OTHER" =
          rawMethod === "CASH" ? "CASH" : rawMethod === "UPI" ? "UPI" : rawMethod === "CARD" ? "CARD" : "OTHER";

        const locId = fullSettlementPayment.location_id || chk?.location_id || (chk?.table_id ? tableMap.get(chk.table_id)?.location_id : null) || null;

        candidateEvents.push({
          checkId: cid,
          amount: checkTotal,
          settledAt: new Date(fullSettlementPayment.created_at),
          method,
          locationId: locId,
          isLedger: true,
        });
      } else if (chk && chk.status === "PAID" && (chk.closed_at || chk.invoice_date)) {
        // Authoritative finalization evidence: valid ₹0 sale or verified legacy check
        const amt = Number(chk.paid_total !== undefined && chk.paid_total !== null && chk.paid_total > 0 ? chk.paid_total : (chk.total ?? 0));
        if (amt >= 0) {
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

    // Query refunded orders in the window
    const windowRefunds = await fetchAllPages<any>(async (from, to) => {
      return await db
        .from("orders")
        .select("id, total, payment_status, payment_method, location_id, created_at, paid_at, updated_at")
        .eq("tenant_id", tenantId)
        .in("payment_status", ["REFUNDED", "refunded"])
        .gte("updated_at", winStart.toISOString())
        .lt("updated_at", winEnd.toISOString())
        .order("updated_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    });

    return { events: windowEvents, checkMap: localCheckMap, orders: allWindowOrders, refunds: windowRefunds };
  }

  /* -------------------------------------------------------------------------- */
  /* Reconcile Main Reporting Window                                            */
  /* -------------------------------------------------------------------------- */
  const { events: mainEvents, checkMap: mainCheckMap, orders: mainOrders, refunds: mainRefunds } =
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
  // Exclude zero-amount settlement events (e.g. ₹0 comped sales) from payment-method transaction counts
  let cashAmount = 0, cashCount = 0;
  let upiAmount = 0, upiCount = 0;
  let cardAmount = 0, cardCount = 0;
  let otherAmount = 0, otherCount = 0;

  for (const e of filteredEvents) {
    if (e.amount <= 0) continue;
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

  // Attribution of refunds across methods
  let cashRefunds = 0, upiRefunds = 0, cardRefunds = 0, otherRefunds = 0, unattributedRefunds = 0;
  let cashRefundCount = 0, upiRefundCount = 0, cardRefundCount = 0, otherRefundCount = 0, unattributedRefundCount = 0;
  for (const r of mainRefunds ?? []) {
    const locId = r.location_id;
    if (selectedLocationId && locId && locId !== selectedLocationId) continue;
    const rawMethod = String(r.payment_method || "").toUpperCase();
    const amt = Number(r.total || 0);
    if (rawMethod === "CASH") {
      cashRefunds += amt;
      cashRefundCount++;
    } else if (rawMethod === "UPI") {
      upiRefunds += amt;
      upiRefundCount++;
    } else if (rawMethod === "CARD") {
      cardRefunds += amt;
      cardRefundCount++;
    } else if (rawMethod === "OTHER") {
      otherRefunds += amt;
      otherRefundCount++;
    } else {
      unattributedRefunds += amt;
      unattributedRefundCount++;
    }
  }

  const cashNet = +(cashAmount - cashRefunds).toFixed(2);
  const upiNet = +(upiAmount - upiRefunds).toFixed(2);
  const cardNet = +(cardAmount - cardRefunds).toFixed(2);
  const otherNet = +(otherAmount - otherRefunds).toFixed(2);
  const totalRefundAmount = +(cashRefunds + upiRefunds + cardRefunds + otherRefunds + unattributedRefunds).toFixed(2);
  const paymentBreakdownTotal = +(cashAmount + upiAmount + cardAmount + otherAmount).toFixed(2);
  const totalNetAmount = +(paymentBreakdownTotal - totalRefundAmount).toFixed(2);

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
  // Initialize all active menu items to support zero-sale items in least-selling view
  const allItemSalesMap: Record<string, { id?: string; name: string; category: string; qty: number; revenue: number; isZeroSale: boolean }> = {};
  for (const m of menuRows ?? []) {
    if ((m as any).is_active === false) continue;
    const cat = Array.isArray((m as any).category) ? (m as any).category[0]?.name : (m as any).category?.name;
    allItemSalesMap[(m as any).id] = {
      id: (m as any).id,
      name: (m as any).name,
      category: cat || "Other",
      qty: 0,
      revenue: 0,
      isZeroSale: true,
    };
  }

  for (const o of qualifyingOrders) {
    for (const it of o.items) {
      const key = it.menuItemId || it.name;
      if (!allItemSalesMap[key]) {
        // Historical menu item preserved with audited name and category
        allItemSalesMap[key] = {
          id: it.menuItemId || undefined,
          name: it.name,
          category: catMap[it.menuItemId] || "Other",
          qty: 0,
          revenue: 0,
          isZeroSale: false,
        };
      }
      allItemSalesMap[key].qty += it.quantity;
      allItemSalesMap[key].revenue += it.price * it.quantity;
      allItemSalesMap[key].isZeroSale = false;
    }
  }

  const allItemsList = Object.values(allItemSalesMap).map((it) => ({
    ...it,
    revenue: +it.revenue.toFixed(2),
  }));

  const topItems = allItemsList
    .filter((it) => !it.isZeroSale)
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name));

  const typeMap: Record<string, { count: number; revenue: number }> = {
    DINE_IN: { count: 0, revenue: 0 },
    TAKEAWAY: { count: 0, revenue: 0 },
    DELIVERY: { count: 0, revenue: 0 },
  };
  for (const o of qualifyingOrders) {
    const t = o.orderType;
    if (!typeMap[t]) typeMap[t] = { count: 0, revenue: 0 };
    typeMap[t].count++;
    typeMap[t].revenue += Number(o.total || 0);
  }
  const totalOrderTypeRev = Object.values(typeMap).reduce((s, v) => s + v.revenue, 0);
  const typeBreakdown = Object.entries(typeMap).map(([type, v]) => ({
    type,
    count: v.count,
    revenue: +v.revenue.toFixed(2),
    aov: v.count > 0 ? +(v.revenue / v.count).toFixed(2) : 0,
    share: totalOrderTypeRev > 0 ? +((v.revenue / totalOrderTypeRev) * 100).toFixed(1) : 0,
  }));

  const tablePerf: Record<string, {
    tableId: string;
    name: string;
    sessions: Set<string>;
    revenue: number;
  }> = {};

  // 1. Process settled checks: each check settlement counted exactly once
  for (const e of filteredEvents) {
    if (!e.checkId) continue;
    const chk = mainCheckMap.get(e.checkId);
    const tableId = chk?.table_id;
    if (!tableId) continue;
    const name = tableMap.get(tableId)?.name || "Table";
    if (!tablePerf[tableId]) {
      tablePerf[tableId] = { tableId, name, sessions: new Set(), revenue: 0 };
    }
    const sessionId = chk.session_id || chk.id;
    tablePerf[tableId].sessions.add(sessionId);
    tablePerf[tableId].revenue += e.amount;
  }

  // 2. Direct table orders settled without a check
  for (const o of qualifyingOrders) {
    if (!o.tableId || o.checkId) continue;
    const name = o.tableName || tableMap.get(o.tableId)?.name || "Table";
    if (!tablePerf[o.tableId]) {
      tablePerf[o.tableId] = { tableId: o.tableId, name, sessions: new Set(), revenue: 0 };
    }
    tablePerf[o.tableId].sessions.add(o.id);
    tablePerf[o.tableId].revenue += Number(o.total || 0);
  }

  const topTables = Object.values(tablePerf)
    .map((t) => {
      const sessionCount = t.sessions.size;
      const rev = +t.revenue.toFixed(2);
      const avgBill = sessionCount > 0 ? +(rev / sessionCount).toFixed(2) : 0;
      return {
        tableId: t.tableId,
        name: t.name,
        orders: sessionCount, // backward compatibility
        sessionCount,
        revenue: rev,
        averageBill: avgBill,
        avgBill,
        utilization: null, // source data lacks defined available-time denominator
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));

  const hourly: number[] = new Array(24).fill(0);
  const hourlyRevenueArr: number[] = new Array(24).fill(0);
  for (const o of qualifyingOrders) {
    const h = zonedHour(o.settledAt, timeZone);
    if (h >= 0 && h < 24) {
      hourly[h]++;
      hourlyRevenueArr[h] += Number(o.total || 0);
    }
  }
  const hourlyBreakdown = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    orders: hourly[h],
    revenue: +hourlyRevenueArr[h].toFixed(2),
  }));

  const catStats: Record<string, { revenue: number; units: number }> = {};
  for (const o of qualifyingOrders) {
    for (const it of o.items) {
      const cat = catMap[it.menuItemId] || "Other";
      if (!catStats[cat]) catStats[cat] = { revenue: 0, units: 0 };
      catStats[cat].revenue += Number(it.price || 0) * Number(it.quantity || 0);
      catStats[cat].units += Number(it.quantity || 0);
    }
  }

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
  /* Previous Period Comparison Reconciled for Active Reporting Window          */
  /* -------------------------------------------------------------------------- */
  const windowDurationMs = rangeEnd.getTime() - rangeStart.getTime();
  const prevRangeStart = new Date(rangeStart.getTime() - windowDurationMs);
  const prevRangeEnd = rangeStart;
  const prevFromStr = zonedDateStr(prevRangeStart, timeZone);
  const prevToStr = zonedDateStr(new Date(prevRangeEnd.getTime() - DAY_MS), timeZone);

  const { events: prevEvents, checkMap: prevCheckMap, orders: prevOrders } =
    await getReconciledEventsForWindow(prevRangeStart, prevRangeEnd);

  const filteredPrevEvents = prevEvents.filter((e) => {
    if (!selectedLocationId) return true;
    return e.locationId === selectedLocationId;
  });

  const prevQualifyingOrders: any[] = [];
  for (const o of prevOrders) {
    const locId = resolveEntityLocation(o, prevCheckMap);
    if (selectedLocationId && locId !== selectedLocationId) continue;

    let settlementTime: Date | null = null;
    if (o.check_id) {
      const chkEvent = prevEvents.find((e) => e.checkId === o.check_id);
      if (chkEvent) settlementTime = chkEvent.settledAt;
    } else if (o.paid_at) {
      settlementTime = new Date(o.paid_at);
    } else if (o.completed_at) {
      settlementTime = new Date(o.completed_at);
    }

    if (!settlementTime || isNaN(settlementTime.getTime())) continue;
    if (settlementTime < prevRangeStart || settlementTime >= prevRangeEnd) continue;

    prevQualifyingOrders.push(o);
  }

  const prevDailyRevenue: { date: string; label: string; revenue: number; orders: number }[] = [];
  for (let t = prevRangeStart.getTime(); t < prevRangeEnd.getTime(); t += DAY_MS) {
    const dayStart = new Date(t);
    const dayEnd = new Date(t + DAY_MS);

    const dayEvents = filteredPrevEvents.filter(
      (e) => e.settledAt >= dayStart && e.settledAt < dayEnd
    );
    const dayRevenue = dayEvents.reduce((s, e) => s + e.amount, 0);

    const dayOrders = prevQualifyingOrders.filter(
      (o) => o.settledAt >= dayStart && o.settledAt < dayEnd
    );

    const dateStr = zonedDateStr(dayStart, timeZone);
    const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();

    prevDailyRevenue.push({
      date: dateStr,
      label: DAY_LABELS[dayOfWeek],
      revenue: +dayRevenue.toFixed(2),
      orders: dayOrders.length,
    });
  }

  const prevRevenue = +(filteredPrevEvents.reduce((s, e) => s + e.amount, 0)).toFixed(2);
  const prevTotalOrders = prevQualifyingOrders.length;
  const prevAvgOrder = prevTotalOrders > 0 ? +(prevRevenue / prevTotalOrders).toFixed(2) : 0;
  const prevNetSales = +(prevQualifyingOrders.reduce((s: number, o: any) => s + Math.max(0, Number(o.items_total || o.total || 0) - Number(o.discount || 0)), 0)).toFixed(2);

  function calcChange(curr: number, prev: number): number | null {
    if (prev > 0) {
      return +(((curr - prev) / prev) * 100).toFixed(1);
    }
    if (prev === 0 && curr > 0) {
      return 100.0;
    }
    if (prev === 0 && curr === 0) {
      return 0.0;
    }
    return null;
  }

  const periodRevenueChange = calcChange(totalRevenue, prevRevenue);
  const periodOrdersChange = calcChange(totalOrders, prevTotalOrders);
  const periodAvgOrderChange = calcChange(avgOrder, prevAvgOrder);
  const periodNetSalesChange = calcChange(netSales, prevNetSales);

  /* -------------------------------------------------------------------------- */
  /* Previous Period Category Revenue & Reconciled Category Breakdown           */
  /* -------------------------------------------------------------------------- */
  const prevCatRevenue: Record<string, number> = {};
  for (const o of prevQualifyingOrders) {
    for (const it of (o.items ?? [])) {
      const cat = catMap[it.menu_item_id || it.menuItemId] || "Other";
      prevCatRevenue[cat] = (prevCatRevenue[cat] || 0) + Number(it.price || 0) * Number(it.quantity || 0);
    }
  }

  const allCatNames = new Set([...Object.keys(catStats), ...Object.keys(prevCatRevenue)]);
  const totalCatRevenue = Object.values(catStats).reduce((s, v) => s + v.revenue, 0);
  const categoryBreakdown = Array.from(allCatNames)
    .map((name) => {
      const curStat = catStats[name] || { revenue: 0, units: 0 };
      const rev = +curStat.revenue.toFixed(2);
      const prevRev = +(prevCatRevenue[name] || 0).toFixed(2);
      let growth: number | null = null;
      if (prevRev > 0) {
        growth = +(((rev - prevRev) / prevRev) * 100).toFixed(1);
      } else if (prevRev === 0 && rev > 0) {
        growth = 100.0;
      } else if (prevRev === 0 && rev === 0) {
        growth = 0.0;
      }
      return {
        name,
        value: rev, // backwards compatible
        revenue: rev,
        units: curStat.units,
        share: totalCatRevenue > 0 ? +((rev / totalCatRevenue) * 100).toFixed(1) : 0,
        previousRevenue: prevRev,
        growth,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name));

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
    allItems: isAdvanced ? allItemsList : [],
    categoryBreakdown: isAdvanced ? categoryBreakdown : [],
    advanced: isAdvanced,
    todaysRevenue,
    todaysOrders,
    revenueChange: periodRevenueChange ?? revenueChange,
    comparison: {
      period: { from: prevFromStr, to: prevToStr, days: dailyRevenue.length },
      previous: {
        revenue: prevRevenue,
        orders: prevTotalOrders,
        avgOrder: prevAvgOrder,
        netSales: prevNetSales,
      },
      dailyRevenue: prevDailyRevenue,
      revenueChange: periodRevenueChange,
      ordersChange: periodOrdersChange,
      avgOrderChange: periodAvgOrderChange,
      netSalesChange: periodNetSalesChange,
    },
    typeBreakdown: isAdvanced ? typeBreakdown : [],
    topTables: isAdvanced ? topTables : [],
    hourly: isAdvanced ? hourly : [],
    hourlyBreakdown: isAdvanced ? hourlyBreakdown : [],
    paymentMethods: {
      cash: { amount: +cashAmount.toFixed(2), count: cashCount, refunds: +cashRefunds.toFixed(2), net: cashNet },
      upi: { amount: +upiAmount.toFixed(2), count: upiCount, refunds: +upiRefunds.toFixed(2), net: upiNet },
      card: { amount: +cardAmount.toFixed(2), count: cardCount, refunds: +cardRefunds.toFixed(2), net: cardNet },
      other: (otherCount > 0 || otherAmount > 0 || otherRefunds > 0) ? {
        amount: +otherAmount.toFixed(2),
        count: otherCount,
        refunds: +otherRefunds.toFixed(2),
        net: otherNet,
      } : { amount: 0, count: 0, refunds: 0, net: 0 },
      unattributedRefunds: unattributedRefunds > 0 ? {
        amount: +unattributedRefunds.toFixed(2),
        count: unattributedRefundCount,
      } : undefined,
      totalCollected: paymentBreakdownTotal,
      totalRefunds: totalRefundAmount,
      totalNet: totalNetAmount,
      total: paymentBreakdownTotal > 0 ? paymentBreakdownTotal : totalRevenue,
    },
    locations: (locRows ?? []).map((l: any) => ({ id: l.id, name: l.name, isPrimary: l.is_primary })),
    multiLocationEnabled,
  });
});
