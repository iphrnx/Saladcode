import { supabaseAdmin } from '@/lib/supabase/admin'

/**
 * Table Session access system — BACKEND source of truth.
 *
 * A customer may only view the menu / place orders while holding an ACTIVE
 * session. A session is created when they scan a valid table QR code. Every
 * protected request re-validates against the database — never against
 * localStorage or a client-supplied tableId.
 *
 * Guarantees:
 *  - The menu URL alone is not sufficient to order.
 *  - tableId / tenantId from the frontend are never trusted without a DB check.
 *  - An ENDED session is rejected immediately.
 */

export interface ValidatedSession {
  session: {
    id: string
    token: string
    status: string
    tenantId: string
    tableId: string
    createdAt: Date
    endedAt: Date | null
  }
  tenant: {
    id: string
    name: string
    currencySymbol: string
    taxRate: number
    serviceCharge: number
  }
  table: {
    id: string
    name: string
    seats: number
    area: string
    active: boolean
  }
}

function shape(row: any): ValidatedSession {
  const tenant = Array.isArray(row.tenant) ? row.tenant[0] : row.tenant
  const table = Array.isArray(row.table) ? row.table[0] : row.table
  return {
    session: {
      id: row.id,
      token: row.token,
      status: row.status,
      tenantId: row.tenant_id,
      tableId: row.table_id,
      createdAt: new Date(row.created_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : null,
    },
    tenant: {
      id: tenant.id,
      name: tenant.name,
      currencySymbol: tenant.currency_symbol,
      taxRate: Number(tenant.tax_rate),
      serviceCharge: Number(tenant.service_charge),
    },
    table: {
      id: table.id,
      name: table.name,
      seats: table.seats,
      area: table.area,
      active: table.active,
    },
  }
}

/**
 * Validate a table session for a protected request.
 *
 * The database is the source of truth: we look the session up by token, then
 * confirm it belongs to the claimed tenant + table and is still ACTIVE.
 */
export async function validateTableSession(params: {
  tenantId?: string | null
  tableId?: string | null
  sessionToken?: string | null
}): Promise<
  { ok: true; data: ValidatedSession } | { ok: false; error: string; status: number }
> {
  const { tenantId, tableId, sessionToken } = params

  if (!sessionToken) {
    return {
      ok: false,
      error: 'Missing session credentials. Please scan the table QR code.',
      status: 401,
    }
  }

  const { data: row } = await supabaseAdmin()
    .from('table_sessions')
    .select('*, tenant:tenants(*), table:tables(*)')
    .eq('token', sessionToken)
    .maybeSingle()

  if (!row) {
    return { ok: false, error: 'Invalid session. Please scan the table QR code.', status: 401 }
  }

  if (tenantId && row.tenant_id !== tenantId) {
    return {
      ok: false,
      error: 'Session does not match this restaurant. Please scan the table QR code.',
      status: 403,
    }
  }
  if (tableId && row.table_id !== tableId) {
    return {
      ok: false,
      error: 'Session does not match this table. Please scan the table QR code.',
      status: 403,
    }
  }
  if (row.status !== 'ACTIVE') {
    return {
      ok: false,
      error: 'Session ended. Please scan the table QR code again to continue.',
      status: 403,
    }
  }

  const data = shape(row)
  if (!data.table || !data.table.active) {
    return { ok: false, error: 'This table is no longer available.', status: 403 }
  }

  return { ok: true, data }
}

/**
 * Activate a new table session after a customer scans a QR code.
 *
 * The QR token is the physical table's `qr_token` — only someone who scanned
 * the physical code has it. Delegated to `start_table_session()` in the
 * database so the same validated path is used whether the caller is a server
 * route or a future direct-from-client flow.
 */
export async function activateTableSession(params: {
  qrToken: string
  deviceFp?: string
}): Promise<
  { ok: true; data: ValidatedSession } | { ok: false; error: string; status: number }
> {
  const { qrToken, deviceFp } = params

  if (!qrToken) {
    return { ok: false, error: 'Missing QR token. Please scan the table QR code.', status: 400 }
  }

  const { data, error } = await supabaseAdmin().rpc('start_table_session', {
    p_qr_token: qrToken,
    p_device_fp: deviceFp || null,
  })

  if (error) {
    if (error.message.includes('INVALID_QR')) {
      return {
        ok: false,
        error: 'Invalid QR code. Please scan the QR code on your table.',
        status: 404,
      }
    }
    if (error.message.includes('RESTAURANT_UNAVAILABLE')) {
      return { ok: false, error: 'This restaurant is currently unavailable.', status: 403 }
    }
    return { ok: false, error: 'Could not start your table session. Please try again.', status: 500 }
  }

  const { data: row } = await supabaseAdmin()
    .from('table_sessions')
    .select('*, tenant:tenants(*), table:tables(*)')
    .eq('token', (data as any).session_token)
    .maybeSingle()

  if (!row) {
    return { ok: false, error: 'Could not start your table session. Please try again.', status: 500 }
  }
  return { ok: true, data: shape(row) }
}

/**
 * End table session(s). Called by staff or automatically on order completion.
 * Marks status=ENDED and stamps endedAt. Rows and orders are preserved for
 * history — nothing is deleted.
 */
export async function endTableSession(params: {
  tenantId: string
  sessionId?: string
  tableId?: string
}): Promise<{ ok: true; ended: number } | { ok: false; error: string; status: number }> {
  const { tenantId, sessionId, tableId } = params

  let query = supabaseAdmin()
    .from('table_sessions')
    .update({ status: 'ENDED', ended_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('status', 'ACTIVE')

  if (sessionId) query = query.eq('id', sessionId)
  if (tableId) query = query.eq('table_id', tableId)

  const { data, error } = await query.select('id')
  if (error) return { ok: false, error: error.message, status: 500 }

  return { ok: true, ended: data?.length ?? 0 }
}
