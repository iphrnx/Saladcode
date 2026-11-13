# The Salad: Prisma → Supabase migration guide

Read this before touching any file. The data layer has been replaced.
**`@/lib/db` no longer exists.** There is no Prisma at runtime.

## Clients

```ts
// Privileged, bypasses RLS. Server-only. Use in almost every API route.
import { supabaseAdmin } from '@/lib/supabase/admin'
const admin = supabaseAdmin()

// Acts as the signed-in owner (RLS applies). Use only when you specifically
// want the caller's own permissions enforced.
import { createClient } from '@/lib/supabase/server'
const supabase = await createClient()

// Browser client. Only in 'use client' files.
import { createClient } from '@/lib/supabase/client'
```

## Table names (Prisma → Postgres)

| Prisma | Postgres |
|---|---|
| `db.tenant` | `tenants` |
| `db.user` | `profiles` |
| `db.role` | `roles` |
| `db.category` | `categories` |
| `db.menuItem` | `menu_items` |
| `db.table` | `tables` |
| `db.tableSession` | `table_sessions` |
| `db.order` | `orders` |
| `db.orderItem` | `order_items` |
| `db.reservation` | `reservations` |
| `db.promoCode` | `promo_codes` |
| `db.setting` | `settings` |
| `db.securityLog` | `security_logs` |
| `db.session` | `user_sessions` |
| `db.staff` | `staff` |
| `db.staffSession` | `staff_sessions` |
| `db.staffActivity` | `staff_activities` |
| `db.googleConnection` | `google_connections` |
| `db.googleReview` | `google_reviews` |

## Column names are snake_case

Every field is snake_case in the database. `tenantId`→`tenant_id`,
`createdAt`→`created_at`, `updatedAt`→`updated_at`, `orderNumber`→`order_number`,
`orderType`→`order_type`, `itemsTotal`→`items_total`, `qrToken`→`qr_token`,
`currencySymbol`→`currency_symbol`, `taxRate`→`tax_rate`,
`serviceCharge`→`service_charge`, `paymentMethod`→`payment_method`,
`paymentStatus`→`payment_status`, `menuItemId`→`menu_item_id`,
`categoryId`→`category_id`, `prepTime`→`prep_time`, `sortOrder`→`sort_order`,
`employeeId`→`employee_id`, `pinHash`→`pin_hash`, `pinSalt`→`pin_salt`,
`failedAttempts`→`failed_attempts`, `lockedUntil`→`locked_until`,
`lastLogin`→`last_login`, `roleId`→`role_id`, `isSystem`→`is_system`,
`minOrder`→`min_order`, `maxDiscount`→`max_discount`, `usageLimit`→`usage_limit`,
`usedCount`→`used_count`, `validFrom`→`valid_from`, `validTo`→`valid_to`,
`partySize`→`party_size`, `sessionId`→`table_session_id` (on orders),
`servedById`→`served_by_id`, `completedAt`→`completed_at`, `deviceFp`→`device_fp`,
`endedAt`→`ended_at`, `lastActive`→`last_active`, `userAgent`→`user_agent`,
`twoFactorEnabled`→`two_factor_enabled`, `promoCodeId`→`promo_code_id`,
`promoCode`→`promo_code`, `customerName`→`customer_name`,
`customerPhone`→`customer_phone`. Google columns follow the same rule
(`accessToken`→`access_token`, `syncIntervalMins`→`sync_interval_mins`, …).

## Common translations

```ts
// findMany
const { data, error } = await admin.from('menu_items').select('*')
  .eq('tenant_id', tenantId).order('sort_order')

// findFirst / findUnique
const { data } = await admin.from('tables').select('*').eq('id', id).maybeSingle()

// create  (uuid + timestamps are DB defaults — do not invent ids)
const { data, error } = await admin.from('categories')
  .insert({ tenant_id: tenantId, name, icon }).select().single()

// update
const { data, error } = await admin.from('orders')
  .update({ status: 'READY' }).eq('id', id).select().single()

// delete
await admin.from('promo_codes').delete().eq('id', id)

// include: { role: true }  ->  embedded select
const { data } = await admin.from('staff')
  .select('*, role:roles(*)').eq('tenant_id', tenantId)

// count
const { count } = await admin.from('orders')
  .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
```

## Rules

1. **Always check `error`.** Supabase resolves with `{ data, error }` instead of
   throwing. Return `json({ error: error.message }, 500)` when it is set.
2. **Never invent primary keys or timestamps.** `id`, `created_at`, `updated_at`
   are filled by the database.
3. **Use `?`-safe filters.** Values are escaped by the client — never build
   `.or()` strings from raw user input. For two-column lookups prefer two
   sequential queries over interpolation.
4. **Money is `double precision`** and arrives as a JSON number. Do not wrap it
   in `Number()`-parsing guards that assume strings.
5. **Keep the existing response shape** exactly. The frontend was written
   against it: camelCase JSON keys in responses, same field names, same HTTP
   status codes, same error message strings.
6. **Do not change business logic.** This is a data-layer swap plus the
   explicitly-noted auth/security fixes. No new product features.
7. **Preserve `export const runtime`/`dynamic` declarations** if present.
8. TypeScript: `npx tsc --noEmit` must not report errors **in the files you
   touched**. Other groups' files may still be mid-migration.

## Security fixes applied

- Owner identity now comes from Supabase Auth (`auth.users`), not a
  base64 cookie. `profiles.id` == `auth.users.id`.
- `requireTenant()` in `@/lib/tenant` resolves the tenant from the session and
  refuses a mismatched `x-tenant-id`. Use it on write routes.
- `getTenantId()` remains permissive for public read routes only.
- Never trust a client-supplied `tenantId`, `tableId`, or price.

## Ordering / realtime

`src/lib/order-events.ts` (an in-process EventEmitter) is being replaced by
Supabase Realtime. If you touch an ordering path, publish through
`broadcastOrderEvent()` from `@/lib/order-events` instead of the raw emitter —
see that file for the current API.
