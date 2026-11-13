'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { edgeFetch, staffFetch } from '@/lib/edge'
import { AppShell } from '@/components/app/app-shell'
import { PublicMenu } from '@/components/public/public-menu'
import { LandingPage } from '@/components/landing/landing-page'
import { OnboardingFlow } from '@/components/onboarding/onboarding-flow'
import { LoginPage } from '@/components/auth/login-page'
import { StaffLoginPage } from '@/components/staff/staff-login'
import { StaffDashboard } from '@/components/staff/staff-dashboard'
import { ResetPasswordView } from '@/components/auth/reset-password'
import { MagicLinkForwarder } from '@/components/auth/magic-link-forwarder'
import { ConfirmEmailView } from '@/components/auth/confirm-email'

// Views that require a logged-in owner session
const PROTECTED_VIEWS = ['onboarding', 'dashboard', '']

function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    edgeFetch('/api/auth/me').then(async res => {
        if (res.ok) {
          // The server decides which shell this session belongs to. A request
          // carrying a valid staff session always answers "staff" — even when
          // an owner session also exists in the same browser — so a staff PIN
          // user is never rendered the owner shell, no matter the URL they
          // typed or refreshed, and whether or not they could reach the owner's
          // session. See auth/me.
          const body = await res.json().catch(() => null)
          if (body?.sessionKind === 'staff') {
            window.location.href = '/?view=staff-dashboard'
            return
          }
          setChecked(true)
          return
        }
        // Not an owner session — but it may still be a staff one. A staff member
        // who types an app URL (`/?view=orders`) has no owner bearer, so this used
        // to send them to the owner login page: told to sign in as someone they
        // are not, with no way back to the shell their role does open. Their own
        // shell is the honest destination, and it enforces their permissions.
        staffFetch('/api/staff/me')
          .then(sres => {
            if (sres.ok) window.location.href = '/?view=staff-dashboard'
            else router.replace('/?view=login')
          })
          .catch(() => router.replace('/?view=login'))
      }).catch(() => router.replace('/?view=login'))
  }, [router])

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center pulse-ring">
            <div className="w-6 h-6 rounded-md bg-primary" />
          </div>
          <p className="text-sm text-muted-foreground">Checking session…</p>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

function PageContent() {
  const searchParams = useSearchParams()
  const view = searchParams.get('view') ?? ''

  // Public views — no auth required
  //
  // A password-reset email lands here with a one-time `code`, either because the
  // link asked for ?view=reset-password or because Supabase fell back to the
  // project's Site URL — which happens whenever the redirect target is not on
  // the allow list. Treating a bare code at the root as a reset link means the
  // email works either way, with no dashboard configuration required.
  if (view === 'reset-password') return <ResetPasswordView />
  // Where a signup confirmation link lands. The link's tokens arrive in the
  // fragment, which never reaches the server, so this view is what turns them
  // into a session and routes the owner into the app.
  if (view === 'confirm-email') return <ConfirmEmailView />
  if (view === '' && (searchParams.has('code') || searchParams.get('type') === 'recovery')) {
    return <ResetPasswordView />
  }
  // A scan is keyed by its token, so a new scan remounts the menu.
  //
  // Without this, scanning a second table's QR while the menu was already
  // open changed the URL but not the component: React keeps the same
  // element, the session effect does not re-run, and the diner was left
  // looking at the previous table's menu — or at the "session ended" screen
  // with a fresh QR code in their hand. A scan has to be treated as a new
  // event every time, and a remount is the honest way to say that.
  //
  // The key comes from the router's own view of the URL. The menu strips
  // `?table=` from the address bar with history.replaceState, which does not
  // touch the router state, so the key stays put for the life of the scan and
  // only changes when a genuinely different QR is opened.
  if (view === 'public-menu' || searchParams.has('table')) {
    return <PublicMenu key={searchParams.get('table') ?? 'session'} />
  }
  if (view === 'landing') return <LandingPage />
  if (view === 'login') return <LoginPage />
  if (view === 'staff-login') return <StaffLoginPage />
  if (view === 'staff-dashboard') return <StaffDashboard />

  // Default (/) → landing page
  if (view === '') return <LandingPage />

  // Protected views
  if (view === 'onboarding') {
    return (
      <AuthGate>
        <OnboardingFlow />
      </AuthGate>
    )
  }

  // Dashboard + any other view → full app shell (also handles NO_TENANT → onboarding redirect)
  return (
    <AuthGate>
      <AppShell />
    </AuthGate>
  )
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center pulse-ring">
            <div className="w-6 h-6 rounded-md bg-primary" />
          </div>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    }>
      <PageContent />
      <MagicLinkForwarder />
    </Suspense>
  )
}
