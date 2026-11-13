'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MailCheck, MailX } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { edgeFetch } from '@/lib/edge'
import { createClient } from '@/lib/supabase/client'

/**
 * Where an email-confirmation link lands.
 *
 * Supabase delivers the confirmation in one of two shapes, and the browser can
 * only reach one of them:
 *
 *   ?code=…                 PKCE — the code arrives in the query string
 *   #access_token=…&…       implicit — the tokens arrive in the fragment
 *
 * Either way this view does the same three things: establish the owner's
 * session, send them where their setup actually is (the wizard at the exact
 * unfinished step, or the dashboard), and never leave the credentials sitting
 * in the address bar.
 *
 * A link can only be consumed once, but a person can arrive here many times —
 * the back button, a refresh, a mail client that opens the link in a preview.
 * Every path that finds the tokens already used falls back to the session the
 * first visit established, so a duplicate never turns into an error the owner
 * has to think about.
 */
export function ConfirmEmailView() {
  const router = useRouter()
  const [status, setStatus] = useState<'working' | 'needs-email' | 'error'>('working')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [resending, setResending] = useState(false)
  const ranRef = useRef(false)

  /** An account that never finished setup resumes in the wizard, not an empty dashboard. */
  const routeByAccount = async () => {
    try {
      const res = await edgeFetch('/api/auth/me')
      const body = await res.json().catch(() => null)
      if (res.ok && body?.authenticated) {
        router.replace(body.tenant?.onboardingDone === false ? '/?view=onboarding' : '/?view=dashboard')
        return
      }
    } catch {
      /* fall through to the login screen */
    }
    router.replace('/?view=login')
  }

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    ;(async () => {
      const supabase = createClient()

      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
      const fragmentParams = new URLSearchParams(hash)
      const accessToken = fragmentParams.get('access_token')
      const refreshToken = fragmentParams.get('refresh_token')
      const code = new URLSearchParams(window.location.search).get('code')

      // The tokens are one-use credentials. They have done their job the moment
      // they are read, so they do not stay in the address bar for a refresh, a
      // share, or the browser history to hold.
      if (accessToken || code) {
        window.history.replaceState({}, '', '/?view=confirm-email')
      }

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        if (!error) return routeByAccount()
        // Used or expired — a session from an earlier click still counts.
        const { data: { session } } = await supabase.auth.getSession()
        if (session) return routeByAccount()
        setStatus('error')
        setMessage('That confirmation link has already been used or has expired.')
        return
      }

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code)
        if (!error) return routeByAccount()
        const { data: { session } } = await supabase.auth.getSession()
        if (session) return routeByAccount()
        setStatus('error')
        setMessage('That confirmation link has already been used or has expired.')
        return
      }

      // No credentials in the URL at all — a refresh, or the view opened
      // directly. A session already here means the confirmation worked earlier.
      const { data: { session } } = await supabase.auth.getSession()
      if (session) return routeByAccount()
      setStatus('needs-email')
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resendConfirmation = async () => {
    if (!email.trim()) {
      toast.error('Enter the email address you signed up with.')
      return
    }
    setResending(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/?view=confirm-email` },
      })
      if (error) throw new Error(error.message)
      toast.success('Confirmation email sent — check your inbox.')
    } catch (e: any) {
      toast.error(e?.message || 'Could not resend the email. Try again in a minute.')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="card-premium rounded-3xl border border-border p-8 shadow-elevated w-full max-w-md text-center">
        {status === 'working' && (
          <>
            <div className="inline-flex w-14 h-14 rounded-2xl bg-primary/15 items-center justify-center mb-4">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Confirming your email…</h1>
            <p className="text-sm text-muted-foreground mt-1">One moment while we sign you in.</p>
          </>
        )}

        {status === 'needs-email' && (
          <>
            <div className="inline-flex w-14 h-14 rounded-2xl bg-primary/15 items-center justify-center mb-4">
              <MailCheck className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">Confirm your email</h1>
            <p className="text-sm text-muted-foreground mt-1 mb-5">
              Need the confirmation link again? Enter the email you signed up with and
              we&apos;ll send a new one.
            </p>
            <div className="space-y-3">
              <Input
                type="email"
                placeholder="you@restaurant.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && resendConfirmation()}
              />
              <Button className="w-full" onClick={resendConfirmation} disabled={resending}>
                {resending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                {resending ? 'Sending…' : 'Send confirmation link'}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => router.replace('/?view=login')}>
                Back to sign in
              </Button>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="inline-flex w-14 h-14 rounded-2xl bg-destructive/15 items-center justify-center mb-4">
              <MailX className="h-6 w-6 text-destructive" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">This link is no longer valid</h1>
            <p className="text-sm text-muted-foreground mt-1 mb-5">{message}</p>
            <div className="space-y-3">
              <Input
                type="email"
                placeholder="you@restaurant.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && resendConfirmation()}
              />
              <Button className="w-full" onClick={resendConfirmation} disabled={resending}>
                {resending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                {resending ? 'Sending…' : 'Send me a new link'}
              </Button>
              <Button variant="ghost" className="w-full" onClick={() => router.replace('/?view=login')}>
                Back to sign in
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
