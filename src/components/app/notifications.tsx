'use client'

import { useMemo, useState } from 'react'
import { useApp } from '@/components/app/data-context'
import { useStore } from '@/lib/store'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Bell, ChefHat, CalendarClock, PackageX, ShieldAlert, CheckCircle2, Inbox } from 'lucide-react'
import { readStored, writeStored } from '@/lib/storage-keys'

/** How long a "seen" mark lasts before everything counts as unread again. */


type Kind = 'order' | 'ready' | 'reservation' | 'soldout' | 'security'

interface Notice {
  id: string
  kind: Kind
  title: string
  body: string
  at: number
  view?: string
  /** How many things this one line stands for, when it is an aggregate. */
  count?: number
}

const TONES: Record<Kind, { icon: typeof Bell; cls: string }> = {
  order: { icon: ChefHat, cls: 'bg-primary/15 text-primary' },
  ready: { icon: CheckCircle2, cls: 'bg-emerald-500/15 text-emerald-500' },
  reservation: { icon: CalendarClock, cls: 'bg-blue-500/15 text-blue-500' },
  soldout: { icon: PackageX, cls: 'bg-amber-500/15 text-amber-500' },
  security: { icon: ShieldAlert, cls: 'bg-destructive/15 text-destructive' },
}

/** "12 min ago", then a date once that stops being useful. */
function ago(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/**
 * Notifications, derived from data the app already holds.
 *
 * There is no notifications table and none is needed: every one of these is a
 * fact already loaded — an order nobody has started, a dish that is off, a
 * booking due shortly, a failed sign-in. They also clear themselves. Starting a
 * pending order or marking a dish available removes it from this list, so
 * nothing has to be dismissed and nothing can go stale.
 *
 * The one piece of local state is a "seen" timestamp, so the dot clears when the
 * menu is opened rather than sitting there until the underlying work is done.
 */
export function Notifications() {
  const { data } = useApp()
  const { setView } = useStore()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [seenAt, setSeenAt] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return Number(readStored('notificationsSeen') || 0)
  })
  const [clearedAt, setClearedAt] = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return Number(readStored('notificationsCleared') || 0)
  })

  const notices = useMemo<Notice[]>(() => {
    if (!data) return []
    const out: Notice[] = []
    const now = Date.now()

    /**
     * One line per kind of thing, not one line per order.
     *
     * Listing five near-identical "Order #x has not been started" rows buries
     * the one fact that matters — how many are waiting and how long the oldest
     * has been. Counts collapse into a single entry that says both, and the
     * entry clears itself as the orders are started.
     */
    const pending = (data.orders ?? []).filter((o) => o.status === 'PENDING')
    if (pending.length > 0) {
      const oldest = Math.min(...pending.map((o) => new Date(o.createdAt).getTime()))
      const hrs = Math.floor((now - oldest) / 3600000)
      out.push({
        id: 'orders-pending', kind: 'order', view: 'orders', count: pending.length,
        title: pending.length === 1
          ? `Order #${pending[0].orderNumber} has not been started`
          : `${pending.length} orders have not been started`,
        body: pending.length === 1
          ? (pending[0].table?.name ? `${pending[0].table.name} · waiting to be prepared` : 'Waiting to be prepared')
          : `Oldest is ${hrs < 1 ? 'under an hour' : hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)} days`} old`,
        // the newest, so a fresh order is what lights the bell
        at: Math.max(...pending.map((o) => new Date(o.createdAt).getTime())),
      })
    }

    const ready = (data.orders ?? []).filter((o) => o.status === 'READY')
    if (ready.length > 0) {
      out.push({
        id: 'orders-ready', kind: 'ready', view: 'orders', count: ready.length,
        title: ready.length === 1 ? `Order #${ready[0].orderNumber} is ready to serve` : `${ready.length} orders are ready to serve`,
        body: ready.length === 1 && ready[0].table?.name ? ready[0].table.name : 'Waiting to be carried out',
        at: Math.max(...ready.map((o) => new Date(o.createdAt).getTime())),
      })
    }

    // Bookings stay individual — they are few, and each is a specific person.
    const today = new Date().toISOString().slice(0, 10)
    for (const r of data.reservations ?? []) {
      if (r.status === 'CANCELLED' || r.status === 'SEATED') continue
      const when = new Date(`${r.date}T${(r.time || '00:00').slice(0, 5)}:00`).getTime()
      if (Number.isNaN(when)) continue
      if (r.date !== today && !(when < now && when > now - 6 * 60 * 60 * 1000)) continue
      out.push({
        id: `res-${r.id}`, kind: 'reservation', view: 'orders',
        title: `${r.name} · ${r.partySize} ${r.partySize === 1 ? 'guest' : 'guests'}`,
        body: `${r.date === today ? 'Today' : r.date} at ${r.time}${r.table?.name ? ` · ${r.table.name}` : ''}`,
        at: when,
      })
    }

    const soldOut = (data.menuItems ?? []).filter((m) => !m.available)
    if (soldOut.length > 0) {
      out.push({
        id: 'menu-soldout', kind: 'soldout', view: 'menu', count: soldOut.length,
        title: soldOut.length === 1 ? `${soldOut[0].name} is unavailable` : `${soldOut.length} dishes are unavailable`,
        body: 'Not orderable until switched back on',
        at: now,
      })
    }

    const failed = (data.securityLogs ?? []).filter(
      (l) => l.action === 'LOGIN_FAILED' && now - new Date(l.createdAt).getTime() < 24 * 3600000,
    )
    if (failed.length > 0) {
      out.push({
        id: 'security-failed', kind: 'security', view: 'security', count: failed.length,
        title: failed.length === 1 ? 'A sign-in attempt failed' : `${failed.length} sign-in attempts failed`,
        body: 'In the last 24 hours',
        at: Math.max(...failed.map((l) => new Date(l.createdAt).getTime())),
      })
    }

    return out.sort((a, b) => b.at - a.at)
  }, [data])

  const activeNotices = useMemo(
    () => notices.filter((n) => n.at > clearedAt),
    [notices, clearedAt],
  )

  const unread = activeNotices.filter((n) => n.at > seenAt).length

  const openMenu = (next: boolean) => {
    setOpen(next)
    if (next) {
      const now = Date.now()
      setSeenAt(now)
      writeStored('notificationsSeen', String(now))
    }
  }

  const handleClearAll = () => {
    const now = Date.now()
    setClearedAt(now)
    setSeenAt(now)
    writeStored('notificationsCleared', String(now))
    writeStored('notificationsSeen', String(now))
  }

  return (
    <DropdownMenu open={open} onOpenChange={openMenu}>
      <DropdownMenuTrigger asChild>
        <button
          className="relative h-9 w-9 rounded-xl border border-border bg-secondary/40 hover:bg-secondary items-center justify-center transition-colors hidden sm:flex"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell className="h-4 w-4 text-muted-foreground" />
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center ring-2 ring-background">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>

      {/* Width is capped against the viewport so the panel cannot run off a
          narrow screen, and the list gets its own scroll area bounded by the
          viewport rather than a fixed pixel height — otherwise it overflows a
          short window with no way to reach the rest. */}
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        className="w-[min(360px,calc(100vw-1rem))] p-0 bg-card border-border"
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{t('notifications.title')}</span>
            {activeNotices.length > 0 && (
              <Badge variant="secondary" className="bg-secondary/70 text-[10px]">{activeNotices.length}</Badge>
            )}
          </div>
          {activeNotices.length > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleClearAll()
              }}
              className="text-[11px] font-medium text-muted-foreground hover:text-primary transition-colors cursor-pointer"
            >
              Clear all
            </button>
          )}
        </div>

        {activeNotices.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <Inbox className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{t('notifications.empty')}</p>
          </div>
        ) : (
          <div className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain scrollbar-thin">
            {activeNotices.map((n) => {
              const tone = TONES[n.kind]
              const Icon = tone.icon
              return (
                <button
                  key={n.id}
                  onClick={() => { if (n.view) setView(n.view as never); setOpen(false) }}
                  className="w-full text-left px-3 py-2.5 flex gap-3 hover:bg-secondary/50 transition-colors border-b border-border/40 last:border-0"
                >
                  <span className={cn('mt-0.5 h-7 w-7 shrink-0 rounded-lg flex items-center justify-center', tone.cls)}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span className="flex-1 text-[13px] font-medium leading-snug">{n.title}</span>
                      {typeof n.count === 'number' && n.count > 1 && (
                        <span className="mt-0.5 shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {n.count}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground mt-0.5 leading-snug">{n.body}</span>
                    <span className="block text-[11px] text-muted-foreground/70 mt-1">{ago(n.at)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
