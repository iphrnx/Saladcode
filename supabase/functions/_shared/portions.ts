// deno-lint-ignore-file no-explicit-any

export interface MenuPortion {
  id: string;
  name: string;
  price: number;
}

const PRESET_NAMES: Record<string, string> = {
  quarter: "Quarter",
  half: "Half",
  full: "Full",
  regular: "Regular",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/**
 * Clean a portion name and canonicalise standard preset names ("half" -> "Half",
 * "full" -> "Full") so case differences cannot create duplicate options.
 */
export function canonicalPortionName(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .trim()
    .split(" ")
    .filter(Boolean)
    .join(" ");
  if (!cleaned) return "";
  const preset = PRESET_NAMES[cleaned.toLowerCase()];
  return preset ?? cleaned;
}

/**
 * Deterministic slug ID for a portion within a dish (e.g. "Quarter" -> "quarter").
 */
export function portionIdFromName(name: string, rawId?: unknown): string {
  const candidate = String(rawId ?? "").trim().toLowerCase();
  const base = candidate || name.trim().toLowerCase();
  let slug = "";
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    const isAlphaNum =
      (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (isAlphaNum) {
      slug += ch;
    } else if (slug.length > 0 && !slug.endsWith("-")) {
      slug += "-";
    }
  }
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug || "portion";
}

/**
 * Validate portion options submitted on dish create/update.
 * Rejects empty names, negative/NaN prices, >8 portions, or duplicate names.
 * Assigns a stable `id` and canonical name to each portion.
 */
export function validatePortionsInput(
  value: unknown,
): { ok: true; portions: MenuPortion[] | null } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true, portions: null };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "portions must be a list" };
  }
  if (value.length > 8) {
    return { ok: false, error: "A dish can have at most 8 portions" };
  }

  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const portions: MenuPortion[] = [];

  for (let idx = 0; idx < value.length; idx++) {
    const raw = value[idx];
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "Each portion must have a name and price" };
    }
    const name = canonicalPortionName((raw as any).name);
    const price = Number((raw as any).price);
    if (!name) {
      return { ok: false, error: "Every portion needs a name" };
    }
    if (name.length > 40) {
      return { ok: false, error: "Portion names can be at most 40 characters" };
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      return { ok: false, error: `Duplicate portion name: ${name}` };
    }
    if (!Number.isFinite(price) || price < 0) {
      return { ok: false, error: `Enter a valid price for portion ${name}` };
    }

    let id = portionIdFromName(name, (raw as any).id);
    if (seenIds.has(id)) {
      id = `${id}-${idx + 1}`;
    }

    seenNames.add(nameKey);
    seenIds.add(id);
    portions.push({
      id,
      name,
      price: Math.round(price * 100) / 100,
    });
  }

  return { ok: true, portions: portions.length > 0 ? portions : null };
}

/**
 * Normalise portions read from the database or external extraction.
 * Deduplicates by case-insensitive portion name so duplicate portions can never
 * leak into API responses or UI views.
 */
export function normalizeStoredPortions(value: unknown): MenuPortion[] | null {
  let list: unknown = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list) || list.length === 0) return null;

  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  const out: MenuPortion[] = [];

  for (let idx = 0; idx < list.length; idx++) {
    const raw = list[idx];
    if (typeof raw !== "object" || raw === null) continue;
    const name = canonicalPortionName((raw as any).name);
    const price = Number((raw as any).price);
    if (!name || !Number.isFinite(price) || price < 0) continue;

    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) continue;

    let id = portionIdFromName(name, (raw as any).id);
    if (seenIds.has(id)) {
      id = `${id}-${idx + 1}`;
    }

    seenNames.add(nameKey);
    seenIds.add(id);
    out.push({
      id,
      name: name.slice(0, 40),
      price: Math.round(price * 100) / 100,
    });
    if (out.length >= 8) break;
  }

  return out.length > 0 ? out : null;
}

/**
 * When a dish has portions, its base `price` column in `menu_items` is kept in
 * sync with the lowest portion price so there is never a conflicting second
 * price on the dish.
 */
export function effectiveDishBasePrice(
  rawPrice: unknown,
  portions: MenuPortion[] | null,
): number {
  if (portions && portions.length > 0) {
    return Math.min(...portions.map((p) => p.price));
  }
  const n = Number(rawPrice);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Resolve the unit price for an order item from the database.
 * - Never trusts client-supplied prices.
 * - Matches portion by stable `portionId` or case-insensitive `portion` name.
 * - Charges the selected portion price once (never adds base price + portion price).
 * - Rejects unknown portion names with an explicit error.
 */
export function resolveOrderUnitPrice(
  mi: { name: string; price: number; portions?: unknown },
  requestedPortion?: unknown,
  requestedPortionId?: unknown,
):
  | { ok: true; price: number; portion: string | null; portionId: string | null }
  | { ok: false; error: string } {
  const portions = normalizeStoredPortions(mi.portions);
  const wantedName = canonicalPortionName(requestedPortion);
  const wantedId = String(requestedPortionId ?? "").trim().toLowerCase();

  if (!wantedName && !wantedId) {
    const unitPrice = effectiveDishBasePrice(mi.price, portions);
    return {
      ok: true,
      price: unitPrice,
      portion: null,
      portionId: null,
    };
  }

  if (!portions || portions.length === 0) {
    return {
      ok: false,
      error: `${mi.name} does not have portion options`,
    };
  }

  const match = portions.find(
    (p) =>
      (wantedId && p.id.toLowerCase() === wantedId) ||
      (wantedName && p.name.toLowerCase() === wantedName.toLowerCase()) ||
      (wantedName && p.id.toLowerCase() === wantedName.toLowerCase()),
  );

  if (!match) {
    return {
      ok: false,
      error: `${mi.name} has no portion named "${wantedName || wantedId}"`,
    };
  }

  return {
    ok: true,
    price: match.price,
    portion: match.name,
    portionId: match.id,
  };
}
