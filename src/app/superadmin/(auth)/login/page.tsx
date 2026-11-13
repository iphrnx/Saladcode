'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, KeyRound, Loader2, Mail, ShieldCheck } from 'lucide-react'

function LoginInner() {
  const search = useSearchParams()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The server sends the visitor here when the account is signed in but is
  // not on the allowlist. Say so, because they have already proved control
  // of the address by this point.
  useEffect(() => {
    if (search.get('error') === 'not-authorised') {
      setError('This account is signed in but is not authorised for the admin panel.')
    }
  }, [search])

  // A sign-in link lands here in one of two shapes, and only one of them
  // reaches the server:
  //
  //   ?code=…                 PKCE — the code is in the query string
  //   #access_token=…&…       implicit — the tokens are in the fragment
  //
  // The fragment never leaves the browser, so it is read here and posted to
  // the server, which writes the session into the HttpOnly cookie and checks
  // the allowlist. Either way the tokens are scrubbed from the address bar.
  useEffect(() => {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : ''
    const frag = new URLSearchParams(hash)
    const accessToken = frag.get('access_token')
    const refreshToken = frag.get('refresh_token')
    const code = new URLSearchParams(window.location.search).get('code')

    if (!accessToken && !code) return

    let cancelled = false
    const run = async () => {
      setStep('code')
      setLoading(true)
      setError(null)
      setNotice('Signing you in…')

      try {
        const res = await fetch('/api/auth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken, refreshToken, code }),
        })
        const payload = await res.json().catch(() => ({}))

        // Take the tokens out of the address bar either way.
        window.history.replaceState({}, '', '/superadmin/login')

        if (!res.ok) {
          throw new Error(payload?.error || 'That sign-in link could not be used.')
        }
        if (cancelled) return
        window.location.href = '/superadmin'
      } catch (e: any) {
        if (cancelled) return
        setNotice(null)
        setError(e.message || 'That sign-in link could not be used.')
        setLoading(false)
        setStep('email')
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setNotice(null)

    try {
      const res = await fetch('/api/auth/otp', {
        method: 'POST',
        body: JSON.stringify({ email }),
        headers: { 'Content-Type': 'application/json' },
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'Could not send a sign-in code.')

      // The response is the same whether or not the address is on the
      // allowlist, so nothing here reveals who administers the platform.
      setNotice(
        'If that address belongs to a registered administrator, a sign-in code is on its way.',
      )
      setStep('code')
    } catch (e: any) {
      setError(e.message || 'Could not send a sign-in code.')
    } finally {
      setLoading(false)
    }
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
        headers: { 'Content-Type': 'application/json' },
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload?.error || 'That code was not accepted.')

      window.location.href = '/superadmin'
    } catch (e: any) {
      setError(e.message || 'That code was not accepted.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-admin-rail px-4 py-10">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 size-[420px] rounded-full bg-admin-accent/25 blur-3xl" />
        <div className="absolute -bottom-48 -right-24 size-[460px] rounded-full bg-[#f59e0b]/20 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
            backgroundSize: '56px 56px',
          }}
        />
      </div>

      <div className="relative w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-admin-accent to-admin-accent-hover text-white shadow-lg shadow-[rgba(234,88,12,0.30)]">
            <ShieldCheck className="size-6" />
          </span>
          <h1 className="mt-4 text-[22px] font-semibold tracking-tight text-white">
            The Salad Admin
          </h1>
          <p className="mt-1 text-[13.5px] text-admin-rail-fg">
            Restricted access. Sign in with your administrator address.
          </p>
        </div>

        <div className="rounded-2xl border border-admin-rail-border bg-white/[0.04] p-6 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <form
            onSubmit={step === 'email' ? handleEmailSubmit : handleCodeSubmit}
            className="space-y-4"
          >
            {step === 'email' ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-email"
                  className="text-[12px] font-medium uppercase tracking-wider text-admin-rail-fg"
                >
                  Administrator email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-admin-rail-fg" />
                  <input
                    id="admin-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    required
                    className="h-11 w-full rounded-lg border border-admin-rail-border bg-white/5 pl-10 pr-3 text-sm text-white outline-none transition placeholder:text-admin-rail-fg focus:border-[rgba(249,115,22,0.55)] focus:bg-white/[0.07]"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-code"
                  className="text-[12px] font-medium uppercase tracking-wider text-admin-rail-fg"
                >
                  Sign-in code
                </label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-admin-rail-fg" />
                  <input
                    id="admin-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="000000"
                    required
                    className="h-11 w-full rounded-lg border border-admin-rail-border bg-white/5 pl-10 pr-3 text-center font-mono text-lg tracking-[0.4em] text-white outline-none transition placeholder:text-admin-rail-fg focus:border-[rgba(249,115,22,0.55)] focus:bg-white/[0.07]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setStep('email')
                    setCode('')
                    setError(null)
                    setNotice(null)
                  }}
                  className="flex items-center gap-1.5 pt-1 text-[12.5px] text-admin-rail-fg transition hover:text-white"
                >
                  <ArrowLeft className="size-3.5" />
                  Use a different address
                </button>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/25 bg-rose-500/10 px-3 py-2.5 text-[13px] text-rose-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-400" />
                <span>{error}</span>
              </div>
            )}

            {notice && !error && (
              <div className="rounded-lg border border-admin-accent-ring bg-admin-accent-soft px-3 py-2.5 text-[13px] text-[#fed7aa]">
                {notice}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="h-11 w-full rounded-lg bg-gradient-to-r from-admin-accent to-admin-accent-hover text-sm font-semibold text-white shadow-lg shadow-[rgba(234,88,12,0.22)] transition hover:from-[#fb923c] hover:to-admin-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {step === 'email' ? 'Sending code…' : 'Verifying…'}
                </span>
              ) : step === 'email' ? (
                'Send sign-in code'
              ) : (
                'Verify and enter'
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-[11.5px] leading-relaxed text-admin-rail-fg">
          Sessions are held in a secure server-side cookie and expire automatically.
          <br />
          Every access is written to the audit log.
        </p>
      </div>
    </div>
  )
}

export default function SuperAdminLogin() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-admin-rail">
          <Loader2 className="size-5 animate-spin text-admin-rail-fg" />
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  )
}
