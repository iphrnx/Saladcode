'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useApp, type Session, type SecurityLog } from '@/components/app/data-context'
import { cn } from '@/lib/utils'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { hasPermission } from '@/lib/permissions'
import { activeSessionTotal, sessionRight, viewerIsOwner } from '@/lib/session-ui'
import { AccessDenied } from '@/components/shared/access-denied'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { safeTimeZone } from '@/lib/order-time'
import {
  Shield, ShieldAlert, Activity, Monitor, Smartphone, Tablet, LogOut, MapPin, Clock, AlertTriangle, X,
  KeyRound, CheckCircle2, QrCode, Copy,
} from 'lucide-react'
import { toast } from 'sonner'

function timeAgo(date: string | Date | undefined | null): string | null {
  if (!date) return null
  const d = new Date(date)
  const time = d.getTime()
  if (isNaN(time)) return null
  const diff = Date.now() - time
  if (isNaN(diff)) return null
  // Small clock skew: if up to 60s in future, display as 'just now'
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

function initials(name: string) {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
}

function deviceIcon(device: string | null) {
  if (!device) return <Monitor className="h-4 w-4" />
  const d = device.toLowerCase()
  if (d.includes('phone') || d.includes('mobile') || d.includes('iphone') || d.includes('android')) return <Smartphone className="h-4 w-4" />
  if (d.includes('tablet') || d.includes('ipad')) return <Tablet className="h-4 w-4" />
  return <Monitor className="h-4 w-4" />
}

export const LOG_COLORS: Record<string, string> = {
  CHECK_SETTLED_CASH: '#16a34a', // green
  CHECK_FINALISED: '#059669',     // emerald
  CHECK_PAYMENT: '#16a34a',       // green
  CHECK_PAYMENT_REVERSED: '#d97706', // amber
  ORDER_CANCELLED: '#ea580c',     // orange
  ORDER_REJECTED: '#e11d48',      // rose
  ORDER_DELETED: '#dc2626',       // red
  TABLE_CLOSED: '#2563eb',        // blue
  TABLE_CLOSED_FORCED: '#d97706', // amber
  TABLE_ACTIVATED: '#16a34a',     // green
  SETTINGS_CHANGE: '#4f46e5',     // indigo
  LOGIN: '#16a34a',               // green
  LOGIN_FAILED: '#dc2626',        // red
  LOGOUT: '#64748b',              // slate
  REGISTER: '#7c3aed',            // violet
  PASSWORD_CHANGE: '#d97706',     // amber
  ROLE_CHANGE: '#9333ea',         // purple
  PROMO_CREATED: '#db2777',       // pink
  SESSION_REVOKED: '#ea580c',     // orange
}

export const LOG_LABELS: Record<string, string> = {
  CHECK_SETTLED_CASH: 'Cash Payment Completed',
  CHECK_FINALISED: 'Bill Finalized',
  CHECK_PAYMENT: 'Payment Collected',
  CHECK_PAYMENT_REVERSED: 'Payment Refunded',
  ORDER_CANCELLED: 'Order Cancelled',
  ORDER_REJECTED: 'Order Rejected',
  ORDER_DELETED: 'Order Deleted',
  TABLE_CLOSED: 'Table Session Ended',
  TABLE_CLOSED_FORCED: 'Table Force Closed',
  TABLE_ACTIVATED: 'Table Activated',
  SETTINGS_CHANGE: 'Settings Updated',
  LOGIN: 'Sign In',
  LOGIN_FAILED: 'Failed Login',
  LOGOUT: 'Sign Out',
  REGISTER: 'Account Registered',
  PASSWORD_CHANGE: 'Password Changed',
  ROLE_CHANGE: 'Role Updated',
  PROMO_CREATED: 'Promo Created',
  SESSION_REVOKED: 'Session Revoked',
}

export function formatActionLabel(action?: string | null): string {
  if (!action) return 'Activity'
  if (LOG_LABELS[action]) return LOG_LABELS[action]
  return action
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function formatActionColor(action?: string | null): string {
  if (!action) return '#64748b'
  return LOG_COLORS[action] || '#64748b'
}

export function formatExactDateTime(iso?: string | null, timeZone = 'Asia/Kolkata', pattern = 'DD/MM/YYYY'): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const tz = safeTimeZone(timeZone)
  try {
    let dateStr = ''
    const yyyy = d.toLocaleDateString('en-GB', { timeZone: tz, year: 'numeric' })
    const mm = d.toLocaleDateString('en-GB', { timeZone: tz, month: '2-digit' })
    const dd = d.toLocaleDateString('en-GB', { timeZone: tz, day: '2-digit' })

    if (pattern === 'MM/DD/YYYY') dateStr = `${mm}/${dd}/${yyyy}`
    else if (pattern === 'YYYY-MM-DD') dateStr = `${yyyy}-${mm}-${dd}`
    else dateStr = `${dd}/${mm}/${yyyy}`

    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    return `${dateStr}, ${timeFormatter.format(d)}`
  } catch {
    return ''
  }
}

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export interface MergedSecurityLog extends SecurityLog {
  mergedCount?: number
  cleanDetails?: string
  invoiceNumber?: string | null
  orderNumbers?: number[]
  tableName?: string | null
  amount?: string | null
}

export function enrichSecurityLog(
  log: SecurityLog,
  data?: any,
  timeZone: string = 'Asia/Kolkata',
): MergedSecurityLog {
  const rawMeta = String(log.meta || '')
  const matchedUuids = Array.from(rawMeta.matchAll(UUID_REGEX), (m) => m[0].toLowerCase())

  // Extract invoice number if present (e.g. INV-0000014)
  const invMatch = rawMeta.match(/\b(INV-[A-Za-z0-9-]+)\b/i)
  const invoiceNumber = invMatch ? invMatch[1].toUpperCase() : null

  // Extract order number if present (e.g. Order #62)
  const ordMatch = rawMeta.match(/(?:Order\s*#?|#)(\d+)\b/i)
  const parsedOrderNum = ordMatch ? parseInt(ordMatch[1], 10) : null

  // Extract amount if present (e.g. ₹157.50, ₹ 525)
  const amtMatch =
    rawMeta.match(/[(]?(₹\s*[\d,]+(?:\.\d{2})?|\b[\d,]+(?:\.\d{2})?\s*(?:INR|₹))[)]?/i) ||
    rawMeta.match(/\((₹\s*[\d,]+(?:\.\d{2})?)\)/)
  let amountStr = amtMatch ? amtMatch[1].trim() : null
  if (amountStr && !amountStr.startsWith('₹') && !amountStr.includes('INR')) {
    amountStr = '₹' + amountStr
  }

  // Extract cancellation/rejection reason if present
  const reasonMatch = rawMeta.match(/(?:cancelled|rejected|deleted)(?:\s*:|\s+-)\s*(.+)$/i)
  const reason = reasonMatch ? reasonMatch[1].trim() : null

  const currency = data?.tenant?.currencySymbol || '₹'
  let tableName: string | null = null
  const linkedOrderNums: number[] = parsedOrderNum ? [parsedOrderNum] : []
  let paymentMethod: string | null = null

  // 1. Resolve via parsed order number from data.orders
  if (parsedOrderNum && Array.isArray(data?.orders)) {
    const o = data.orders.find((ord: any) => ord.orderNumber === parsedOrderNum)
    if (o) {
      if (o.table?.name) tableName = o.table.name
      else if (o.tableId && Array.isArray(data?.tables)) {
        tableName = data.tables.find((t: any) => t.id === o.tableId)?.name || null
      }
      if (!amountStr && o.total != null) {
        amountStr = `${currency}${Number(o.total).toFixed(2)}`
      }
      if (o.paymentMethod) paymentMethod = o.paymentMethod
    }
  }

  // 2. Resolve via invoice number or check UUIDs from data.orders and data.checks
  if (invoiceNumber || matchedUuids.length > 0) {
    if (Array.isArray(data?.orders)) {
      const matchingOrders = data.orders.filter((ord: any) => {
        if (ord.checkId && matchedUuids.includes(String(ord.checkId).toLowerCase())) return true
        if (invoiceNumber && ord.checkId && data?.checks?.[ord.checkId]?.invoiceNumber === invoiceNumber) return true
        if (invoiceNumber && String(ord.invoiceNumber || '').toUpperCase() === invoiceNumber) return true
        return false
      })

      if (matchingOrders.length > 0) {
        if (!tableName) {
          const first = matchingOrders[0]
          tableName = first.table?.name || data?.tables?.find((t: any) => t.id === first.tableId)?.name || null
        }
        for (const ord of matchingOrders) {
          if (ord.orderNumber && !linkedOrderNums.includes(ord.orderNumber)) {
            linkedOrderNums.push(ord.orderNumber)
          }
        }
        if (!amountStr) {
          const firstChkId = matchingOrders[0].checkId
          if (firstChkId && data?.checks?.[firstChkId]?.total != null) {
            amountStr = `${currency}${Number(data.checks[firstChkId].total).toFixed(2)}`
          }
        }
        if (!paymentMethod && matchingOrders[0].paymentMethod) {
          paymentMethod = matchingOrders[0].paymentMethod
        }
      }
    }

    // Direct check lookup in data.checks
    for (const uid of matchedUuids) {
      if (data?.checks?.[uid]) {
        const chk = data.checks[uid]
        if (!amountStr && chk.total != null) {
          amountStr = `${currency}${Number(chk.total).toFixed(2)}`
        }
      }
    }
  }

  // 3. Resolve table if UUID is a table ID
  if (!tableName && matchedUuids.length > 0 && Array.isArray(data?.tables)) {
    const tbl = data.tables.find((t: any) => matchedUuids.includes(String(t.id).toLowerCase()))
    if (tbl) tableName = tbl.name
  }

  // Construct clean human-readable details
  let cleanDetails = ''

  if (log.action === 'CHECK_SETTLED_CASH') {
    const parts: string[] = []
    if (invoiceNumber) parts.push(`Invoice ${invoiceNumber}`)
    if (tableName) parts.push(tableName)
    if (linkedOrderNums.length === 1) parts.push(`Order #${linkedOrderNums[0]}`)
    else if (linkedOrderNums.length > 1) parts.push(`Orders ${linkedOrderNums.map((n) => `#${n}`).join(', ')}`)
    if (amountStr) parts.push(amountStr)
    parts.push('Cash')
    cleanDetails = parts.join(' · ')
  } else if (
    log.action === 'CHECK_FINALISED' ||
    log.action === 'CHECK_PAYMENT' ||
    log.action === 'CHECK_PAYMENT_REVERSED'
  ) {
    const parts: string[] = []
    if (invoiceNumber) parts.push(`Invoice ${invoiceNumber}`)
    if (tableName) parts.push(tableName)
    if (linkedOrderNums.length === 1) parts.push(`Order #${linkedOrderNums[0]}`)
    else if (linkedOrderNums.length > 1) parts.push(`Orders ${linkedOrderNums.map((n) => `#${n}`).join(', ')}`)
    if (amountStr) parts.push(amountStr)
    if (paymentMethod) parts.push(paymentMethod)
    if (log.action === 'CHECK_PAYMENT_REVERSED') parts.push('Refunded')
    cleanDetails = parts.join(' · ')
  } else if (log.action === 'ORDER_CANCELLED') {
    const parts: string[] = []
    if (linkedOrderNums.length > 0) parts.push(`Order #${linkedOrderNums[0]}`)
    if (tableName) parts.push(tableName)
    if (amountStr) parts.push(amountStr)
    if (reason) parts.push(`Reason: ${reason}`)
    cleanDetails = parts.length > 0 ? parts.join(' · ') : 'Order cancelled'
  } else if (log.action === 'ORDER_REJECTED') {
    const parts: string[] = []
    if (linkedOrderNums.length > 0) parts.push(`Order #${linkedOrderNums[0]}`)
    if (tableName) parts.push(tableName)
    if (reason) parts.push(`Reason: ${reason}`)
    cleanDetails = parts.length > 0 ? parts.join(' · ') : 'Order rejected'
  } else if (log.action === 'ORDER_DELETED') {
    const parts: string[] = []
    if (linkedOrderNums.length > 0) parts.push(`Order #${linkedOrderNums[0]}`)
    if (tableName) parts.push(tableName)
    cleanDetails = parts.length > 0 ? parts.join(' · ') : 'Order deleted'
  } else if (log.action === 'SETTINGS_CHANGE') {
    cleanDetails = 'Updated restaurant profile and settings'
  } else if (log.action === 'LOGIN') {
    cleanDetails =
      rawMeta.toLowerCase().includes('pin')
        ? 'Signed in via staff PIN'
        : 'Signed in via email and password'
  } else if (log.action === 'LOGIN_FAILED') {
    cleanDetails = 'Failed sign-in attempt'
  } else if (log.action === 'LOGOUT') {
    cleanDetails = 'Signed out of session'
  } else if (log.action === 'REGISTER') {
    cleanDetails = 'Account registered successfully'
  } else if (log.action === 'PASSWORD_CHANGE') {
    cleanDetails = 'Password updated successfully'
  } else if (log.action === 'ROLE_CHANGE') {
    cleanDetails = 'Staff role and permissions updated'
  } else if (log.action === 'SESSION_REVOKED') {
    if (rawMeta.toLowerCase().includes('all')) {
      cleanDetails = 'All other active sessions revoked'
    } else if (/for\s+([^()]+)/i.test(rawMeta)) {
      const holder = rawMeta.match(/for\s+([^()]+)/i)![1].trim()
      cleanDetails = `Session ended for ${holder}`
    } else {
      cleanDetails = 'Session revoked'
    }
  } else if (log.action === 'TABLE_CLOSED' || log.action === 'TABLE_CLOSED_FORCED') {
    const parts: string[] = []
    if (tableName) parts.push(tableName)
    parts.push(log.action === 'TABLE_CLOSED_FORCED' ? 'Table session force closed' : 'Table session ended and cleared')
    cleanDetails = parts.join(' · ')
  } else if (log.action === 'TABLE_ACTIVATED') {
    cleanDetails = tableName ? `${tableName} activated` : 'Table activated'
  } else {
    // General fallback
    const scrubbed = rawMeta
      .replace(/\(\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)/gi, '')
      .replace(/\b(?:check|order)\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*/gi, '')
      .replace(UUID_REGEX, '')
      .replace(/\(\s*\)/g, '')
      .replace(/\[\s*\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .trim()
    cleanDetails = scrubbed || `${formatActionLabel(log.action)} recorded`
  }

  // Strict check: strip any remaining UUIDs and clean whitespace
  cleanDetails = cleanDetails
    .replace(/\(\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*\)/gi, '')
    .replace(UUID_REGEX, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return {
    ...log,
    cleanDetails,
    invoiceNumber,
    orderNumbers: linkedOrderNums,
    tableName,
    amount: amountStr,
  }
}

function checkIsDuplicate(a: MergedSecurityLog, b: MergedSecurityLog): boolean {
  if (a.action !== b.action) return false

  // Check same actor
  const actorA = a.userId || (a as any).actorStaffId || a.actor?.name
  const actorB = b.userId || (b as any).actorStaffId || b.actor?.name
  if (actorA && actorB && actorA !== actorB) return false

  const timeA = new Date(a.createdAt).getTime()
  const timeB = new Date(b.createdAt).getTime()
  const diffMs = Math.abs(timeA - timeB)

  // Payment / Settlement
  if (
    a.action === 'CHECK_SETTLED_CASH' ||
    a.action === 'CHECK_PAYMENT' ||
    a.action === 'CHECK_FINALISED'
  ) {
    if (diffMs <= 15_000) {
      if (a.invoiceNumber && b.invoiceNumber && a.invoiceNumber === b.invoiceNumber) return true
      if (diffMs <= 3_000) return true
    }
  }

  // Settings
  if (a.action === 'SETTINGS_CHANGE' && diffMs <= 10_000) {
    return true
  }

  // Orders
  if (
    (a.action === 'ORDER_CANCELLED' || a.action === 'ORDER_REJECTED' || a.action === 'ORDER_DELETED') &&
    diffMs <= 10_000
  ) {
    if (
      a.orderNumbers &&
      b.orderNumbers &&
      a.orderNumbers.some((num) => b.orderNumbers?.includes(num))
    ) {
      return true
    }
  }

  // Auth
  if (
    (a.action === 'LOGIN' || a.action === 'LOGIN_FAILED' || a.action === 'LOGOUT') &&
    diffMs <= 5_000
  ) {
    return true
  }

  return false
}

export function mergeSecurityLogs(
  logs: SecurityLog[],
  data?: any,
  timeZone: string = 'Asia/Kolkata',
): MergedSecurityLog[] {
  if (!logs || logs.length === 0) return []

  const enriched = logs.map((l) => enrichSecurityLog(l, data, timeZone))
  const merged: MergedSecurityLog[] = []

  for (const item of enriched) {
    if (merged.length === 0) {
      merged.push({ ...item, mergedCount: 1 })
      continue
    }

    const prev = merged[merged.length - 1]
    const isDup = checkIsDuplicate(prev, item)

    if (isDup) {
      prev.mergedCount = (prev.mergedCount || 1) + 1
      // Keep richer cleanDetails
      if (!prev.cleanDetails || (item.cleanDetails && item.cleanDetails.length > prev.cleanDetails.length)) {
        prev.cleanDetails = item.cleanDetails
      }
      if (!prev.tableName && item.tableName) {
        prev.tableName = item.tableName
      }
      if (!prev.amount && item.amount) {
        prev.amount = item.amount
      }
      if (!prev.actor?.role && item.actor?.role) {
        prev.actor = item.actor
      }
    } else {
      merged.push({ ...item, mergedCount: 1 })
    }
  }

  return merged
}

export function SecurityView() {
  const { data, refresh, applySecurity } = useApp()
  const [revokeAllOpen, setRevokeAllOpen] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const { scrollRef, collapsed } = useScrollCollapse()
  const { denied, setDenied, handleLoad, handleAction } = useAccessDenied()
  // Revoking is `security.manage`; the page itself is `security.view`, so a
  // role that may only look sees the sessions and no way to end them.
  const canManageSecurity = hasPermission(data?.permissions, 'security.manage')

  // ── Two-Factor Authentication (Supabase MFA) ─────────────────────────────
  const [mfaFactors, setMfaFactors] = useState<any[]>([])
  const [mfaLoading, setMfaLoading] = useState(false)
  const [enrollModalOpen, setEnrollModalOpen] = useState(false)
  const [enrollingFactor, setEnrollingFactor] = useState<{ id: string; totp: { qr_code: string; secret: string; uri: string } } | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [unenrollOpen, setUnenrollOpen] = useState(false)

  const loadMfaFactors = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data: factorData, error } = await supabase.auth.mfa.listFactors()
      if (!error && factorData) {
        setMfaFactors(factorData.totp || [])
      }
    } catch (e) {
      console.error('Failed to load MFA factors:', e)
    }
  }, [])

  useEffect(() => {
    void loadMfaFactors()
  }, [loadMfaFactors])

  const verifiedFactor = mfaFactors.find((f: any) => f.status === 'verified')

  const handleStartEnroll = async () => {
    setMfaLoading(true)
    try {
      const supabase = createClient()
      const { data: factor, error } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        issuer: 'The Salad POS',
      })
      if (error) throw error
      setEnrollingFactor(factor as any)
      setVerificationCode('')
      setEnrollModalOpen(true)
    } catch (err: any) {
      toast.error(err.message || 'Could not start 2FA enrollment')
    } finally {
      setMfaLoading(false)
    }
  }

  const handleVerifyEnroll = async () => {
    if (!enrollingFactor || !verificationCode.trim()) return
    setEnrolling(true)
    try {
      const supabase = createClient()
      const challenge = await supabase.auth.mfa.challenge({ factorId: enrollingFactor.id })
      if (challenge.error) throw challenge.error

      const verify = await supabase.auth.mfa.verify({
        factorId: enrollingFactor.id,
        challengeId: challenge.data.id,
        code: verificationCode.trim(),
      })
      if (verify.error) throw verify.error

      toast.success('Two-factor authentication enabled successfully!')
      setEnrollModalOpen(false)
      setEnrollingFactor(null)
      await loadMfaFactors()
    } catch (err: any) {
      toast.error(err.message || 'Invalid verification code')
    } finally {
      setEnrolling(false)
    }
  }

  const handleUnenroll = async () => {
    if (!verifiedFactor) return
    try {
      const supabase = createClient()
      const { error } = await supabase.auth.mfa.unenroll({ factorId: verifiedFactor.id })
      if (error) throw error
      toast.success('Two-factor authentication disabled')
      setUnenrollOpen(false)
      await loadMfaFactors()
    } catch (err: any) {
      toast.error(err.message || 'Could not disable 2FA')
    }
  }

  const sessions = data?.sessions ?? []
  const logs = data?.securityLogs ?? []
  const users = data?.users ?? []
  const restaurantTimeZone = safeTimeZone(data?.settings?.timezone)
  const mergedLogs = useMemo(() => {
    return mergeSecurityLogs(logs, data, restaurantTimeZone)
  }, [logs, data, restaurantTimeZone])
  // Every live sign-in, not the number of grouped rows. One row stands for a
  // browser that signed in more than once; the total has to count every
  // session behind the rows or it understates who is signed in.
  const activeTotal = activeSessionTotal(sessions)
  // A staff member may hold security.manage and view this page; only the
  // owner may end an owner session. See src/lib/session-ui.ts.
  const viewerIsOwnerFlag = viewerIsOwner(data?.currentStaff)
  // Windowed counts come from the server (see _shared/audit.ts): the old
  // cards counted inside the last-50 log slice, so the numbers moved with
  // unrelated activity and named no window.
  const stats = data?.securityStats ?? null

  const tenantId = data?.tenant.id ?? null

  const headers = {
    'x-tenant-id': data?.tenant.id ?? '',
    'content-type': 'application/json',
  }

  /**
   * Keep the page current without a refresh button.
   *
   * Only the security slice is re-read.
   *
   * `refresh()` re-fetches the entire bootstrap — menu, orders, tables — to
   * move one number on this page. `/api/security` returns exactly the four
   * fields this screen shows, so the page can stay current without dragging
   * the restaurant's whole state across the wire every few seconds.
   */
  // The same load is the first read *and* the ten-second beat, so it has to
  // remember whether it has ever succeeded: only a first load may take the
  // screen, and a missed beat must never blank a page that already loaded.
  const loadedOnce = useRef(false)
  const loadSecurity = useCallback(async () => {
    if (!tenantId) return
    try {
      const res = await edgeFetch('/api/security', { headers: { 'x-tenant-id': tenantId } })
      await failIfNotOk(res, 'security data')
      const json = await res.json()
      applySecurity({
        sessions: Array.isArray(json.sessions) ? json.sessions : [],
        securityLogs: Array.isArray(json.logs) ? json.logs : [],
        securityStats: json.stats ?? null,
      })
      loadedOnce.current = true
      setDenied(null)
    } catch (err) {
      // A 403/401 on the first load is the screen's answer ("you may not" /
      // "sign in again"); a 500 or a dead network offers a retry. A failure
      // after the first success is a missed beat, and stays quiet.
      if (!loadedOnce.current) handleLoad(err, 'security data')
    }
  }, [tenantId, applySecurity, handleLoad, setDenied])

  const refreshRef = useRef(loadSecurity)
  useEffect(() => {
    refreshRef.current = loadSecurity
  }, [loadSecurity])
  useEffect(() => {
    if (!tenantId) return
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refreshRef.current()
      }, 350)
    }

    const channel = supabase
      .channel(`security:${tenantId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'security_logs', filter: `tenant_id=eq.${tenantId}` },
        soon,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'staff_sessions' },
        soon,
      )
      .subscribe()

    /**
     * Sessions live in the `auth` schema, which cannot be published to
     * Realtime — so a sign-in on another device reaches this page only through
     * the LOGIN audit row above, and a row that was never written (a refresh,
     * a revoke from the API) reaches it only through this beat. Ten seconds,
     * because "active sessions" is the one number on the dashboard that people
     * stare at after clicking Revoke somewhere else.
     */
    const poll = setInterval(() => void refreshRef.current(), 10_000)
    // A tab that was in the background comes back current before it is read.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    void refreshRef.current()

    return () => {
      if (timer) clearTimeout(timer)
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [tenantId])

  const revokeSession = async (sessionId: string, sessionIds?: string[]) => {
    setRevoking(sessionId)
    try {
      const res = await edgeFetch('/api/security', {
        method: 'DELETE',
        headers,
        // Every session behind the row, so one click cannot leave the others.
        body: JSON.stringify({ sessionId, sessionIds: sessionIds ?? [sessionId] }),
      })
      await failIfNotOk(res, 'the session', { action: 'save' })
      toast.success('Session revoked')
      await loadSecurity()
    } catch (err) {
      handleAction(err, 'the session')
    } finally {
      setRevoking(null)
    }
  }

  const revokeAllSessions = async () => {
    setRevokeAllOpen(false)
    setRevoking('all')
    try {
      const res = await edgeFetch('/api/security', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ action: 'revoke_all' }),
      })
      await failIfNotOk(res, 'the sessions', { action: 'save' })
      toast.success('All sessions revoked')
      await loadSecurity()
    } catch (err) {
      handleAction(err, 'the sessions')
    } finally {
      setRevoking(null)
    }
  }

  if (!data) return null

  // A refused first load is the whole answer: the page has nothing to show and
  // an empty session list would read as "no one is signed in" rather than
  // "you may not look".
  if (denied) return <AccessDenied failure={denied} onRetry={loadSecurity} view="security" />

  // (scrollRef + collapsed come from useScrollCollapse above)

  return (
    <div className="h-full flex flex-col">
      {/* Header — collapses on scroll to give content cards more room */}
      <div
        className={cn(
          'shrink-0 px-3.5 md:px-6 flex items-center justify-between gap-3 flex-wrap transition-all duration-200 ease-out',
          collapsed ? 'pt-1.5 pb-1.5' : 'pt-2.5 md:pt-5 pb-2',
        )}
      >
        <div className="min-w-0">
          <h2
            className={cn(
              'font-bold tracking-tight flex items-center gap-2 transition-all duration-200 ease-out',
              collapsed ? 'text-base md:text-lg' : 'text-lg md:text-2xl',
            )}
          >
            <Shield className="h-5 w-5 md:h-6 md:w-6 text-primary" />
            Security
          </h2>
          <p
            className={cn(
              'text-sm text-muted-foreground transition-all duration-200 ease-out',
              collapsed
                ? 'max-h-0 opacity-0 overflow-hidden mt-0'
                : 'max-h-8 opacity-100 mt-0.5',
            )}
          >
            Sessions, two-factor authentication & activity audit
          </p>
        </div>
        {canManageSecurity && (
          <Button variant="outline" className="h-8 shrink-0 px-2.5 text-[13px] border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setRevokeAllOpen(true)}>
            <LogOut className="h-3.5 w-3.5" />
            Revoke All Sessions
          </Button>
        )}
      </div>

      {/* Top stats — collapse away when header is collapsed */}
      <div
        className={cn(
          // Three cards, so three columns from md up rather than four with a
          // hole in the row. The cap is sized to the compact cards so the
          // collapse animation does not leave a gap behind them.
          'shrink-0 px-3.5 md:px-6 grid grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3 transition-all duration-200 ease-out',
          collapsed
            ? 'max-h-0 pb-0 opacity-0 overflow-hidden'
            : 'max-h-[8.5rem] pb-2 opacity-100',
        )}
      >
        <StatCard icon={<Monitor className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Active Sessions" value={activeTotal} tint="#ff7e6b" />
        <StatCard icon={<Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Audit Events · 7d" value={stats?.auditEvents7d ?? 0} tint="#60a5fa" />
        <StatCard icon={<ShieldAlert className="h-3.5 w-3.5 sm:h-4 sm:w-4" />} label="Failed Logins · 24h" value={stats?.failedLogins24h ?? 0} tint="#ef4444" className="col-span-2 md:col-span-1" />
      </div>

      {/* Main scroll area: sessions and the activity log side by side on wide
          screens — the sessions card used to sit alone in this grid, leaving
          the second column empty above a full-width log. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pb-4 md:pb-6 space-y-3">
        {/* Two-Factor Authentication Card */}
        <Card className="rounded-2xl bg-card border-border p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={cn(
              "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
              verifiedFactor ? "bg-emerald-500/10 text-emerald-500" : "bg-primary/10 text-primary"
            )}>
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold">Two-Factor Authentication (2FA)</h4>
                {verifiedFactor ? (
                  <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[11px] gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Enabled
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground text-[11px]">
                    Not Configured
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {verifiedFactor
                  ? `Secured with authenticator app (TOTP) · Factor ID ${verifiedFactor.id.slice(0, 8)}…`
                  : 'Add an extra layer of protection using Google Authenticator, Authy, or 1Password'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {verifiedFactor ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => setUnenrollOpen(true)}
              >
                Disable 2FA
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleStartEnroll}
                disabled={mfaLoading}
              >
                {mfaLoading ? 'Loading…' : 'Enable 2FA'}
              </Button>
            )}
          </div>
        </Card>

        <div className="grid lg:grid-cols-2 gap-3">
          {/* Sessions */}
          <Card className="rounded-2xl bg-card border-border flex flex-col overflow-hidden py-0 gap-0">
            <div className="p-3 sm:p-4 border-b border-border flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm sm:text-base font-semibold flex items-center gap-2">
                  <Monitor className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary shrink-0" />
                  <span className="truncate">Active Sessions</span>
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">Every live sign-in, one row per device</p>
              </div>
              <Badge variant="secondary" className="bg-secondary/70 shrink-0">{activeTotal}</Badge>
            </div>
            <div className="lg:max-h-[440px] overflow-y-auto scrollbar-thin">
              <div className="p-2.5 sm:p-3 space-y-2">
                {sessions.length === 0 ? (
                  <div className="text-center py-6">
                    <Monitor className="h-7 w-7 text-muted-foreground mx-auto mb-2 opacity-50" />
                    <p className="text-[13px] text-muted-foreground">No active sessions</p>
                  </div>
                ) : (
                  sessions.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      revoking={revoking === s.id}
                      canRevoke={canManageSecurity}
                      viewerIsOwner={viewerIsOwnerFlag}
                      onRevoke={() => revokeSession(s.id, s.ids)}
                      users={users}
                    />
                  ))
                )}
              </div>
            </div>
          </Card>

          {/* Recent activity — the grid's second column on lg, stacked below
              the sessions list on a phone */}

        <Card className="rounded-2xl bg-card border-border flex flex-col overflow-hidden py-0 gap-0">
          <div className="p-3 sm:p-4 border-b border-border flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm sm:text-base font-semibold flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-primary shrink-0" />
                <span className="truncate">Recent Activity Log</span>
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">Audit trail of account activity</p>
            </div>
            <Badge variant="secondary" className="bg-secondary/70 shrink-0">{mergedLogs.length} events</Badge>
          </div>
          <div className="lg:max-h-[440px] max-h-80 overflow-y-auto scrollbar-thin">
            <div className="p-3 sm:p-4">
              {mergedLogs.length === 0 ? (
                <div className="text-center py-6">
                  <Activity className="h-7 w-7 text-muted-foreground mx-auto mb-2 opacity-50" />
                  <p className="text-[13px] text-muted-foreground">No activity recorded yet</p>
                </div>
              ) : (
                <div className="relative pl-4">
                  {/* timeline rail */}
                  <div className="absolute left-1.5 top-1 bottom-1 w-px bg-border" />
                  <div className="space-y-3">
                    {mergedLogs.map((log) => (
                      <LogItem key={log.id} log={log} timeZone={restaurantTimeZone} dateFormat={data?.settings?.pref_date_format || 'DD/MM/YYYY'} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          </Card>
        </div>
      </div>

      {/* Revoke all confirm */}
      <AlertDialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              Revoke all sessions?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will end every other signed-in device — staff PIN sessions and, for the owner, sign-ins on other browsers. The session you are using stays, so you are not locked out of the page you are on. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={revokeAllSessions}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {revoking === 'all' ? 'Revoking…' : 'Revoke All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 2FA Enrollment Modal */}
      <Dialog open={enrollModalOpen} onOpenChange={setEnrollModalOpen}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Enable Two-Factor Authentication
            </DialogTitle>
            <DialogDescription>
              Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password) or copy the setup key.
            </DialogDescription>
          </DialogHeader>

          {enrollingFactor && (
            <div className="space-y-4 py-2">
              <div className="flex justify-center p-4 bg-white rounded-xl border border-border">
                {enrollingFactor.totp.qr_code.startsWith('data:') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={enrollingFactor.totp.qr_code}
                    alt="2FA QR Code"
                    className="w-48 h-48"
                  />
                ) : (
                  <div
                    dangerouslySetInnerHTML={{ __html: enrollingFactor.totp.qr_code }}
                    className="w-48 h-48 flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Secret Key (Manual Entry):</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 p-2 bg-secondary/50 rounded-lg text-xs font-mono select-all break-all border border-border">
                    {enrollingFactor.totp.secret}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2.5"
                    onClick={() => {
                      navigator.clipboard.writeText(enrollingFactor.totp.secret)
                      toast.success('Secret key copied')
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium">Enter 6-Digit Verification Code:</p>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="123456"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, ''))}
                  className="font-mono text-center tracking-widest text-lg h-11"
                  autoFocus
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setEnrollModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleVerifyEnroll}
              disabled={enrolling || verificationCode.length < 6}
              className="bg-primary text-primary-foreground"
            >
              {enrolling ? 'Verifying…' : 'Verify & Enable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 2FA Unenroll Confirm */}
      <AlertDialog open={unenrollOpen} onOpenChange={setUnenrollOpen}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
              Disable Two-Factor Authentication?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Disabling 2FA will remove this extra security protection from your account. You will only need your password to log in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUnenroll}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Disable 2FA
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatCard({ icon, label, value, tint = '#ff7e6b', sub, className }: { icon: React.ReactNode; label: string; value: number; tint?: string; sub?: string; className?: string }) {
  return (
    // The Card primitive ships with py-6 and gap-6, which is a lot of air
    // for a number and a label. Both are overridden here, and the type and the
    // icon are sized for a phone.
    <Card className={cn("rounded-2xl bg-card border-border p-2.5 gap-0 sm:p-3", className)}>
      <div className="flex items-center gap-2.5 sm:gap-3">
        <div
          className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${tint}1a`, color: tint }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-lg sm:text-xl font-bold leading-none tabular-nums">{value}</p>
          <p className="text-[10.5px] sm:text-xs text-muted-foreground mt-0.5 leading-tight truncate">
            {label}{sub ? <span className="opacity-70"> · {sub}</span> : null}
          </p>
        </div>
      </div>
    </Card>
  )
}

