/**
 * POS cart line mutations — the regression test for the frozen-cart bug.
 *
 * A cart line's identity is (menuItemId, portionId): portions created in the
 * menu editor carry ids like "custom-1793184616912-1", which do NOT equal the
 * slug derived from the portion name. The cart's +/−/remove/notes controls
 * used to address the line by name only, so every mutation silently no-op'd
 * on portioned lines — the cashier's cart looked completely stuck.
 *
 *   npm run test:pos-cart
 */
import { useStore } from "../src/lib/store";

let checks = 0;
let bad = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks++;
  if (!ok) { bad++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
  else console.log(`  ok    ${name}`);
};

const st = useStore.getState;
const ITEM = "a22e9ed3-2f7c-41f6-bf65-5e6c409ba468"; // Spicy Handi Maggie
const PID = "custom-1793184616912-1"; // portion "Spicy" ₹89 — id differs from name slug

// ── a portioned line, added the way the dish card adds it ────────────────
useStore.getState().clearCart();
st().addToCart({ menuItemId: ITEM, name: "Spicy Handi Maggie", portion: "Spicy", portionId: PID, price: 89 });
check("portioned line added", st().cart.length === 1 && st().cart[0].quantity === 1, st().cart);
check("line carries the portion id", st().cart[0].portionId === PID, st().cart[0]);

// the controls pass the line's own identity (name + id), as CartPanel does
st().updateCartQty(ITEM, 2, "Spicy", PID);
check("qty + reaches a portioned line", st().cart[0]?.quantity === 2, st().cart);
st().updateCartQty(ITEM, 1, "Spicy", PID);
check("qty − reaches a portioned line", st().cart[0]?.quantity === 1, st().cart);
st().setCartNotes(ITEM, "less oil", "Spicy", PID);
check("notes reach a portioned line", st().cart[0]?.notes === "less oil", st().cart[0]);

// the old broken call shape (name only) must NOT silently no-op either:
// sameLine falls back to the name when the line has no id, and the line's
// own id is what the buttons now pass — but a name-only call addressing a
// line whose id differs from the name slug still must not corrupt anything.
st().updateCartQty(ITEM, 3, "Spicy");
check("name-only call does not corrupt (no match, qty unchanged)", st().cart[0]?.quantity === 1, st().cart);

// remove
st().removeFromCart(ITEM, "Spicy", PID);
check("remove deletes a portioned line", st().cart.length === 0, st().cart);

// qty 0 on the minus button removes the line
st().addToCart({ menuItemId: ITEM, name: "Spicy Handi Maggie", portion: "Spicy", portionId: PID, price: 89 });
st().updateCartQty(ITEM, 0, "Spicy", PID);
check("qty − to 0 removes the line", st().cart.length === 0, st().cart);

// ── a portion-less line still works (identity is empty on both sides) ────
st().addToCart({ menuItemId: "classic", name: "Classic Maggie", price: 39 });
st().updateCartQty("classic", 2, null, null);
check("portion-less + works", st().cart[0]?.quantity === 2, st().cart);
st().removeFromCart("classic", null, null);
check("portion-less remove works", st().cart.length === 0, st().cart);

// ── two portions of the same dish are distinct lines ─────────────────────
st().addToCart({ menuItemId: ITEM, name: "Spicy Handi Maggie", portion: "Spicy", portionId: PID, price: 89 });
st().addToCart({ menuItemId: ITEM, name: "Spicy Handi Maggie", portion: "Extra Spicy", portionId: "custom-1793184632979-2", price: 99 });
st().updateCartQty(ITEM, 5, "Spicy", PID);
const spicy = st().cart.find((c) => c.portionId === PID);
const extra = st().cart.find((c) => c.portionId === "custom-1793184632979-2");
check("+ on one portion leaves the other alone", spicy?.quantity === 5 && extra?.quantity === 1, st().cart);
st().removeFromCart(ITEM, "Extra Spicy", "custom-1793184632979-2");
check("remove one portion leaves the other", st().cart.length === 1 && st().cart[0].portionId === PID, st().cart);

// ── subtractCartLines (post-order decrement) uses the payload identity ───
st().clearCart();
st().addToCart({ menuItemId: ITEM, name: "Spicy Handi Maggie", portion: "Spicy", portionId: PID, price: 89 });
st().addToCart({ menuItemId: ITEM, name: "Spicy Handi Maggie", portion: "Spicy", portionId: PID, price: 89 });
st().subtractCartLines([{ menuItemId: ITEM, portion: "Spicy", portionId: PID, quantity: 1 } as any]);
check("subtractCartLines decrements by payload identity", st().cart[0]?.quantity === 1, st().cart);

st().clearCart();
console.log(`\n${checks - bad}/${checks} passed`);
process.exit(bad ? 1 : 0);
