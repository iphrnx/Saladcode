// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { resolvePlan } from "../_shared/plans.ts";

/**
 * /functions/v1/analytics
 *   GET   aggregated analytics for the caller's tenant (analytics.view)
 *
 * All active plans (Starter and Pro) have full access to advanced analytics:
 * revenue trend, hourly distribution, order types, top selling items, top tables,
 * and category breakdown.
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
/*  Date ranges & Timezone helpers                                            */
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

/** Get hour of day (0-23) in restaurant's timeZone. */
function zonedHour(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "numeric",
    }).formatToParts(at);
    const hourPart = parts.find((p) => p.type === "hour");
    if (hourPart) {
      const val = parseInt(hourPart.value, 10);
      return (val === 24 ? 0 : val) % 24;
    }
  } catch {
    // fallback to UTC
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

  // The restaurant's own timezone decides where a day starts.
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

  // Build orders query with strict tenant isolation and valid revenue status
  let ordersQuery = db
    .from("orders")
    .select("*, items:order_items(*), table:tables(*)")
    .eq("tenant_id", tenantId)
    .or("status.eq.COMPLETED,payment_status.eq.PAID")
    .neq("status", "CANCELLED")
    .neq("payment_status", "REFUNDED")
    .gte("created_at", rangeStart.toISOString())
    .lt("created_at", rangeEnd.toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);

  const locationId = url.searchParams.get("location_id") || url.searchParams.get("locationId");
  if (locationId) {
    ordersQuery = ordersQuery.eq("location_id", locationId);
  }

  const { data: orderRows, error: ordersError } = await ordersQuery;
  if (ordersError) return json(req, { error: ordersError.message }, 500);

  const orders = (orderRows ?? []).map((o: any) => {
    const table = Array.isArray(o.table) ? o.table[0] : o.table;
    return {
      total: Number(o.total || 0),
      orderType: o.order_type || "DINE_IN",
      tableId: o.table_id,
      createdAt: o.created_at,
      items: (o.items ?? []).map((it: any) => ({
        menuItemId: it.menu_item_id,
        name: it.name,
        price: Number(it.price || 0),
        quantity: Number(it.quantity || 0),
      })),
      table: table ? { name: table.name } : null,
    };
  });

  // daily revenue across the selected range, in the restaurant's timezone
  const dailyRevenue: { date: string; label: string; revenue: number; orders: number }[] = [];
  for (let t = rangeStart.getTime(); t < rangeEnd.getTime(); t += DAY_MS) {
    const dayStart = new Date(t);
    const dayEnd = new Date(t + DAY_MS);
    const dayOrders = orders.filter(
      (o: any) => new Date(o.createdAt) >= dayStart && new Date(o.createdAt) < dayEnd,
    );
    const dateStr = zonedDateStr(dayStart, timeZone);
    dailyRevenue.push({
      date: dateStr,
      label: DAY_LABELS[new Date(`${dateStr}T00:00:00Z`).getUTCDay()],
      revenue: +dayOrders.reduce((s: number, o: any) => s + Number(o.total || 0), 0).toFixed(2),
      orders: dayOrders.length,
    });
  }

  const totalRevenue = orders.reduce((s: number, o: any) => s + Number(o.total || 0), 0);
  const avgOrder = orders.length ? totalRevenue / orders.length : 0;

  // top items
  const itemCounts: Record<string, { name: string; qty: number; revenue: number }> = {};
  for (const o of orders) {
    for (const it of o.items) {
      if (!itemCounts[it.menuItemId]) itemCounts[it.menuItemId] = { name: it.name, qty: 0, revenue: 0 };
      itemCounts[it.menuItemId].qty += it.quantity;
      itemCounts[it.menuItemId].revenue += it.price * it.quantity;
    }
  }
  const topItems = Object.values(itemCounts).sort((a, b) => b.qty - a.qty).slice(0, 6);

  // order type breakdown
  const typeBreakdown: Record<string, { count: number; revenue: number }> = {};
  for (const o of orders) {
    const t = o.orderType;
    if (!typeBreakdown[t]) typeBreakdown[t] = { count: 0, revenue: 0 };
    typeBreakdown[t].count++;
    typeBreakdown[t].revenue += Number(o.total || 0);
  }

  // table performance
  const tablePerf: Record<string, { name: string; orders: number; revenue: number }> = {};
  for (const o of orders) {
    if (!o.tableId) continue;
    const name = o.table?.name || "Unknown";
    if (!tablePerf[o.tableId]) tablePerf[o.tableId] = { name, orders: 0, revenue: 0 };
    tablePerf[o.tableId].orders++;
    tablePerf[o.tableId].revenue += Number(o.total || 0);
  }
  const topTables = Object.values(tablePerf).sort((a, b) => b.revenue - a.revenue).slice(0, 6);

  // hourly distribution in restaurant timezone
  const hourly: number[] = new Array(24).fill(0);
  for (const o of orders) {
    const h = zonedHour(new Date(o.createdAt), timeZone);
    hourly[h]++;
  }

  // category breakdown
  const { data: menuRows, error: menuError } = await db
    .from("menu_items")
    .select("id, category:categories(name)")
    .eq("tenant_id", tenantId)
    .limit(5000);
  if (menuError) return json(req, { error: menuError.message }, 500);

  const catMap: Record<string, string> = {};
  for (const m of menuRows ?? []) {
    const category = Array.isArray((m as any).category) ? (m as any).category[0] : (m as any).category;
    catMap[(m as any).id] = category?.name || "Other";
  }
  const catRevenue: Record<string, number> = {};
  for (const o of orders) {
    for (const it of o.items) {
      const cat = catMap[it.menuItemId] || "Other";
      catRevenue[cat] = (catRevenue[cat] || 0) + Number(it.price || 0) * Number(it.quantity || 0);
    }
  }
  const categoryBreakdown = Object.entries(catRevenue)
    .map(([name, value]) => ({ name, value: +Number(value || 0).toFixed(2) }))
    .sort((a, b) => b.value - a.value);

  // Today vs yesterday for KPI card
  const todayStart = zonedStart(todayStr, timeZone);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
  let recentQuery = db
    .from("orders")
    .select("total, created_at")
    .eq("tenant_id", tenantId)
    .or("status.eq.COMPLETED,payment_status.eq.PAID")
    .neq("status", "CANCELLED")
    .neq("payment_status", "REFUNDED")
    .gte("created_at", yesterdayStart.toISOString())
    .lt("created_at", tomorrowStart.toISOString());
  if (locationId) {
    recentQuery = recentQuery.eq("location_id", locationId);
  }
  const { data: recentRows } = await recentQuery;
  const recent = recentRows ?? [];
  const todaysOrders = recent.filter((o: any) => new Date(o.created_at) >= todayStart);
  const todaysRevenue = todaysOrders.reduce((s: number, o: any) => s + Number(o.total || 0), 0);

  const yestOrders = recent.filter((o: any) => new Date(o.created_at) < todayStart);
  const yestRevenue = yestOrders.reduce((s: number, o: any) => s + Number(o.total || 0), 0);
  const revenueChange = yestRevenue ? ((todaysRevenue - yestRevenue) / yestRevenue) * 100 : 0;

  // Plan verification: Starter and Pro both unlock full advanced analytics.
  // Multi-location reporting is enabled for Pro tenants.
  const plan = await resolvePlan(tenantId);
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
    totalOrders: orders.length,
    avgOrder: +avgOrder.toFixed(2),
    dailyRevenue,
    topItems: topItems.map((t) => ({ ...t, revenue: +t.revenue.toFixed(2) })),
    categoryBreakdown,
    // Advanced analytics unlocked for Starter & Pro
    advanced: true,
    todaysRevenue: +todaysRevenue.toFixed(2),
    todaysOrders: todaysOrders.length,
    revenueChange: +revenueChange.toFixed(1),
    typeBreakdown: Object.entries(typeBreakdown).map(([type, v]) => ({
      type,
      ...v,
      revenue: +v.revenue.toFixed(2),
    })),
    topTables: topTables.map((t) => ({ ...t, revenue: +t.revenue.toFixed(2) })),
    hourly,
    locations: (locRows ?? []).map((l: any) => ({ id: l.id, name: l.name, isPrimary: l.is_primary })),
    multiLocationEnabled,
  });
}
