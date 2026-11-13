/**
 * The permission catalogue — one source.
 *
 * The client re-exports these (src/lib/constants.ts) and the roles function
 * imports the groups from here, so a key that only exists in one copy can no
 * longer drift in silently. This used to be mirrored in three places that were
 * only "kept in sync" by comments.
 */
export const PERMISSION_KEYS = [
  "dashboard.view",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.cancel",
  "orders.complete",
  "orders.prepare",
  "orders.ready",
  "orders.serve",
  "orders.discount",
  "payments.collect",
  "payments.refund",
  "menu.view", "menu.manage",
  "tables.view", "tables.manage",
  "table-sessions.manage",
  "promos.view", "promos.manage",
  "analytics.view",
  "qr.manage",
  "settings.view", "settings.manage",
  "security.view", "security.manage",
  "roles.view", "roles.manage",
  "staff.view", "staff.manage",
] as const;

/**
 * How the matrix groups the keys, and how the page labels each section.
 */
export const PERMISSION_GROUPS: ReadonlyArray<{
  label: string;
  perms: readonly string[];
}> = [
  { label: "Dashboard", perms: ["dashboard.view"] },
  {
    label: "Orders",
    perms: [
      "orders.view", "orders.create", "orders.edit", "orders.cancel",
      "orders.complete", "orders.prepare", "orders.ready", "orders.serve",
      "orders.discount",
    ],
  },
  {
    label: "Payments",
    perms: ["payments.collect", "payments.refund"],
  },
  { label: "Menu", perms: ["menu.view", "menu.manage"] },
  {
    label: "Tables & QR",
    perms: ["tables.view", "tables.manage", "table-sessions.manage", "qr.manage"],
  },
  { label: "Promo Codes", perms: ["promos.view", "promos.manage"] },
  { label: "Analytics", perms: ["analytics.view"] },
  { label: "Settings", perms: ["settings.view", "settings.manage"] },
  { label: "Security", perms: ["security.view", "security.manage"] },
  {
    label: "Roles & Staff",
    perms: ["roles.view", "roles.manage", "staff.view", "staff.manage"],
  },
];

/**
 * `.manage` implies its `.view`.
 *
 * A role that may write orders may obviously read them — the read half of a
 * key is the smaller grant. This is applied when a session's permission list
 * is built AND when the matrix renders checkmarks, so the two can never
 * disagree: a `settings.manage`-only role shows "Settings 2/2" and actually
 * opens the Settings module, because the server and the page read the same
 * expanded list.
 */
export const PERMISSION_IMPLICATIONS: Readonly<Record<string, string>> = {
  "orders.create": "orders.view",
  "orders.edit": "orders.view",
  "orders.cancel": "orders.view",
  "orders.complete": "orders.view",
  "orders.prepare": "orders.view",
  "orders.ready": "orders.view",
  "orders.serve": "orders.view",
  "orders.discount": "orders.view",
  "payments.refund": "payments.collect",
  "table-sessions.manage": "tables.view",
  "menu.manage": "menu.view",
  "tables.manage": "tables.view",
  "promos.manage": "promos.view",
  "settings.manage": "settings.view",
  "security.manage": "security.view",
  "roles.manage": "roles.view",
  "staff.manage": "staff.view",
};

/**
 * The legacy `orders.manage` (pre-granular) covered every order action. It
 * lives on until the granular migration converts existing roles, so a role
 * that still holds it keeps exactly what it had. Remove once migrated.
 */
export const LEGACY_ORDER_MANAGE = "orders.manage";

/** Every granular order action (and the legacy catch-all). */
export const ORDER_ACTION_KEYS: readonly string[] = [
  "orders.view", "orders.create", "orders.edit", "orders.cancel",
  "orders.complete", "orders.prepare", "orders.ready", "orders.serve",
  "orders.discount", LEGACY_ORDER_MANAGE,
];

/** The key that unlocks each order status transition. */
export const ORDER_STATUS_KEYS: Readonly<Record<string, string>> = {
  PREPARING: "orders.prepare",
  READY: "orders.ready",
  SERVED: "orders.serve",
  COMPLETED: "orders.complete",
  CANCELLED: "orders.cancel",
};

/** Whether a session holds one granular order action (or the legacy catch-all). */
export function canOrderAction(permissions: readonly string[], action: string): boolean {
  return permissions.includes(action) || permissions.includes(LEGACY_ORDER_MANAGE);
}

/**
 * Whether a list resolves a permission, honouring the legacy transition
 * aliases:
 *
 *   * `orders.manage` still resolves every granular order action AND
 *     `payments.collect` — a pre-granular role keeps exactly what it had until
 *     the migration converts it (nothing is accidentally revoked mid-flight);
 *   * `tables.manage` still resolves `table-sessions.manage` — ending a
 *     session used to live under table management.
 *
 * Remove the aliases once the granular migration has run everywhere.
 */
