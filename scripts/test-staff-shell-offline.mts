/**
 * The staff shell module grid and shell-separation rules, without a server.
 *
 * The staff shell renders exactly what `/staff/me` puts in `modules`. A module
 * offered to a role that the screen cannot serve is the bug class that gave a
 * Cashier a "Tables & QR" module answering 403 on every load — so the grid is
 * pinned here, per built-in role, and two invariants are checked:
 *
 *   1. a module is offered only when the role holds the key its screens and
 *      endpoints actually require (no wider ORs of neighbour keys),
 *   2. the staff shell's first module for a role is the same view
 *      `firstAllowedView` would land that role on — the two shells must not
 *      disagree about where a restricted login goes.
 *
 *   npm run test:staff-shell
 */
import { staffModules } from "../supabase/functions/_shared/staff-modules.ts";
import { DEFAULT_ROLES } from "../supabase/functions/_shared/permissions.ts";
import { VIEW_ORDER, firstAllowedView } from "../src/lib/permissions.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

/** The keys a module's screens + entry data endpoint will 403 without. */
const MODULE_GATES: Record<string, string[]> = {
  // The POS takes both halves of its gate — dashboard.view (may use the
  // dashboard at all) AND tables.view (the screen it shows).
  dashboard: ["dashboard.view", "tables.view"],
  orders: ["orders.view"],
  analytics: ["analytics.view"],
  menu: ["menu.view"],
  qr: ["qr.manage"],
  promos: ["promos.view"],
  roles: ["roles.view", "roles.manage", "staff.view", "staff.manage"],
  security: ["security.view"],
  settings: ["settings.view"],
};

// ---- the grid, per built-in role ------------------------------------------
console.log("\nstaffModules per built-in role");
for (const role of DEFAULT_ROLES) {
  const perms = role.permissions.split(",").map((p) => p.trim()).filter(Boolean);
  const grid = staffModules(perms);
  const offered = Object.entries(grid).filter(([, v]) => v).map(([k]) => k);
  check(
    `${role.name}: every offered module is backed by a held gate key`,
    offered.every((m) => MODULE_GATES[m].some((g) => perms.includes(g))),
    `offered=${offered.join(",")} perms=${perms.join(",")}`,
  );
}

// ---- the two regressions, by name -----------------------------------------
console.log("\nthe fixes, by role");
const cashier = staffModules(DEFAULT_ROLES.find((r) => r.name === "Cashier")!.permissions.split(","));
check(
  "Cashier is no longer offered Tables & QR (no qr.manage)",
  cashier.qr === false,
  `qr=${cashier.qr} — the module must be hidden, not granted`,
);
check(
  "Cashier still holds the POS",
  cashier.dashboard === true,
  `dashboard=${cashier.dashboard}`,
);
const manager = staffModules(DEFAULT_ROLES.find((r) => r.name === "Manager")!.permissions.split(","));
check(
  "Manager keeps Roles & Staff through staff.view (screen handles it)",
  manager.roles === true,
  `roles=${manager.roles}`,
);
const kitchen = staffModules(DEFAULT_ROLES.find((r) => r.name === "Kitchen")!.permissions.split(","));
check(
  "Kitchen has no POS and keeps only the queue",
  kitchen.dashboard === false && kitchen.orders === true,
  `dashboard=${kitchen.dashboard} orders=${kitchen.orders}`,
);
check(
  "Waiter keeps the POS",
  staffModules(DEFAULT_ROLES.find((r) => r.name === "Waiter")!.permissions.split(",")).dashboard === true,
);

// ---- the two shells agree on where a restricted role lands -----------------
console.log("\nstaff first module == firstAllowedView");
for (const role of DEFAULT_ROLES) {
  const perms = role.permissions.split(",").map((p) => p.trim()).filter(Boolean);
  const grid = staffModules(perms);
  const firstModule = Object.entries(grid).find(([, v]) => v)?.[0] ?? null;
  const client = firstAllowedView(perms);
  check(
    `${role.name}: staff shell lands on ${firstModule}, client on ${client}`,
    firstModule === client,
    `staff=${firstModule} client=${client}`,
  );
}

// ---- custom roles: the grid follows the keys, not the name -----------------
console.log("\ncustom roles");
const custom = staffModules(["orders.view", "menu.view", "tables.view"]);
check(
  "a tables-view role without dashboard.view gets no POS (compound gate)",
  custom.qr === false && custom.dashboard === false,
  `dashboard=${custom.dashboard}`,
);
const posRole = staffModules(["dashboard.view", "tables.view", "orders.view"]);
check(
  "dashboard.view + tables.view opens the POS",
  posRole.dashboard === true && posRole.orders === true,
  `dashboard=${posRole.dashboard}`,
);
check(
  "dashboard.view alone still opens nothing",
  staffModules(["dashboard.view", "orders.view"]).dashboard === false,
);
const staffOnly = staffModules(["staff.manage"]);
check(
  "a staff-only role gets the Roles & Staff module (it can manage staff)",
  staffOnly.roles === true && staffOnly.qr === false,
  `roles=${staffOnly.roles}`,
);
const orderManager = staffModules(["orders.manage"]);
check(
  "orders.manage alone does not open the queue (list needs orders.view)",
  orderManager.orders === false,
  `orders=${orderManager.orders}`,
);

// ---- the owner-staff seam ---------------------------------------------------
console.log("\nview order covers every module key");
for (const key of Object.keys(MODULE_GATES)) {
  check(`${key} appears in VIEW_ORDER`, VIEW_ORDER.includes(key as any));
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
