// deno-lint-ignore-file no-explicit-any

/**
 * Normalisation for AI-extracted menu data.
 *
 * A pure module — no Deno, no network, no environment — so the edge function
 * and the offline test suite (`tsx scripts/test-menu-normalize.mts`) share
 * exactly the same code.
 *
 * What the AI gives us is raw text lifted off a photo: the same dish twice,
 * the portion inside the name ("Chicken Tikka (8 pcs)"), a category spelled
 * two ways, a price that could not be read. This pass turns that into the
 * shape the rest of the product is built on:
 *
 *   - Portions move out of the dish name into variants, each with its own
 *     price. "Chicken Tikka (8 pcs) ₹250" and "Chicken Tikka (12 pcs) ₹420"
 *     become ONE dish, "Chicken Tikka", with two variants.
 *   - A dish price is never invented and never saved as 0: a price that
 *     could not be read stays null and the item is flagged for review. When
 *     portion prices exist, the dish price is the lowest of them — derived,
 *     not guessed.
 *   - Duplicate dishes, categories, variants and add-ons are merged — but a
     * conflict (the same portion at two different prices) is never resolved
     * silently: both entries survive, flagged, for the owner to settle.
 *   - The original names are kept in `rawNames`, so no extracted information
 *     is lost no matter how much is merged.
 */

import { sanitizeMenuTags } from "./menu-tags.ts";

export interface ExtractedVariant {
  name: string;
  price: number | null;
  priceUnreadable?: boolean;
}

export interface ExtractedAddOn {
  name: string;
  price: number | null;
  priceUnreadable?: boolean;
}

export interface NormalizedItem {
  name: string;
  rawNames: string[];
  description: string | null;
  price: number | null;
  priceUnreadable: boolean;
  veg: boolean | null;
  confidence: "high" | "low";
  variants: ExtractedVariant[];
  addOns: ExtractedAddOn[];
  tags: string[];
}

export interface NormalizedCategory {
  name: string;
  icon: string;
  items: NormalizedItem[];
}

/**
 * A price is a number or null. It is never a guess: a price that came back
 * as a word, or not at all, is null so the item can be flagged.
 */
