/** Regression checks for the session card's existing actions and role permissions. */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ROLES, expandPermissions } from "../supabase/functions/_shared/permissions.ts";
import { hasEffectivePermission, ORDER_STATUS_KEYS } from "../src/lib/constants.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const src = fs.readFileSync(path.join(process.cwd(), "src/components/views/orders.tsx"), "utf8");

console.log("SittingCard regression checks:");

// 1. Takeaway/Delivery payment & ended viewability
check(
  "Takeaway/Delivery routes to onPay(sitting.latest) when no tableId/checkId",
  src.includes("else if (canPay && sitting.checkId) onCompletePay(sitting)") &&
    src.includes("else if (canPay) onPay(sitting.latest)"),
);
check(
  "Primary CTA is not disabled solely for missing tableId on ended sittings",
  src.includes("disabled={active && !canPay}") && !src.includes("disabled={!sitting.tableId || (active && !canPay)}"),
);
check(
  "OrderCard onViewBill falls back to setBillDoc when tableId is null",
  src.includes("orderId: order.id,\n                        table: null,"),
);

// 2. Inline Accept / Reject for PENDING_ACTIVATION
const drawerSrc = fs.readFileSync(
  path.join(process.cwd(), "src/components/shared/order-detail-drawer.tsx"),
  "utf8",
);
check(
  "OrderDetailDrawer renders Accept & Reject for PENDING_ACTIVATION gated by canAccept",
  drawerSrc.includes("const isHeld = order.status === 'PENDING_ACTIVATION'") &&
    drawerSrc.includes("canAccept ? (") &&
    drawerSrc.includes("Accept Order"),
);
check(
  "OrderRow toggles from its preview and keeps a separate Order Details action",
  src.includes("aria-expanded={expanded}") && src.includes("Order details") &&
    src.includes("onClick={onOpen}"),
);

// 3. Inline Prepare / Ready / Serve & 4. RBAC permission matrix
const rolePerms = (name: string) => {
  const role = DEFAULT_ROLES.find((r) => r.name === name)!;
  return expandPermissions(role.permissions.split(","));
};
const owner = rolePerms("Owner");
const manager = rolePerms("Manager");
const cashier = rolePerms("Cashier");

check("Owner has prepare/ready/serve + accept + complete + collect",
  hasEffectivePermission(owner, ORDER_STATUS_KEYS.PREPARING) &&
  hasEffectivePermission(owner, ORDER_STATUS_KEYS.READY) &&
  hasEffectivePermission(owner, ORDER_STATUS_KEYS.SERVED) &&
  hasEffectivePermission(owner, "table-sessions.manage") &&
  hasEffectivePermission(owner, "orders.complete") &&
  hasEffectivePermission(owner, "payments.collect"),
);
check("Manager has prepare/ready/serve + accept + complete + collect",
  hasEffectivePermission(manager, ORDER_STATUS_KEYS.PREPARING) &&
  hasEffectivePermission(manager, ORDER_STATUS_KEYS.READY) &&
  hasEffectivePermission(manager, ORDER_STATUS_KEYS.SERVED) &&
  hasEffectivePermission(manager, "table-sessions.manage") &&
  hasEffectivePermission(manager, "orders.complete") &&
  hasEffectivePermission(manager, "payments.collect"),
);
check("Cashier has accept + complete + collect, but NOT prepare/ready/serve",
  !hasEffectivePermission(cashier, ORDER_STATUS_KEYS.PREPARING) &&
  !hasEffectivePermission(cashier, ORDER_STATUS_KEYS.READY) &&
  !hasEffectivePermission(cashier, ORDER_STATUS_KEYS.SERVED) &&
  hasEffectivePermission(cashier, "table-sessions.manage") &&
  hasEffectivePermission(cashier, "orders.complete") &&
  hasEffectivePermission(cashier, "payments.collect"),
);

// 5. canPay enforces both canComplete and canCollectPay
check(
  "SittingCard canPay requires both canComplete and canCollectPay",
  src.includes("const hasPayPerm = canComplete && canCollectPay"),
);

// 6. Accurate Awaiting / No bill yet states
check(
  "SittingCard detects onlyPendingActivation and renders Awaiting + No bill yet",
  src.includes("onlyPendingActivation ? 'Awaiting' : sitting.state") &&
  src.includes("No bill yet"),
);

// 7. Menu actions and scroll bounds
check(
  "The session menu exposes the Bill action",
  src.includes('aria-label={`View bill for ${cardName}`}'),
);
check(
  "The session order list has bounded vertical scrolling",
  /data-sitting-orders[\s\S]*?max-h-\[min\(56vh,30rem\)\][^"\n]*overflow-y-auto/.test(src),
);

// 10. Dead helpers removed
check(
  "Dead helpers and unused openOrders state removed from orders.tsx",
  !src.includes("function SessionCell") &&
  !src.includes("function ServeBadge") &&
  !src.includes("function Money(") &&
  !src.includes("function BillStatePill") &&
  !src.includes("function CardAction") &&
  !src.includes("setOpenOrders"),
);

// 12. Reference UI elements (4-cell strip, serving status labels, +N overflow)
check(
  "SittingCard renders 4-cell session strip and smart serving status labels",
  src.includes("All Items Preparing") &&
  src.includes("to Serve") &&
  src.includes("All Served") &&
  src.includes("shortDuration("),
);

// 13. Active vs Ended card footer actions and All Served indicator
check(
  "Active sessions always render Complete & Pay and replace with Session Details only when ended",
  src.includes("active ? 'Complete & Pay' : 'Session Details'") &&
  src.includes("disabled={active && !canPay}"),
);
check(
  "All Served indicator turns emerald green when sitting.allServed is true",
  src.includes("sitting.allServed") &&
  src.includes("border-emerald-300 bg-emerald-50 text-emerald-800") &&
  src.includes("text-emerald-600 dark:text-emerald-400"),
);

// 14. Financial totals strip renders Total | Due | Paid
check(
  "SittingCard renders figures in Total | Due | Paid order",
  /Figure\s+label="Total"[\s\S]*?Figure\s+label="Due"[\s\S]*?Figure\s+label="Paid"/.test(src),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

