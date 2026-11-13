// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { evaluatePromo } from "../_shared/promo.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/promos
 *   GET            list promo codes (promos.view)
 *   POST           create a promo (promos.manage)
 *   POST  /validate check a code against a cart total (orders.manage)
 *   PATCH  [?id=]  update a promo (promos.manage)
 *   DELETE [?id=]  delete a promo (promos.manage)
 *
 * Ported from src/app/api/promos/*. The Next.js [id] route updated/deleted by
 * `id` alone; every write here is scoped to the caller's tenant. Responses keep
 * the legacy camelCase shape (mapPromo).
 */

function mapPromo(p: any) {
  return {
    id: p.id,
    tenantId: p.tenant_id,
    code: p.code,
    description: p.description,
    type: p.type,
    value: p.value,
    minOrder: p.min_order,
    maxDiscount: p.max_discount,
    usageLimit: p.usage_limit,
    usedCount: p.used_count,
    validFrom: p.valid_from,
    validTo: p.valid_to,
    active: p.active,
    createdAt: p.created_at,
  };
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "promos");
  const url = new URL(req.url);

  try {
    switch (req.method) {
      case "GET":
        return await list(req);
      case "POST":
        if (segments[0] === "validate") return await validate(req);
        return await create(req);
      case "PATCH":
      case "PUT":
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

async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "promos.view" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const { data, error } = await admin()
    .from("promo_codes")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (error) return json(req, { error: error.message }, 500);
  return json(req, (data ?? []).map(mapPromo));
}

/**
 * Check a promo code against a cart total without applying it.
 *
 * The POS asks this before showing a discount, so the cashier learns straight
 * away that a code is expired, used up, or below the minimum order — instead
 * of discovering it when the server quietly charges full price.
 *
 * Guarded by orders.manage, not promos.view: a cashier needs this to take an
 * order, and the Waiter/Cashier/Kitchen roles have orders.manage while being
 * kept out of promo administration.
 */
async function validate(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "orders.discount" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const b = await body(req) as any;
  const code = typeof b.code === "string" ? b.code : "";
  const total = Number(b.total) || 0;

  const { data: tenant } = await admin()
    .from("tenants")
    .select("currency_symbol")
    .eq("id", tenantId)
    .maybeSingle();

  const result = await evaluatePromo(admin(), tenantId, code, total, {
    currencySymbol: tenant?.currency_symbol ?? "₹",
  });

  return json(req, {
    applied: result.applied,
    reason: result.reason,
    discount: result.discount,
    code: result.code,
    promo: result.promo ? mapPromo(result.promo) : null,
  });
}

async function create(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "promos.manage" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;
  const b = await body(req) as any;

  const { data, error } = await admin()
    .from("promo_codes")
    .insert({
      tenant_id: tenantId,
      code: (b.code as string).toUpperCase(),
      description: b.description,
      type: b.type || "PERCENTAGE",
      value: b.value,
      min_order: b.minOrder || 0,
      max_discount: b.maxDiscount || 0,
      usage_limit: b.usageLimit || 0,
      valid_to: b.validTo ? new Date(b.validTo).toISOString() : null,
      active: b.active !== false,
    })
    .select()
    .single();

  if (error) return json(req, { error: error.message }, 500);
  return json(req, mapPromo(data), 201);
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "promos.manage" });
  if (!g.ok) return g.response;
  const b = await body(req) as any;
  const promoId = id ?? (b.id as string | undefined);
  if (!promoId) return json(req, { error: "id is required" }, 400);

  const data: any = {};
  if (b.code) data.code = (b.code as string).toUpperCase();
  if (b.description !== undefined) data.description = b.description;
  if (b.type) data.type = b.type;
  if (b.value !== undefined) data.value = b.value;
  if (b.minOrder !== undefined) data.min_order = b.minOrder;
  if (b.maxDiscount !== undefined) data.max_discount = b.maxDiscount;
  if (b.usageLimit !== undefined) data.usage_limit = b.usageLimit;
  if (b.validTo !== undefined) data.valid_to = b.validTo ? new Date(b.validTo).toISOString() : null;
  if (b.active !== undefined) data.active = b.active;

  const { data: promo, error } = await admin()
    .from("promo_codes")
    .update(data)
    .eq("id", promoId)
    .eq("tenant_id", g.session.tenantId) // tenant scoping — see header
    .select()
    .single();

  if (error) return json(req, { error: error.message }, 500);
  return json(req, mapPromo(promo));
}

async function remove(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "promos.manage" });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);

  const { error } = await admin()
    .from("promo_codes")
    .delete()
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId); // tenant scoping

  if (error) return json(req, { error: error.message }, 500);
  return json(req, { success: true });
}