export function toPrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = parseFloat(value.replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Portion words we recognise standing alone ("Half", "Jumbo"). */
const PORTION_WORDS = new Set([
  "quarter",
  "half",
  "full",
  "regular",
  "small",
  "medium",
  "large",
  "xl",
  "xxl",
  "jumbo",
  "mini",
  "king",
  "single",
  "double",
  "family",
  "party",
]);

/** Preset portion names, matching `_shared/portions.ts` canonicalisation. */
const PORTION_PRESETS: Record<string, string> = {
  quarter: "Quarter",
  half: "Half",
  full: "Full",
  regular: "Regular",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

function titleCaseWords(text: string): string {
  return text
    .split(" ")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/** Whether a short trailing string is a portion rather than a description. */
export function looksLikePortion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (PORTION_WORDS.has(t)) return true;
  if (/^\d+\s*(pcs?|pc|pieces?|nos?|no\.?)$/.test(t)) return true;
  if (/^\d+\s*(ml|cl|l|litres?|liters?)$/.test(t)) return true;
  if (/^serves?\s*\d+$/.test(t)) return true;
  if (/^(quarter|half|full)\s+(plate|portion)$/.test(t)) return true;
  return false;
}

/**
 * Canonicalise a portion label so the same portion can never exist twice in
 * different spellings: "8pc" and "8 pcs" and "8 PCS" all become "8 pcs",
 * "HALF" becomes "Half", "500ml" becomes "500 ml".
 */
export function canonicalPortionLabel(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .join(" ");
  if (!cleaned) return "";
  const t = cleaned.toLowerCase();

  let m = /^(\d+)\s*(pcs?|pc|pieces?|nos?|no\.?)$/.exec(t);
  if (m) return `${m[1]} pcs`;

  m = /^(\d+)\s*ml$/.exec(t);
  if (m) return `${m[1]} ml`;
  m = /^(\d+)\s*(cl)$/.exec(t);
  if (m) return `${m[1]} cl`;
  m = /^(\d+)\s*(l|litres?|liters?)$/.exec(t);
  if (m) return `${m[1]} L`;

  m = /^serves?\s*(\d+)$/.exec(t);
  if (m) return `Serves ${m[1]}`;

  if (t === "xl" || t === "xxl") return t.toUpperCase();
  const preset = PORTION_PRESETS[t];
  if (preset) return preset;

  return titleCaseWords(cleaned);
}

/**
 * Move a trailing portion out of a dish name.
 *
 *   "Chicken Tikka (8 pcs)"  → { baseName: "Chicken Tikka", portion: "8 pcs" }
 *   "Tandoori Chicken - Half"→ { baseName: "Tandoori Chicken", portion: "Half" }
 *   "Veg Momos 6 pcs"        → { baseName: "Veg Momos", portion: "6 pcs" }
 *   "Paneer 65"              → unchanged (a number alone is not a portion)
 *   "Paneer Tikka (Spicy)"   → unchanged ("Spicy" describes, it doesn't size)
 */
export function stripPortionFromName(name: string): { baseName: string; portion: string | null } {
  let base = String(name ?? "")
    .trim()
    .split(/\s+/)
    .join(" ");
  if (!base) return { baseName: "", portion: null };

  for (let pass = 0; pass < 2; pass++) {
    let m: RegExpExecArray | null;

    // Trailing bracket: "Dish (8 pcs)"
    m = /^(.*?)\s*[\(\[]([^\)\]]{1,30})[\)\]]\s*$/.exec(base);
    if (m && looksLikePortion(m[2]) && m[1].trim().length >= 2) {
      base = m[1].trim();
      return { baseName: base, portion: canonicalPortionLabel(m[2]) };
    }

    // Trailing after a separator: "Dish - Half", "Dish, Large", "Dish: Full"
    m = /^(.*?)\s*[\-–—,:|]\s*([^\-–—,:|]{1,30})$/.exec(base);
    if (m && looksLikePortion(m[2]) && m[1].trim().length >= 2) {
      base = m[1].trim();
      return { baseName: base, portion: canonicalPortionLabel(m[2]) };
    }

    // Bare trailing quantity: "Veg Momos 6 pcs"
    m = /^(.*?)\s+(\d+\s*(?:pcs?|pc|pieces?|nos?|no\.?))$/i.exec(base);
    if (m && m[1].trim().length >= 2) {
      return { baseName: m[1].trim(), portion: canonicalPortionLabel(m[2]) };
    }

    // Bare trailing size word: "Chicken Curry Half", "Cold Coffee Large"
    m = new RegExp(`^(.*?)\\s+(${[...PORTION_WORDS].join("|")})$`, "i").exec(base);
    if (m && m[1].trim().length >= 2) {
      return { baseName: m[1].trim(), portion: canonicalPortionLabel(m[2]) };
    }

    break;
  }

  return { baseName: base, portion: null };
}

/**
 * The dedup key for a dish: its portion-stripped base name, case- and
 * punctuation-insensitive. "Paneer Tikka", "paneer  tikka" and
 * "Paneer Tikka (Half)" all share one key.
 */
