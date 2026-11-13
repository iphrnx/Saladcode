/**
 * Regression tests for menu-tag sanitisation — the AI scanner used to save
 * tags Menu Management has never heard of ("healthy" rendered as "FIT",
 * "signature"), leaving chips on dishes the owner cannot see or edit. Both
 * copies of the validator (edge + frontend) are exercised here and must
 * agree: exact match and safe aliases survive, inventions are dropped,
 * nothing is ever rewritten or created. Run: npm run test:menu-tags
 */
import { sanitizeMenuTags as sanitizeEdge, CANONICAL_MENU_TAGS } from "../supabase/functions/_shared/menu-tags.ts";
import { sanitizeMenuTags as sanitizeWeb } from "../src/lib/menu-tags.ts";

let passed = 0;
let failed = 0;

function check(name: string, input: unknown, expected: string[]) {
  const edge = sanitizeEdge(input);
  const web = sanitizeWeb(input);
  const ok =
    JSON.stringify(edge) === JSON.stringify(expected) &&
    JSON.stringify(web) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${name}\n  input:    ${JSON.stringify(input)}\n  expected: ${JSON.stringify(expected)}\n  edge:     ${JSON.stringify(edge)}\n  web:      ${JSON.stringify(web)}`);
  }
}

// Exact matches, any case
check("lowercase canonical", ["veg"], ["VEG"]);
check("uppercase canonical", ["SPICY"], ["SPICY"]);
check("mixed case", ["Veg", "Spicy"], ["VEG", "SPICY"]);
check("all eight canonical survive", ["veg", "non-veg", "vegan", "spicy", "jain", "bestseller", "new", "gluten-free"], ["VEG", "NON-VEG", "VEGAN", "SPICY", "JAIN", "BESTSELLER", "NEW", "GLUTEN-FREE"]);

// Comma-string input (the database storage form)
check("comma string", "veg, spicy", ["VEG", "SPICY"]);
check("comma string no space", "veg,spicy", ["VEG", "SPICY"]);
check("Menu Management format", "VEG, SPICY", ["VEG", "SPICY"]);

// Safe aliases
check("vegetarian", ["vegetarian"], ["VEG"]);
check("veggie", ["veggie"], ["VEG"]);
check("nonveg spellings", ["nonveg"], ["NON-VEG"]);
check("non veg spaced", ["Non Veg"], ["NON-VEG"]);
check("best seller", ["best seller"], ["BESTSELLER"]);
check("best-seller hyphen", ["Best-Seller"], ["BESTSELLER"]);
check("gluten free", ["gluten free"], ["GLUTEN-FREE"]);
check("gf", ["GF"], ["GLUTEN-FREE"]);

// The reported bug: invented tags are dropped, never saved
check("healthy dropped", ["healthy"], []);
check("FIT dropped", ["FIT"], []);
check("signature dropped", ["signature"], []);
check("healthy among valid", ["veg", "healthy", "spicy"], ["VEG", "SPICY"]);

// Unsafe semantics are NOT matched
check("hot not spicy", ["hot"], []);
check("popular not bestseller", ["popular"], []);

// Dedupe across spellings
check("dedupe same id", ["veg", "VEG", "vegetarian"], ["VEG"]);
check("dedupe alias", ["gluten free", "gf", "gluten-free"], ["GLUTEN-FREE"]);

// Junk in, nothing out — never throws
check("null", null, []);
check("undefined", undefined, []);
check("number", 42, []);
check("object", {}, []);
check("empty string", "", []);
check("blank tokens", ["", "  "], []);
check("array with junk members", ["veg", null, 42, undefined, "new"], ["VEG", "NEW"]);

// Order preserved (first-seen)
check("order", ["new", "veg", "spicy"], ["NEW", "VEG", "SPICY"]);

// Canonical list is exactly Menu Management's picker
const expectedCanonical = ["VEG", "NON-VEG", "VEGAN", "SPICY", "JAIN", "BESTSELLER", "NEW", "GLUTEN-FREE"];
if (JSON.stringify([...CANONICAL_MENU_TAGS]) === JSON.stringify(expectedCanonical)) {
  passed++;
} else {
  failed++;
  console.error(`✗ canonical list drifted: ${JSON.stringify(CANONICAL_MENU_TAGS)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
