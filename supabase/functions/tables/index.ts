// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { toCamel, embedCount } from "../_shared/case.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/tables
 *   GET            list tables + counts + live status (tables.view)
 *   POST           create a table (tables.manage)
 *   PATCH  [?id=]  update a table (tables.manage)
 *   DELETE [?id=]  delete a table (tables.manage)
 *
 * Ported from src/app/api/tables/*. The Next.js [id] route updated/deleted by
 * `id` alone; every write here is scoped to the caller's tenant.
 */

/** 9 random bytes as 18 hex chars — the unguessable per-table QR token. */
function tableToken(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "tables");
  const idFromPath = segments[0];
  const url = new URL(req.url);

  try {
    switch (req.method) {
      case "GET":
        return await list(req);
      case "POST":
        return await create(req);
      case "PATCH":
      case "PUT":
        return await update(req, idFromPath ?? url.searchParams.get("id"));
      case "DELETE":
        return await remove(req, idFromPath ?? url.searchParams.get("id"));
      default:
        return json(req, { error: "Method not allowed" }, 405);
    }
  } catch (err) {
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});

async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "tables.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const db = admin();

  const { data: tables, error } = await db
    .from("tables")
    .select("*, orders(count), reservations(count)")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true });

  if (error) return json(req, { error: error.message }, 500);

  // Which tables currently have food on them?
  const { data: activeOrders } = await db
    .from("orders")
    .select("table_id, status")
    .eq("tenant_id", tenantId)
    .in("status", ["PENDING", "PREPARING", "READY", "SERVED"]);

  const tableStatus: Record<string, string> = {};
  for (const o of activeOrders ?? []) {
    if (o.table_id) tableStatus[o.table_id] = o.status;
  }

  return json(
    req,
    (tables ?? []).map((row: any) => {
      const { orders, reservations, ...rest } = row;
      return {
        ...toCamel(rest),
        _count: {
          orders: embedCount(orders),
          reservations: embedCount(reservations),
        },
        currentStatus: tableStatus[row.id] || "AVAILABLE",
      };
    }),
  );
}

async function create(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "tables.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const b = await body(req) as any;
  if (!String(b.name ?? "").trim()) return json(req, { error: "Table name is required" }, 400);

  const { data, error } = await admin()
    .from("tables")
    .insert({
      tenant_id: tenantId,
      name: String(b.name).trim(),
      seats: Number(b.seats) || 4,
      area: b.area ? String(b.area).trim() || "Main Hall" : "Main Hall",
      active: b.active !== false,
      // Unguessable: this token is the only thing protecting a table's session.
      qr_token: tableToken(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      return json(req, { error: "A table with that name already exists" }, 409);
    }
    return json(req, { error: error.message }, 500);
  }
  return json(req, toCamel(data), 201);
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "tables.manage" });
  if (!g.ok) return g.response;
  const b = await body(req) as any;
  const tableId = id ?? (b.id as string | undefined);
  if (!tableId) return json(req, { error: "id is required" }, 400);

  const patch: Record<string, any> = {};
  if (b.name !== undefined) patch.name = String(b.name).trim();
  if (b.seats !== undefined) patch.seats = Number(b.seats) || 4;
  if (b.area !== undefined) patch.area = String(b.area).trim();
  if (b.active !== undefined) patch.active = Boolean(b.active);
  if (b.regenerateToken) patch.qr_token = tableToken();

  const { data, error } = await admin()
    .from("tables")
    .update(patch)
    .eq("id", tableId)
    .eq("tenant_id", g.session.tenantId) // tenant scoping — see header
    .select("*")
    .single();

  if (error) return json(req, { error: error.message }, 500);
  return json(req, toCamel(data));
}

async function remove(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "tables.manage" });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);

  const { error } = await admin()
    .from("tables")
    .delete()
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId); // tenant scoping

  if (error) return json(req, { error: error.message }, 500);
  return json(req, { success: true });
}