function SessionItem({
  session, revoking, canRevoke, viewerIsOwner: viewerIsOwnerFlag, onRevoke, users = [],
}: {
  session: Session
  revoking: boolean
  canRevoke: boolean
  viewerIsOwner: boolean
  onRevoke: () => void
  users?: { id: string; name?: string; email?: string }[]
}) {
  const matchedUser = users.find((item) => item.id === session.userId)
  const u = session.user ?? matchedUser
  const emailVal = u?.email?.trim() || (session as any).email?.trim() || ''
  const emailPrefix = emailVal ? emailVal.split('@')[0] : ''
  const displayName =
    u?.name?.trim() ||
    (session as any).name?.trim() ||
    (session.kind === 'staff' ? (session.role ? `${session.role} Staff` : 'Staff Member') : (emailPrefix || 'Restaurant Owner'))
  const displayEmail = emailVal
  const createdTime = session.createdAt || (session as any).created_at
  const lastActiveTime = session.lastActive || (session as any).last_active || (session as any).updatedAt || (session as any).updated_at
  const createdAgo = timeAgo(createdTime)
  const activeAgo = timeAgo(lastActiveTime)
  const signInsSince = (session.count ?? 1) > 1 ? timeAgo(session.firstSeen ?? createdTime) : null
  // The label and the button, decided by the same rules the server enforces —
  // see src/lib/session-ui.ts. The current session is never revocable here;
  // an owner session is revocable only by the owner (on another device); a
  // staff session by anyone with security.manage.
  const right = sessionRight(canRevoke, viewerIsOwnerFlag, session)
  return (
    <div data-session-row={session.id} className="rounded-xl border border-border bg-secondary/30 p-3">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          {deviceIcon(session.device)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {/* The person, never the address. A profile with no name still gets
                a human label rather than a UUID. */}
            <p className="text-sm font-medium truncate">{displayName}</p>
            {session.kind === 'staff' && displayEmail && (
              <span className="text-xs text-muted-foreground">@{displayEmail}</span>
            )}
            {session.current && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 bg-emerald-500/15 text-emerald-400">
                <span className="w-1 h-1 rounded-full bg-emerald-400" />
                Current
              </Badge>
            )}
            {session.role && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                {session.role}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 break-words">
            {[session.browser, session.os, session.device].filter(Boolean).join(' · ') || 'Unknown client'}
            {signInsSince && (
              <span className="text-muted-foreground/80">
                {' '}· {session.count} sign-ins since {signInsSince}
              </span>
            )}
          </p>
          {/* When it was last used, in words. The full timestamps and the IP
              address used to sit behind a "Details" toggle here; the page is
              about which devices are signed in, not where they connected
              from, and the raw values added a step for no answer. */}
          <div className="flex items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] text-muted-foreground flex-wrap">
            {session.location && (
              <span className="inline-flex items-center gap-1 min-w-0 break-words">
                <MapPin className="h-3 w-3 shrink-0" />
                {session.location}
              </span>
            )}
            {createdAgo && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Signed in {createdAgo}
              </span>
            )}
            {activeAgo && (
              <span>
                · Active {activeAgo}
              </span>
            )}
          </div>
        </div>
        {right === 'current' && (
          <span className="shrink-0 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground">
            Current session
          </span>
        )}
        {right === 'protected' && (
          // A staff member may look but never end an owner's session — the
          // server answers 403, so the row says so instead of offering a
          // button that would fail.
          <span className="shrink-0 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground">
            Protected
          </span>
        )}
        {right === 'revoke' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={revoking}
            onClick={onRevoke}
            className="text-xs h-7 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {revoking ? 'Revoking…' : <><X className="h-3 w-3" /> Revoke</>}
          </Button>
        )}
      </div>
    </div>
  )
}

