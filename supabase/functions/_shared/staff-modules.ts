/**
 * Which dashboard modules a staff role may open.
 *
 * One answer per module, decided the same way the client's VIEW_PERMISSIONS
 * (src/lib/permissions.ts) decides it: the role is offered a module iff it
 * holds the key the module's screens and data endpoints actually require.
 *
 * The rule that keeps the two sides honest: a module must never be granted on
 * a *wider* OR of neighbouring keys than the screen can serve. That drift is
 * how a Cashier got a "Tables & QR" module that answered 403 on every load —
 * the module was offered on `tables.view`, while the screen and `/api/qr`
 * both demand `qr.manage`.
 *
 * The one deliberate exception is `roles`: that screen handles partial
 * permission sets internally (a Manager with `staff.view` but not
 * `roles.view` lands on a working staff tab), so its gate keeps the OR.
 */
export function staffModules(
  permissions: string[],
  isOwner = false,
): Record<string, boolean> {
  const has = (p: string) => isOwner || permissions.includes(p);
  return {
    // The POS is the table-and-order screen. It takes `dashboard.view` (may
    // use the dashboard at all) *and* `tables.view` (the screen's data), the
    // same mapping the dashboard shell uses. Without the tables half a
    // Kitchen login (which holds only `dashboard.view` + orders) would land
    // on the till, with payment controls, which is not what that role is
    // for: the kitchen gets the order queue and nothing to take money with.
    // And without the dashboard half, `dashboard.view` would be a checkbox
    // that means nothing — it is a real half of the gate.
    dashboard: has("dashboard.view") && has("tables.view"),
    orders: has("orders.view"),
    analytics: has("analytics.view"),
    menu: has("menu.view"),
    qr: has("qr.manage"),
    promos: has("promos.view"),
    roles:
      has("roles.view") ||
      has("roles.manage") ||
      has("staff.view") ||
      has("staff.manage"),
    security: has("security.view"),
    settings: has("settings.view"),
  };
}
