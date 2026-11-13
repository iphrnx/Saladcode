/**
 * Where the browser keeps things, and how the old names are handled.
 *
 * The product was renamed, so the keys carry the new name — that is what a
 * visitor sees in the Cookie Policy and in their browser's storage viewer.
 *
 * The values did not move on their own, though: a rename that signs a staff
 * member out, forgets someone's theme, or empties a diner's cart is not a
 * rename, it is an outage. So every read looks in the new place first, then in
 * the old one, and moves the value across as it finds it. That happens once,
 * on the next visit that touches that key; after that the old name is gone.
 *
 * `remove` clears both, so a value removed in the new name cannot be brought
 * back by a stale one left under the old name.
 */

type Area = 'local' | 'session'

export const KEYS = {
  theme: { now: 'the-salad-theme', was: ['toastly-theme', 'tablo-theme'], area: 'local' },
  menuTheme: { now: 'the-salad-menu-theme', was: ['toastly-menu-theme', 'tablo-menu-theme'], area: 'local' },
  onboarding: { now: 'the-salad-onboarding', was: ['toastly-onboarding', 'tablo-onboarding'], area: 'local' },
  /** The diner's cart for one table session: the session token is the suffix. */
  cart: { now: 'the-salad-cart-session-', was: ['toastly-cart-session-', 'public-cart-session-'], area: 'local' },
  /** The POS cart: the suffix is <tenantId>-<userId>. */
  posCart: { now: 'the-salad-pos-cart-', was: ['toastly-pos-cart-', 'swixo-pos-cart-'], area: 'local' },
  /** Pending checkout queue: the suffix is <tenantId>-<actorId>. */
  orderQueue: { now: 'the-salad-order-queue-', was: ['toastly-order-queue-', 'swixo-order-queue-'], area: 'local' },
  dinerSession: { now: 'the-salad-diner-session', was: ['toastly-diner-session', 'swixo-diner-session'], area: 'session' },
  staffToken: { now: 'the-salad-staff-token', was: ['toastly-staff-token', 'swixo-staff-token'], area: 'session' },
  lastOrderId: { now: 'the_salad_last_order_id', was: ['toastly_last_order_id', 'swixo_last_order_id'], area: 'session' },
  notificationsSeen: {
    now: 'the-salad-notifications-seen',
    was: ['toastly-notifications-seen', 'swixo-notifications-seen'],
    area: 'local',
  },
  notificationsCleared: {
    now: 'the-salad-notifications-cleared',
    was: [],
    area: 'local',
  },
} as const satisfies Record<string, { now: string; was: readonly string[]; area: Area }>

export type KeyName = keyof typeof KEYS

/** The name in use. */
export function keyName(name: KeyName, suffix = ''): string {
  return KEYS[name].now + suffix
}

/** The immediate previous name it had before the latest rename. */
export function legacyKeyName(name: KeyName, suffix = ''): string {
  return KEYS[name].was[0] + suffix
}

/** All prior names it has had, most recent first. */
export function legacyKeyNames(name: KeyName, suffix = ''): string[] {
  return KEYS[name].was.map((prefix) => prefix + suffix)
}

function area(name: KeyName): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return KEYS[name].area === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    // Storage can be blocked outright — private modes, embedded webviews.
    return null
  }
}

/** Read a value, carrying it across from any old name the first time. */
export function readStored(name: KeyName, suffix = ''): string | null {
  const store = area(name)
  if (!store) return null
  try {
    const current = store.getItem(keyName(name, suffix))
    if (current !== null) return current

    for (const legacy of legacyKeyNames(name, suffix)) {
      const previous = store.getItem(legacy)
      if (previous === null) continue
      // Move it, so this only ever happens once for a given browser.
      store.setItem(keyName(name, suffix), previous)
      for (const k of legacyKeyNames(name, suffix)) store.removeItem(k)
      return previous
    }
    return null
  } catch {
    return null
  }
}

export function writeStored(name: KeyName, value: string, suffix = ''): void {
  const store = area(name)
  if (!store) return
  try {
    store.setItem(keyName(name, suffix), value)
    // The new name is the truth from here on.
    for (const legacy of legacyKeyNames(name, suffix)) {
      store.removeItem(legacy)
    }
  } catch {
    /* storage blocked — the value simply does not persist */
  }
}

export function removeStored(name: KeyName, suffix = ''): void {
  const store = area(name)
  if (!store) return
  try {
    store.removeItem(keyName(name, suffix))
    for (const legacy of legacyKeyNames(name, suffix)) {
      store.removeItem(legacy)
    }
  } catch {
    /* nothing to clear */
  }
}
