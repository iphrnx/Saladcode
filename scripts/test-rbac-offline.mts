/**
 * The permission rules, without a server.
 *
 * Three things are decided in code rather than by the database, and each of
 * them can be wrong in a way that no API test would notice:
 *
 *   * which view needs which permission (`VIEW_PERMISSIONS`),
 *   * what "no permission list" means (`hasPermission`'s owner rule),
 *   * what a failure is called when it reaches the screen (`apiError`).
 *
 * The last one matters most: a 403 that reads "Failed to load QR codes" is the
 * bug this whole change exists to remove, and it is a pure function, so it can
 * be pinned exactly.
 *
 *   npm run test:rbac-offline
 */
import { VIEW_PERMISSIONS, VIEW_ORDER, canView, hasPermission, firstAllowedView, canGrantRole, reservedRoleName } from "../src/lib/permissions.ts";
import { PERMISSION_KEYS, PERMISSION_GROUPS, expandPermissions } from "../src/lib/constants.ts";
import { apiError, asActionFailure, describeFailure, describeRequiredActions, isPermissionFailure, isAuthFailure } from "../src/lib/api-error.ts";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail && !ok ? `\n        ${detail}` : ""}`);
};

const res = (status: number, body?: unknown) =>
  new Response(body === undefined ? "" : JSON.stringify(body), { status });

// ---- the view map ----------------------------------------------------------
console.log("\nview → permission");
for (const view of VIEW_ORDER) {
  const needed = VIEW_PERMISSIONS[view];
  check(`${view} names real permission(s) (${needed.join(", ")})`,
    Array.isArray(needed) && needed.length > 0 && needed.every((p) => PERMISSION_KEYS.includes(p as any)));
}
check("every view in VIEW_ORDER has an entry", VIEW_ORDER.every((v) => v in VIEW_PERMISSIONS));
check(
  "no view is gated on a permission that no role can hold",
  Object.values(VIEW_PERMISSIONS).every((p) => Array.isArray(p) && p.length > 0 && p.every((k) => PERMISSION_KEYS.includes(k as any))),
);

// ---- the dashboard gate is compound ----------------------------------------
console.log("\ndashboard gate");
check("the POS needs dashboard.view AND tables.view",
  canView(["dashboard.view", "tables.view"], "dashboard") === true);
check("tables.view alone does not open the POS",
  canView(["tables.view"], "dashboard") === false);
check("dashboard.view alone does not open the POS",
  canView(["dashboard.view", "orders.view"], "dashboard") === false);
check("the owner opens the POS (empty/absent list is the owner)",
  canView(undefined, "dashboard") === true && canView([], "dashboard") === true);

// ---- .manage implies its .view ---------------------------------------------
console.log("\npermission implications");
check("settings.manage implies settings.view", expandPermissions(["settings.manage"]).includes("settings.view"));
check("a manage key implies only its view, nothing else",
  expandPermissions(["menu.manage"]).sort().join(",") === "menu.manage,menu.view");
check("an order action implies exactly orders.view",
  expandPermissions(["orders.cancel"]).sort().join(",") === "orders.cancel,orders.view");
check("implied views survive alongside explicit ones", expandPermissions(["menu.view", "menu.manage"]).sort().join(",") === "menu.manage,menu.view");
check("every group is covered by the catalogue",
  PERMISSION_GROUPS.every((g) => g.perms.length > 0 && g.perms.every((p) => PERMISSION_KEYS.includes(p as any))));

// ---- assignable roles ------------------------------------------------------
console.log("\ncanGrantRole");
check("an owner may grant any role", canGrantRole(["settings.manage"], undefined) === true);
check("a manager may grant a role it fully holds", canGrantRole(["orders.view", "orders.manage", "menu.view"], ["orders.view", "orders.manage", "menu.view", "menu.manage"]) === true);
check("a manager may not grant a role holding more than it", canGrantRole(["security.manage"], ["orders.view", "orders.manage", "menu.view", "menu.manage"]) === false);
check("a caller holding .manage may grant .view of the same key", canGrantRole(["settings.view"], ["settings.manage", "security.view"]) === true);

// ---- reserved role names ----------------------------------------------------
console.log("\nreserved role names");
check("Owner is reserved", reservedRoleName("Owner") === "Owner");
check("case-insensitive", reservedRoleName("manager") === "Manager");
check("irrelevant names pass", reservedRoleName("Server") === null && reservedRoleName("") === null);

// ---- hasPermission ---------------------------------------------------------
console.log("\nhasPermission");
check("a held permission is held", hasPermission(["menu.view"], "menu.view") === true);
check("an unheld permission is not held", hasPermission(["menu.view"], "menu.manage") === false);
check("an empty list means the owner", hasPermission([], "settings.manage") === true);
check("an absent list means the owner", hasPermission(undefined, "settings.manage") === true);

// ---- canView ---------------------------------------------------------------
console.log("\ncanView");
check("a role without the key cannot open the view", canView(["orders.view"], "menu") === false);
check("a role with the key can open the view", canView(["menu.view"], "menu") === true);
check("an owner can open every view", VIEW_ORDER.every((v) => canView(undefined, v)));
check("a role with only orders.view opens only orders",
  VIEW_ORDER.filter((v) => canView(["orders.view"], v)).join(",") === "orders");

// ---- failures are classified, not guessed ----------------------------------
console.log("\nfailure classification");
const forbidden = await apiError(res(403, { error: "Forbidden", required: "menu.manage" }), "the menu");
check("403 is a permission failure", isPermissionFailure(forbidden));
check("403 does not leak the word Forbidden", !/forbidden/i.test(forbidden.message), forbidden.message);
check("403 names the action in plain English", forbidden.message === "You do not have permission to manage the menu.", forbidden.message);
check("403 keeps the permission for the UI", forbidden.required?.includes("menu.manage") === true);

const unauth = await apiError(res(401, { error: "Unauthorized" }), "your restaurant");
check("401 is an auth failure", isAuthFailure(unauth));
check("401 does not leak the word Unauthorized", !/unauthorized/i.test(unauth.message), unauth.message);
check("401 asks for a sign-in", unauth.message === "Your session has expired. Please sign in again.", unauth.message);

const server = await apiError(res(500, { error: "relation does not exist" }), "QR codes");
check("500 is neither a permission nor an auth failure", !isPermissionFailure(server) && !isAuthFailure(server));
check("500 does not leak the database error", !/relation does not exist/.test(server.message), server.message);
check("500 reads as a load failure", server.message === "Something went wrong on our side while loading QR codes. Please try again.", server.message);
check("500 on a save reads as a save failure",
  asActionFailure(server, "QR codes").message === "Something went wrong on our side and your change to QR codes was not saved. Please try again.",
  asActionFailure(server, "QR codes").message);

const net = describeFailure(new TypeError("Failed to fetch"), "orders");
check("a dropped connection is named as one", /could not reach the server/i.test(net.message), net.message);

const notFound = await apiError(res(404, { error: "Not found" }), "the order");
check("404 is not reported as a permission problem", !isPermissionFailure(notFound));

const conflict = await apiError(res(409, { error: "This role still has 3 members" }), "the role");
check("409 keeps the server's own sentence", /still has 3 members/.test(conflict.message), conflict.message);

// ---- the action phrasing ---------------------------------------------------
console.log("\nphrasing");
check("one permission reads as a verb phrase", describeRequiredActions(["menu.manage"]) === "manage the menu");
check("two permissions read as alternatives", describeRequiredActions(["menu.manage", "roles.manage"]) === "manage the menu or manage roles");
check("no gerunds slip in", !/managing|viewing|editing/.test(describeRequiredActions(PERMISSION_KEYS as unknown as string[])));

// ---- the landing rule ------------------------------------------------------
console.log("\nfirstAllowedView");
check("a Kitchen-shaped role lands on orders", firstAllowedView(["dashboard.view", "orders.view"]) === "orders");
check("a till-shaped role lands on the POS", firstAllowedView(["dashboard.view", "orders.view", "tables.view"]) === "dashboard");
check("an owner lands on the dashboard", firstAllowedView(undefined) === "dashboard");

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ` — ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
