// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import {
  evaluatePromo,
  getISTDateString,
  istEndOfDayISO,
  istStartOfDayISO,
  normalizePromoCode,
  toISTDateString,
} from "../_shared/promo.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";

/**
 * /functions/v1/promos
 *   GET            list promo codes (promos.view)
 *   POST           create a promo (promos.manage)
 *   POST  /validate check a code against a cart total (orders.discount)
 *   PATCH  [?id=]  update a promo (promos.manage)
 *   DELETE [?id=]  delete a promo (promos.manage)
 */

function mapPromo(p: any) {
  return {
    id: p.id,
    tenantId: p.tenant_id,
    code: p.code,
    description: p.description,
    type: p.type,
    value: Number(p.value),
    minOrder: Number(p.min_order),
    maxDiscount: Number(p.max_discount),
    usageLimit: Number(p.usage_limit),
    usedCount: Number(p.used_count),
    validFrom: toISTDateString(p.valid_from),
    validTo: toISTDateString(p.valid_to),
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
 */
async function validate(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "orders.discount" });
  if (!g.ok) return g.response;
  const tenantId = g.session.tenantId;

  const b = (await body(req)) as any;
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
  const b = (await body(req)) as any;

  const rawCode = typeof b.code === "string" ? b.code : "";
  const code = normalizePromoCode(rawCode);
  if (!code) {
    return json(req, { error: "Promo code is required" }, 400);
  }

  // Tenant uniqueness check
  const { data: existing } = await admin()
    .from("promo_codes")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("code", code)
    .maybeSingle();

  if (existing) {
    return json(req, { error: `A promo code with code "${code}" already exists` }, 409);
  }

  const type = b.type === "FIXED" ? "FIXED" : "PERCENTAGE";
  const value = Number(b.value);
  if (isNaN(value) || value <= 0) {
    return json(req, { error: "Value must be a positive number" }, 400);
  }
  if (type === "PERCENTAGE" && value > 100) {
    return json(req, { error: "Percentage discount must not exceed 100%" }, 400);
  }

  const minOrder = Math.max(0, Number(b.minOrder) || 0);
  const maxDiscount = type === "PERCENTAGE" ? Math.max(0, Number(b.maxDiscount) || 0) : 0;
  const usageLimit = Math.max(0, parseInt(String(b.usageLimit), 10) || 0);

  const validFromStr = toISTDateString(b.validFrom);
  const validToStr = toISTDateString(b.validTo);

  if (validFromStr && validToStr && validToStr < validFromStr) {
    return json(req, { error: "Valid Until cannot be earlier than Valid From" }, 400);
  }

  const todayIST = getISTDateString();
  const active = b.active !== false;

  if (validToStr && todayIST > validToStr && active) {
    return json(req, { error: "Extend Valid Until to reactivate this code." }, 400);
  }

  const { data, error } = await admin()
    .from("promo_codes")
    .insert({
      tenant_id: tenantId,
      code,
      description: typeof b.description === "string" && b.description.trim() ? b.description.trim() : null,
      type,
      value,
      min_order: minOrder,
      max_discount: maxDiscount,
      usage_limit: usageLimit,
      valid_from: validFromStr ? istStartOfDayISO(validFromStr) : new Date().toISOString(),
      valid_to: validToStr ? istEndOfDayISO(validToStr) : null,
      active,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return json(req, { error: `A promo code with code "${code}" already exists` }, 409);
    }
    return json(req, { error: error.message }, 500);
  }
  return json(req, mapPromo(data), 201);
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "promos.manage" });
  if (!g.ok) return g.response;
  const b = (await body(req)) as any;
  const promoId = id ?? (b.id as string | undefined);
  if (!promoId) return json(req, { error: "id is required" }, 400);

  const tenantId = g.session.tenantId;

  // Fetch current promo to enforce tenant scoping, immutability, and date integrity
  const { data: current, error: fetchErr } = await admin()
    .from("promo_codes")
    .select("*")
    .eq("id", promoId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (fetchErr) return json(req, { error: fetchErr.message }, 500);
  if (!current) return json(req, { error: "Promo code not found" }, 404);

  const data: any = {};
  const redemptions = Number(current.used_count ?? 0);

  // If redeemed at least once: code and type cannot be modified!
  if (b.code !== undefined) {
    const newCode = normalizePromoCode(b.code);
    if (!newCode) return json(req, { error: "Code cannot be empty" }, 400);
    if (newCode !== current.code) {
      if (redemptions > 0) {
        return json(req, { error: "Cannot modify code once it has been redeemed" }, 400);
      }
      // Check uniqueness within restaurant
      const { data: conflict } = await admin()
        .from("promo_codes")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("code", newCode)
        .neq("id", promoId)
        .maybeSingle();
      if (conflict) {
        return json(req, { error: `A promo code with code "${newCode}" already exists` }, 409);
      }
      data.code = newCode;
    }
  }

  if (b.type !== undefined) {
    const newType = b.type === "FIXED" ? "FIXED" : "PERCENTAGE";
    if (newType !== current.type) {
      if (redemptions > 0) {
        return json(req, { error: "Cannot modify discount type once it has been redeemed" }, 400);
      }
      data.type = newType;
    }
  }

  const effectiveType = data.type ?? current.type;

  if (b.value !== undefined) {
    const val = Number(b.value);
    if (isNaN(val) || val <= 0) {
      return json(req, { error: "Value must be a positive number" }, 400);
    }
    if (effectiveType === "PERCENTAGE" && val > 100) {
      return json(req, { error: "Percentage discount must not exceed 100%" }, 400);
    }
    data.value = val;
  }

  if (b.description !== undefined) {
    data.description = typeof b.description === "string" && b.description.trim() ? b.description.trim() : null;
  }

  if (b.minOrder !== undefined) {
    data.min_order = Math.max(0, Number(b.minOrder) || 0);
  }

  if (effectiveType === "PERCENTAGE") {
    if (b.maxDiscount !== undefined) {
      data.max_discount = Math.max(0, Number(b.maxDiscount) || 0);
    }
  } else {
    // For flat discounts, max_discount is reset to 0 to prevent stale hidden fields
    data.max_discount = 0;
  }

  if (b.usageLimit !== undefined) {
    data.usage_limit = Math.max(0, parseInt(String(b.usageLimit), 10) || 0);
  }

  const effValidFrom = b.validFrom !== undefined ? toISTDateString(b.validFrom) : toISTDateString(current.valid_from);
  const effValidTo = b.validTo !== undefined ? toISTDateString(b.validTo) : toISTDateString(current.valid_to);

  if (effValidFrom && effValidTo && effValidTo < effValidFrom) {
    return json(req, { error: "Valid Until cannot be earlier than Valid From" }, 400);
  }

  if (b.validFrom !== undefined) {
    data.valid_from = effValidFrom ? istStartOfDayISO(effValidFrom) : null;
  }
  if (b.validTo !== undefined) {
    data.valid_to = effValidTo ? istEndOfDayISO(effValidTo) : null;
  }

  const todayIST = getISTDateString();
  const effActive = b.active !== undefined ? b.active : current.active;

  // Permit date correction without allowing an already-expired promo to be enabled through an invalid save
  if (b.active === true && effValidTo && todayIST > effValidTo) {
    return json(req, { error: "Extend Valid Until to reactivate this code." }, 400);
  }

  if (b.active !== undefined) {
    data.active = b.active;
  }

  const { data: promo, error } = await admin()
    .from("promo_codes")
    .update(data)
    .eq("id", promoId)
    .eq("tenant_id", tenantId)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return json(req, { error: "A promo code with this code already exists" }, 409);
    }
    return json(req, { error: error.message }, 500);
  }
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
    .eq("tenant_id", g.session.tenantId);

  if (error) return json(req, { error: error.message }, 500);
  return json(req, { success: true });
}
