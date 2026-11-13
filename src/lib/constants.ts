/**
 * Environment-agnostic constants and formatters.
 *
 * Deliberately free of any server-only import so that client components can
 * use them. `@/lib/tenant` re-exports these, but client components must
 * import from HERE — pulling in `@/lib/tenant` would drag `next/headers`
 * into the browser bundle and break the build.
 */

export function formatCurrency(amount: number, symbol = '₹'): string {
  return `${symbol}${amount.toFixed(2)}`
}

export function timeAgo(date: Date | string | undefined | null): string | null {
  if (!date) return null
  const d = new Date(date)
  const time = d.getTime()
  if (isNaN(time)) return null
  const diff = Date.now() - time
  if (isNaN(diff)) return null
  if (diff < 0 && diff > -60000) return 'just now'
  if (diff < 0) return null
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const ORDER_STATUS = {
  PENDING: { label: 'Pending', color: '#d97706', step: 0 },
  PREPARING: { label: 'Preparing', color: '#2563eb', step: 1 },
  READY: { label: 'Ready', color: '#16a34a', step: 2 },
  SERVED: { label: 'Served', color: '#059669', step: 3 },
  COMPLETED: { label: 'Completed', color: '#64748b', step: 4 },
  CANCELLED: { label: 'Cancelled', color: '#ef4444', step: -1 },
} as const

export const ORDER_TYPE = {
  DINE_IN: { label: 'Dine In', icon: '🍽️' },
  TAKEAWAY: { label: 'Takeaway', icon: '🥡' },
  DELIVERY: { label: 'Delivery', icon: '🛵' },
} as const

// The permission catalogue is defined once, in the edge functions' shared
// module, and re-exported here so the browser bundle and the server can never
// drift apart. (The same pattern as src/lib/menu-theme.ts.)
export {
  PERMISSION_KEYS,
  PERMISSION_GROUPS,
  PERMISSION_IMPLICATIONS,
  RESERVED_ROLE_NAMES,
  ORDER_STATUS_KEYS,
  expandPermissions,
  hasEffectivePermission,
  canOrderAction,
} from '../../supabase/functions/_shared/permissions'
