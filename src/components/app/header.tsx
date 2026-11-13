'use client'

import { useState } from 'react'
import { useApp } from './data-context'
import { useStore } from '@/lib/store'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Search, ChevronDown, Building2, Check, Menu as MenuIcon, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { edgeFetch } from '@/lib/edge'
import { signOutAndLeave } from '@/lib/sign-out'
import { Notifications } from '@/components/app/notifications'
import { GlobalSearch } from '@/components/app/global-search'
import { useT } from '@/lib/i18n'

export function Header() {
  const { data, setTenantId, refresh } = useApp()
  const t = useT()
  const { view, setSidebarOpen, setView, setSettingsTab } = useStore()
  const [tenants, setTenants] = useState<any[] | null>(null)
  const [openTenants, setOpenTenants] = useState(false)

  const openSettingsTab = (tab: string) => {
    setSettingsTab(tab)
    setView('settings')
  }

  const loadTenants = async () => {
    try {
      const res = await edgeFetch('/api/tenants')
      const json = await res.json()
      if (Array.isArray(json)) {
        setTenants(json)
      }
    } catch {
      // fallback
    }
  }

  const switchTenant = async (id: string, name: string) => {
    setTenantId(id)
    setOpenTenants(false)
    toast.success(`Switched to ${name}`)
    setTimeout(() => refresh(), 50)
  }

  // Shared with the rail and the phone drawer — see src/lib/sign-out.ts. This
  // was the reference copy; the drawer's had no handler at all.
  const handleLogout = signOutAndLeave

  if (!data) return null
  const { tenant, currentUser } = data

  const titles: Record<string, string> = {
    dashboard: 'Point of Sale',
    orders: 'Orders',
    analytics: 'Analytics',
    menu: 'Menu Management',
    qr: 'QR Codes',
    promos: 'Promo Codes',
    roles: 'Role Access',
    security: 'Security',
    settings: 'Settings',
  }

  return (
    <header className="flex items-center justify-between gap-2 md:gap-3 px-3.5 md:px-6 h-14 md:h-16 border-b border-border glass-strong sticky top-0 z-30">
      <div className="flex items-center gap-2 min-w-0">
        {/* Hamburger — opens main menu side panel (mobile only) */}
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Open main menu"
          className="md:hidden shrink-0 flex items-center justify-center w-10 h-10 rounded-xl border border-border bg-secondary/40 hover:bg-secondary hover:border-primary/30 transition-premium"
        >
          <MenuIcon className="h-5 w-5 text-foreground" />
        </button>
        <div className="min-w-0">
          <h1 className="text-base md:text-lg font-semibold truncate tracking-tight">{titles[view] || 'The Salad'}</h1>
          <p className="text-xs text-muted-foreground hidden sm:block truncate">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3">
        {/* Search — desktop only */}
        <GlobalSearch />

        {/* Tenant switcher */}
        <DropdownMenu open={openTenants} onOpenChange={(o) => { setOpenTenants(o); if (o && !tenants) loadTenants() }}>
          <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/40 hover:bg-secondary px-2 py-1.5 transition-colors">
            <div className="w-5 h-5 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
              <Building2 className="h-3 w-3 text-primary" />
            </div>
            <span className="text-xs font-medium hidden sm:block max-w-[120px] truncate">{tenant.name}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Locations</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-bold text-primary">
                {(tenants?.length || 1)}/3 on Pro
              </span>
            </div>
            <DropdownMenuSeparator />
            {(tenants || [{ id: tenant.id, name: tenant.name, plan: 'pro', area: 'Connaught Place' }]).map((t: any) => (
              <DropdownMenuItem
                key={t.id}
                onClick={() => switchTenant(t.id, t.name)}
                className="flex items-center justify-between py-2 cursor-pointer"
              >
                <div className="flex flex-col min-w-0 pr-2">
                  <span className="text-xs font-semibold truncate text-foreground">{t.name}</span>
                  <span className="text-[10px] text-muted-foreground truncate">
                    {t.area ? `${t.area} · ` : ''}Pro plan
                  </span>
                </div>
                {t.id === tenant.id ? (
                  <Check className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <span className="text-[10px] font-medium text-muted-foreground hover:text-foreground">Switch</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="p-1">
              {(tenants?.length || 1) < 3 ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpenTenants(false)
                    setView('location-onboarding')
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/40 bg-primary/5 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Location (up to 3 on Pro)
                </button>
              ) : (
                <div className="px-2 py-1.5 text-center text-[11px] text-muted-foreground">
                  Pro limit reached (3/3 locations)
                </div>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Notifications — hide on small screens to avoid cramping */}
        <Notifications />

        {/* User */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 rounded-xl border border-border bg-secondary/40 hover:bg-secondary pl-1.5 pr-2 py-1 transition-colors">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="bg-primary/20 text-primary text-xs font-semibold">
                {currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div className="hidden sm:flex flex-col items-start leading-tight">
              <span className="text-xs font-medium">{currentUser.name}</span>
              <span className="text-[10px] text-muted-foreground">{currentUser.role}</span>
            </div>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{currentUser.name}</span>
                <span className="text-xs text-muted-foreground">{currentUser.email}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openSettingsTab('profile')} className="cursor-pointer">
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openSettingsTab('preferences')} className="cursor-pointer">
              Preferences
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive cursor-pointer" onClick={handleLogout}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
