import { hasEffectivePermission } from "./permissions.ts";

/** Shared projection for authenticated workspace order reads. QR capabilities
 * are never needed in an embedded table; the QR screen has its own guard. */
export function workspaceOrderReadScope(permissions: readonly string[]) {
  const can = (key: string) => hasEffectivePermission(permissions, key);
  const canReadOrders = can("orders.view");
  const canReadContacts = can("orders.edit") || can("payments.collect");
  return {
    canReadOrders,
    canReadSummary: canReadOrders && can("dashboard.view"),
    select: `id, tenant_id, table_id, table_session_id, check_id, order_number, order_type, status, items_total, discount, tax, service_charge, total, promo_code_id, promo_code, customer_name, notes, payment_method, payment_status, served_by_id, created_at, updated_at, completed_at, paid_at, location_id, items:order_items(*), table:tables(id, name, seats, area), servedBy:profiles(id, name)${canReadContacts ? ", customer_phone" : ""}`,
  };
}
