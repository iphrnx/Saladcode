/**
 * What may travel over a Realtime topic — tested without a network.
 *
 * The old broadcast carried the whole order row to a public channel named
 * after the tenant id: customer name, customer phone, the order's notes, and
 * the table's `qrToken` nested inside the table object. Every diner knows the
 * tenant id (it is in their session payload), so every diner could read every
 * other table's orders — and the token that mints sessions.
 *
 * These checks pin the shape of an event, the shape of a topic, and the
 * subscriptions the two clients are allowed to make.
 *
 *   npm run test:realtime-privacy
 */
import { readFileSync, existsSync } from "node:fs";
import {
  dinerTopicName,
  isCapabilityTopic,
  orderEvent,
  staffTopicName,
} from "../supabase/functions/_shared/realtime-payload.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

/** An order row shaped the way the database and mapOrder() return it. */
const row = {
  id: "order-1",
  tenant_id: "tenant-1",
  order_number: 2150,
  table_id: "table-1",
  table_session_id: "session-1",
  status: "PREPARING",
  items_total: 640,
  discount: 0,
  tax: 32,
  service_charge: 0,
  total: 672,
  payment_status: "UNPAID",
  customer_name: "Anita Sharma",
  customer_phone: "+91 98765 43210",
  notes: "Call me on 98765 43210 when ready",
  created_at: "2026-11-08T06:00:00.000Z",
  updated_at: "2026-11-08T06:05:00.000Z",
  completed_at: null,
  items: [
    { id: "i1", name: "Paneer Tikka", quantity: 2, price: 320, total: 640, portion: "Full", status: "PENDING", notes: "extra spicy" },
  ],
  table: { id: "table-1", tenant_id: "tenant-1", name: "Table 4", qr_token: "SECRET-QR-TOKEN-123", area: "Main" },
};

console.log("\n── the event carries no personal data ──");
{
  const ev = orderEvent(row);
  check("the id survives", ev.id === "order-1");
  check("the order number survives", ev.orderNumber === 2150);
  check("the status survives", ev.status === "PREPARING");
  check("the money survives", ev.total === 672 && ev.tax === 32);
  check("the session link survives", ev.tableSessionId === "session-1");
  check("the line items survive", ev.items.length === 1 && ev.items[0].name === "Paneer Tikka");

  check("no customer name", !("customerName" in ev) && !("customer_name" in ev));
  check("no customer phone", !("customerPhone" in ev) && !("customer_phone" in ev));
  check("no order notes", !("notes" in ev));
  check("no table object", !("table" in ev), JSON.stringify(Object.keys(ev)));

  const wire = JSON.stringify(ev);
  check("the phone number is nowhere in the payload", !wire.includes("98765"));
  check("the customer's name is nowhere in the payload", !wire.includes("Anita"));
  check("the QR token is nowhere in the payload", !wire.includes("SECRET-QR-TOKEN"));
  check("a line item's free-text note does not travel", !wire.includes("extra spicy"));
}

console.log("\n── a topic is a capability, not an identifier ──");
{
  const staff = staffTopicName("tenant-1", "ab12cd34ef56");
  check("the staff topic names the tenant", staff.startsWith("staff:tenant-1:"));
  check("…and carries a secret after it", staff.split(":")[2] === "ab12cd34ef56");
  check("…so it is not derivable from the tenant id alone",
    staff !== `staff:tenant-1` && staff.length > "staff:tenant-1:".length);

  const diner = dinerTopicName("abc123sessiontoken");
  check("the diner topic is their session token", diner === "diner:abc123sessiontoken");
  check("two diners never share a topic",
    dinerTopicName("token-a") !== dinerTopicName("token-b"));
  check("an empty token is not a topic", dinerTopicName("") === "diner:");

  check("capability topics are private", isCapabilityTopic(staff) && isCapabilityTopic(diner));
  check("the legacy tenant topic is not", !isCapabilityTopic("orders:tenant-1"));
}

console.log("\n── the publishers only use the sanitised shape ──");
{
  const src = readFileSync("supabase/functions/_shared/realtime-payload.ts", "utf8");
  for (const banned of ["customerPhone", "customer_phone", "qrToken", "qr_token"]) {
    const asField = new RegExp(`^\\s*${banned}\\??:`, "m");
    check(`orderEvent does not copy ${banned}`, !asField.test(src));
  }

  const publisher = readFileSync("supabase/functions/_shared/realtime.ts", "utf8");
  check("the publisher does not claim a private channel", /private:\s*false/.test(publisher));

  const orders = readFileSync("supabase/functions/orders/index.ts", "utf8");
  check("orders broadcasts go through orderEvent()", /order:\s*orderEvent\(/.test(orders));
  check("orders no longer hand the raw row to the bus",
    !/publishToStaff\([^)]*order:\s*order(?!Event)/.test(orders));
}

console.log("\n── the clients subscribe where they are allowed to ──");
{
  const menu = readFileSync("src/components/public/public-menu.tsx", "utf8");
  check("the diner subscribes to its own session topic",
    /\.channel\(`diner:\$\{sessionToken\}`/.test(menu));
  check("the diner no longer subscribes to the restaurant's order topic",
    !/\.channel\(`orders:\$\{/.test(menu));
  check("the diner's channel is public with a capability topic", !/private:\s*true/.test(menu));

  const ctx = readFileSync("src/components/app/data-context.tsx", "utf8");
  check("staff subscribe to the server-issued topic", /data\?\.realtimeTopic/.test(ctx));
  check("staff channels are not opened private either", !/private:\s*true/.test(ctx));

  const bootstrap = readFileSync("supabase/functions/bootstrap/index.ts", "utf8");
  check("bootstrap issues the topic only to orders/tables readers",
    /orders\.view.*tables\.view/.test(bootstrap) && /staffTopic\(/.test(bootstrap));

  check("the dead second publisher is gone", !existsSync("src/lib/order-events.ts"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
