// Re-exported for server routes, which have historically imported these from
// `@/lib/tenant`. Client components must import from `@/lib/constants` instead.
//
// Tenant resolution no longer lives here. Dashboard routes must call
// `guard()` from `@/lib/session`; genuinely public routes resolve an explicit
// tenant through `publicTenantId()` from the same module. The old
// `getTenantId()` helper — whose "oldest tenant" fallback let anonymous callers
// read the first restaurant in the database — has been removed.
export {
  formatCurrency,
  timeAgo,
  json,
  ORDER_STATUS,
  ORDER_TYPE,
  PERMISSION_KEYS,
  PERMISSION_GROUPS,
} from './constants'
