/**
 * Menu extraction normalisation, tested without a database or a network.
 *
 * Covers the regression list the feature was specified against:
 *   - single-price dishes pass through untouched
 *   - multiple portions with different prices merge into one dish whose
 *     variants carry each price — and the dish price is the lowest portion
 *     price, never 0
 *   - portion text moves out of dish names ("Chicken Tikka (8 pcs)" →
 *     name + "8 pcs" variant), while things that are not portions
 *     ("Paneer 65", "(Spicy)") stay in the name
 *   - unreadable prices stay null and flagged — never 0, never invented
 *   - duplicate dish names collapse; a conflicting duplicate survives as a
 *     separate, flagged item rather than losing a price
 *   - duplicate categories, variants and add-ons merge; original names are
 *     preserved in rawNames
 *
 *   npm run test:menu-normalize
 */
import {
  canonicalPortionLabel,
  dishKey,
  looksLikePortion,
  normalizeExtractedCategories,
  stripPortionFromName,
  toPrice,
} from "../supabase/functions/_shared/menu-normalize.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) passed++;
  else failures.push(name);
}
function eq(name: string, got: unknown, want: unknown) {
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

/* ---------- price parsing ---------- */
eq("toPrice number", toPrice(250), 250);
eq("toPrice string", toPrice("₹ 320"), 320);
eq("toPrice word", toPrice("two fifty"), null);
eq("toPrice missing", toPrice(undefined), null);
eq("toPrice NaN", toPrice(NaN), null);

/* ---------- portion recognition ---------- */
check("(8 pcs) is a portion", looksLikePortion("8 pcs"));
check("Half is a portion", looksLikePortion("half"));
check("500ml is a portion", looksLikePortion("500ml"));
check("Serves 2 is a portion", looksLikePortion("Serves 2"));
check("Spicy is not a portion", !looksLikePortion("Spicy"));
check("Chef special is not a portion", !looksLikePortion("Chef Special"));

/* ---------- portion label canonicalisation ---------- */
eq("8pc → 8 pcs", canonicalPortionLabel("8pc"), "8 pcs");
eq("8 PCS → 8 pcs", canonicalPortionLabel("8 PCS"), "8 pcs");
eq("HALF → Half", canonicalPortionLabel("HALF"), "Half");
eq("full → Full", canonicalPortionLabel("full"), "Full");
eq("500ml → 500 ml", canonicalPortionLabel("500ml"), "500 ml");
eq("half plate → Half Plate", canonicalPortionLabel("half plate"), "Half Plate");

/* ---------- portion stripping ---------- */
{
  const r = stripPortionFromName("Chicken Tikka (8 pcs)");
  eq("bracket strip name", r.baseName, "Chicken Tikka");
  eq("bracket strip portion", r.portion, "8 pcs");
}
{
  const r = stripPortionFromName("Tandoori Chicken - Half");
  eq("dash strip name", r.baseName, "Tandoori Chicken");
  eq("dash strip portion", r.portion, "Half");
}
{
  const r = stripPortionFromName("Veg Momos 6 pcs");
  eq("bare qty strip name", r.baseName, "Veg Momos");
  eq("bare qty strip portion", r.portion, "6 pcs");
}
{
  const r = stripPortionFromName("Chicken Curry Half");
  eq("bare word strip name", r.baseName, "Chicken Curry");
  eq("bare word strip portion", r.portion, "Half");
}
{
  const r = stripPortionFromName("Paneer 65");
  eq("number without unit stays", r.baseName, "Paneer 65");
  eq("number without unit no portion", r.portion, null);
}
{
  const r = stripPortionFromName("Paneer Tikka (Spicy)");
  eq("descriptor stays in name", r.baseName, "Paneer Tikka (Spicy)");
  eq("descriptor no portion", r.portion, null);
}
{
  const r = stripPortionFromName("Masala Dosa");
  eq("plain name untouched", r.baseName, "Masala Dosa");
  eq("plain name no portion", r.portion, null);
}

/* ---------- dish keys ---------- */
eq("dishKey strips portion", dishKey("Chicken Tikka (8 pcs)"), "chicken tikka");
eq("dishKey case/space-insensitive", dishKey("paneer  TIKKA"), "paneer tikka");
check("same dish two spellings share a key", dishKey("Chicken Tikka (12 pcs)") === dishKey("chicken tikka"));

/* ---------- 1. single-price dish passes through ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Mains", icon: "🍛", items: [
      { name: "Masala Dosa", price: 140, veg: true, confidence: "high" },
    ]},
  ]);
  eq("single: one category", out.length, 1);
  const item = out[0].items[0];
  eq("single: name", item.name, "Masala Dosa");
  eq("single: price", item.price, 140);
  eq("single: not flagged", item.priceUnreadable, false);
  eq("single: confidence", item.confidence, "high");
  eq("single: no variants", item.variants.length, 0);
}

/* ---------- 2. spec example: two portion lines → one dish, two variants ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Starters", items: [
      { name: "Chicken Tikka (8 pcs)", price: 250, veg: false, confidence: "high" },
      { name: "Chicken Tikka (12 pcs)", price: 420, veg: false, confidence: "high" },
    ]},
  ]);
  eq("group: one item", out[0].items.length, 1);
  const item = out[0].items[0];
  eq("group: name", item.name, "Chicken Tikka");
  eq("group: variants", item.variants.length, 2);
  eq("group: first variant", item.variants[0].name, "8 pcs");
  eq("group: first variant price", item.variants[0].price, 250);
  eq("group: second variant", item.variants[1].name, "12 pcs");
  eq("group: second variant price", item.variants[1].price, 420);
  eq("group: dish price is min portion", item.price, 250);
  check("group: dish not ₹0", item.price !== 0);
  eq("group: not flagged", item.priceUnreadable, false);
  eq("group: raw names kept", item.rawNames.length, 2);
}

/* ---------- 3. single portion line keeps the portion as a variant ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Starters", items: [
      { name: "Chicken Wings (8 pcs)", price: 220, veg: false, confidence: "high" },
    ]},
  ]);
  const item = out[0].items[0];
  eq("single portion: name", item.name, "Chicken Wings");
  eq("single portion: one variant", item.variants.length, 1);
  eq("single portion: variant name", item.variants[0].name, "8 pcs");
  eq("single portion: variant price", item.variants[0].price, 220);
  eq("single portion: dish price", item.price, 220);
}

/* ---------- 4. the screenshot bug: null base price + valid variants ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Starters", items: [
      {
        name: "Tandoori Chicken", price: null, veg: false, confidence: "low",
        variants: [
          { name: "Half", price: 320 },
          { name: "Full", price: 560 },
        ],
      },
    ]},
  ]);
  const item = out[0].items[0];
  eq("screenshot: dish price derived from variants", item.price, 320);
  eq("screenshot: not flagged unreadable", item.priceUnreadable, false);
  eq("screenshot: variants kept", item.variants.length, 2);
  eq("screenshot: variant names canonical", item.variants[0].name, "Half");
}

/* ---------- 5. unreadable prices stay null and flagged, never 0 ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Mains", items: [
      { name: "Mystery Curry", price: null, veg: null, confidence: "low" },
    ]},
  ]);
  const item = out[0].items[0];
  eq("unreadable: price null", item.price, null);
  eq("unreadable: flagged", item.priceUnreadable, true);
  eq("unreadable: low confidence", item.confidence, "low");
  check("unreadable: never 0", item.price !== 0);
}
{
  // variant price unreadable → variant null + item flagged, but the
  // readable variant still derives the dish price
  const out = normalizeExtractedCategories([
    { name: "Starters", items: [
      {
        name: "Fish Fry", price: null, veg: false,
        variants: [
          { name: "Half", price: null },
          { name: "Full", price: 480 },
        ],
      },
    ]},
  ]);
  const item = out[0].items[0];
  eq("variant unreadable: dish price from readable variant", item.price, 480);
  eq("variant unreadable: null stays null", item.variants[0].price, null);
  eq("variant unreadable: variant flagged", item.variants[0].priceUnreadable, true);
  eq("variant unreadable: item low confidence", item.confidence, "low");
}

/* ---------- 6. duplicate dish names ---------- */
{
  // true duplicate (same everything) → merged
  const out = normalizeExtractedCategories([
    { name: "Mains", items: [
      { name: "Paneer Tikka", price: 260, veg: true, confidence: "high" },
      { name: "paneer tikka", price: 260, veg: true, confidence: "high" },
    ]},
  ]);
  eq("dupe: one item", out[0].items.length, 1);
  eq("dupe: price", out[0].items[0].price, 260);
  eq("dupe: raw names kept", out[0].items[0].rawNames.length, 2);
}
{
  // conflicting duplicate → both kept, both flagged, never silently resolved
  const out = normalizeExtractedCategories([
    { name: "Mains", items: [
      { name: "Butter Chicken", price: 320, veg: false },
      { name: "Butter Chicken", price: 350, veg: false },
    ]},
  ]);
  eq("conflict: two items kept", out[0].items.length, 2);
  eq("conflict: first price", out[0].items[0].price, 320);
  eq("conflict: second price", out[0].items[1].price, 350);
  eq("conflict: both flagged", out[0].items.every((i) => i.confidence === "low"), true);
  check("conflict: second carries a note", (out[0].items[1].description ?? "").includes("conflicting price"));
}

/* ---------- 7. AI already emits variants → kept, dish price = min ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Breads", items: [
      {
        name: "Naan Basket", price: null, veg: true,
        variants: [
          { name: "half", price: 90 },
          { name: "full", price: 160 },
        ],
      },
    ]},
  ]);
  const item = out[0].items[0];
  eq("ai variants: count", item.variants.length, 2);
  eq("ai variants: canonical name", item.variants[0].name, "Half");
  eq("ai variants: dish price min", item.price, 90);
}

/* ---------- 8. duplicate categories merge ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Starters", items: [{ name: "A", price: 10, veg: true }] },
    { name: "starters", items: [{ name: "B", price: 20, veg: true }] },
  ]);
  eq("cat merge: one category", out.length, 1);
  eq("cat merge: both items", out[0].items.length, 2);
}

/* ---------- 9. edges ---------- */
{
  eq("empty categories", normalizeExtractedCategories([]).length, 0);
  eq("non-array", normalizeExtractedCategories(null).length, 0);
  const out = normalizeExtractedCategories([
    { name: "Mains", items: [
      { name: "", price: 10 },
      { name: "Real Dish", price: 99, veg: true },
    ]},
  ]);
  eq("nameless item dropped", out[0].items.length, 1);
  eq("nameless: real dish kept", out[0].items[0].name, "Real Dish");
}
{
  // missing category name falls back, items survive
  const out = normalizeExtractedCategories([
    { items: [{ name: "Orphan Dish", price: 50, veg: true }] },
  ]);
  eq("missing cat name: category kept", out.length, 1);
  eq("missing cat name: item kept", out[0].items[0].name, "Orphan Dish");
}

/* ---------- 10. add-on merging on grouped dishes ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Mains", items: [
      { name: "Biryani (Half)", price: 180, veg: false, addOns: [{ name: "Raita", price: 30 }] },
      { name: "Biryani (Full)", price: 300, veg: false, addOns: [{ name: "raita", price: 30 }] },
    ]},
  ]);
  const item = out[0].items[0];
  eq("addons: one dish", out[0].items.length, 1);
  eq("addons: merged once", item.addOns.length, 1);
  eq("addons: price kept", item.addOns[0].price, 30);
  eq("addons: variants", item.variants.length, 2);
}

/* ---------- 11. veg merge: definitive wins over unknown ---------- */
{
  const out = normalizeExtractedCategories([
    { name: "Mains", items: [
      { name: "Dal Fry", price: 150, veg: null },
      { name: "Dal Fry", price: 150, veg: true },
    ]},
  ]);
  eq("veg merge: one item", out[0].items.length, 1);
  eq("veg merge: true wins", out[0].items[0].veg, true);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
