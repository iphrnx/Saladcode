import { supabaseAdmin } from './supabase/admin'
import { createClient } from './supabase/server'
import { json, PERMISSION_KEYS } from './constants'
import { validateStaffSession } from './staff-auth'
import { splitPermissions } from './permissions'

/**
 * Session resolution for server routes.
 *
 * The app has two audiences and therefore two session shapes:
 *   * owners — Supabase Auth cookie, permission set from their `roles` row
 *   * staff  — `the-salad-staff-session` cookie, permission set from their role
 *
 * `guard()` is the only thing a dashboard route should use. It fails closed:
 * no session, a deactivated account, a cross-tenant `x-tenant-id`, or a
 * missing permission all produce a 401/403 instead of data.
 *
 * Public routes (the diner menu, the QR session handshake) must NOT use
 * `guard()`; they resolve a tenant explicitly through `publicTenantId()`.
 */

export type SessionKind = 'owner' | 'staff'

export interface Session {
  kind: SessionKind
  tenantId: string
  /** `profiles.id` for owners, `staff.id` for staff. */
  subjectId: string
  name: string
  email: string | null
  roleName: string
  permissions: string[]
}

export type GuardResult =
  | { ok: true; session: Session }
  | { ok: false; response: Response }

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function staffTokenFrom(req: Request): string | null {
  const cookie = req.headers.get('cookie') || ''
  // Either name: the cookie the app issues now, or the one it used to — a
  // staff session issued before the rename is still a staff session.
  const match = cookie.match(/the-salad-staff-session=([^;]+)|toastly-staff-session=([^;]+)|tablo-staff-session=([^;]+)/)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value ? decodeURIComponent(value) : null
}

function claimedTenant(req: Request): string | null {
  const url = new URL(req.url)
  return req.headers.get('x-tenant-id') || url.searchParams.get('tenant')
}

async function ownerSession(): Promise<Session | null> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return null

    const { data: profile } = await supabaseAdmin()
      .from('profiles')
      .select(
        'id, tenant_id, name, email, role, role_id, active, role_row:roles!profiles_role_id_fkey (name, permissions, is_system)',
      )
      .eq('id', user.id)
      .maybeSingle()

    if (!profile?.tenant_id || profile.active === false) return null

    const rel: unknown = (profile as Record<string, unknown>).role_row
    const role = (Array.isArray(rel) ? rel[0] : rel) as
      | { name?: string; permissions?: string; is_system?: boolean }
      | null
      | undefined

    // A profile with no role row predates roles (or is the tenant creator);
    // give it the full set so the account cannot lock itself out.
    const permissions = profile.role_id
      ? splitPermissions(role?.permissions)
      : [...PERMISSION_KEYS]

    return {
      kind: 'owner',
      tenantId: profile.tenant_id,
      subjectId: profile.id,
      name: profile.name,
      email: profile.email,
      roleName: role?.name ?? profile.role ?? 'Owner',
      permissions,
    }
  } catch {
    return null
  }
}

async function staffSession(req: Request): Promise<Session | null> {
  const token = staffTokenFrom(req)
  if (!token) return null

  const result = await validateStaffSession(token)
  if (!result.ok) return null

  const staff = result.staff
  return {
    kind: 'staff',
    tenantId: staff.tenant_id,
    subjectId: staff.id,
    name: staff.name,
    email: null,
    roleName: staff.role?.name ?? 'Staff',
    permissions: result.permissions ?? [],
  }
}

/**
 * Authenticate a dashboard request. Returns the session, or a ready-to-return
 * 401/403 Response.
 *
 *   const g = await guard(req, { permission: 'menu.manage' })
 *   if (!g.ok) return g.response
 *   const { tenantId } = g.session
 */
export async function guard(
  req: Request,
  opts: { permission?: string; anyOf?: string[] } = {},
): Promise<GuardResult> {
  const session = (await ownerSession()) ?? (await staffSession(req))
  if (!session) {
    return { ok: false, response: json({ error: 'Unauthorized' }, 401) }
  }

  // A signed-in session may not address another restaurant.
  const claimed = claimedTenant(req)
  if (claimed && claimed !== session.tenantId) {
    return { ok: false, response: json({ error: 'Forbidden' }, 403) }
  }

  if (opts.permission && !session.permissions.includes(opts.permission)) {
    return {
      ok: false,
      response: json({ error: 'Forbidden', required: opts.permission }, 403),
    }
  }

  if (opts.anyOf && !opts.anyOf.some((p) => session.permissions.includes(p))) {
    return {
      ok: false,
      response: json({ error: 'Forbidden', required: opts.anyOf }, 403),
    }
  }

  return { ok: true, session }
}

/**
 * Resolve a tenant for a genuinely public route from an explicit
 * `?tenant=` / `x-tenant-id` value only.
 *
 * Note the deliberate absence of the old "oldest tenant" fallback — that
 * fallback is what let anonymous callers read the first restaurant in the
 * database.
 */
export async function publicTenantId(req: Request): Promise<string | null> {
  const key = claimedTenant(req)
  if (!key) return null

  const admin = supabaseAdmin()
  if (UUID_RE.test(key)) {
    const { data } = await admin.from('tenants').select('id').eq('id', key).maybeSingle()
    if (data?.id) return data.id
  }
  const { data } = await admin.from('tenants').select('id').eq('slug', key).maybeSingle()
  return data?.id ?? null
}
