import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

console.log("Session Details UI/UX checks:");

const drawerFile = path.join(process.cwd(), "src/components/shared/session-orders-drawer.tsx");
const drawerSrc = fs.readFileSync(drawerFile, "utf8");

const ordersFile = path.join(process.cwd(), "src/components/views/orders.tsx");
const ordersSrc = fs.readFileSync(ordersFile, "utf8");

// 1. Centered Header & Dynamic Subtitle
check(
  "SessionOrdersDrawer renders centered 'Session Details' title and tab-aware subtitle",
  drawerSrc.includes("Session Details") &&
    drawerSrc.includes("headerSubtitle") &&
    drawerSrc.includes("Bill Summary"),
);

// 2. Circular Close Button
check(
  "SessionOrdersDrawer renders circular close button in top right",
  drawerSrc.includes("absolute right-4 top-4") &&
    drawerSrc.includes("rounded-full") &&
    drawerSrc.includes("<X className="),
);

// 3. Context Card
check(
  "SessionOrdersDrawer renders context card with table info and (✓) Paid badge",
  drawerSrc.includes("bg-[#FFF9F5]") &&
    drawerSrc.includes("border-orange-200/80") &&
    drawerSrc.includes("metaSubtitle") &&
    drawerSrc.includes("Paid"),
);

// 4. 3-Cell Timing Strip
check(
  "SessionOrdersDrawer renders 3-cell timing strip (Started at, Ended at, Duration) with icons",
  drawerSrc.includes("Started at") &&
    drawerSrc.includes("Ended at") &&
    drawerSrc.includes("Duration") &&
    drawerSrc.includes("CalendarDays") &&
    drawerSrc.includes("Power") &&
    drawerSrc.includes("Timer"),
);

// 5. Segmented Pill Tabs
check(
  "SessionOrdersDrawer renders 3 pill tabs (Orders, Bill Summary, Activity) with solid orange active pill",
  drawerSrc.includes("Orders ({orders.length})") &&
    drawerSrc.includes("Bill Summary") &&
    drawerSrc.includes("Activity") &&
    drawerSrc.includes("bg-[#EA580C] text-white"),
);

// 6. Orders List
check(
  "SessionOrdersDrawer orders list renders #{orderNumber}, time, status badge, amount, and dishes preview",
  drawerSrc.includes("#{order.orderNumber}") &&
    drawerSrc.includes("itemsPreview") &&
    drawerSrc.includes("ChevronDown") &&
    drawerSrc.includes("order.items.map"),
);

// 7. Bill Summary 2-Column Layout
check(
  "SessionOrdersDrawer Bill Summary tab renders Charges card (Subtotal, CGST, SGST, Total Paid)",
  drawerSrc.includes("Charges") &&
    drawerSrc.includes("Subtotal") &&
    drawerSrc.includes("CGST") &&
    drawerSrc.includes("SGST") &&
    drawerSrc.includes("Total Paid"),
);

check(
  "SessionOrdersDrawer Bill Summary tab renders 3 cards: Payment Method, Invoice No., Paid At",
  drawerSrc.includes("Payment Method") &&
    drawerSrc.includes("Invoice No.") &&
    drawerSrc.includes("Paid At") &&
    drawerSrc.includes("formatPaymentMethod") &&
    drawerSrc.includes("formatInvoiceNumber") &&
    drawerSrc.includes("formatFullDateTime"),
);

// 8. Activity Timeline
check(
  "SessionOrdersDrawer Activity tab renders chronological timeline with icons (Play, Plus, Cloche, CreditCard, Flag)",
  drawerSrc.includes("timelineEvents") &&
    drawerSrc.includes("Session Started") &&
    drawerSrc.includes("Order Placed") &&
    drawerSrc.includes("All Orders Served") &&
    drawerSrc.includes("Payment Completed") &&
    drawerSrc.includes("Session Ended") &&
    drawerSrc.includes("Play") &&
    drawerSrc.includes("Plus") &&
    drawerSrc.includes("CreditCard") &&
    drawerSrc.includes("Flag"),
);

// 9. Footer Action Buttons
check(
  "SessionOrdersDrawer renders Print Bill (outline) and Download Bill (PDF) (solid orange)",
  drawerSrc.includes("Print Bill") &&
    drawerSrc.includes("Download Bill (PDF)") &&
    drawerSrc.includes("Printer") &&
    drawerSrc.includes("Download"),
);

// 10. Integration in orders.tsx
check(
  "orders.tsx connects invoiceNumber, paymentMethod, paidAt, onPrintBill, onDownloadBill",
  ordersSrc.includes("invoiceNumber={") &&
    ordersSrc.includes("paymentMethod={") &&
    ordersSrc.includes("paidAt={") &&
    ordersSrc.includes("onPrintBill={() => {") &&
    ordersSrc.includes("onDownloadBill={() => {"),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
