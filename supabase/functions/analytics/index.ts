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
  const adjusted = guess - zoneOffsetMinutes(new Date(guess), timeZone) * 60000;
  return new Date(guess - zoneOffsetMinutes(new Date(adjusted), timeZone) * 60000);
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
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
  const isCalendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && shiftDay(value, 0) === value;
  if (!isCalendarDate(fromStr) || !isCalendarDate(toStr) ||
      Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`) > 365 * DAY_MS) {
    return json(req, { error: "Select a valid date range of up to 366 days" }, 400);
  }

  const rangeStart = zonedStart(fromStr, timeZone);
  const rangeEnd = zonedStart(shiftDay(toStr, 1), timeZone); // exclusive

  const selectedLocationId = url.searchParams.get("location_id") || url.searchParams.get("locationId") || null;
  const compareEnabled = url.searchParams.get("compare") !== "0";

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
    .select("id, name, available, category:categories(name)")
    .eq("tenant_id", tenantId)
    .limit(5000);
  const catMap: Record<string, string> = {};
  const menuCatalog: { id: string; name: string; category: string; available: boolean }[] = [];
  for (const m of menuRows ?? []) {
    const category = Array.isArray((m as any).category) ? (m as any).category[0] : (m as any).category;
    const catName = category?.name || "Other";
    catMap[(m as any).id] = catName;
    menuCatalog.push({
      id: (m as any).id,
      name: (m as any).name || "Unnamed Item",
      category: catName,
      available: Boolean((m as any).available ?? true),
    });
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
        .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, promo_code, tax, service_charge, total, paid_at, completed_at, created_at, served_by_id, payment_method, location_id, items:order_items(id, menu_item_id, name, price, quantity)")
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
            .select("id, order_number, order_type, table_id, table_session_id, check_id, status, payment_status, items_total, discount, promo_code, tax, service_charge, total, paid_at, completed_at, created_at, served_by_id, payment_method, location_id, items:order_items(id, menu_item_id, name, price, quantity)")
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
  /* Helper: Build Reconciled Summary for any Window                            */
  /* -------------------------------------------------------------------------- */
  async function summarizeWindow(winStart: Date, winEnd: Date) {
    const { events, checkMap, orders } = await getReconciledEventsForWindow(winStart, winEnd);

    const locEvents = events.filter((e) => !selectedLocationId || e.locationId === selectedLocationId);
    const qualOrders: any[] = [];

    for (const o of orders) {
      const locId = resolveEntityLocation(o, checkMap);
      if (selectedLocationId && locId !== selectedLocationId) continue;

      let settlementTime: Date | null = null;
      if (o.check_id) {
        const chkEvent = events.find((e) => e.checkId === o.check_id);
        if (chkEvent) settlementTime = chkEvent.settledAt;
      } else if (o.paid_at) {
        settlementTime = new Date(o.paid_at);
      } else if (o.completed_at) {
        settlementTime = new Date(o.completed_at);
      }

      if (!settlementTime || isNaN(settlementTime.getTime())) continue;
      if (settlementTime < winStart || settlementTime >= winEnd) continue;

      const chk = o.check_id ? checkMap.get(o.check_id) : null;
      const effectiveTableId = o.table_id || chk?.table_id || null;
      const resolvedTable = effectiveTableId ? tableMap.get(effectiveTableId) : null;

      let normalizedType = String(o.order_type || chk?.order_type || (effectiveTableId ? "DINE_IN" : "TAKEAWAY"))
        .toUpperCase()
        .replace(/[-\s]/g, "_");
      if (!["DINE_IN", "TAKEAWAY", "DELIVERY"].includes(normalizedType)) {
        normalizedType = effectiveTableId ? "DINE_IN" : "TAKEAWAY";
      }

      const sessionKey = o.table_session_id || chk?.session_id || chk?.anchor_session_id || o.check_id || o.id;

      qualOrders.push({
        id: o.id,
        orderNumber: o.order_number,
        total: Number(o.total || 0),
        itemsTotal: Number(o.items_total || o.total || 0),
        discount: Number(o.discount || 0),
        promoCode: o.promo_code || null,
        tax: Number(o.tax || 0),
        serviceCharge: Number(o.service_charge || 0),
        orderType: normalizedType,
        tableId: effectiveTableId,
        tableName: resolvedTable?.name || (normalizedType === "DINE_IN" ? "Table" : normalizedType),
        sessionKey,
        settledAt: settlementTime,
        createdAt: o.created_at ? new Date(o.created_at) : null,
        completedAt: o.completed_at ? new Date(o.completed_at) : null,
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

    const daily: { date: string; label: string; revenue: number; orders: number }[] = [];
    for (let day = zonedDateStr(winStart, timeZone); zonedStart(day, timeZone) < winEnd; day = shiftDay(day, 1)) {
      const dayStart = zonedStart(day, timeZone);
      const dayEnd = zonedStart(shiftDay(day, 1), timeZone);
      const dayRevenue = locEvents
        .filter((e) => e.settledAt >= dayStart && e.settledAt < dayEnd)
        .reduce((s, e) => s + e.amount, 0);
      const dayOrderCount = qualOrders.filter(
        (o) => o.settledAt >= dayStart && o.settledAt < dayEnd
      ).length;
      const dateStr = zonedDateStr(dayStart, timeZone);
      const dayOfWeek = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      daily.push({
        date: dateStr,
        label: DAY_LABELS[dayOfWeek],
        revenue: +dayRevenue.toFixed(2),
        orders: dayOrderCount,
      });
    }

    const rev = +(daily.reduce((s, d) => s + d.revenue, 0)).toFixed(2);
    const cnt = qualOrders.length;
    const avg = cnt > 0 ? +(rev / cnt).toFixed(2) : 0;
    const net = +(qualOrders.reduce((s: number, o: any) => s + Math.max(0, o.itemsTotal - o.discount), 0)).toFixed(2);

    const catRev: Record<string, { revenue: number; units: number }> = {};
    for (const o of qualOrders) {
      for (const it of o.items) {
        const cat = (it.menuItemId && catMap[it.menuItemId]) || "Other";
        if (!catRev[cat]) catRev[cat] = { revenue: 0, units: 0 };
        catRev[cat].revenue += Number(it.price || 0) * Number(it.quantity || 0);
        catRev[cat].units += Number(it.quantity || 0);
      }
    }

    return {
      events: locEvents,
      checkMap,
      orders: qualOrders,
      daily,
      totalRevenue: rev,
      totalOrders: cnt,
      avgOrder: avg,
      netSales: net,
      catRev,
    };
  }

  /* -------------------------------------------------------------------------- */
  /* Reconcile Main Reporting Window & Previous Period                          */
  /* -------------------------------------------------------------------------- */
  const mainSummary = await summarizeWindow(rangeStart, rangeEnd);
  const filteredEvents = mainSummary.events;
  const mainCheckMap = mainSummary.checkMap;
  const qualifyingOrders = mainSummary.orders;
  const dailyRevenue = mainSummary.daily;
  const totalRevenue = mainSummary.totalRevenue;
  const totalOrders = mainSummary.totalOrders;
  const avgOrder = mainSummary.avgOrder;
  const netSales = mainSummary.netSales;

  const taxCollected = +(qualifyingOrders.reduce((s: number, o: any) => s + o.tax, 0)).toFixed(2);
  const serviceChargeCollected = +(qualifyingOrders.reduce((s: number, o: any) => s + o.serviceCharge, 0)).toFixed(2);

  // Previous period of equal day count immediately preceding rangeStart
  const periodDays = Math.max(1, dailyRevenue.length);
  const prevEnd = rangeStart;
  const prevStart = zonedStart(shiftDay(fromStr, -periodDays), timeZone);
  const prevFromStr = zonedDateStr(prevStart, timeZone);
  const prevToStr = shiftDay(fromStr, -1);
  const prevSummary = compareEnabled ? await summarizeWindow(prevStart, prevEnd) : null;

  /* -------------------------------------------------------------------------- */
  /* Refunds & Discounts (Audited Attribution)                                  */
  /* -------------------------------------------------------------------------- */
  // Legacy reversals without a verified date are not attributed to any period.
  // Both selection and chart bucketing use the same persisted reversal time.
  // 1. Voided ledger payments in window (explicit payment method)
  const voidPayments = await fetchAllPages<any>(async (from, to) => {
    return await db
      .from("check_payments")
      .select("id, check_id, amount, method, location_id, reversed_at")
      .eq("tenant_id", tenantId)
      .eq("status", "VOID")
      .gte("reversed_at", rangeStart.toISOString())
      .lt("reversed_at", rangeEnd.toISOString())
      .order("reversed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  });

  // 2. Refunded orders in window (may lack check_payments VOID record)
  const refundedOrders = await fetchAllPages<any>(async (from, to) => {
    return await db
      .from("orders")
      .select("id, order_number, check_id, table_id, total, payment_method, payment_status, location_id, reversed_at")
      .eq("tenant_id", tenantId)
      .in("payment_status", ["REFUNDED", "refunded"])
      .gte("reversed_at", rangeStart.toISOString())
      .lt("reversed_at", rangeEnd.toISOString())
      .order("reversed_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  });

  // Payment method breakdowns (Cash, UPI, Card, Other) + Refunds
  const pmStats = {
    CASH: { amount: 0, count: 0, refunds: 0, refundCount: 0 },
    UPI: { amount: 0, count: 0, refunds: 0, refundCount: 0 },
    CARD: { amount: 0, count: 0, refunds: 0, refundCount: 0 },
    OTHER: { amount: 0, count: 0, refunds: 0, refundCount: 0 },
  };
  let unattributedRefundAmount = 0;
  let unattributedRefundCount = 0;

  for (const e of filteredEvents) {
    if (e.amount <= 0) continue;
    pmStats[e.method].amount += e.amount;
    pmStats[e.method].count++;
  }

  const voidCheckIds = new Set<string>();
  const refundDailyMap: Record<string, { amount: number; count: number }> = {};

  for (const vp of voidPayments) {
    const locId = resolveEntityLocation(vp, mainCheckMap);
    if (selectedLocationId && locId !== selectedLocationId) continue;
    if (vp.check_id) voidCheckIds.add(vp.check_id);
    const amt = Number(vp.amount || 0);
    if (amt <= 0) continue;
    const rawM = String(vp.method || "").toUpperCase();
    const m: "CASH" | "UPI" | "CARD" | "OTHER" =
      rawM === "CASH" ? "CASH" : rawM === "UPI" ? "UPI" : rawM === "CARD" ? "CARD" : "OTHER";
    pmStats[m].refunds += amt;
    pmStats[m].refundCount++;
    const dStr = zonedDateStr(new Date(vp.reversed_at), timeZone);
    if (!refundDailyMap[dStr]) refundDailyMap[dStr] = { amount: 0, count: 0 };
    refundDailyMap[dStr].amount += amt;
    refundDailyMap[dStr].count++;
  }

  for (const ro of refundedOrders) {
    if (ro.check_id && voidCheckIds.has(ro.check_id)) continue;
    const locId = resolveEntityLocation(ro, mainCheckMap);
    if (selectedLocationId && locId !== selectedLocationId) continue;
    const amt = Number(ro.total || 0);
    if (amt <= 0) continue;
    const rawM = String(ro.payment_method || "").toUpperCase();
    if (rawM === "CASH" || rawM === "UPI" || rawM === "CARD") {
      pmStats[rawM].refunds += amt;
      pmStats[rawM].refundCount++;
    } else {
      unattributedRefundAmount += amt;
      unattributedRefundCount++;
    }
    const dStr = zonedDateStr(new Date(ro.reversed_at), timeZone);
    if (!refundDailyMap[dStr]) refundDailyMap[dStr] = { amount: 0, count: 0 };
    refundDailyMap[dStr].amount += amt;
    refundDailyMap[dStr].count++;
  }

  /* -------------------------------------------------------------------------- */
  /* Top & Least Selling Items, Order Types, Tables, Hourly, Categories         */
  /* -------------------------------------------------------------------------- */
  const itemCounts: Record<string, { menuItemId: string | null; name: string; category: string; qty: number; revenue: number }> = {};
  const soldMenuIds = new Set<string>();
  for (const o of qualifyingOrders) {
    for (const it of o.items) {
      const key = it.menuItemId || it.name;
      if (it.menuItemId) soldMenuIds.add(it.menuItemId);
      const cat = (it.menuItemId && catMap[it.menuItemId]) || "Uncategorized / Historical";
      if (!itemCounts[key]) {
        itemCounts[key] = { menuItemId: it.menuItemId || null, name: it.name, category: cat, qty: 0, revenue: 0 };
      }
      itemCounts[key].qty += it.quantity;
      itemCounts[key].revenue += it.price * it.quantity;
    }
  }
  const allItems = Object.values(itemCounts)
    .map((t) => ({ ...t, revenue: +t.revenue.toFixed(2) }))
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || a.name.localeCompare(b.name));
  const topItems = allItems.slice(0, 6).map(({ name, qty, revenue }) => ({ name, qty, revenue }));
  const zeroSaleItems = menuCatalog
    .filter((m) => m.available && !soldMenuIds.has(m.id))
    .map((m) => ({ menuItemId: m.id, name: m.name, category: m.category, qty: 0, revenue: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

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
  const typeTotalRev = Object.values(typeMap).reduce((s, v) => s + v.revenue, 0);
  const typeBreakdown = Object.entries(typeMap)
    .filter(([k, v]) => ["DINE_IN", "TAKEAWAY", "DELIVERY"].includes(k) || v.count > 0)
    .map(([type, v]) => ({
      type,
      count: v.count,
      revenue: +v.revenue.toFixed(2),
      share: typeTotalRev > 0 ? +((v.revenue / typeTotalRev) * 100).toFixed(1) : 0,
      avgOrder: v.count > 0 ? +(v.revenue / v.count).toFixed(2) : 0,
    }));

  // Top Tables: Count distinct sessions and settled revenue per table
  const tablePerf: Record<string, { tableId: string; name: string; orders: number; sessionKeys: Set<string>; revenue: number }> = {};
  for (const o of qualifyingOrders) {
    if (!o.tableId) continue;
    const name = o.tableName || tableMap.get(o.tableId)?.name || "Table";
    if (!tablePerf[o.tableId]) {
      tablePerf[o.tableId] = { tableId: o.tableId, name, orders: 0, sessionKeys: new Set(), revenue: 0 };
    }
    tablePerf[o.tableId].orders++;
    tablePerf[o.tableId].sessionKeys.add(String(o.sessionKey));
    tablePerf[o.tableId].revenue += Number(o.total || 0);
  }
  const topTables = Object.values(tablePerf)
    .map((t) => {
      const sessions = t.sessionKeys.size;
      const rev = +t.revenue.toFixed(2);
      return {
        tableId: t.tableId,
        name: t.name,
        orders: t.orders,
        sessions,
        revenue: rev,
        avgBill: sessions > 0 ? +(rev / sessions).toFixed(2) : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.sessions - a.sessions)
    .slice(0, 10);

  const hourly: number[] = new Array(24).fill(0);
  const hourlyRev: number[] = new Array(24).fill(0);
  for (const o of qualifyingOrders) {
    const h = zonedHour(o.settledAt, timeZone);
    if (h >= 0 && h < 24) {
      hourly[h]++;
      hourlyRev[h] += Number(o.total || 0);
    }
  }
  const hourlyDetailed = hourly.map((ordersCount, h) => ({
    hour: h,
    label: `${h}:00`,
    displayHour: h === 0 ? "12 AM" : h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`,
    orders: ordersCount,
    revenue: +hourlyRev[h].toFixed(2),
  }));

  const totalCatRev = Object.values(mainSummary.catRev).reduce((s, v) => s + v.revenue, 0);
  const categoryBreakdown = Object.entries(mainSummary.catRev)
    .map(([name, v]) => {
      const rev = +Number(v.revenue || 0).toFixed(2);
      const prevVal = prevSummary ? +(prevSummary.catRev[name]?.revenue ?? 0).toFixed(2) : null;
      const growthPct = prevVal !== null && prevVal > 0 ? +(((rev - prevVal) / prevVal) * 100).toFixed(1) : null;
      return {
        name,
        value: rev,
        units: v.units,
        share: totalCatRev > 0 ? +((rev / totalCatRev) * 100).toFixed(1) : 0,
        prevValue: prevVal,
        growthPct,
      };
    })
    .sort((a, b) => b.value - a.value);

  /* -------------------------------------------------------------------------- */
  /* Operations Performance (Valid Timestamps Only)                             */
  /* -------------------------------------------------------------------------- */
  const serviceDurationsMin: number[] = [];
  let excludedServiceCount = 0;
  for (const o of qualifyingOrders) {
    if (o.createdAt && o.completedAt && !isNaN(o.createdAt.getTime()) && !isNaN(o.completedAt.getTime())) {
      const diffMin = (o.completedAt.getTime() - o.createdAt.getTime()) / 60000;
      if (diffMin >= 0 && diffMin <= 1440) {
        serviceDurationsMin.push(diffMin);
      } else {
        excludedServiceCount++;
      }
    } else {
      excludedServiceCount++;
    }
  }
  serviceDurationsMin.sort((a, b) => a - b);
  const avgServiceMin = serviceDurationsMin.length > 0
    ? +(serviceDurationsMin.reduce((s, d) => s + d, 0) / serviceDurationsMin.length).toFixed(1)
    : null;
  const mid = Math.floor(serviceDurationsMin.length / 2);
  const medianServiceMin = serviceDurationsMin.length === 0 ? null
    : +((serviceDurationsMin[mid] + serviceDurationsMin[Math.floor((serviceDurationsMin.length - 1) / 2)]) / 2).toFixed(1);

  /* -------------------------------------------------------------------------- */
  /* Discounts & Refunds Summary                                                */
  /* -------------------------------------------------------------------------- */
  let totalDiscounts = 0;
  let discountedOrders = 0;
  const promoMap: Record<string, { code: string; count: number; amount: number }> = {};
  const discountDailyMap: Record<string, { amount: number; count: number }> = {};

  for (const o of qualifyingOrders) {
    if (o.discount > 0) {
      totalDiscounts += o.discount;
      discountedOrders++;
      const code = o.promoCode || "Manual / Direct Discount";
      if (!promoMap[code]) promoMap[code] = { code, count: 0, amount: 0 };
      promoMap[code].count++;
      promoMap[code].amount += o.discount;

      const dStr = zonedDateStr(o.settledAt, timeZone);
      if (!discountDailyMap[dStr]) discountDailyMap[dStr] = { amount: 0, count: 0 };
      discountDailyMap[dStr].amount += o.discount;
      discountDailyMap[dStr].count++;
    }
  }

  const totalRefunds = +(
    pmStats.CASH.refunds +
    pmStats.UPI.refunds +
    pmStats.CARD.refunds +
    pmStats.OTHER.refunds +
    unattributedRefundAmount
  ).toFixed(2);
  const totalRefundCount =
    pmStats.CASH.refundCount +
    pmStats.UPI.refundCount +
    pmStats.CARD.refundCount +
    pmStats.OTHER.refundCount +
    unattributedRefundCount;

  const discountsAndRefundsTrend = dailyRevenue.map((d) => ({
    date: d.date,
    label: d.label,
    discounts: +(discountDailyMap[d.date]?.amount ?? 0).toFixed(2),
    discountCount: discountDailyMap[d.date]?.count ?? 0,
    refunds: +(refundDailyMap[d.date]?.amount ?? 0).toFixed(2),
    refundCount: refundDailyMap[d.date]?.count ?? 0,
  }));

  /* -------------------------------------------------------------------------- */
  /* Independent Today & Yesterday Queries (Run through identical reconciliation)*/
  /* -------------------------------------------------------------------------- */
  const todayStart = zonedStart(todayStr, timeZone);
  const tomorrowStart = zonedStart(shiftDay(todayStr, 1), timeZone);
  const yesterdayStart = zonedStart(shiftDay(todayStr, -1), timeZone);

  const { events: todayEvents } = await getReconciledEventsForWindow(todayStart, tomorrowStart);
  const filteredTodayEvents = todayEvents.filter((e) => !selectedLocationId || e.locationId === selectedLocationId);
  const todaysRevenue = +(filteredTodayEvents.reduce((s, e) => s + e.amount, 0)).toFixed(2);
  const todaysOrders = filteredTodayEvents.length;

  const { events: yestEvents } = await getReconciledEventsForWindow(yesterdayStart, todayStart);
  const filteredYestEvents = yestEvents.filter((e) => !selectedLocationId || e.locationId === selectedLocationId);
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

  const totalCollected = +(
    pmStats.CASH.amount +
    pmStats.UPI.amount +
    pmStats.CARD.amount +
    pmStats.OTHER.amount
  ).toFixed(2);

  const pmEntry = (s: { amount: number; count: number; refunds: number; refundCount: number }) => ({
    amount: +s.amount.toFixed(2),
    count: s.count,
    refunds: +s.refunds.toFixed(2),
    refundCount: s.refundCount,
    net: +(s.amount - s.refunds).toFixed(2),
  });

  return json(req, {
    range: { from: fromStr, to: toStr, days: dailyRevenue.length, timezone: timeZone },
    previousPeriod: prevSummary
      ? {
          from: prevFromStr,
          to: prevToStr,
          days: periodDays,
          totalRevenue: prevSummary.totalRevenue,
          totalOrders: prevSummary.totalOrders,
          avgOrder: prevSummary.avgOrder,
          netSales: prevSummary.netSales,
          dailyRevenue: prevSummary.daily,
        }
      : null,
    totalRevenue,
    totalOrders,
    avgOrder: +avgOrder.toFixed(2),
    netSales: +netSales.toFixed(2),
    taxCollected,
    serviceChargeCollected,
    dailyRevenue,
    topItems: isAdvanced ? topItems : [],
    allItems: isAdvanced ? allItems : [],
    zeroSaleItems: isAdvanced ? zeroSaleItems : [],
    categoryBreakdown: isAdvanced ? categoryBreakdown : [],
    advanced: isAdvanced,
    todaysRevenue,
    todaysOrders,
    revenueChange,
    typeBreakdown: isAdvanced ? typeBreakdown : [],
    topTables: isAdvanced ? topTables : [],
    hourly: isAdvanced ? hourly : [],
    hourlyDetailed: isAdvanced ? hourlyDetailed : [],
    paymentMethods: {
      cash: pmEntry(pmStats.CASH),
      upi: pmEntry(pmStats.UPI),
      card: pmEntry(pmStats.CARD),
      other: pmEntry(pmStats.OTHER),
      unattributedRefunds: {
        amount: +unattributedRefundAmount.toFixed(2),
        count: unattributedRefundCount,
      },
      totalCollected,
      totalRefunds,
      totalNet: +(totalCollected - totalRefunds).toFixed(2),
      total: totalCollected > 0 ? totalCollected : totalRevenue,
    },
    operations: isAdvanced
      ? {
          orderVolume: totalOrders,
          prepTime: {
            available: false,
            reason: "Kitchen stage timestamps (preparing_at / ready_at) are not recorded in the current schema.",
          },
          serviceTime: {
            available: serviceDurationsMin.length > 0,
            startEvent: "Order Created (created_at)",
            endEvent: "Order Completed (completed_at)",
            avgMinutes: avgServiceMin,
            medianMinutes: medianServiceMin,
            sampleCount: serviceDurationsMin.length,
            excludedCount: excludedServiceCount,
          },
        }
      : null,
    discountsAndRefunds: {
      totalDiscounts: +totalDiscounts.toFixed(2),
      discountedOrders,
      discountBreakdown: Object.values(promoMap)
        .map((p) => ({ ...p, amount: +p.amount.toFixed(2) }))
        .sort((a, b) => b.amount - a.amount),
      totalRefunds,
      refundCount: totalRefundCount,
      refundBreakdown: [
        ...(pmStats.CASH.refundCount > 0 ? [{ method: "Cash", count: pmStats.CASH.refundCount, amount: +pmStats.CASH.refunds.toFixed(2) }] : []),
        ...(pmStats.UPI.refundCount > 0 ? [{ method: "UPI", count: pmStats.UPI.refundCount, amount: +pmStats.UPI.refunds.toFixed(2) }] : []),
        ...(pmStats.CARD.refundCount > 0 ? [{ method: "Card", count: pmStats.CARD.refundCount, amount: +pmStats.CARD.refunds.toFixed(2) }] : []),
        ...(pmStats.OTHER.refundCount > 0 ? [{ method: "Other / Legacy", count: pmStats.OTHER.refundCount, amount: +pmStats.OTHER.refunds.toFixed(2) }] : []),
        ...(unattributedRefundCount > 0 ? [{ method: "Method Unavailable", count: unattributedRefundCount, amount: +unattributedRefundAmount.toFixed(2) }] : []),
      ],
      trend: discountsAndRefundsTrend,
    },
    locations: (locRows ?? []).map((l: any) => ({ id: l.id, name: l.name, isPrimary: l.is_primary })),
    multiLocationEnabled,
  });
});