export function dishKey(name: string): string {
  const { baseName } = stripPortionFromName(name);
  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeByLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

function mergeAddOns(lists: ExtractedAddOn[][]): ExtractedAddOn[] {
  const seen = new Set<string>();
  const out: ExtractedAddOn[] = [];
  for (const list of lists) {
    for (const a of list) {
      const key = a.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

/**
 * Merge the variant lists of dishes being grouped. A label seen twice with
 * the same price (or one unreadable) collapses; a label seen twice with two
 * DIFFERENT prices is a conflict — it is returned so the caller can keep the
 * conflicting dish separate rather than silently picking a price.
 */
function mergeVariants(
  lists: ExtractedVariant[][],
): { merged: ExtractedVariant[]; conflict: boolean } {
  const byLabel = new Map<string, ExtractedVariant>();
  let conflict = false;
  for (const list of lists) {
    for (const v of list) {
      const key = v.name.trim().toLowerCase();
      if (!key) continue;
      const existing = byLabel.get(key);
      if (!existing) {
        byLabel.set(key, { ...v });
        continue;
      }
      if (existing.price === null && v.price !== null) {
        existing.price = v.price;
        existing.priceUnreadable = false;
      } else if (
        existing.price !== null && v.price !== null && existing.price !== v.price
      ) {
        conflict = true;
      }
      if (v.price === null) existing.priceUnreadable = existing.priceUnreadable ?? true;
    }
  }
  return { merged: [...byLabel.values()], conflict };
}

/** The price a merged dish displays: the lowest portion price when portions
 * exist (never 0), otherwise the dish's own readable price, otherwise null. */
function derivedPrice(itemPrice: number | null, variants: ExtractedVariant[]): number | null {
  const valid = variants
    .map((v) => v.price)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  if (valid.length > 0) return Math.min(...valid);
  return itemPrice;
}

/** Pick the best display casing among duplicates: prefer not-all-caps,
 * then the longest, then the first seen. */
function bestDisplayName(names: string[]): string {
  const notAllCaps = names.filter((n) => n !== n.toUpperCase());
  const pool = notAllCaps.length > 0 ? notAllCaps : names;
  return pool.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Build the preliminary (ungrouped) normalised form of one raw AI item. */
function normalizeRawItem(raw: any): NormalizedItem | null {
  const rawName = String(raw?.name ?? "").trim();
  if (!rawName) return null;

  const { baseName, portion } = stripPortionFromName(rawName);
  if (!baseName) return null;

  const variants: ExtractedVariant[] = Array.isArray(raw?.variants)
    ? raw.variants
        .map((v: any) => {
          const name = looksLikePortion(String(v?.name ?? ""))
            ? canonicalPortionLabel(v?.name)
            : String(v?.name ?? "").trim();
          const price = toPrice(v?.price);
          return { name, price, priceUnreadable: price === null };
        })
        .filter((v: ExtractedVariant) => v.name)
    : [];

  const itemPrice = toPrice(raw?.price);

  // A portion lifted out of the name carries the item's price with it — the
  // ₹250 in "Chicken Tikka (8 pcs) ₹250" is the price OF the 8 pcs.
  if (portion) {
    variants.push({ name: portion, price: itemPrice, priceUnreadable: itemPrice === null });
  }

  const addOns: ExtractedAddOn[] = Array.isArray(raw?.addOns)
    ? raw.addOns
        .map((a: any) => {
          const price = toPrice(a?.price);
          return {
            name: String(a?.name ?? "").trim(),
            price,
            priceUnreadable: price === null,
          };
        })
        .filter((a: ExtractedAddOn) => a.name)
    : [];

  const veg = raw?.veg === true ? true : raw?.veg === false ? false : null;

  const price = derivedPrice(portion ? null : itemPrice, variants);
  const priceUnreadable = price === null;

  const lowConfidence =
    raw?.confidence === "low" ||
    !raw?.name ||
    priceUnreadable ||
    variants.some((v) => v.price === null) ||
    addOns.some((a) => a.price === null) ||
    raw?.veg === undefined;

  return {
    name: baseName,
    rawNames: [rawName],
    description: raw?.description ? String(raw.description) : null,
    price,
    priceUnreadable,
    veg,
    confidence: lowConfidence ? "low" : "high",
    variants: dedupeVariantsSamePrice(variants),
    addOns,
    // Only Menu Management tags survive; the model's inventions die here.
    tags: sanitizeMenuTags(raw?.tags),
  };
}

/** Collapse exact duplicate variant labels when their prices agree (or one
 * is unreadable). Conflicts are left untouched — grouping handles those. */
function dedupeVariantsSamePrice(variants: ExtractedVariant[]): ExtractedVariant[] {
  const byLabel = new Map<string, ExtractedVariant>();
  const order: string[] = [];
  for (const v of variants) {
    const key = v.name.trim().toLowerCase();
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, { ...v });
      order.push(key);
      continue;
    }
    if (existing.price === null && v.price !== null) {
      existing.price = v.price;
      existing.priceUnreadable = false;
    } else if (existing.price !== null && v.price !== null && existing.price !== v.price) {
      // Conflict inside one item: keep both, disambiguated, so nothing is lost.
      let suffix = 2;
      let newKey = `${key} (${suffix})`;
      while (byLabel.has(newKey)) newKey = `${key} (${++suffix})`;
      byLabel.set(newKey, { ...v, name: `${v.name} (${suffix})` });
      order.push(newKey);
    }
  }
  return order.map((k) => byLabel.get(k)!);
}

/**
 * The full normalisation pass over the AI's raw `categories` array:
 * per-item cleanup, then grouping of same-dish entries into one dish with
 * variants, then category-level dedup.
 */
export function normalizeExtractedCategories(rawCategories: unknown): NormalizedCategory[] {
  if (!Array.isArray(rawCategories)) return [];

  const categories: NormalizedCategory[] = [];
  const catIndexByKey = new Map<string, number>();

  for (const rawCat of rawCategories as any[]) {
    const rawName = String(rawCat?.name ?? "").trim();
    const name = rawName ? titleCaseWords(rawName) : "Uncategorized";
    const key = name.toLowerCase();
    const icon = String(rawCat?.icon || "🍽️");

    let idx = catIndexByKey.get(key);
    if (idx === undefined) {
      idx = categories.length;
      catIndexByKey.set(key, idx);
      categories.push({ name, icon, items: [] });
    } else if (categories[idx].icon === "🍽️" && icon !== "🍽️") {
      // A later spelling of the same category brought a real icon.
      categories[idx].icon = icon;
    }

    const prelim: NormalizedItem[] = [];
    for (const rawItem of (Array.isArray(rawCat?.items) ? rawCat.items : []) as any[]) {
      const item = normalizeRawItem(rawItem);
      if (item) prelim.push(item);
    }

    // Group by portion-stripped dish key, preserving first-appearance order.
    const groups = new Map<string, NormalizedItem[]>();
    const groupOrder: string[] = [];
    for (const item of prelim) {
      const key = dishKey(item.name);
      if (!key) continue;
      const existing = groups.get(key);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(key, [item]);
        groupOrder.push(key);
      }
    }

    for (const key of groupOrder) {
      const group = groups.get(key)!;
      if (group.length === 1) {
        categories[idx].items.push(group[0]);
        continue;
      }
      categories[idx].items.push(...mergeGroup(group));
    }
  }

  return categories.filter((c) => c.items.length > 0);
}

/**
 * Merge dishes that share a base name. True duplicates collapse into one
 * dish whose variants carry every portion. A price conflict (same portion,
 * different price, or two bare prices that disagree) is never resolved
 * silently: the conflicting dish is kept as a separate, flagged item.
 */
function mergeGroup(group: NormalizedItem[]): NormalizedItem[] {
  const kept: NormalizedItem[] = [];
  let primary = group[0];

  for (const item of group.slice(1)) {
    const primaryHasVariants = primary.variants.length > 0;
    const itemHasVariants = item.variants.length > 0;

    const { merged, conflict } = mergeVariants([primary.variants, item.variants]);
    const baseConflict =
      !primaryHasVariants && !itemHasVariants &&
      primary.price !== null && item.price !== null && primary.price !== item.price;

    if (conflict || baseConflict) {
      // Two readings of the same dish disagree on price. Keep both, flag
      // both, and let the owner settle it in the preview.
      const note = "duplicate dish with a conflicting price — please verify";
      kept.push({
        ...item,
        description: item.description ? `${item.description} (${note})` : `(${note})`,
        confidence: "low",
      });
      primary = { ...primary, confidence: "low" };
      continue;
    }

    const variants = merged;
    const price = derivedPrice(
      primary.price !== null && primary.price !== item.price && !primaryHasVariants && !itemHasVariants
        ? primary.price
        : primary.price ?? item.price,
      variants,
    );

    primary = {
      ...primary,
      name: bestDisplayName([primary.name, item.name]),
      rawNames: [...primary.rawNames, ...item.rawNames],
      description:
        [primary.description, item.description]
          .filter((d): d is string => typeof d === "string" && d.length > 0)
          .sort((a, b) => b.length - a.length)[0] ?? null,
      price,
      priceUnreadable: price === null,
      veg: primary.veg ?? item.veg,
      confidence:
        primary.confidence === "low" || item.confidence === "low" ? "low" : "high",
      variants,
      addOns: mergeAddOns([primary.addOns, item.addOns]),
      tags: dedupeByLower([...primary.tags, ...item.tags]),
    };
  }

  return [primary, ...kept];
}