export function hasEffectivePermission(permissions: readonly string[], permission: string): boolean {
  if (permissions.includes(permission)) return true;
  const hasLegacyOrders = permissions.includes(LEGACY_ORDER_MANAGE);
  if (hasLegacyOrders && (ORDER_ACTION_KEYS.includes(permission) || permission === "payments.collect")) {
    return true;
  }
  if (permission === "table-sessions.manage" && permissions.includes("tables.manage")) {
    return true;
  }
  return false;
}

/**
 * Names reserved for the built-in roles — a custom role may not be created or
 * renamed onto one, so a limited role never wears a system role's name.
 */
export const RESERVED_ROLE_NAMES = ["Owner", "Manager", "Cashier", "Kitchen", "Waiter"] as const;

/** The effective permission set of a stored list: every held key plus the
 * `.view` each `.manage` implies, deduplicated. */
export function expandPermissions(permissions: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of permissions) {
    out.add(p);
    const implied = PERMISSION_IMPLICATIONS[p];
    if (implied) out.add(implied);
  }
  return [...out];
}

/**
 * What each built-in role starts with.
 *
 * One definition, imported by both routes that create a restaurant
 * (registration and onboarding). It used to be written out in both files, which
 * is a standing invitation for them to drift — a new restaurant would then get
 * one set of permissions or the other depending on which route happened to
 * create it.
 *
 * Two rules this encodes, both of which the old defaults got wrong:
 *
 *  - `dashboard.view` is on every role. It means "may use the dashboard at
 *    all"; it is not a grant of any particular screen. It was missing from
 *    Cashier, Kitchen and Waiter, so those roles could not load the app.
 *  - A module needs its own permission. Dashboard access grants nothing else:
 *    the screens each require the key for what they show. The POS/table screen
 *    needs `tables.view`, which is why Kitchen — a queue, not a till — does not
 *    have it and lands on Orders instead.
 */
export const DEFAULT_ROLES: Array<{
  name: string;
  description: string;
  permissions: string;
  is_system: boolean;
  color: string;
}> = [
  {
    name: "Owner",
    description: "Full access to everything",
    permissions: [...PERMISSION_KEYS].join(","),
    is_system: true,
    color: "#ff7e6b",
  },
  {
    name: "Manager",
    description: "Runs the floor and the team",
    // Everything operational — every order action, payments and refunds, menu,
    // tables, table sessions, promos, analytics, QR — plus staff management.
    // No billing, no roles, no account-level settings, no security module —
    // those stay the owner's.
    permissions: [
      "dashboard.view",
      "orders.view", "orders.create", "orders.edit", "orders.cancel",
      "orders.complete", "orders.prepare", "orders.ready", "orders.serve",
      "orders.discount",
      "payments.collect", "payments.refund",
      "menu.view", "menu.manage",
      "tables.view", "tables.manage",
      "table-sessions.manage",
      "promos.view", "promos.manage",
      "analytics.view",
      "qr.manage",
      "staff.view", "staff.manage",
    ].join(","),
    is_system: true,
    color: "#60a5fa",
  },
  {
    name: "Cashier",
    description: "Takes payment and closes tables",
    // Create and edit orders, collect payments, complete orders, apply
    // authorised discounts and manage table sessions. Deliberately NOT: cancel
    // orders, refund payments, advance kitchen/floor statuses, or touch the
    // menu or prices.
    permissions: [
      "dashboard.view",
      "orders.view", "orders.create", "orders.edit", "orders.complete",
      "orders.discount",
      "payments.collect",
      "tables.view",
      "table-sessions.manage",
    ].join(","),
    is_system: true,
    color: "#fbbf24",
  },
  {
    name: "Kitchen",
    description: "Sees and advances the order queue",
    // The queue, and exactly two buttons on it: mark Preparing and mark Ready.
    // No way to complete or cancel an order, no payments, no tables, no menu,
    // no staff or settings.
    permissions: [
      "dashboard.view",
      "orders.view", "orders.prepare", "orders.ready",
    ].join(","),
    is_system: true,
    color: "#c084fc",
  },
  {
    name: "Waiter",
    description: "Takes and serves orders at the tables",
    // The floor: create and edit orders, mark them Served, and manage table
    // sessions. Deliberately NOT: complete orders, collect payments, cancel,
    // discount, refund, or edit prices.
    permissions: [
      "dashboard.view",
      "orders.view", "orders.create", "orders.edit", "orders.serve",
      "tables.view",
      "table-sessions.manage",
    ].join(","),
    is_system: true,
    color: "#4ade80",
  },
];
