'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Delete, ArrowLeft, Loader2, Lock, Shield } from 'lucide-react'
import { toast } from 'sonner'
import { edgeFetch, staffFetch, rememberStaffToken } from '@/lib/edge'

export function StaffLoginPage() {
  const searchParams = useSearchParams()
  const initialTenantSlug = searchParams.get('tenant') || ''

  const [tenant, setTenant] = useState<any>(null)
  const [staff, setStaff] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedStaff, setSelectedStaff] = useState<any>(null)
  const [pin, setPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [lockedUntil, setLockedUntil] = useState<Date | null>(null)

  const loadTenant = (slugOrId: string) => {
    setLoading(true)
    setError('')
    setSelectedStaff(null)
    setPin('')

    const url = slugOrId ? `/api/staff/login?tenant=${encodeURIComponent(slugOrId)}` : '/api/staff/login'
    edgeFetch(url)
      .then(res => res.json())
      .then(data => {
        if (data.tenant) {
          setTenant(data.tenant)
          setStaff(data.staff || [])
        }
      })
      .catch(() => {
        setError('Failed to load restaurant data')
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadTenant(initialTenantSlug)
  }, [initialTenantSlug])

  // Auto-submit when PIN is 4 digits
  useEffect(() => {
    if (pin.length === 4 && selectedStaff) {
      handleLogin()
    }
  }, [pin])

  const handleLogin = async () => {
    if (!selectedStaff || pin.length !== 4) return
    setSubmitting(true)
    setError('')
    try {
      const res = await staffFetch('/api/staff/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId: tenant.id,
          employeeId: selectedStaff.employeeId,
          pin,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Login failed')
        if (data.lockedUntil) setLockedUntil(new Date(data.lockedUntil))
        setPin('')
        return
      }
      // Keep the token from the response. The matching cookie may never be
      // stored — see rememberStaffToken — so this is what identifies the staff
      // member on every later request.
      if (data.token) rememberStaffToken(data.token)
      toast.success(`Welcome, ${data.staff.name.split(' ')[0]}!`)
      setTimeout(() => { window.location.href = '/?view=staff-dashboard' }, 300)
    } catch {
      setError('Network error')
      setPin('')
    } finally {
      setSubmitting(false)
    }
  }

  const handlePinDigit = (d: string) => {
    if (pin.length < 4 && !submitting) setPin(p => p + d)
  }

  const handleBackspace = () => {
    setPin(p => p.slice(0, -1))
  }

  if (loading) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center p-4">
      {/* Background glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[500px] h-[300px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-sm">
        {/* Restaurant header */}
        <div className="text-center mb-6">
          <div className="inline-flex w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary-hover items-center justify-center shadow-glow-primary mb-3">
            {tenant?.logo ? (
              <img src={tenant.logo} alt="" className="w-full h-full rounded-2xl object-cover" />
            ) : (
              <span className="text-white font-bold text-xl">{tenant?.name?.[0] || 'T'}</span>
            )}
          </div>

          {/* The restaurant is fixed. Staff belong to one restaurant, and the
              page knows which from the ?tenant= link they arrived on, so there
              is nothing to choose here — and nothing a visitor could switch to
              reach another restaurant's roster. */}
          <span className="text-xl font-bold">{tenant?.name || 'Restaurant'}</span>
          {tenant?.tagline && <p className="text-xs text-muted-foreground mt-0.5">{tenant.tagline}</p>}
        </div>

        {!selectedStaff ? (
          /* Staff selection */
          <Card className="rounded-3xl border border-border bg-card p-5 shadow-elevated">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 text-center">
              Select your name
            </h2>
            <div className="space-y-2 max-h-[380px] overflow-y-auto scrollbar-thin">
              {staff.length === 0 ? (
                <div className="text-center py-6 px-3">
                  <p className="text-sm font-medium text-foreground mb-1">No staff accounts for {tenant?.name || 'this restaurant'}</p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Ask your manager to create an account in Role Access.
                  </p>
                </div>
              ) : (
                staff.map(s => (
                  <button
                    key={s.id}
                    onClick={() => { setSelectedStaff(s); setError(''); setPin('') }}
                    className="flex items-center gap-3 w-full rounded-2xl border border-border bg-secondary/40 hover:bg-secondary hover:border-primary/30 px-4 py-3 transition-premium"
                  >
                    <div className="w-10 h-10 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold shrink-0">
                      {s.name.split(' ').map((n: string) => n[0]).slice(0, 2).join('')}
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium truncate">{s.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{s.employeeId}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>
        ) : (
          /* PIN entry */
          <Card className="rounded-3xl border border-border bg-card p-4 md:p-6 shadow-elevated">
            {/* Selected staff */}
            <div className="flex items-center gap-3 mb-6">
              <button onClick={() => { setSelectedStaff(null); setError(''); setPin('') }} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="w-12 h-12 rounded-full bg-primary/15 text-primary flex items-center justify-center text-base font-bold">
                {selectedStaff.name.split(' ').map((n: string) => n[0]).slice(0, 2).join('')}
              </div>
              <div>
                <p className="text-sm font-medium">{selectedStaff.name}</p>
                <p className="text-xs text-muted-foreground">{selectedStaff.employeeId}</p>
              </div>
            </div>

            {/* PIN dots */}
            <div className="flex items-center justify-center gap-3 mb-6">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className={cn(
                  'w-4 h-4 rounded-full border-2 transition-all',
                  i < pin.length ? 'bg-primary border-primary' : 'border-border'
                )} />
              ))}
            </div>

            {/* Error */}
            {error && (
              <div className={cn('rounded-xl border px-3 py-2 mb-4 text-xs text-center', lockedUntil ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-destructive/10 border-destructive/20 text-destructive')}>
                {lockedUntil && <Lock className="h-3 w-3 inline mr-1" />}
                {error}
              </div>
            )}

            {/* Number pad */}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => (
                <button
                  key={d}
                  onClick={() => handlePinDigit(d)}
                  disabled={submitting || pin.length >= 4}
                  className="h-14 rounded-2xl border border-border bg-secondary/40 hover:bg-secondary text-lg font-semibold transition-premium disabled:opacity-50"
                >
                  {d}
                </button>
              ))}
              <div className="h-14" />
              <button
                onClick={() => handlePinDigit('0')}
                disabled={submitting || pin.length >= 4}
                className="h-14 rounded-2xl border border-border bg-secondary/40 hover:bg-secondary text-lg font-semibold transition-premium disabled:opacity-50"
              >
                0
              </button>
              <button
                onClick={handleBackspace}
                disabled={pin.length === 0 || submitting}
                className="h-14 rounded-2xl border border-border bg-secondary/40 hover:bg-secondary flex items-center justify-center transition-premium disabled:opacity-50"
              >
                <Delete className="h-5 w-5" />
              </button>
            </div>

            {submitting && (
              <div className="flex items-center justify-center gap-2 mt-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
              </div>
            )}

            {/* Security note */}
            <p className="text-[10px] text-muted-foreground text-center mt-4 flex items-center justify-center gap-1">
              <Shield className="h-3 w-3" /> PIN is hashed & secure
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}
