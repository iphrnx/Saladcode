/**
 * Automated test suite for Takeaway & Delivery Order Binding, Add Items, Separate KOT, and Consolidated Billing.
 *
 * Usage: npx tsx scripts/test-takeaway-delivery-add-items.mts
 */
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const migAddItems = readFileSync("supabase/migrations/20261114000002_tighten_takeaway_delivery_add_items.sql", "utf8");
const ordersFn = readFileSync("supabase/functions/orders/index.ts", "utf8");
const ordersView = readFileSync("src/components/views/orders.tsx", "utf8");
const addModal = readFileSync("src/components/shared/add-items-modal.tsx", "utf8");

console.log("\n── 1. Order Ownership & Isolation (Strict order:id) ──");
{
  check(
    "orders view isolates Takeaway & Delivery strictly by order:id, never by session or check",
    ordersView.includes("isTakeawayOrDelivery") &&
    ordersView.includes("? `order:${o.id}`")
  );
  check(
    "add_items_to_order_tx strictly enforces tenant isolation on the order",
    migAddItems.includes("where id = p_order_id and tenant_id = p_tenant")
  );
  check(
    "add_items_to_order_tx verifies order_type is TAKEAWAY or DELIVERY",
    migAddItems.includes("v_order.order_type not in ('TAKEAWAY', 'DELIVERY')")
  );
}

console.log("\n── 2. Add Items & Preservation of Original Order ──");
{
  check(
    "addItem endpoint enforces RBAC for Owner, Manager, and Cashier",
    ordersFn.includes('const allowedRoles = ["owner", "manager", "cashier"]') &&
    ordersFn.includes('guard(req, { permission: "orders.edit" })')
  );
  check(
    "add_items_to_order_tx appends new items directly to order_items referencing p_order_id",
    migAddItems.includes("insert into public.order_items") &&
    migAddItems.includes("order_id,") &&
    migAddItems.includes("p_order_id,")
  );
  check(
    "menu item prices and portions are validated server-side from menu_items",
    ordersFn.includes("resolveOrderUnitPrice(mi, raw.portion, raw.portionId)") &&
    migAddItems.includes("from public.menu_items") &&
    migAddItems.includes("where id = (v_item->>'menu_item_id')::uuid")
  );
}

console.log("\n── 3. Separate KOT Generation & Kitchen/Waiter Pass ──");
{
  check(
    "add_items_to_order_tx atomically calculates next KOT number",
    migAddItems.includes("select coalesce(max(kot_number), 1) + 1") &&
    migAddItems.includes("into v_next_kot")
  );
  check(
    "newly added items are stamped with the new KOT number and status PENDING",
    migAddItems.includes("v_next_kot,") &&
    migAddItems.includes("'PENDING',")
  );
  check(
    "orders view separates multiple KOTs into independent tickets on Kitchen/Waiter pass",
    ordersView.includes("kotMap.set(kot, list)") &&
    ordersView.includes("key: `${o.id}-kot-${kot}`") &&
    ordersView.includes("isMultiKot: true")
  );
  check(
    "orders edge function broadcasts KOT_ADDED event to staff topic",
    ordersFn.includes('publishToStaff(tenantId, "KOT_ADDED"') &&
    ordersFn.includes("kotNumber: (txResult as any)?.kot_number")
  );
}

console.log("\n── 4. Single Consolidated Bill & Recalculation ──");
{
  check(
    "add_items_to_order_tx recalculates total across all non-cancelled order_items",
    migAddItems.includes("coalesce(sum(price * quantity), 0)") &&
    migAddItems.includes("where order_id = p_order_id") &&
    migAddItems.includes("status <> 'CANCELLED'")
  );
  check(
    "tax and service charge are re-applied from tenant rates",
    migAddItems.includes("v_tax := round(((v_items_total - v_discount) * v_tax_rate)::numeric, 2);") &&
    migAddItems.includes("v_service_charge := round((v_items_total * v_service_rate)::numeric, 2);") &&
    migAddItems.includes("v_total := round((v_items_total - v_discount + v_tax + v_service_charge)::numeric, 2);")
  );
  check(
    "orders row is updated in the same transaction with new consolidated totals",
    migAddItems.includes("update public.orders") &&
    migAddItems.includes("items_total = v_items_total,") &&
    migAddItems.includes("total = v_total,")
  );
}

console.log("\n── 5. Lifecycle Protection & Settlement ──");
{
  check(
    "add_items_to_order_tx rejects additions if order is COMPLETED or CANCELLED",
    migAddItems.includes("if v_order.status in ('COMPLETED', 'CANCELLED') then") &&
    migAddItems.includes("ORDER_LIFECYCLE_CLOSED")
  );
  check(
    "add_items_to_order_tx rejects additions if order is already PAID",
    migAddItems.includes("if v_order.payment_status in ('PAID', 'paid') then") &&
    migAddItems.includes("ORDER_ALREADY_PAID")
  );
  check(
    "orders card disables Add Items when order is completed, cancelled, or paid",
    ordersView.includes("canAddToThisOrder = isTakeawayOrDelivery && active && sitting.latest.status !== 'COMPLETED' && sitting.latest.status !== 'CANCELLED' && !isPaid")
  );
  check(
    "order status reverts from READY/SERVED to PENDING when new items are added",
    migAddItems.includes("status = case when status in ('READY', 'SERVED') then 'PENDING' else status end")
  );
}

console.log("\n── 6. Backend Security, Row Locks & Idempotency ──");
{
  check(
    "add_items_to_order_tx acquires row-level exclusive lock (FOR UPDATE)",
    migAddItems.includes("from public.orders") &&
    migAddItems.includes("where id = p_order_id and tenant_id = p_tenant") &&
    migAddItems.includes("for update;")
  );
  check(
    "idempotency key deduplication prevents double-insertion on network retry",
    migAddItems.includes("where order_id = p_order_id and idempotency_key = p_idempotency_key") &&
    migAddItems.includes("'deduplicated', true")
  );
  check(
    "addItem function handles deduplication cleanly without duplicate broadcasts",
    ordersFn.includes("if ((txResult as any)?.deduplicated) {") &&
    ordersFn.includes("return json(req, mapped, 200);")
  );
}

console.log("\n── 7. UI Modal & Diner Menu Integration ──");
{
  check(
    "AddItemsModal reuses Diner Menu component logic and imports",
    addModal.includes("from '@/components/public/public-menu'")
  );
  check(
    "AddItemsModal displays order number and newly selected items",
    addModal.includes("Adding Items to Order #{order.orderNumber}")
  );
  check(
    "AddItemsModal preserves selected cart items on failure and closes only on success",
    addModal.includes("toast.error(msg)") &&
    addModal.includes("onSuccess(updatedOrder)") &&
    addModal.includes("onOpenChange(false)")
  );
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
