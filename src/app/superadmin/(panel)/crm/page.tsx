'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Search, Store, Users } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  Pill,
  compactMoney,
  relativeTime,
} from '@/components/superadmin/ui'

export type Restaurant = {
  id: string
  name: string
  slug: string
  plan: string
  active: boolean
  onboardingDone: boolean
  subscriptionStatus: string
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  createdAt: string
  lastActivity: string
  orderCount: number
  orderValue: number
  menuItemCount: number
  staffCount: number
  ownerEmail: string | null
  ownerName: string | null
  hasPayment: boolean
}

export default function SuperAdminCrm() {
  const [rows, setRows] = useState<Restaurant[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (status) params.set('status', status)
      if (plan) params.set('plan', plan)
      const res = await superAdminFetch<Restaurant[]>(`crm?${params.toString()}`)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setError(null)
      setRows(res.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [query, status, plan])

  // Search is debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, query])

  const statuses = useMemo(
    () => ['trial', 'active', 'past_due', 'cancelled', 'expired'].filter((s) => rows.some((r) => r.subscriptionStatus === s)),
    [rows],
  )
  const plans = useMemo(
    () => [...new Set(rows.map((r) => r.plan))].sort(),
    [rows],
  )

  const exportCsv = () => {
    const headers = [
      'Restaurant',
      'Slug',
      'Owner',
      'Plan',
      'Status',
      'Orders',
      'Revenue',
      'Menu items',
      'Staff',
      'Signed up',
      'Last activity',
    ]
    const escape = (v: unknown) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const body = rows.map((r) =>
      [
        r.name,
        r.slug,
        r.ownerEmail ?? '',
        r.plan,
        r.subscriptionStatus,
        r.orderCount,
        r.orderValue.toFixed(2),
        r.menuItemCount,
        r.staffCount,
        r.createdAt,
        r.lastActivity,
      ]
        .map(escape)
        .join(','),
    )
    const blob = new Blob([[headers.join(','), ...body].join('\n')], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `the-salad-restaurants-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <PageTitle
        title="Restaurant CRM"
        description="Every restaurant on the platform, with what they do and where they stand."
        action={
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="inline-flex items-center gap-2 rounded-lg border border-admin-border bg-white px-3 py-2 text-[13px] font-medium text-admin-fg-body transition hover:bg-admin-bg disabled:opacity-50"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        }
      />

      <Panel bodyClassName="px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-admin-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, slug, owner or email…"
              className="h-9 w-full rounded-lg border border-admin-border bg-admin-bg pl-9 pr-3 text-[13.5px] outline-none transition placeholder:text-admin-faint focus:border-admin-accent focus:bg-white"
            />
          </div>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[13px] text-admin-fg-body outline-none focus:border-admin-accent"
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[13px] text-admin-fg-body outline-none focus:border-admin-accent"
          >
            <option value="">All plans</option>
            {plans.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <span className="ml-auto text-[12.5px] tabular-nums text-admin-muted">
            {rows.length} restaurant{rows.length === 1 ? '' : 's'}
          </span>
        </div>
      </Panel>

      <div className="mt-5">
        <DataState
          loading={loading}
          error={error}
          onRetry={load}
          empty={rows.length === 0}
          emptyTitle="No restaurants match"
          emptyDescription="Try a different search, or clear the filters."
        >
          <Panel bodyClassName="px-0 py-0 sm:px-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left">
                <thead>
                  <tr className="border-b border-admin-border text-[11.5px] uppercase tracking-wider text-admin-muted">
                    <th className="px-5 py-3 font-medium">Restaurant</th>
                    <th className="px-3 py-3 font-medium">Owner</th>
                    <th className="px-3 py-3 font-medium">Plan</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 text-right font-medium">Orders</th>
                    <th className="px-3 py-3 text-right font-medium">Revenue</th>
                    <th className="px-3 py-3 font-medium">Last activity</th>
                    <th className="px-5 py-3 text-right font-medium">Signed up</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-admin-border-soft">
                  {rows.map((r) => (
                    <tr key={r.id} className="group transition hover:bg-admin-elevated">
                      <td className="px-5 py-3">
                        <Link
                          href={`/superadmin/crm/${r.id}`}
                          className="flex items-center gap-2.5"
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-admin-elevated text-admin-muted transition group-hover:bg-admin-accent-soft group-hover:text-admin-accent">
                            <Store className="size-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[13.5px] font-medium text-admin-fg">
                              {r.name}
                            </span>
                            <span className="flex items-center gap-1.5 text-[12px] text-admin-muted">
                              {r.slug}
                              <span className="text-admin-faint-2">·</span>
                              {r.menuItemCount} items
                              <span className="text-admin-faint-2">·</span>
                              <Users className="size-3" />
                              {r.staffCount}
                            </span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-3">
                        <span className="block truncate text-[13px] text-admin-fg-body">
                          {r.ownerName ?? '—'}
                        </span>
                        <span className="block truncate text-[12px] text-admin-muted">
                          {r.ownerEmail ?? '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="rounded-md bg-admin-elevated px-2 py-0.5 text-[12px] capitalize text-admin-fg-body">
                          {r.plan}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <Pill status={r.subscriptionStatus}>{r.subscriptionStatus}</Pill>
                        {!r.onboardingDone && (
                          <span className="ml-1.5 text-[11.5px] text-amber-600">setup</span>
                        )}
                        {!r.active && (
                          <span className="ml-1.5 text-[11.5px] text-rose-600">disabled</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {r.orderCount}
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {compactMoney(r.orderValue)}
                      </td>
                      <td className="px-3 py-3 text-[12.5px] text-admin-muted">
                        {relativeTime(r.lastActivity)}
                      </td>
                      <td className="px-5 py-3 text-right text-[12.5px] text-admin-muted">
                        {relativeTime(r.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </DataState>
      </div>
    </div>
  )
}
