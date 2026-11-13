/**
 * The one list of dish tags the product knows — the same set Menu
 * Management offers in its picker. The AI scanner is told about these and
 * only these, and anything the model invents anyway ("healthy",
 * "signature", "popular"…) is dropped here rather than saved: a tag the
 * owner cannot see or edit in Menu Management should not exist on a dish.
 *
 * The edge-function copy lives at supabase/functions/_shared/menu-tags.ts —
 * the two are kept behaviour-identical by scripts/test-menu-tags.mts.
 */
export const CANONICAL_MENU_TAGS = [
  "VEG",
  "NON-VEG",
  "VEGAN",
  "SPICY",
  "JAIN",
  "BESTSELLER",
  "NEW",
  "GLUTEN-FREE",
] as const;

const TAG_LOOKUP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const id of CANONICAL_MENU_TAGS) m.set(id.toLowerCase(), id);
  // Unambiguous alternates only. "hot" stays out — a hot tea is not spicy.
  // "popular" stays out — calling a dish a bestseller is the owner's
  // decision, not the OCR's. "healthy" has no canonical home and is dropped.
  const aliases: Record<string, string> = {
    "vegetarian": "VEG",
    "veggie": "VEG",
    "nonveg": "NON-VEG",
    "non veg": "NON-VEG",
    "non vegetarian": "NON-VEG",
    "best seller": "BESTSELLER",
    "best-seller": "BESTSELLER",
    "gluten free": "GLUTEN-FREE",
    "glutenfree": "GLUTEN-FREE",
    "gf": "GLUTEN-FREE",
  };
  for (const [k, v] of Object.entries(aliases)) m.set(k, v);
  return m;
})();

/**
 * Accepts a tag array or a comma-separated string and returns the canonical
 * ids (Menu Management's storage form), deduped, in first-seen order.
 * Anything that is not an exact or safe-alias match is dropped — never
 * rewritten, never invented.
 */
export function sanitizeMenuTags(input: unknown): string[] {
  const tokens = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const key = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const id = key ? TAG_LOOKUP.get(key) : undefined;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
