// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/reservations
 *   GET                 list reservations, optional ?date= (orders.view)
 *   POST                create a reservation (tables.manage | orders.create)
 *   PATCH  [?id=]       update status / table (tables.manage | orders.create)
 *   DELETE [?id=]       delete a reservation (tables.manage | orders.create)
 *
 * Ported from src/app/api/reservations/route.ts and reservations/[id]/route.ts.
 * The Next.js PATCH and DELETE filtered by `id` alone; both are tenant-scoped
 * here so one restaurant cannot touch another's bookings.
 */

function mapTable(t: any) {
  if (!t) return null;
  const table = Array.isArray(t) ? t[0] : t;
  if (!table) return null;
  return {
    id: table.id,
    tenantId: table.tenant_id,
    name: table.name,
    seats: table.seats,
    area: table.area,
    qrToken: table.qr_token,
    active: table.active,
    createdAt: table.created_at,
  };
}

function mapReservation(r: any) {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tableId: r.table_id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    partySize: r.party_size,
    date: r.date,
    time: r.time,
    status: r.status,
    occasion: r.occasion,
    notes: r.notes,
    createdAt: r.created_at,
    table: mapTable(r.table),
  };
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "reservations");
  const url = new URL(req.url);
  const id = segments[0] ?? url.searchParams.get("id");

  try {
    switch (req.method) {
      case "GET":
        return await list(req);
      case "POST":
        return await create(req);
      case "PATCH":
      case "PUT":
        return await update(req, id);
      case "DELETE":
        return await remove(req, id);
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

async function list(req: Request): Promise<Response> {
  // A reservation is a table booked for a time — floor state, not order state.
  // The guest book carries names and phone numbers, so guarding it with
  // `orders.view` handed it to everyone who can see the order book, Kitchen
  // included. `tables.view` is the floor's read key and the right one here.
  const g = await guard(req, { permission: "tables.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const url = new URL(req.url);
  const date = url.searchParams.get("date");

  let query = admin()
    .from("reservations")
    .select("*, table:tables(*)")
    .eq("tenant_id", tenantId);
  if (date) query = query.eq("date", date);

  const { data, error } = await query
    .order("date", { ascending: true })
    .order("time", { ascending: true });
  if (error) return json(req, { error: error.message }, 500);
  return json(req, (data ?? []).map(mapReservation));
}

async function create(req: Request): Promise<Response> {
  const g = await guard(req, { anyOf: ["tables.manage", "orders.create"] });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const b = await body(req);

  // An empty body used to fall through to the insert and surface the database
  // constraint as a 500; the caller should hear that the fields are missing.
  if (!String(b.name ?? "").trim() || !b.date || !b.time) {
    return json(req, { error: "Name, date and time are required" }, 400);
  }

  const { data, error } = await admin()
    .from("reservations")
    .insert({
      tenant_id: tenantId,
      table_id: b.tableId || null,
      name: b.name,
      phone: b.phone,
      email: b.email,
      party_size: b.partySize,
      date: b.date,
      time: b.time,
      occasion: b.occasion,
      notes: b.notes,
      status: b.status || "PENDING",
    })
    .select("*, table:tables(*)")
    .single();
  if (error) return json(req, { error: error.message }, 500);
  return json(req, mapReservation(data), 201);
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { anyOf: ["tables.manage", "orders.create"] });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);
  const tenantId = g.session.tenantId;
  const b = await body(req);

  const data: Record<string, unknown> = {};
  if (b.status !== undefined) data.status = b.status;
  if (b.tableId !== undefined) data.table_id = b.tableId;

  const { data: reservation, error } = await admin()
    .from("reservations")
    .update(data)
    .eq("id", id)
    .eq("tenant_id", tenantId) // tenant scoping — see header comment
    .select("*, table:tables(*)")
    .single();
  if (error) return json(req, { error: error.message }, 500);
  return json(req, mapReservation(reservation));
}

async function remove(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { anyOf: ["tables.manage", "orders.create"] });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);
  const tenantId = g.session.tenantId;

  const { error } = await admin()
    .from("reservations")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId); // tenant scoping
  if (error) return json(req, { error: error.message }, 500);
  return json(req, { success: true });
}
