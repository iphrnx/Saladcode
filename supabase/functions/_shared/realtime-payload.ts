/**
 * What travels over a Realtime topic, and what a topic is called.
 *
 * Kept separate from the publisher so it can be exercised without a database
 * or a network: this is the code that decides whether a customer's phone
 * number leaves the server, and a rule that can only be tested against live
 * infrastructure is a rule nobody tests.
 *
 * The invariant: an event carries identifiers, money and status. Never a
 * customer's name or phone, never free-text notes, never a table's QR token,
 * never a session credential.
 */

/** What a client is told about an order. Everything else stays server-side. */
export interface OrderEventFacts {
  id: string;
  tenantId: string;
  orderNumber: number;
  tableId: string | null;
  tableSessionId: string | null;
  status: string;
  itemsTotal: number;
  discount: number;
  tax: number;
  serviceCharge: number;
  total: number;
  paymentStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    price: number;
    total: number;
    portion: string | null;
    status: string;
  }>;
}

/**
 * The order, reduced to what a screen needs to draw it.
 *
 * Deliberately absent: `customerName`, `customerPhone`, `notes`, `servedBy`,
 * and the whole nested `table` object (which is where `qrToken` used to leak).
 * The POS and the kitchen fetch the authoritative row from `/orders/sync`
 * anyway — the event is a signal, not the record.
 */
export function orderEvent(order: any): OrderEventFacts {
  return {
    id: String(order.id),
    tenantId: String(order.tenantId ?? order.tenant_id),
    orderNumber: Number(order.orderNumber ?? order.order_number ?? 0),
    tableId: order.tableId ?? order.table_id ?? null,
    tableSessionId: order.tableSessionId ?? order.table_session_id ?? null,
    status: String(order.status ?? ""),
    itemsTotal: Number(order.itemsTotal ?? order.items_total ?? 0),
    discount: Number(order.discount ?? 0),
    tax: Number(order.tax ?? 0),
    serviceCharge: Number(order.serviceCharge ?? order.service_charge ?? 0),
    total: Number(order.total ?? 0),
    paymentStatus: String(order.paymentStatus ?? order.payment_status ?? "UNPAID"),
    createdAt: order.createdAt ?? order.created_at ?? null,
    updatedAt: order.updatedAt ?? order.updated_at ?? null,
    completedAt: order.completedAt ?? order.completed_at ?? null,
    items: Array.isArray(order.items)
      ? order.items.map((i: any) => ({
          id: String(i.id),
          name: String(i.name ?? ""),
          quantity: Number(i.quantity ?? 0),
          price: Number(i.price ?? 0),
          total: Number(i.total ?? 0),
          portion: i.portion ?? null,
          status: String(i.status ?? ""),
        }))
      : [],
  };
}

/** The topic a restaurant's staff listen on. Never derived from the tenant id alone. */
export function staffTopicName(tenantId: string, secret: string): string {
  return `staff:${tenantId}:${secret}`;
}

/** True for the capability topics; decides whether a channel is private. */
export function isCapabilityTopic(topic: string): boolean {
  return topic.startsWith("staff:") || topic.startsWith("diner:");
}

/** The topic one diner listens on: their own session token is the capability. */
export function dinerTopicName(sessionToken: string): string {
  return `diner:${sessionToken}`;
}

