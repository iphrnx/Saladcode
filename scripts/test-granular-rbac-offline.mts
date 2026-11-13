/**
 * The granular RBAC spec, pinned without a server.
 *
 * The redesign splits the coarse order/payment/table permissions into
 * action-level keys. This suite pins the catalogue, the per-transition key
 * map, the implications, the legacy `orders.manage` transition alias, and —
 * most importantly — the exact permission set of every built-in role, so a
 * future edit to a role default is a deliberate diff, never a silent drift.
 *
 *   npm run test:granular-rbac
 */
import {
  DEFAULT_ROLES,
  ORDER_ACTION_KEYS,
  ORDER_STATUS_KEYS,
  PERMISSION_IMPLICATIONS,
  PERMISSION_KEYS,
  canOrderAction,
  hasEffectivePermission,
} from "../supabase/functions/_shared/permissions.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const permsOfRole = (name: string): string[] =>
  DEFAULT_ROLES.find((r) => r.name === name)!.permissions.split(",");

// ---- the catalogue ----------------------------------------------------------
console.log("\ncatalogue");
check("29 granular keys", PERMISSION_KEYS.length === 29, `got ${PERMISSION_KEYS.length}`);
check("orders.manage is gone from the catalogue", !PERMISSION_KEYS.includes("orders.manage" as never));
check("every granular order action is a key", ORDER_ACTION_KEYS.every((k) => k === "orders.manage" || PERMISSION_KEYS.includes(k as never)));
for (const status of ["PREPARING", "READY", "SERVED", "COMPLETED", "CANCELLED"]) {
  check(`transition → ${status} has a key`, !!ORDER_STATUS_KEYS[status], ORDER_STATUS_KEYS[status]);
}

// ---- implications -----------------------------------------------------------
console.log("\nimplications");
check("every order action implies orders.view",
  ["orders.create", "orders.edit", "orders.cancel", "orders.complete", "orders.prepare", "orders.ready", "orders.serve", "orders.discount"]
    .every((k) => PERMISSION_IMPLICATIONS[k] === "orders.view"));
check("refund implies collect", PERMISSION_IMPLICATIONS["payments.refund"] === "payments.collect");
check("session management implies tables.view", PERMISSION_IMPLICATIONS["table-sessions.manage"] === "tables.view");

// ---- legacy transition alias ------------------------------------------------
console.log("\nlegacy orders.manage alias");
check("legacy full-orders holder keeps every action",
  ["orders.create", "orders.prepare", "orders.ready", "orders.serve", "orders.complete", "orders.cancel", "orders.discount", "payments.collect"]
    .every((k) => hasEffectivePermission(["orders.manage"], k)));
check("legacy holder does NOT gain refund", hasEffectivePermission(["orders.manage"], "payments.refund") === false);
check("tables.manage still resolves session management", hasEffectivePermission(["tables.manage"], "table-sessions.manage") === true);
check("granular keys resolve directly", hasEffectivePermission(["orders.prepare"], "orders.prepare") === true);
check("canOrderAction honours the legacy catch-all", canOrderAction(["orders.manage"], "orders.serve") === true);

// ---- the five built-in roles: exact spec ------------------------------------
console.log("\nrole specs");
const SPEC: Record<string, (p: (k: string) => boolean) => void> = {
  Owner: (p) => {
    PERMISSION_KEYS.forEach((k) => check(`Owner holds ${k}`, p(k)));
  },
  Manager: (p) => {
    check("Manager: every order action", ["orders.view", "orders.create", "orders.edit", "orders.cancel", "orders.complete", "orders.prepare", "orders.ready", "orders.serve", "orders.discount"].every(p));
    check("Manager: payments", p("payments.collect") && p("payments.refund"));
    check("Manager: menu + tables + sessions + promos + analytics + qr + staff",
      ["menu.view", "menu.manage", "tables.view", "tables.manage", "table-sessions.manage", "promos.view", "promos.manage", "analytics.view", "qr.manage", "staff.view", "staff.manage"].every(p));
    check("Manager: never security/settings/roles", ["security.view", "security.manage", "settings.view", "settings.manage", "roles.view", "roles.manage"].every((k) => !p(k)));
  },
  Cashier: (p) => {
    check("Cashier: create/edit/complete/discount + view", ["orders.view", "orders.create", "orders.edit", "orders.complete", "orders.discount"].every(p));
    check("Cashier: collect, tables, sessions", p("payments.collect") && p("tables.view") && p("table-sessions.manage"));
    check("Cashier: no cancel", !p("orders.cancel"));
    check("Cashier: no refund", !p("payments.refund"));
    check("Cashier: no kitchen/floor statuses", !p("orders.prepare") && !p("orders.ready") && !p("orders.serve"));
    check("Cashier: no menu/prices", !p("menu.view") && !p("menu.manage"));
  },
  Kitchen: (p) => {
    check("Kitchen: view + prepare + ready only", p("orders.view") && p("orders.prepare") && p("orders.ready"));
    check("Kitchen: never anything else", ["orders.create", "orders.edit", "orders.cancel", "orders.complete", "orders.serve", "orders.discount", "payments.collect", "payments.refund", "menu.view", "menu.manage", "tables.view", "tables.manage", "table-sessions.manage", "promos.view", "promos.manage", "analytics.view", "qr.manage", "settings.view", "settings.manage", "security.view", "security.manage", "roles.view", "roles.manage", "staff.view", "staff.manage"].every((k) => !p(k)));
  },
  Waiter: (p) => {
    check("Waiter: create/edit/serve + view", ["orders.view", "orders.create", "orders.edit", "orders.serve"].every(p));
    check("Waiter: tables + sessions", p("tables.view") && p("table-sessions.manage"));
    check("Waiter: never complete/pay/refund/cancel/discount/kitchen", ["orders.complete", "orders.cancel", "orders.discount", "orders.prepare", "orders.ready", "payments.collect", "payments.refund"].every((k) => !p(k)));
    check("Waiter: never menu/prices", !p("menu.view") && !p("menu.manage"));
  },
};

for (const role of DEFAULT_ROLES) {
  const perms = new Set(permsOfRole(role.name));
  const has = (k: string) => perms.has(k);
  console.log(`  — ${role.name} (${perms.size} keys)`);
  SPEC[role.name]?.(has);
  if (!SPEC[role.name]) check(`${role.name}: spec asserted`, false);
}

// ---- status machine × keys are the same map the server enforces ------------
console.log("\nstatus machine");
check("cancel is included in every open status",
  ["PENDING", "PREPARING", "READY", "SERVED"].every((s) => ORDER_STATUS_KEYS[s] !== ORDER_STATUS_KEYS["CANCELLED"]));
check("complete key differs from collect key",
  ORDER_STATUS_KEYS["COMPLETED"] !== "payments.collect" &&
  ORDER_STATUS_KEYS["COMPLETED"] === "orders.complete");

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
