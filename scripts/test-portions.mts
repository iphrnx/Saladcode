/**
 * End-to-end test suite for portion-wise menu pricing.
 */

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let checks = 0;
let bad = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (!ok) {
    bad++;
    console.log(`  FAIL  ${name}`, detail ? `
        detail: ${JSON.stringify(detail)}` : "");
  } else {
    console.log(`  ok    ${name}`);
  }
}

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

async function sessionFor(email: string) {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr) throw new Error(`Magiclink failed: ${linkErr.message}`);
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data, error } = await c.auth.verifyOtp({
    token_hash: link!.properties.hashed_token,
    type: "magiclink",
  });
  if (error) throw new Error(`verifyOtp failed: ${error.message}`);
  return data!.session!.access_token;
}

async function callFn(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

console.log(`
── 1. Authenticate owner & resolve tenant ──`);
const token = await sessionFor("swizofoods@gmail.com");
check("Owner sign-in succeeded", Boolean(token));

const boot = await callFn("bootstrap", token);
check("Bootstrap 200", boot.status === 200);
const tenantId = boot.data?.tenant?.id;
check("Tenant ID resolved", Boolean(tenantId));

const categoriesRes = await callFn("categories", token);
const categories = Array.isArray(categoriesRes.data) ? categoriesRes.data : [];
check("Categories fetched", categories.length > 0);
const categoryId = categories[0]?.id;

const createdItemIds: string[] = [];
const createdOrderIds: string[] = [];

try {
  console.log(`
── 2. Menu Item Portions Validation ──`);

  // Duplicate portion names
  const dupRes = await callFn("menu", token, {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: `Test Dish Validation ${Date.now()}`,
      price: 150,
      portions: [
        { name: "Half", price: 80 },
        { name: "half", price: 90 }, // case-insensitive duplicate
      ],
    }),
  });
  check("Duplicate portion name rejected with 400", dupRes.status === 400, dupRes.data);

  // Negative price
  const negRes = await callFn("menu", token, {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: `Test Dish Validation ${Date.now()}`,
      price: 150,
      portions: [{ name: "Half", price: -20 }],
    }),
  });
  check("Negative portion price rejected with 400", negRes.status === 400, negRes.data);

  // Missing name
  const emptyRes = await callFn("menu", token, {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: `Test Dish Validation ${Date.now()}`,
      price: 150,
      portions: [{ name: "", price: 50 }],
    }),
  });
  check("Empty portion name rejected with 400", emptyRes.status === 400, emptyRes.data);

  // More than 8 portions
  const manyRes = await callFn("menu", token, {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: `Test Dish Validation ${Date.now()}`,
      price: 150,
      portions: Array.from({ length: 9 }, (_, i) => ({ name: `Size ${i + 1}`, price: 10 + i })),
    }),
  });
  check("Over 8 portions rejected with 400", manyRes.status === 400, manyRes.data);

  console.log(`
── 3. Create Dish with Portions (without separate base price) ──`);
  const testDishName = `Tandoori Chicken Test ${Date.now()}`;
  const createRes = await callFn("menu", token, {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: testDishName,
      description: "Tender chicken cooked with aromatic spices in a clay oven",
      // Even if a conflicting price (90) or no price is sent, server syncs base price to min portion (70)
      price: 90,
      portions: [
        { name: "quarter", price: 70 },
        { name: "Half", price: 130 },
        { name: "full", price: 240 },
      ],
    }),
  });
  check("Dish with portions created (201)", createRes.status === 201, createRes.data);
  const dishId = createRes.data?.id;
  if (dishId) createdItemIds.push(dishId);
  check("Dish portions returned on create", Array.isArray(createRes.data?.portions) && createRes.data.portions.length === 3);
  check("Base price synced to min portion price (70, not conflicting 90)", createRes.data?.price === 70, createRes.data?.price);
  check(
    "Portion names canonicalised and assigned stable IDs",
    createRes.data?.portions?.[0]?.id === "quarter" &&
      createRes.data?.portions?.[0]?.name === "Quarter" &&
      createRes.data?.portions?.[2]?.id === "full" &&
      createRes.data?.portions?.[2]?.name === "Full",
    createRes.data?.portions,
  );

  console.log(`
── 4. Verify Menu List contains Portions ──`);
  const listRes = await callFn("menu", token);
  const items = Array.isArray(listRes.data) ? listRes.data : [];
  const foundDish = items.find((i: any) => i.id === dishId);
  check("Dish found in menu list", Boolean(foundDish));
  check("Dish has 3 portions in menu list", foundDish?.portions?.length === 3);
  check("Quarter price is 70", foundDish?.portions?.find((p: any) => p.name === "Quarter")?.price === 70);
  check("Half price is 130", foundDish?.portions?.find((p: any) => p.name === "Half")?.price === 130);
  check("Full price is 240", foundDish?.portions?.find((p: any) => p.name === "Full")?.price === 240);

  console.log(`
── 5. Place Order with Selected Portion (Half @ ₹130) & Duplicate Line Merging ──`);
  const orderRes = await callFn("orders", token, {
    method: "POST",
    body: JSON.stringify({
      orderType: "TAKEAWAY",
      customerName: "Priyanshu Test",
      items: [
        {
          menuItemId: dishId,
          portionId: "half",
          portion: "Half",
          price: 9999, // Tampered client price — must be ignored
          quantity: 1,
          notes: "Extra mint chutney",
        },
        {
          menuItemId: dishId,
          portion: "half", // Duplicate line with lowercase 'half' and same note -> merges into qty 2
          quantity: 1,
          notes: "Extra mint chutney",
        },
      ],
    }),
  });
  check("Order placed successfully (201)", orderRes.status === 201, orderRes.data);
  const orderId = orderRes.data?.id;
  if (orderId) createdOrderIds.push(orderId);

  check("Duplicate portion lines merged into 1 order_item row", orderRes.data?.items?.length === 1, orderRes.data?.items);
  const orderItem = orderRes.data?.items?.[0];
  check("Order item has portion 'Half' and portionId 'half'", orderItem?.portion === "Half" && orderItem?.portionId === "half", orderItem);
  check("Order item unit price is ₹130 (portion price charged once, not base ₹70 + ₹130)", orderItem?.price === 130, orderItem?.price);
  check("Order item quantity merged to 2", orderItem?.quantity === 2, orderItem?.quantity);
  check("Order itemsTotal matches 2 × 130 = ₹260", orderRes.data?.itemsTotal === 260, orderRes.data?.itemsTotal);

  console.log(`
── 6. Invalid Portion Name Rejected on Order ──`);
  const badOrderRes = await callFn("orders", token, {
    method: "POST",
    body: JSON.stringify({
      orderType: "TAKEAWAY",
      customerName: "Bad Portion Test",
      items: [
        {
          menuItemId: dishId,
          portion: "MonsterSize",
          quantity: 1,
        },
      ],
    }),
  });
  check("Invalid portion rejected with 400", badOrderRes.status === 400, badOrderRes.data);

  console.log(`
── 7. Single-Price Dish & Backward Compatibility ──`);
  const singleDishRes = await callFn("menu", token, {
    method: "POST",
    body: JSON.stringify({
      categoryId,
      name: `Single Price Paneer ${Date.now()}`,
      price: 180,
      portions: null,
    }),
  });
  check("Single-price dish created (201)", singleDishRes.status === 201, singleDishRes.data);
  const singleDishId = singleDishRes.data?.id;
  if (singleDishId) createdItemIds.push(singleDishId);
  check("Single-price dish portions is null", singleDishRes.data?.portions === null);
  check("Single-price dish price is 180", singleDishRes.data?.price === 180);

  const singleOrderRes = await callFn("orders", token, {
    method: "POST",
    body: JSON.stringify({
      orderType: "TAKEAWAY",
      customerName: "Single Price Test",
      items: [{ menuItemId: singleDishId, quantity: 2 }],
    }),
  });
  check("Order for single-price dish accepted (201)", singleOrderRes.status === 201, singleOrderRes.data);
  if (singleOrderRes.data?.id) createdOrderIds.push(singleOrderRes.data.id);
  const singleOrderItem = singleOrderRes.data?.items?.[0];
  check("Single-price order item portion is null", singleOrderItem?.portion === null);
  check("Single-price order item unit price is ₹180 and itemsTotal is ₹360", singleOrderItem?.price === 180 && singleOrderRes.data?.itemsTotal === 360);

  const invalidSinglePortionRes = await callFn("orders", token, {
    method: "POST",
    body: JSON.stringify({
      orderType: "TAKEAWAY",
      customerName: "Invalid Single Portion",
      items: [{ menuItemId: singleDishId, portion: "Half", quantity: 1 }],
    }),
  });
  check("Sending portion for a single-price dish rejected with 400", invalidSinglePortionRes.status === 400, invalidSinglePortionRes.data);

  console.log(`
── 8. Add Item with Portion to Existing Order (Quarter @ ₹70) ──`);
  const addItemRes = await callFn(`orders/${orderId}/items`, token, {
    method: "POST",
    body: JSON.stringify({
      menuItemId: dishId,
      portionId: "quarter",
      portion: "Quarter",
      quantity: 1,
      notes: "Crispy",
    }),
  });
  check("Item added to order (201)", addItemRes.status === 201, addItemRes.data);
  check("Added item has portion 'Quarter' and portionId 'quarter'", addItemRes.data?.portion === "Quarter" && addItemRes.data?.portionId === "quarter");
  check("Added item price is ₹70", addItemRes.data?.price === 70);

  // Check updated order totals: 2×130 + 1×70 = ₹330
  const updatedOrderRes = await callFn(`orders/${orderId}`, token);
  check("Order itemsTotal updated to ₹330", updatedOrderRes.data?.itemsTotal === 330, updatedOrderRes.data?.itemsTotal);
  check("Order has 2 items", updatedOrderRes.data?.items?.length === 2);

  console.log(`
── 9. Bill Verification ──`);
  const billRes = await callFn(`bill/${orderId}`, token);
  check("Bill fetched (200)", billRes.status === 200, billRes.data);
  const billItems = billRes.data?.items || [];
  const billHalf = billItems.find((it: any) => it.portion === "Half");
  const billQuarter = billItems.find((it: any) => it.portion === "Quarter");
  check("Bill has item with portion 'Half'", Boolean(billHalf));
  check("Bill Half unitPrice is 130 and total is 260", billHalf?.unitPrice === 130 && billHalf?.total === 260);
  check("Bill has item with portion 'Quarter'", Boolean(billQuarter));
  check("Bill Quarter unitPrice is 70 and total is 70", billQuarter?.unitPrice === 70 && billQuarter?.total === 70);
  check("Bill subtotal is 330", billRes.data?.subtotal === 330);

  console.log(`
── 10. Update Dish Portions (PATCH /menu) & DB Trigger Deduplication ──`);
  const patchRes = await callFn(`menu/${dishId}`, token, {
    method: "PATCH",
    body: JSON.stringify({
      portions: [
        { name: "Small", price: 80 },
        { name: "Large", price: 150 },
      ],
    }),
  });
  check("Menu item patched with new portions (200)", patchRes.status === 200, patchRes.data);
  check("Patched item has 2 portions with stable IDs", patchRes.data?.portions?.length === 2 && patchRes.data?.portions?.[0]?.id === "small");
  check("Patched item base price synced to ₹80", patchRes.data?.price === 80, patchRes.data?.price);

  // Verify DB trigger deduplicates direct SQL writes
  const { data: sqlRow, error: sqlErr } = await admin
    .from("menu_items")
    .update({
      price: 999,
      portions: [
        { name: "half", price: 60 },
        { name: "HALF", price: 95 },
        { name: "full", price: 120 },
      ],
    })
    .eq("id", dishId)
    .select("price, portions")
    .single();
  check("Direct SQL write succeeded", !sqlErr && Boolean(sqlRow), sqlErr);
  check("DB trigger deduplicated 'half'/'HALF' to 2 portions", Array.isArray(sqlRow?.portions) && sqlRow.portions.length === 2, sqlRow?.portions);
  check("DB trigger synced base price to 60 (not 999)", sqlRow?.price === 60, sqlRow?.price);

  console.log(`
── 11. Frontend Portion Helpers Verification ──`);
  const { formatDishPriceLabel, normalizePortions, normalizePortionKey } = await import("../src/lib/portions.ts");
  check(
    "Single-portion price label does not duplicate price ('₹100.00', never '₹100–₹100.00')",
    formatDishPriceLabel(100, [{ name: "Full", price: 100 }], "₹") === "₹100.00",
  );
  check(
    "Multi-portion price label formats range cleanly ('₹50.00 – ₹100.00')",
    formatDishPriceLabel(90, [{ name: "Half", price: 50 }, { name: "full", price: 100 }], "₹") === "₹50.00 – ₹100.00",
  );
  check(
    "normalizePortions deduplicates case-insensitively and canonicalises names",
    normalizePortions([{ name: "half", price: 50 }, { name: "Half", price: 60 }]).length === 1 &&
      normalizePortions([{ name: "full", price: 100 }])[0]?.name === "Full",
  );
  check(
    "normalizePortionKey matches 'Full' and 'full'",
    normalizePortionKey("Full") === normalizePortionKey("full"),
  );

} finally {
  console.log(`
── Cleanup ──`);
  for (const id of createdOrderIds) {
    await admin.from("order_items").delete().eq("order_id", id);
    await admin.from("orders").delete().eq("id", id);
  }
  for (const id of createdItemIds) {
    await admin.from("menu_items").delete().eq("id", id);
  }
  console.log(`Cleaned up ${createdOrderIds.length} test orders and ${createdItemIds.length} test menu items.`);
}

console.log(`
========================================`);
console.log(`Summary: ${checks - bad}/${checks} checks passed.`);
if (bad > 0) {
  console.log(`❌ ${bad} CHECKS FAILED`);
  process.exit(1);
} else {
  console.log(`✅ ALL CHECKS PASSED`);
}