function LogItem({ log, timeZone = 'Asia/Kolkata', dateFormat = 'DD/MM/YYYY' }: { log: MergedSecurityLog; timeZone?: string; dateFormat?: string }) {
  const color = formatActionColor(log.action)
  const label = formatActionLabel(log.action)
  // The server resolves the actor (profile or staff, migration 0065). A failed
  // login is an *attempted* identity, so it is labelled as one and never
  // presented as the person it names.
  const actor = log.actor
  const isAttempt = actor?.kind === 'attempt' || log.action === 'LOGIN_FAILED'
  const actorName = actor?.name?.trim() || (isAttempt ? 'Unknown account' : 'System')

  const exactDateStr = formatExactDateTime(log.createdAt, timeZone, dateFormat)
  const ago = timeAgo(log.createdAt) ?? 'Recently'
  const detailsText = log.cleanDetails || log.meta

  return (
    <div data-log-row={log.id} className="relative">
      {/* dot */}
      <span
        className="absolute -left-3.5 top-1.5 w-3 h-3 rounded-full ring-2 ring-card"
        style={{ backgroundColor: color }}
      />
      <div className="rounded-xl border border-border bg-secondary/30 p-3 ml-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="secondary"
            className="text-[10px] h-5 font-semibold"
            style={{ backgroundColor: `${color}1a`, color }}
          >
            {label}
          </Badge>
          <span className="text-sm font-medium">
            {isAttempt ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="text-muted-foreground">Attempted:</span>
                {actorName}
              </span>
            ) : (
              actorName
            )}
          </span>
          {!isAttempt && actor?.role && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-normal">
              {actor.role}
            </Badge>
          )}
          <span
            className="text-[11px] text-muted-foreground ml-auto whitespace-nowrap"
            title={exactDateStr}
          >
            {exactDateStr ? `${exactDateStr} · ${ago}` : ago}
          </span>
        </div>
        {detailsText && (
          <div className="mt-1.5 flex items-center gap-x-2 gap-y-1 text-xs text-muted-foreground flex-wrap">
            <span className="break-words min-w-0 font-medium text-foreground/85">{detailsText}</span>
          </div>
        )}
      </div>
    </div>
  )
}
