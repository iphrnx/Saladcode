// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sanitizeMenuTags } from "../_shared/menu-tags.ts";
import { guard } from "../_shared/auth.ts";
import { admin } from "../_shared/db.ts";
import { toCamel } from "../_shared/case.ts";
import { body, json, preflight, subPath } from "../_shared/http.ts";
import { enforceWriteLimit } from "../_shared/plans.ts";
import { publishEvent } from "../_shared/realtime.ts";
import {
  effectiveDishBasePrice,
  normalizeStoredPortions,
  validatePortionsInput,
} from "../_shared/portions.ts";

/**
 * /functions/v1/menu
 *   GET                 list menu items (menu.view)
 *   POST                create an item (menu.manage)
 *   PATCH  [?id=]       update an item (menu.manage)
 *   DELETE [?id=]       delete an item (menu.manage)
 *
 * Every write is scoped to the caller's tenant.
 */

const SELECT = "*, category:categories(*)";

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  const segments = subPath(req, "menu");
  const url = new URL(req.url);
  const idFromPath = segments[0];

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

function ratingInput(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(0, Math.round(n * 10) / 10));
}

function formatMenuItem(row: any): any {
  const item = toCamel<any>(row);
  const portions = normalizeStoredPortions(row?.portions);
  item.portions = portions;
  if (portions && portions.length > 0) {
    item.price = effectiveDishBasePrice(item.price, portions);
  }
  return item;
}

async function list(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "menu.view" });
  if (!g.ok) return g.response;

  const { data, error } = await admin()
    .from("menu_items")
    .select(SELECT)
    .eq("tenant_id", g.session.tenantId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) return json(req, { error: error.message }, 500);
  return json(req, (data ?? []).map(formatMenuItem));
}

async function create(req: Request): Promise<Response> {
  const g = await guard(req, { permission: "menu.manage" });
  if (!g.ok) return g.response;

  const b = await body(req);
  if (!String(b.name ?? "").trim() || !b.categoryId) {
    return json(req, { error: "Name and category are required" }, 400);
  }

  const portions = validatePortionsInput(b.portions);
  if (!portions.ok) return json(req, { error: portions.error }, 400);

  if (!portions.portions) {
    const rawPrice = Number(b.price);
    if (!Number.isFinite(rawPrice) || rawPrice < 0) {
      return json(req, { error: "Enter a valid price" }, 400);
    }
  }

  const resolvedPrice = effectiveDishBasePrice(b.price, portions.portions);

  // The plan's limit is checked and the row written in one transaction, so two
  // requests cannot both take the last slot. A limit that cannot be checked
  // writes nothing and asks the caller to retry.
  const written = await enforceWriteLimit(g.session.tenantId, "menuItems", {
    category_id: b.categoryId,
    name: String(b.name).trim(),
    description: b.description ?? null,
    price: resolvedPrice,
    image: b.image ?? null,
    available: b.available !== false,
    prep_time: Number(b.prepTime) || 15,
    calories: b.calories != null ? Number(b.calories) : null,
    ...(typeof ratingInput(b.rating) === "number" ? { rating: ratingInput(b.rating) } : {}),
    // Same rule as everywhere: only Menu Management tags may be stored.
    tags: b.tags == null ? null : sanitizeMenuTags(b.tags).join(", ") || null,
    portions: portions.portions,
  });

  if (!written.ok) {
    if (written.reason === "limit") return json(req, { error: written.error, limit: written.limit }, 402);
    if (written.reason === "write") return json(req, { error: written.error }, written.status);
    return json(req, { error: written.error, retryable: true }, written.status);
  }

  // Read it back with its category, so the response is the shape the menu
  // screen has always received.
  const { data, error } = await admin()
    .from("menu_items")
    .select(SELECT)
    .eq("id", (written.row as any).id)
    .single();
  if (error) return json(req, { error: error.message }, 500);
  return json(req, formatMenuItem(data), 201);
}

async function update(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "menu.manage" });
  if (!g.ok) return g.response;

  const b = await body(req);
  const itemId = id ?? (b.id as string | undefined);
  if (!itemId) return json(req, { error: "id is required" }, 400);

  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = String(b.name).trim();
  if (b.description !== undefined) patch.description = b.description;
  if (b.price !== undefined) {
    const rawPrice = Number(b.price);
    if (!Number.isFinite(rawPrice) || rawPrice < 0) {
      return json(req, { error: "Enter a valid price" }, 400);
    }
    patch.price = Math.round(rawPrice * 100) / 100;
  }
  if (b.image !== undefined) patch.image = b.image;
  if (b.available !== undefined) patch.available = Boolean(b.available);
  if (b.tags !== undefined) patch.tags = sanitizeMenuTags(b.tags).join(", ") || null;
  if (b.categoryId !== undefined) patch.category_id = b.categoryId;
  if (b.prepTime !== undefined) patch.prep_time = Number(b.prepTime);
  if (b.calories !== undefined) patch.calories = b.calories;
  if (b.rating !== undefined) patch.rating = ratingInput(b.rating);
  if (b.portions !== undefined) {
    const portions = validatePortionsInput(b.portions);
    if (!portions.ok) return json(req, { error: portions.error }, 400);
    patch.portions = portions.portions;
    if (portions.portions && portions.portions.length > 0) {
      patch.price = effectiveDishBasePrice(b.price, portions.portions);
    }
  }

  const { data, error } = await admin()
    .from("menu_items")
    .update(patch)
    .eq("id", itemId)
    .eq("tenant_id", g.session.tenantId)
    .select(SELECT)
    .single();

  if (error) return json(req, { error: error.message }, 500);

  // A diner may be reading this menu right now. Hiding a dish at the till used to
  // be invisible to them until they reloaded the page — the menu is fetched once
  // when the session starts and nothing ever told it to look again. Every write
  // is announced, not only availability: the same refresh should pick up a price
  // or a name that changed while someone was deciding.
  publishEvent({
    type: "MENU_UPDATED",
    tenantId: g.session.tenantId,
    topic: `menu:${g.session.tenantId}`,
    itemId,
    available: (data as any)?.available,
  });

  return json(req, formatMenuItem(data));
}

async function remove(req: Request, id: string | null): Promise<Response> {
  const g = await guard(req, { permission: "menu.manage" });
  if (!g.ok) return g.response;
  if (!id) return json(req, { error: "id is required" }, 400);

  const { error } = await admin()
    .from("menu_items")
    .delete()
    .eq("id", id)
    .eq("tenant_id", g.session.tenantId);

  if (error) return json(req, { error: error.message }, 500);

  publishEvent({
    type: "MENU_UPDATED",
    tenantId: g.session.tenantId,
    topic: `menu:${g.session.tenantId}`,
    itemId: id,
    removed: true,
  });

  return json(req, { success: true });
}
