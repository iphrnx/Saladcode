'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { AlertTriangle, ArrowRight, Eye, EyeOff, KeyRound, Loader2, Mail } from 'lucide-react'

type Stage = 'checking' | 'form' | 'done' | 'invalid' | 'request'

/**
 * Password reset.
 *
 * A reset email carries a one-time code. Supabase issues it in PKCE form, so the
 * link lands here with `?code=...` and the code has to be exchanged for a
 * session before the password can be changed. The exchange happens once per
 * page load: a code is single-use, and exchanging it twice — which React's
 * development double-render would otherwise do — comes back as "invalid".
 *
 * The router reaches this view either from `?view=reset-password` or by noticing
 * a code on the root URL, because Supabase falls back to the project's Site URL
 * when the redirect target is not on the allow list. That means the link works
 * whether or not anyone has configured a redirect URL.
 *
 * The form is never shown on the strength of an existing session. updateUser()
 * acts on whoever is signed in, so doing that would change the password of the
 * account already in the browser rather than the one the link was issued for.
 */
export function ResetPasswordView() {
  const [stage, setStage] = useState<Stage>('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    /**
     * Establish the recovery session, handling both link shapes explicitly.
     *
     * Supabase can send either, and the shape depends on the client's flow type
     * rather than on anything this page controls:
     *
     *   #access_token=…&refresh_token=…&type=recovery   implicit
     *   ?code=…&type=recovery                           PKCE
     *
     * The client is configured for PKCE, and it does not consume an implicit
     * hash on its own — so relying on auto-detection left the page sitting on
     * "enter your email" while the recovery tokens went unread, and the password
     * was never changed. Both are handled here instead.
     */
    const run = async () => {
      const supabase = createClient()
      const params = new URLSearchParams(window.location.search)

      const linkError = params.get('error_description') || params.get('error')
      if (linkError) {
        if (!cancelled) setStage('invalid')
        return
      }

      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
      const frag = new URLSearchParams(hash)
      const accessToken = frag.get('access_token')
      const refreshToken = frag.get('refresh_token')
      const code = params.get('code')

      // Keep the tokens out of the address bar and out of history once used.
      const scrub = () => window.history.replaceState({}, '', window.location.pathname + '?view=reset-password')

      if (accessToken && refreshToken) {
        const { error: setError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        scrub()
        if (!cancelled) setStage(setError ? 'invalid' : 'form')
        return
      }

      if (code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        scrub()
        if (!cancelled) setStage(exchangeError ? 'invalid' : 'form')
        return
      }

      // No credentials in the URL at all.
      //
      // Critically, this does NOT fall back to whatever session the browser
      // happens to hold. updateUser() changes the password of the signed-in
      // user, so treating an existing session as permission to show the form
      // meant that opening this page while signed in as A and following a reset
      // link meant for B would silently change A's password. A reset must be
      // backed by a recovery token, which is exactly what is missing here.
      if (cancelled) return
      setStage('request')
    }

    run()
    return () => { cancelled = true }
  }, [])

  /** Start over: send a fresh link to an address the user types. */
  const sendLink = async () => {
    const address = email.trim()
    if (!address) { setError('Enter your email address.'); return }
    setBusy(true); setError('')
    try {
      const supabase = createClient()
      const { error: sendError } = await supabase.auth.resetPasswordForEmail(address, {
        redirectTo: `${window.location.origin}/?view=reset-password`,
      })
      if (sendError) throw sendError
      // Deliberately the same message whether or not the address exists, so
      // this cannot be used to discover which emails are registered.
      toast.success('Check your email', {
        description: 'If that address has an account, a reset link is on its way.',
      })
      setStage('checking')
      await new Promise((r) => setTimeout(r, 1200))
      setStage('request')
    } catch (e) {
      setError((e as Error).message || 'Could not send the reset email.')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (password.length < 8) { setError('Use at least 8 characters.'); return }
    if (password !== confirm) { setError('The two passwords do not match.'); return }
    setBusy(true); setError('')
    try {
      const supabase = createClient()
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      // Sign out so the next sign-in uses the new password and proves it works.
      await supabase.auth.signOut()
      setStage('done')
    } catch (e) {
      setError((e as Error).message || 'Could not update the password.')
    } finally {
      setBusy(false)
    }
  }

  const wrap = (children: React.ReactNode) => (
    <div className="min-h-[100dvh] flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )

  if (stage === 'checking') {
    return wrap(
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Checking your reset link…</p>
      </div>,
    )
  }

  if (stage === 'invalid') {
    return wrap(
      <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-4">
        <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
        <div>
          <h1 className="font-semibold">This link no longer works</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Reset links can only be used once, and they expire. Ask for a fresh one below.
          </p>
        </div>
        <Button className="w-full" onClick={() => setStage('request')}>Send a new link</Button>
      </div>,
    )
  }

  if (stage === 'done') {
    return wrap(
      <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-4">
        <KeyRound className="h-8 w-8 text-emerald-500 mx-auto" />
        <div>
          <h1 className="font-semibold">Password changed</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in with your new password.</p>
        </div>
        <Button className="w-full" onClick={() => { window.location.href = '/?view=login' }}>
          Go to sign in <ArrowRight className="h-4 w-4 ml-1.5" />
        </Button>
      </div>,
    )
  }

  if (stage === 'request') {
    return wrap(
      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div className="space-y-1">
          <h1 className="font-semibold flex items-center gap-2"><Mail className="h-4 w-4 text-primary" /> Reset your password</h1>
          <p className="text-sm text-muted-foreground">
            Enter the email you signed up with and we will send you a reset link.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reset-email" className="text-xs text-muted-foreground">Email</Label>
          <Input
            id="reset-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@restaurant.com"
            autoComplete="email"
            className="bg-secondary/50 border-border"
          />
        </div>
        {error && (
          <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">{error}</div>
        )}
        <Button onClick={sendLink} disabled={busy} className="w-full">
          {busy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending…</> : 'Send reset link'}
        </Button>
        <button
          onClick={() => { window.location.href = '/?view=login' }}
          className="w-full text-xs text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </button>
      </div>,
    )
  }

  return wrap(
    <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
      <div className="space-y-1">
        <h1 className="font-semibold flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> Choose a new password</h1>
        <p className="text-sm text-muted-foreground">At least 8 characters.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="new-password" className="text-xs text-muted-foreground">New password</Label>
        <div className="relative">
          <Input
            id="new-password"
            type={show ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="pr-10 bg-secondary/50 border-border"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label="Toggle password visibility"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm-password" className="text-xs text-muted-foreground">Confirm password</Label>
        <Input
          id="confirm-password"
          type={show ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="bg-secondary/50 border-border"
        />
      </div>
      {error && (
        <div className="rounded-xl bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">{error}</div>
      )}
      <Button onClick={save} disabled={busy} className="w-full">
        {busy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</> : 'Set new password'}
      </Button>
    </div>,
  )
}
