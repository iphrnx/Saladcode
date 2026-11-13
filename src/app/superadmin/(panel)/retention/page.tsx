'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Clock, Sparkles, UserX } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  compactMoney,
  relativeTime,
} from '@/components/superadmin/ui'

type Tenant = {
  id: string
  name: string
  slug: string
  plan: string
  subscriptionStatus: string
  ownerEmail: string | null
  ownerName: string | null
  createdAt: string
  orderCount: number
  orderValue: number
  lastOrder: string | null
  lastActivity: string
  daysSinceActivity: number
  trialEndsAt: string | null
}

type Retention = {
  inactive: Tenant[]
  expiringTrials: Tenant[]
  expiredTrials: Tenant[]
  prospects: Tenant[]
  summary: {
    inactiveCount: number
    expiringTrialCount: number
    expiredTrialCount: number
    prospectCount: number
  }
}

function RestaurantRow({ t, trailing }: { t: Tenant; trailing?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <Link
          href={`/superadmin/crm/${t.id}`}
          className="block truncate text-[13.5px] font-medium text-admin-fg hover:text-admin-accent"
        >
          {t.name}
        </Link>
        <p className="truncate text-[12px] text-admin-muted">
          {t.ownerEmail ?? 'no owner on file'} · {t.orderCount} orders ·{' '}
          {compactMoney(t.orderValue)}
        </p>
      </div>
      {trailing}
    </li>
  )
}

export default function SuperAdminRetention() {
  const [data, setData] = useState<Retention | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const res = await superAdminFetch<Retention>('retention')
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

  const s = data?.summary

  return (
    <div>
      <PageTitle
        title="Customer Retention"
        description="Restaurants at risk, trials about to end, and the ones worth a call."
      />

      <DataState loading={loading} error={error} onRetry={load}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Inactive"
              value={s?.inactiveCount ?? 0}
              hint="no order in 14 days"
              icon={<UserX className="size-4" />}
              tone="rose"
            />
            <StatCard
              label="Expiring trials"
              value={s?.expiringTrialCount ?? 0}
              hint="within 7 days"
              icon={<Clock className="size-4" />}
              tone="amber"
            />
            <StatCard
              label="Overdue trials"
              value={s?.expiredTrialCount ?? 0}
              hint="past the end date"
              icon={<AlertTriangle className="size-4" />}
              tone="rose"
            />
            <StatCard
              label="Prospects"
              value={s?.prospectCount ?? 0}
              hint="using it, not paying"
              icon={<Sparkles className="size-4" />}
              tone="emerald"
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Panel
              title="Inactive restaurants"
              description="No order in the last fortnight. These are the ones to call."
              bodyClassName="px-0 py-0"
            >
              {data?.inactive?.length ? (
                <ul className="divide-y divide-admin-border-soft">
                  {data.inactive.map((t) => (
                    <RestaurantRow
                      key={t.id}
                      t={t}
                      trailing={
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-[12px] tabular-nums text-admin-muted">
                            {t.daysSinceActivity}d quiet
                          </span>
                          <Pill status={t.subscriptionStatus}>{t.subscriptionStatus}</Pill>
                        </div>
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-10 text-center text-[13px] text-admin-faint">
                  Every restaurant has been active recently.
                </p>
              )}
            </Panel>

            <Panel
              title="Trials ending"
              description="Trials that run out in the next seven days, and the ones that already have."
              bodyClassName="px-0 py-0"
            >
              {data?.expiringTrials?.length || data?.expiredTrials?.length ? (
                <ul className="divide-y divide-admin-border-soft">
                  {[...(data.expiredTrials ?? []), ...(data.expiringTrials ?? [])].map((t) => (
                    <RestaurantRow
                      key={t.id}
                      t={t}
                      trailing={
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-[12px] text-admin-muted">
                            {t.trialEndsAt
                              ? new Date(t.trialEndsAt).toLocaleDateString('en-IN')
                              : '—'}
                          </span>
                          <Pill status={t.subscriptionStatus}>{t.subscriptionStatus}</Pill>
                        </div>
                      }
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-10 text-center text-[13px] text-admin-faint">
                  No trials are ending soon.
                </p>
              )}
            </Panel>
          </div>

          <Panel
            title="Prospects"
            description="Restaurants using the product without paying for it."
            bodyClassName="px-0 py-0"
          >
            {data?.prospects?.length ? (
              <ul className="divide-y divide-admin-border-soft">
                {data.prospects.map((t) => (
                  <RestaurantRow
                    key={t.id}
                    t={t}
                    trailing={
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[12px] text-admin-muted">
                          last seen {relativeTime(t.lastActivity)}
                        </span>
                        <Pill status={t.subscriptionStatus}>{t.subscriptionStatus}</Pill>
                      </div>
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="px-5 py-10 text-center text-[13px] text-admin-faint">
                No prospects right now.
              </p>
            )}
          </Panel>
        </div>
      </DataState>
    </div>
  )
}
