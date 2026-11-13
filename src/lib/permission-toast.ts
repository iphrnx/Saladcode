'use client'

import { toast } from 'sonner'

/**
 * One "Access Denied" toast per refused action.
 *
 * The server's 403 is the truth, and the global 403 listener in edge.ts calls
 * in here. A single refused click must produce exactly one toast — the same
 * request is observed once, but a burst of parallel requests for one action
 * (a screen firing several) or a double-click must not stack them. Keyed by
 * method + path and de-duplicated for a few seconds.
 */

const DEDUP_MS = 4_000
const lastShown = new Map<string, number>()

/** A human verb for the path, so the message names the action where it can. */
function actionFor(method: string, pathname: string): string {
  const p = pathname.replace(/^\/functions\/v1/, '').replace(/^\/api/, '')
  const verb = method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : method === 'PATCH' || method === 'PUT' ? 'update' : 'use'
  const segment = p.split('/').filter(Boolean)[0] || 'this'
  const nouns: Record<string, string> = {
    orders: 'this order',
    menu: 'this menu item',
    tables: 'this table',
    promos: 'this promo code',
    reservations: 'this reservation',
    staff: 'this staff account',
    roles: 'this role',
    settings: 'these settings',
    security: 'this security setting',
    subscriptions: 'your subscription',
    'table-session': 'this table session',
    qr: 'these QR codes',
    analytics: 'these analytics',
    categories: 'this category',
    reviews: 'this review',
    bill: 'this bill',
    onboarding: 'this onboarding step',
    tenants: 'this restaurant',
  }
  const noun = nouns[segment] ?? 'this action'
  return `You don't have permission to ${verb} ${noun}.`
}

/**
 * Report a refused action, once.
 *
 * `method` and `pathname` form the dedup key; a repeat within the window is
 * silently dropped. Returns true when a toast was shown.
 */
export function notifyAccessDenied(method: string, pathname: string): boolean {
  const key = `${method} ${pathname}`
  const now = Date.now()
  const last = lastShown.get(key)
  if (last !== undefined && now - last < DEDUP_MS) return false
  lastShown.set(key, now)
  toast.error('Access Denied — You don\'t have permission to perform this action.', {
    description: actionFor(method, pathname),
  })
  return true
}
