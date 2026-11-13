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
  Shield, ShieldAlert, Activity, Monitor, Smartphone, Tablet, LogOut, MapPin, Clock, AlertTriangle, X,
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

const LOG_COLORS: Record<string, string> = {
  LOGIN: '#4ade80',
  LOGIN_FAILED: '#ef4444',
  SETTINGS_CHANGE: '#60a5fa',
  ROLE_CHANGE: '#c084fc',
  PASSWORD_CHANGE: '#fbbf24',
  PROMO_CREATED: '#ff7e6b',
  LOGOUT: '#9aa3b2',
  SESSION_REVOKED: '#f97316',
  ORDER_CANCELLED: '#f97316',
  ORDER_DELETED: '#ef4444',
}

const LOG_LABELS: Record<string, string> = {
  LOGIN: 'Login',
  LOGIN_FAILED: 'Failed Login',
  SETTINGS_CHANGE: 'Settings Change',
  ROLE_CHANGE: 'Role Change',
  PASSWORD_CHANGE: 'Password Change',
  PROMO_CREATED: 'Promo Created',
  LOGOUT: 'Logout',
  SESSION_REVOKED: 'Session Revoked',
  ORDER_CANCELLED: 'Order Cancelled',
  ORDER_DELETED: 'Order Deleted',
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

  const sessions = data?.sessions ?? []
  const logs = data?.securityLogs ?? []
  const users = data?.users ?? []
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
            <Badge variant="secondary" className="bg-secondary/70 shrink-0">{logs.length} events</Badge>
          </div>
          <div className="lg:max-h-[440px] max-h-80 overflow-y-auto scrollbar-thin">
            <div className="p-3 sm:p-4">
              {logs.length === 0 ? (
                <div className="text-center py-6">
                  <Activity className="h-7 w-7 text-muted-foreground mx-auto mb-2 opacity-50" />
                  <p className="text-[13px] text-muted-foreground">No activity recorded yet</p>
                </div>
              ) : (
                <div className="relative pl-4">
                  {/* timeline rail */}
                  <div className="absolute left-1.5 top-1 bottom-1 w-px bg-border" />
                  <div className="space-y-3">
                    {logs.map((log) => (
                      <LogItem key={log.id} log={log} />
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

function LogItem({ log }: { log: SecurityLog }) {
  const color = LOG_COLORS[log.action] || '#9aa3b2'
  const label = LOG_LABELS[log.action] || log.action
  // The server resolves the actor (profile or staff, migration 0065). A failed
  // login is an *attempted* identity, so it is labelled as one and never
  // presented as the person it names.
  const actor = log.actor
  const isAttempt = actor?.kind === 'attempt' || log.action === 'LOGIN_FAILED'
  const actorName = actor?.name?.trim() || (isAttempt ? 'Unknown account' : 'System')
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
            className="text-[10px] h-5"
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
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {actor.role}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground ml-auto">{timeAgo(log.createdAt) ?? 'Recently'}</span>
        </div>
        {log.meta && (
          <div className="mt-1.5 flex items-center gap-x-2 gap-y-1 text-xs text-muted-foreground flex-wrap">
            <span className="break-words min-w-0">{log.meta}</span>
          </div>
        )}
      </div>
    </div>
  )
}
