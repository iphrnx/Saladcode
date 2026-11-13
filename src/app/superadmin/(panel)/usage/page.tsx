'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Activity, MousePointerClick, Package, Zap } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  StatCard,
  compactMoney,
  relativeTime,
} from '@/components/superadmin/ui'
import { DistributionBars, TrendChart } from '@/components/superadmin/charts'

type Usage = {
  perRestaurant: {
    id: string
    name: string
    plan: string
    orders: number
    orderValue: number
    lastOrder: string | null
    logins: number
    menuEdits: number
    features: string[]
    featureCount: number
  }[]
  featureAdoption: { feature: string; restaurants: number; rate: number }[]
  trend: { date: string; orders: number; revenue: number }[]
  totalEvents: number
}

export default function SuperAdminUsage() {
  const [data, setData] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const res = await superAdminFetch<Usage>('usage')
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
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const totalOrders = (data?.perRestaurant ?? []).reduce((s, r) => s + r.orders, 0)
  const totalLogins = (data?.perRestaurant ?? []).reduce((s, r) => s + r.logins, 0)
  const totalMenuEdits = (data?.perRestaurant ?? []).reduce((s, r) => s + r.menuEdits, 0)

  return (
    <div>
      <PageTitle
        title="Usage Analytics"
        description="What each restaurant actually does, counted from database events rather than from what a client reported."
      />

      <DataState loading={loading} error={error} onRetry={load}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Orders placed"
              value={totalOrders}
              icon={<Package className="size-4" />}
              tone="orange"
            />
            <StatCard
              label="Staff logins"
              value={totalLogins}
              icon={<MousePointerClick className="size-4" />}
              tone="sky"
            />
            <StatCard
              label="Menu changes"
              value={totalMenuEdits}
              icon={<Activity className="size-4" />}
              tone="violet"
            />
            <StatCard
              label="Feature events"
              value={data?.totalEvents ?? 0}
              icon={<Zap className="size-4" />}
              tone="emerald"
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Panel
              title="Order volume"
              description="Across the platform, last 30 days."
              className="xl:col-span-2"
            >
              <TrendChart data={data?.trend ?? []} valueKey="orders" label="Orders" height={230} />
            </Panel>

            <Panel
              title="Feature adoption"
              description="How many restaurants use each feature."
            >
              <DistributionBars
                items={(data?.featureAdoption ?? []).map((f) => ({
                  label: f.feature.replace(/_/g, ' '),
                  value: f.restaurants,
                  hint: `${f.rate}%`,
                }))}
                emptyLabel="No feature usage recorded yet."
              />
            </Panel>
          </div>

          <Panel
            title="Per restaurant"
            description="Every restaurant and what it has done."
            bodyClassName="px-0 py-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left">
                <thead>
                  <tr className="border-b border-admin-border text-[11.5px] uppercase tracking-wider text-admin-muted">
                    <th className="px-5 py-3 font-medium">Restaurant</th>
                    <th className="px-3 py-3 text-right font-medium">Orders</th>
                    <th className="px-3 py-3 text-right font-medium">Value</th>
                    <th className="px-3 py-3 text-right font-medium">Logins</th>
                    <th className="px-3 py-3 text-right font-medium">Menu changes</th>
                    <th className="px-3 py-3 font-medium">Features used</th>
                    <th className="px-5 py-3 text-right font-medium">Last order</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-admin-border-soft">
                  {(data?.perRestaurant ?? []).map((r) => (
                    <tr key={r.id} className="transition hover:bg-admin-elevated">
                      <td className="px-5 py-2.5">
                        <Link
                          href={`/superadmin/crm/${r.id}`}
                          className="text-[13px] font-medium text-admin-fg hover:text-admin-accent"
                        >
                          {r.name}
                        </Link>
                        <span className="ml-2 rounded bg-admin-elevated px-1.5 py-0.5 text-[11px] capitalize text-admin-muted">
                          {r.plan}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {r.orders}
                      </td>
                      <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {compactMoney(r.orderValue)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {r.logins}
                      </td>
                      <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {r.menuEdits}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.features.length ? (
                          <span className="flex flex-wrap gap-1">
                            {r.features.map((f) => (
                              <span
                                key={f}
                                className="rounded bg-admin-elevated px-1.5 py-0.5 text-[11px] capitalize text-admin-fg-body"
                              >
                                {f.replace(/_/g, ' ')}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-[12.5px] text-admin-faint">none</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right text-[12.5px] text-admin-muted">
                        {relativeTime(r.lastOrder)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </DataState>
    </div>
  )
}
