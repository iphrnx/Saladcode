import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Server-side super-admin identity.
 *
 * The admin panel keeps its session in an HttpOnly cookie, so the browser
 * never holds a token and cannot forge one. That means every admin request
 * has to pass through the server, which is what this module is for: it reads
 * the cookie, checks the allowlist, and hands back the caller's own access
 * token for the server to use when it calls the edge function.
 *
 * The allowlist (`public.super_admins`) is the authority. The
 * `profiles.is_super_admin` column is a mirror — before migration 0020 it
 * was the authority, and because it was a column on a row the user could
 * update, it was not a security boundary at all.
 */

export type SuperAdminIdentity = {
  userId: string
  email: string
  label: string
  accessToken: string
}

export type SuperAdminCheck =
  | { ok: true; identity: SuperAdminIdentity }
  | { ok: false; status: 401 | 403; error: string }

/**
 * Who is calling, and are they allowed?
 *
 * Returns 401 when there is no usable session and 403 when there is a session
 * but the account is not on the allowlist.
 */
export async function getSuperAdminIdentity(): Promise<SuperAdminCheck> {
  let accessToken = ''
  let userId = ''
  let email = ''

  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getSession()
    if (error || !data?.session) {
      return { ok: false, status: 401, error: 'Not signed in' }
    }
    accessToken = data.session.access_token
    userId = data.session.user.id
    email = data.session.user.email ?? ''
  } catch {
    return { ok: false, status: 401, error: 'Not signed in' }
  }

  if (!hasServiceRole()) {
    // Without the service role the allowlist cannot be read. Refuse rather
    // than fall through to a weaker check.
    console.error('getSuperAdminIdentity: SUPABASE_SERVICE_ROLE_KEY is not set')
    return { ok: false, status: 500 as never, error: 'Authorization check unavailable' }
  }

  const db = supabaseAdmin()

  // Match on the user id first, then on the address, so an administrator
  // whose row predates their first login still resolves. The address is
  // compared exactly (not with a LIKE pattern) so an underscore in a local
  // part cannot match a different address.
  const { data: byId, error: byIdError } = await db
    .from('super_admins')
    .select('id, email, label, user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (byIdError) {
    console.error('getSuperAdminIdentity: allowlist lookup failed', byIdError)
    return { ok: false, status: 500 as never, error: 'Authorization check failed' }
  }

  let allowed = byId
  if (!allowed && email) {
    const { data: byEmail, error: byEmailError } = await db
      .from('super_admins')
      .select('id, email, label, user_id')
      .eq('email', email.toLowerCase())
      .maybeSingle()
    if (byEmailError) {
      console.error('getSuperAdminIdentity: allowlist lookup by email failed', byEmailError)
      return { ok: false, status: 500 as never, error: 'Authorization check failed' }
    }
    allowed = byEmail
  }

  if (!allowed) {
    return { ok: false, status: 403, error: 'This account is not authorised for the admin panel' }
  }

  // Bind the allowlist row to the authenticated user the first time they
  // arrive, so later logins resolve on the id alone.
  if (!allowed.user_id) {
    try {
      await db.from('super_admins').update({ user_id: userId }).eq('id', allowed.id)
    } catch (e) {
      console.error('getSuperAdminIdentity: could not bind the allowlist row', e)
    }
  }

  return {
    ok: true,
    identity: {
      userId,
      email: allowed.email ?? email,
      label: allowed.label ?? 'Super Admin',
      accessToken,
    },
  }
}

/** True when the server has the service role key it needs. */
export function hasServiceRole(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Where a sign-in link should send the administrator.
 *
 * The link carries a session, so where it points matters: it must be an
 * origin we recognise, and it must be absolute. The `Host` header is not
 * trusted on its own — a request that arrived with a forged host would
 * otherwise be able to have the sign-in token mailed to somewhere else.
 * Only the known origins are used.
 */
const ADMIN_ORIGINS = [
  'https://www.thesalad.in',
  'https://thesalad.in',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]

export function resolveAdminOrigin(req: Request): string {
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const forwardedProto = req.headers.get('x-forwarded-proto') ?? ''

  const candidates = [
    forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : '',
    forwardedHost
      ? `${forwardedHost.includes('localhost') || forwardedHost.includes('127.0.0.1') ? 'http' : 'https'}://${forwardedHost}`
      : '',
    process.env.NEXT_PUBLIC_SITE_URL ?? '',
  ].filter(Boolean)

  for (const candidate of candidates) {
    const match = ADMIN_ORIGINS.find(
      (origin) => candidate.toLowerCase().startsWith(origin.toLowerCase()),
    )
    if (match) return match
  }

  return ADMIN_ORIGINS[0]
}
