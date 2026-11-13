import { supabaseAdmin } from '@/lib/supabase/admin'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'

/**
 * Staff Authentication System
 *
 * Completely separate from owner login (which uses Supabase Auth).
 * Staff authenticate with employeeId + 4-digit PIN.
 *
 * Security:
 *  - PINs are hashed with scrypt + per-staff salt (never plaintext)
 *  - Rate limiting: 5 failed attempts → 15 min lockout
 *  - Staff sessions use their own cookie (the-salad-staff-session), never shared
 *    with owner sessions
 *  - All staff actions are logged to staff_activities
 */

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MINUTES = 15

/** Hash a PIN with a random salt using scrypt */
export function hashPin(pin: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(pin, salt, 64).toString('hex')
  return { hash, salt }
}

/** Verify a PIN against the stored hash + salt */
export function verifyPin(pin: string, hash: string, salt: string): boolean {
  try {
    const testHash = scryptSync(pin, salt, 64)
    const storedHash = Buffer.from(hash, 'hex')
    return testHash.length === storedHash.length && timingSafeEqual(testHash, storedHash)
  } catch {
    return false
  }
}

/** Check if a staff member is currently locked out */
export function isLocked(staff: { locked_until: string | null }): {
  locked: boolean
  remainingMs?: number
} {
  if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
    return { locked: true, remainingMs: new Date(staff.locked_until).getTime() - Date.now() }
  }
  return { locked: false }
}

/**
 * Authenticate a staff member with employeeId + PIN.
 * Returns the staff member + a new session token on success.
 */
export async function authenticateStaff(
  tenantId: string,
  employeeId: string,
  pin: string,
): Promise<
  | { ok: true; staff: any; token: string }
  | { ok: false; error: string; lockedUntil?: string }
> {
  const admin = supabaseAdmin()

  const { data: staff } = await admin
    .from('staff')
    .select('*, role:roles(*)')
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId.trim())
    .maybeSingle()

  if (!staff) {
    return { ok: false, error: 'Employee not found. Please select your name from the list.' }
  }
  if (!staff.active) {
    return { ok: false, error: 'Your account has been deactivated. Please contact your manager.' }
  }

  const lock = isLocked(staff)
  if (lock.locked) {
    const mins = Math.ceil((lock.remainingMs || 0) / 60000)
    return {
      ok: false,
      error: `Account locked. Try again in ${mins} minute(s).`,
      lockedUntil: staff.locked_until ?? undefined,
    }
  }

  const valid = verifyPin(pin, staff.pin_hash, staff.pin_salt)
  if (!valid) {
    const attempts = (staff.failed_attempts || 0) + 1
    const shouldLock = attempts >= MAX_FAILED_ATTEMPTS
    const lockedUntil = shouldLock
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString()
      : null

    await admin
      .from('staff')
      .update({ failed_attempts: attempts, locked_until: lockedUntil })
      .eq('id', staff.id)

    await admin.from('staff_activities').insert({
      staff_id: staff.id,
      tenant_id: tenantId,
      action: 'LOGIN_FAILED',
      meta: `Attempt ${attempts}/${MAX_FAILED_ATTEMPTS}`,
    })

    if (shouldLock) {
      return {
        ok: false,
        error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
        lockedUntil: lockedUntil ?? undefined,
      }
    }
    return {
      ok: false,
      error: `Incorrect PIN. ${MAX_FAILED_ATTEMPTS - attempts} attempt(s) remaining.`,
    }
  }

  await admin
    .from('staff')
    .update({ failed_attempts: 0, locked_until: null, last_login: new Date().toISOString() })
    .eq('id', staff.id)

  const { data: session } = await admin
    .from('staff_sessions')
    .insert({ staff_id: staff.id })
    .select('token')
    .single()

  await admin.from('staff_activities').insert({
    staff_id: staff.id,
    tenant_id: tenantId,
    action: 'LOGIN',
    meta: 'Staff login via PIN',
  })

  return { ok: true, staff, token: session!.token }
}

/**
 * Validate a staff session token. Returns the staff member + permissions.
 */
export async function validateStaffSession(token: string): Promise<
  { ok: true; staff: any; permissions: string[] } | { ok: false; error: string }
> {
  if (!token) return { ok: false, error: 'No session token' }

  const admin = supabaseAdmin()
  const { data: session } = await admin
    .from('staff_sessions')
    .select('*, staff:staff(*, role:roles(*), tenant:tenants(*))')
    .eq('token', token)
    .maybeSingle()

  if (!session) return { ok: false, error: 'Invalid session' }

  // Session expiry: 12 hours
  const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000
  if (new Date(session.created_at).getTime() < twelveHoursAgo) {
    await admin.from('staff_sessions').delete().eq('id', session.id)
    return { ok: false, error: 'Session expired. Please login again.' }
  }

  const staff = (session as any).staff
  if (!staff?.active) return { ok: false, error: 'Account deactivated' }

  await admin
    .from('staff_sessions')
    .update({ last_active: new Date().toISOString() })
    .eq('id', session.id)

  // `is_system` marks a built-in role, not the owner — see the note in
  // supabase/functions/_shared/auth.ts.
  const isOwner = staff.role?.is_system === true && staff.role?.name === 'Owner'
  let permissions: string[] = String(staff.role?.permissions || '')
    .split(',')
    .filter(Boolean)

  // Legacy rows stored permissions as a JSON array string.
  if (permissions.length === 1 && permissions[0].startsWith('[')) {
    try {
      permissions = JSON.parse(permissions[0])
    } catch {
      /* keep as-is */
    }
  }

  if (isOwner) {
    const { PERMISSION_KEYS } = await import('@/lib/tenant')
    permissions = Array.from(new Set([...permissions, ...PERMISSION_KEYS]))
  }

  return { ok: true, staff, permissions }
}

/**
 * End a staff session (logout).
 */
export async function endStaffSession(token: string): Promise<void> {
  if (!token) return
  const admin = supabaseAdmin()

  const { data: session } = await admin
    .from('staff_sessions')
    .select('id, staff_id, staff:staff_id (tenant_id)')
    .eq('token', token)
    .maybeSingle()
  if (!session) return

  const rel = (session as any).staff
  const tenantId = Array.isArray(rel) ? rel[0]?.tenant_id : rel?.tenant_id

  if (tenantId) {
    await admin.from('staff_activities').insert({
      staff_id: session.staff_id,
      tenant_id: tenantId,
      action: 'LOGOUT',
      meta: 'Staff logout',
    })
  }

  await admin.from('staff_sessions').delete().eq('id', session.id)
}

/** Check if a staff member has a specific permission. */
export function hasPermission(permissions: string[], perm: string): boolean {
  return permissions.includes(perm)
}

/** Staff must have ALL of the given permissions. */
export function hasAllPermissions(permissions: string[], perms: string[]): boolean {
  return perms.every((p) => permissions.includes(p))
}

/** Staff must have ANY of the given permissions. */
export function hasAnyPermission(permissions: string[], perms: string[]): boolean {
  return permissions.some((p) => permissions.includes(p))
}

/** Read the staff session token from a request's cookies. */
export function staffTokenFromRequest(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie') || ''
  const match = cookieHeader.match(/the-salad-staff-session=([^;]+)|toastly-staff-session=([^;]+)|tablo-staff-session=([^;]+)/)
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value ? decodeURIComponent(value) : null
}
