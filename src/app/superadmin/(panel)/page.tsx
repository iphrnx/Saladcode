'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  Banknote,
  CreditCard,
  RefreshCcw,
  Store,
  UserCheck,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  compactMoney,
  money,
  relativeTime,
} from '@/components/superadmin/ui'
import { DistributionBars, TrendChart } from '@/components/superadmin/charts'

type Overview = {
  kpis: {
    totalRestaurants: number
    activeRestaurants: number
    newRestaurants30d: number
    completedOnboarding: number
    onboardingIncomplete: number
    onboardingRate: number
    totalUsers: number
    activeUsers7d: number
    activeUsers30d: number
    inactiveUsers: number
    neverLoggedIn: number
    trials: number
    paid: number
    canceled: number
    pastDue: number
    mrr: number
    mrrRealized: number
    arr: number
    churnRate: number
    churned30d: number
    totalOrders: number
  }
  trend: { date: string; restaurants: number; orders: number; revenue: number }[]
  planDistribution: { plan: string; count: number }[]
  statusDistribution: { status: string; count: number }[]
  recentActivity: { type: string; label: string; at: string; tenantId: string }[]
}

export default function SuperAdminOverview() {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const res = await superAdminFetch<Overview>('overview')
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

  const k = data?.kpis

  return (
    <div>
      <PageTitle
        title="Business Overview"
        description="The state of the platform across every restaurant, updated from live database events."
        action={
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-admin-border bg-white px-3 py-2 text-[13px] font-medium text-admin-fg-body transition hover:bg-admin-bg disabled:opacity-60"
          >
            <RefreshCcw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Refresh
          </button>
        }
      />

      <DataState loading={loading} error={error} onRetry={load}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            <StatCard
              label="Restaurants"
              value={k?.totalRestaurants ?? 0}
              hint={`${k?.activeRestaurants ?? 0} active`}
              icon={<Store className="size-4" />}
              tone="orange"
            />
            <StatCard
              label="New signups"
              value={k?.newRestaurants30d ?? 0}
              hint="last 30 days"
              icon={<UserPlus className="size-4" />}
              tone="violet"
            />
            <StatCard
              label="Onboarding done"
              value={`${k?.onboardingRate ?? 0}%`}
              hint={`${k?.completedOnboarding ?? 0} of ${k?.totalRestaurants ?? 0} complete`}
              icon={<UserCheck className="size-4" />}
              tone="emerald"
            />
            <StatCard
              label="Active users"
              value={k?.activeUsers7d ?? 0}
              hint={`${k?.activeUsers30d ?? 0} in 30d · ${k?.inactiveUsers ?? 0} inactive`}
              icon={<Users className="size-4" />}
              tone="sky"
            />
            <StatCard
              label="On trial"
              value={k?.trials ?? 0}
              hint={`${k?.paid ?? 0} paying`}
              icon={<Activity className="size-4" />}
              tone="sky"
            />
            <StatCard
              label="Monthly revenue"
              value={compactMoney(k?.mrr ?? 0)}
              hint={`${compactMoney(k?.arr ?? 0)} ARR`}
              icon={<Banknote className="size-4" />}
              tone="emerald"
            />
            <StatCard
              label="Churn"
              value={`${k?.churnRate ?? 0}%`}
              hint={`${k?.canceled ?? 0} canceled · ${k?.pastDue ?? 0} past due`}
              icon={<UserX className="size-4" />}
              tone="rose"
            />
            <StatCard
              label="Orders"
              value={k?.totalOrders ?? 0}
              hint="all time"
              icon={<CreditCard className="size-4" />}
              tone="amber"
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Panel
              title="Revenue, last 30 days"
              description="Counted from the orders table, in each restaurant's own timezone."
              className="xl:col-span-2"
            >
              <TrendChart
                data={data?.trend ?? []}
                valueKey="revenue"
                label="Revenue"
                height={240}
              />
            </Panel>

            <Panel title="Subscription status" description="Where the platform's restaurants stand.">
              <DistributionBars
                items={(data?.statusDistribution ?? []).map((s) => ({
                  label: s.status,
                  value: s.count,
                }))}
                total={k?.totalRestaurants}
              />
            </Panel>
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <Panel title="Plans" description="Which plan each restaurant is on.">
              <DistributionBars
                items={(data?.planDistribution ?? []).map((p) => ({
                  label: p.plan,
                  value: p.count,
                }))}
                total={k?.totalRestaurants}
              />
            </Panel>

            <Panel
              title="Recent activity"
              description="Signups and payments, newest first."
              className="xl:col-span-2"
              bodyClassName="px-2 py-2"
            >
              {(data?.recentActivity ?? []).length === 0 ? (
                <p className="px-3 py-8 text-center text-[13px] text-admin-faint">
                  Nothing has happened yet.
                </p>
              ) : (
                <ul className="divide-y divide-admin-border-soft">
                  {(data?.recentActivity ?? []).map((item, i) => (
                    <li key={`${item.type}-${item.at}-${i}`} className="flex items-center gap-3 px-3 py-2.5">
                      <span
                        className={`size-2 shrink-0 rounded-full ${
                          item.type === 'restaurant_signup'
                            ? 'bg-admin-accent'
                            : item.type === 'payment_succeeded'
                              ? 'bg-emerald-500'
                              : item.type === 'payment_failed'
                                ? 'bg-rose-500'
                                : 'bg-[rgba(0,0,0,0.10)]'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-admin-fg-body">
                        {item.label}
                      </span>
                      <Pill status={item.type.replace('payment_', '')}>
                        {item.type.replace('restaurant_', '').replace('payment_', '')}
                      </Pill>
                      <span className="w-20 shrink-0 text-right text-[12px] text-admin-faint">
                        {relativeTime(item.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel title="Where the money is" description="MRR, from the plan catalogue and the ledger.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: 'Contracted MRR', value: money(k?.mrr ?? 0) },
                { label: 'Realised MRR (30d)', value: money(k?.mrrRealized ?? 0) },
                { label: 'Annual run rate', value: money(k?.arr ?? 0) },
                { label: 'Trials running', value: String(k?.trials ?? 0) },
              ].map((row) => (
                <div key={row.label}>
                  <p className="text-[12px] font-medium uppercase tracking-wider text-admin-muted">
                    {row.label}
                  </p>
                  <p className="mt-1.5 text-[20px] font-semibold tabular-nums text-admin-fg">
                    {row.value}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </DataState>
    </div>
  )
}
