'use client'

import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AppDataProvider, useApp } from './data-context'
import { Sidebar, MobileMoreSheet } from './sidebar'
import { Header } from './header'
import { useStore } from '@/lib/store'
import { initTheme } from '@/lib/theme'
import { DashboardView } from '@/components/views/dashboard'
import { OrdersView } from '@/components/views/orders'
import { AnalyticsView } from '@/components/views/analytics'
import { MenuView } from '@/components/views/menu'
import { QrView } from '@/components/views/qr'
import { PromosView } from '@/components/views/promos'
import { RolesView } from '@/components/views/roles'
import { SecurityView } from '@/components/views/security'
import { SettingsView } from '@/components/views/settings'
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow'
import { TrialBanner } from '@/components/app/trial-banner'
import { canView, firstAllowedView } from '@/lib/permissions'
import { AccessDeniedForView } from '@/components/shared/access-denied'
import { AccessDenied } from '@/components/shared/access-denied'

function ShellLoading() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-primary/15 flex items-center justify-center pulse-ring">
          <div className="w-7 h-7 rounded-lg bg-primary" />
        </div>
        <p className="text-sm text-muted-foreground">Loading your restaurant…</p>
      </div>
    </div>
  )
}

function ViewRouter() {
  const { view } = useStore()
  const { data } = useApp()
  const router = useRouter()

  // A view is refused before it mounts, not after it has fired its requests.
  //
  // The sidebar only offers what a role holds, but the sidebar is not the only
  // way in: `?view=settings` seeds the store from the URL, and this switch used
  // to render whatever the store held. A role without `settings.view` was given
  // the Settings screen, which then failed its own calls and reported "Failed
  // to load" — a broken page rather than a missing permission.
  //
  // The refused view is not shown a full-page "Access Denied" either. The role
  // has somewhere it may go — `firstAllowedView` — so it is moved there, the
  // same way the staff shell moves a restricted login to its first module. The
  // denial screen is kept only for the pathological role with no permitted view
  // at all, where there is nowhere to move to and the loop would be worse.
  const permitted = canView(data?.permissions, view)
  const landing = permitted ? null : firstAllowedView(data?.permissions)

  // `replace`, not `push`: Back must not re-enter the refused view.
  useEffect(() => {
    if (landing && landing !== view) router.replace(`/?view=${landing}`)
  }, [landing, view, router])

  if (!permitted) {
    if (landing && landing !== view) return null
    return <AccessDeniedForView view={view} />
  }

  switch (view) {
    case 'dashboard': return <DashboardView />
    case 'orders': return <OrdersView />
    case 'analytics': return <AnalyticsView />
    case 'menu': return <MenuView />
    case 'qr': return <QrView />
    case 'promos': return <PromosView />
    case 'roles': return <RolesView />
    case 'security': return <SecurityView />
    case 'settings': return <SettingsView />
    // Billing is the subscription, and it lives inside Settings as a tab.
    // Rendering it as a view of its own is what the trial banner's "See plans"
    // has always meant; without this case the switch fell through to the
    // default and that button opened the POS instead.
    case 'billing': return <SettingsView />
    default: return <DashboardView />
  }
}

const VIEW_KEYS = new Set<string>([
  'dashboard', 'orders', 'analytics', 'promos', 'qr',
  'menu', 'settings', 'security', 'roles', 'billing', 'location-onboarding',
])

function ShellContent() {
  const { data, loading, error, refresh, setTenantId } = useApp()
  const router = useRouter()
  const searchParams = useSearchParams()
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)

  // Deep links: /?view=orders used to always render the dashboard, because the
  // view lives in the zustand store and nothing ever seeded it from the URL.
  // Applied once per distinct param value — re-applying on every render would
  // fight the sidebar, which changes the store without touching the URL.
  const appliedViewRef = useRef<string | null>(null)
  useEffect(() => {
    const requested = searchParams.get('view')
    if (!requested || requested === appliedViewRef.current) return
    appliedViewRef.current = requested
    if (VIEW_KEYS.has(requested)) setView(requested as Parameters<typeof setView>[0])
  }, [searchParams, setView])

  // Initialize theme from localStorage on mount
  useEffect(() => {
    initTheme()
  }, [])

  // No tenant in DB — send to onboarding wizard
  useEffect(() => {
    if (error === 'NO_TENANT') {
      router.replace('/?view=onboarding')
    }
  }, [error, router])

  // A tenant whose setup never finished — or one with a saved setup draft —
  // belongs in the wizard at the exact step it stopped, not in an empty
  // dashboard with no way back to setup. Staff sessions are exempt: the
  // wizard is an owner screen.
  useEffect(() => {
    if (!data) return
    const payload = data as any
    if (payload.currentStaff) return
    const tenant = payload.tenant
    if (!tenant) return
    const hasDraft = Boolean(payload.settings?.['onboarding_draft'])
    if (tenant.onboardingDone === false || hasDraft) {
      router.replace('/?view=onboarding')
    }
  }, [data, router])

  if (loading && !data) {
    return <ShellLoading />
  }

  if (error && !data) {
    // No restaurant yet is a normal first-run state, not a failure — the effect
    // above is already on its way to the wizard, and an error screen in the
    // meantime would be a flash of bad news about nothing.
    if (error === 'NO_TENANT') return <ShellLoading />
    // A 401, a 403 and a 500 used to print the same two words, "Failed to load",
    // with the raw message underneath — so an expired session read as a broken
    // app. Each now says what it is and what to do about it.
    return (
      <div className="min-h-[100dvh] bg-background">
        <AccessDenied failure={error} subject="your restaurant" onRetry={refresh} />
      </div>
    )
  }

  if (view === 'location-onboarding') {
    return (
      <div className="min-h-[100dvh] w-full overflow-y-auto bg-background">
        <OnboardingFlow
          isLocationMode
          onCancel={() => setView('dashboard')}
          onCompleteLocation={async (newLoc) => {
            if (newLoc?.id) setTenantId(newLoc.id)
            setView('dashboard')
            await refresh()
          }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <TrialBanner />
        {/* main fills remaining height — navigation is via the hamburger menu in the header */}
        <main className="flex-1 overflow-hidden min-h-0">
          <ViewRouter />
        </main>
      </div>
      <MobileMoreSheet />
    </div>
  )
}

export function AppShell() {
  return (
    <AppDataProvider>
      <ShellContent />
    </AppDataProvider>
  )
}
