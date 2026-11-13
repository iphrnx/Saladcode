'use client'

import { useCallback, useEffect, useState } from 'react'
import { CalendarRange, Download, FileBarChart } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  StatCard,
  compactMoney,
  money,
} from '@/components/superadmin/ui'
import { TrendChart } from '@/components/superadmin/charts'

type Report = {
  range: { from: string; to: string; type: string }
  rows: {
    tenantId: string
    restaurant: string
    orders: number
    completedOrders: number
    revenue: number
    averageOrderValue: number
  }[]
  daily: { date: string; orders: number; revenue: number }[]
  totals: { orders: number; revenue: number; restaurants: number }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

export default function SuperAdminReports() {
  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10))
  const [type, setType] = useState('revenue')
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const params = new URLSearchParams({ from, to, type })
      const res = await superAdminFetch<Report>(`reports?${params.toString()}`)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setError(null)
      setData(res.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [from, to, type])

  useEffect(() => {
    load()
  }, [load])

  const exportCsv = async () => {
    const params = new URLSearchParams({ from, to, type })
    const res = await fetch(`/api/superadmin/reports/csv?${params.toString()}`, {
      credentials: 'same-origin',
    })
    if (!res.ok) {
      setError('Could not build the export')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `the-salad-${type}-${from}-to-${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <PageTitle
        title="Reports"
        description="Order and revenue activity over any window, per restaurant."
        action={
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-2 rounded-lg border border-admin-border bg-white px-3 py-2 text-[13px] font-medium text-admin-fg-body transition hover:bg-admin-bg"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        }
      />

      <Panel bodyClassName="px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-admin-muted">
              From
            </span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[13px] outline-none focus:border-admin-accent"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-admin-muted">
              To
            </span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[13px] outline-none focus:border-admin-accent"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium uppercase tracking-wider text-admin-muted">
              Report
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[13px] text-admin-fg-body outline-none focus:border-admin-accent"
            >
              <option value="revenue">Revenue by restaurant</option>
              <option value="orders">Every order</option>
              <option value="crm">Restaurant directory</option>
              <option value="retention">At-risk restaurants</option>
            </select>
          </label>

          <button
            onClick={load}
            disabled={loading}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-admin-accent px-3 text-[13px] font-medium text-white transition hover:bg-admin-accent-hover disabled:opacity-60"
          >
            <CalendarRange className="size-3.5" />
            Run report
          </button>

          <div className="ml-auto flex gap-2">
            {[
              { label: '7 days', days: 6 },
              { label: '30 days', days: 29 },
              { label: '90 days', days: 89 },
            ].map((r) => (
              <button
                key={r.label}
                onClick={() => {
                  setFrom(daysAgo(r.days))
                  setTo(new Date().toISOString().slice(0, 10))
                }}
                className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[12.5px] font-medium text-admin-muted transition hover:bg-admin-bg"
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <div className="mt-5">
        <DataState loading={loading} error={error} onRetry={load}>
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Orders" value={data?.totals.orders ?? 0} tone="orange" />
              <StatCard
                label="Revenue"
                value={compactMoney(data?.totals.revenue ?? 0)}
                tone="emerald"
              />
              <StatCard
                label="Restaurants active"
                value={data?.totals.restaurants ?? 0}
                tone="violet"
              />
            </div>

            <Panel
              title="Daily revenue"
              description={`${from} to ${to}`}
            >
              <TrendChart data={data?.daily ?? []} valueKey="revenue" label="Revenue" height={240} />
            </Panel>

            <Panel
              title="By restaurant"
              bodyClassName="px-0 py-0"
            >
              {data?.rows?.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left">
                    <thead>
                      <tr className="border-b border-admin-border text-[11.5px] uppercase tracking-wider text-admin-muted">
                        <th className="px-5 py-3 font-medium">Restaurant</th>
                        <th className="px-3 py-3 text-right font-medium">Orders</th>
                        <th className="px-3 py-3 text-right font-medium">Completed</th>
                        <th className="px-3 py-3 text-right font-medium">Revenue</th>
                        <th className="px-5 py-3 text-right font-medium">Average order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-admin-border-soft">
                      {data.rows.map((r) => (
                        <tr key={r.tenantId} className="transition hover:bg-admin-elevated">
                          <td className="px-5 py-2.5 text-[13px] font-medium text-admin-fg">
                            {r.restaurant}
                          </td>
                          <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                            {r.orders}
                          </td>
                          <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                            {r.completedOrders}
                          </td>
                          <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg">
                            {money(r.revenue)}
                          </td>
                          <td className="px-5 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                            {money(r.averageOrderValue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="px-5 py-10 text-center text-[13px] text-admin-faint">
                  No activity in this window.
                </p>
              )}
            </Panel>
          </div>
        </DataState>
      </div>
    </div>
  )
}
