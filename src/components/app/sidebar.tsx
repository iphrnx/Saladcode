'use client'

import { useStore, ViewKey } from '@/lib/store'
import { useApp } from './data-context'
import { cn } from '@/lib/utils'
import {
  LayoutGrid, ClipboardList, BarChart3, BookOpen,
  QrCode, Ticket, ShieldCheck, Users, Settings,
  LogOut, UtensilsCrossed,
} from 'lucide-react'
import { useT } from '@/lib/i18n'
import { signOutAndLeave } from '@/lib/sign-out'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { canView } from '@/lib/permissions'

// label and desc are dictionary keys, resolved at render so the sidebar
// follows the chosen language. `short` stays literal: it is a compact rail
// label, not prose.
const NAV: { key: ViewKey; label: string; short: string; icon: any; desc: string }[] = [
  { key: 'dashboard', label: 'nav.dashboard', short: 'POS', icon: LayoutGrid, desc: 'nav.dashboard.desc' },
  { key: 'orders', label: 'nav.orders', short: 'Orders', icon: ClipboardList, desc: 'nav.orders.desc' },
  { key: 'analytics', label: 'nav.analytics', short: 'Stats', icon: BarChart3, desc: 'nav.analytics.desc' },
  { key: 'menu', label: 'nav.menu', short: 'Menu', icon: BookOpen, desc: 'nav.menu.desc' },
  { key: 'qr', label: 'nav.qr', short: 'QR', icon: QrCode, desc: 'nav.qr.desc' },
  { key: 'promos', label: 'nav.promos', short: 'Promos', icon: Ticket, desc: 'nav.promos.desc' },
  { key: 'roles', label: 'nav.roles', short: 'Roles', icon: Users, desc: 'nav.roles.desc' },
  { key: 'security', label: 'nav.security', short: 'Secure', icon: ShieldCheck, desc: 'nav.security.desc' },
  { key: 'settings', label: 'nav.settings', short: 'Settings', icon: Settings, desc: 'nav.settings.desc' },
]

export function Sidebar() {
  const { view, setView } = useStore()
  const t = useT()
  const { data } = useApp()
  // Only the modules this role can open. `dashboard.view` says a staff member
  // may use the dashboard; it does not put every module in the rail.
  const nav = NAV.filter((item) => canView(data?.permissions, item.key))

  return (
    <TooltipProvider delayDuration={200}>
      <aside className="hidden md:flex flex-col items-center gap-1 w-[76px] shrink-0 border-r border-border bg-sidebar py-4">
        {/* Logo */}
        <div className="mb-4 flex flex-col items-center gap-1">
          <div className="relative w-11 h-11 rounded-2xl bg-gradient-to-br from-primary to-primary-hover flex items-center justify-center shadow-glow-primary">
            <span className="text-white font-bold text-xl">S</span>
            <span className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/20" />
          </div>
        </div>

        <nav className="flex-1 flex flex-col gap-1 overflow-y-auto scrollbar-thin px-2 w-full items-center">
          {nav.map((item) => {
            const active = view === item.key
            const Icon = item.icon
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setView(item.key)}
                    aria-label={t(item.label)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex h-11 w-11 items-center justify-center rounded-xl transition-premium',
                      active
                        ? 'bg-primary/15 text-primary shadow-glow-primary'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                    )}
                  >
                    <Icon className="h-[22px] w-[22px] transition-transform group-hover:scale-110" strokeWidth={active ? 2.4 : 2} />
                    {active && (
                      <span className="absolute -left-2 top-1/2 -translate-y-1/2 h-7 w-1 rounded-full bg-gradient-to-b from-primary to-primary-hover" />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="font-medium">
                  {t(item.label)}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </nav>

        {/* User + logout */}
        <div className="mt-2 flex flex-col items-center gap-2 px-2 w-full">
          <div className="h-px w-8 bg-gradient-to-r from-transparent via-border to-transparent" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Sign out"
                onClick={signOutAndLeave}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-premium"
              >
                <LogOut className="h-[22px] w-[22px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Sign out</TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  )
}

/** Main menu hamburger side panel — left drawer with all views */
export function MobileMoreSheet() {
  const { view, setView, sidebarOpen, setSidebarOpen } = useStore()
  const t = useT()
  const { data } = useApp()
  // Same list as the rail: the phone sheet must not offer modules the rail hides.
  const nav = NAV.filter((item) => canView(data?.permissions, item.key))
  return (
    <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <SheetContent side="left" className="w-[300px] sm:w-[340px] p-0 bg-sidebar border-r border-border">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-md shadow-primary/20">
              <span className="text-white font-bold text-lg">S</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{data?.tenant.name || 'The Salad'}</p>
              <p className="text-xs text-muted-foreground font-normal truncate">{data?.tenant.tagline || 'Restaurant SaaS'}</p>
            </div>
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 pt-1 pb-2">Main Menu</p>
          {nav.map((item) => {
            const active = view === item.key
            const Icon = item.icon
            return (
              <button
                key={item.key}
                onClick={() => { setView(item.key); setSidebarOpen(false) }}
                className={cn(
                  'flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left transition-all',
                  active ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-secondary'
                )}
              >
                <span className={cn('flex items-center justify-center w-9 h-9 rounded-lg shrink-0', active ? 'bg-primary/20' : 'bg-secondary/60')}>
                  <Icon className="h-[18px] w-[18px]" strokeWidth={active ? 2.5 : 2} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{t(item.label)}</span>
                  <span className="block text-[11px] text-muted-foreground truncate">{t(item.desc)}</span>
                </span>
                {active && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
              </button>
            )
          })}

          <div className="pt-3 mt-3 border-t border-border">
            {/*
              This had no onClick: the label and the icon were there, and
              nothing happened when you tapped it. On a phone that left no way
              out of the dashboard at all. Its muted colour made it look
              disabled, which is probably why it was read as deliberate.
            */}
            <button
              onClick={signOutAndLeave}
              className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-foreground hover:bg-secondary transition-all"
            >
              <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-secondary/60 shrink-0">
                <LogOut className="h-[18px] w-[18px]" />
              </span>
              <span className="text-sm font-medium">Sign out</span>
            </button>
          </div>

          <div className="pt-3 mt-1 px-3">
            <div className="flex items-center gap-2 rounded-xl bg-secondary/30 p-3">
              <UtensilsCrossed className="h-4 w-4 text-primary shrink-0" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {data?.tenant.plan === 'pro' ? 'Pro Plan' : 'Starter Plan'} · {data?.users.length || 0} staff members
              </p>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
