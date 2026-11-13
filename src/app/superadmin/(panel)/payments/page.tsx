'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertOctagon,
  ArrowDownRight,
  Banknote,
  CheckCircle2,
  RotateCcw,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  money,
  relativeTime,
} from '@/components/superadmin/ui'

type Payments = {
  metrics: {
    mrr: number
    mrrRealized: number
    arr: number
    verifiedRevenue30d: number
    successfulCount: number
    failedCount: number
    failedAmount30d: number
    refundCount: number
    refundAmount: number
    pendingCount: number
    renewalCount: number
    cancellations: number
    trials: number
    paid: number
  }
  transactions: any[]
  plans: {
    id: string
    name: string
    priceMonthly: number
    priceYearly: number
    currency: string
    trialDays: number
    features: string[]
    isActive: boolean
    subscribers: number
    razorpayPlanId: string | null
    limits: { locations: number | null; staff: number | null; menuItems: number | null }
  }[]
}

export default function SuperAdminPayments() {
  const [data, setData] = useState<Payments | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The Razorpay plan id being edited, and the value in the field.
  const [editingPlan, setEditingPlan] = useState<string | null>(null)
  const [planIdValue, setPlanIdValue] = useState('')
  const [savingPlan, setSavingPlan] = useState(false)

  const startEditingPlan = (planId: string, current: string | null) => {
    setEditingPlan(planId)
    setPlanIdValue(current ?? '')
  }

  const savePlan = async (planId: string) => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setSavingPlan(true)
    try {
      const res = await superAdminFetch(`plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify({ razorpayPlanId: planIdValue.trim() }),
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setEditingPlan(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSavingPlan(false)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await superAdminFetch<Payments>('payments')
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

  const m = data?.metrics

  return (
    <div>
      <PageTitle
        title="Revenue & Payments"
        description="What has been paid, what has failed, and what it adds up to."
      />

      <DataState loading={loading} error={error} onRetry={load}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            <StatCard
              label="MRR"
              value={money(m?.mrr ?? 0)}
              hint={`${money(m?.arr ?? 0)} ARR`}
              icon={<TrendingUp className="size-4" />}
              tone="emerald"
            />
            <StatCard
              label="Realised (30d)"
              value={money(m?.mrrRealized ?? 0)}
              hint="what actually came in"
              icon={<Banknote className="size-4" />}
              tone="orange"
            />
            <StatCard
              label="Verified revenue"
              value={money(m?.verifiedRevenue30d ?? 0)}
              hint={`${m?.successfulCount ?? 0} successful payments`}
              icon={<CheckCircle2 className="size-4" />}
              tone="emerald"
            />
            <StatCard
              label="Failed"
              value={m?.failedCount ?? 0}
              hint={`${money(m?.failedAmount30d ?? 0)} in 30 days`}
              icon={<XCircle className="size-4" />}
              tone="rose"
            />
            <StatCard
              label="Refunds"
              value={m?.refundCount ?? 0}
              hint={money(m?.refundAmount ?? 0)}
              icon={<RotateCcw className="size-4" />}
              tone="amber"
            />
            <StatCard
              label="Renewals"
              value={m?.renewalCount ?? 0}
              hint="monthly charges"
              icon={<RotateCcw className="size-4" />}
              tone="sky"
            />
            <StatCard
              label="Cancellations"
              value={m?.cancellations ?? 0}
              hint="canceled accounts"
              icon={<ArrowDownRight className="size-4" />}
              tone="rose"
            />
            <StatCard
              label="Pending"
              value={m?.pendingCount ?? 0}
              hint="awaiting settlement"
              icon={<AlertOctagon className="size-4" />}
              tone="slate"
            />
          </div>

          <Panel
            title="Plans"
            description="The catalogue MRR is calculated from."
            bodyClassName="px-0 py-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left">
                <thead>
                  <tr className="border-b border-admin-border text-[11.5px] uppercase tracking-wider text-admin-muted">
                    <th className="px-5 py-3 font-medium">Plan</th>
                    <th className="px-3 py-3 text-right font-medium">Monthly</th>
                    <th className="px-3 py-3 text-right font-medium">Yearly</th>
                    <th className="px-3 py-3 text-right font-medium">Trial</th>
                    <th className="px-3 py-3 text-right font-medium">Subscribers</th>
                    <th className="px-3 py-3 font-medium">Razorpay plan</th>
                    <th className="px-5 py-3 font-medium">Included</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-admin-border-soft">
                  {(data?.plans ?? []).map((p) => (
                    <tr key={p.id} className="transition hover:bg-admin-elevated">
                      <td className="px-5 py-3">
                        <span className="text-[13.5px] font-medium text-admin-fg">{p.name}</span>
                        <span className="ml-2 rounded bg-admin-elevated px-1.5 py-0.5 text-[11px] capitalize text-admin-muted">
                          {p.id}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {money(p.priceMonthly)}
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {money(p.priceYearly)}
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {p.trialDays}d
                      </td>
                      <td className="px-3 py-3 text-right text-[13px] tabular-nums text-admin-fg-body">
                        {p.subscribers}
                      </td>
                      <td className="px-3 py-3">
                        {editingPlan === p.id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              value={planIdValue}
                              onChange={(e) => setPlanIdValue(e.target.value)}
                              placeholder="plan_…"
                              autoComplete="off"
                              spellCheck={false}
                              className="h-7 w-40 rounded-md border border-admin-border bg-admin-bg px-2 font-mono text-[11.5px] text-admin-fg outline-none focus:border-admin-accent"
                            />
                            <button
                              onClick={() => savePlan(p.id)}
                              disabled={savingPlan}
                              className="rounded-md bg-admin-accent px-2 py-1 text-[11.5px] font-medium text-white disabled:opacity-60"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingPlan(null)}
                              className="rounded-md px-1.5 py-1 text-[11.5px] text-admin-muted hover:text-admin-fg"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => startEditingPlan(p.id, p.razorpayPlanId)}
                            className="flex items-center gap-1.5 text-left font-mono text-[11.5px] text-admin-muted transition hover:text-admin-fg"
                          >
                            {p.razorpayPlanId ? (
                              <span className="text-admin-fg-body">{p.razorpayPlanId}</span>
                            ) : (
                              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-sans text-[10.5px] text-amber-600">
                                not set
                              </span>
                            )}
                            <span className="text-[10.5px] underline underline-offset-2">edit</span>
                          </button>
                        )}
                      </td>
                      <td className="px-5 py-3 text-[12.5px] text-admin-muted">
                        {p.features.join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Transactions"
            description="Everything in the ledger, newest first."
            bodyClassName="px-0 py-0"
          >
            {data?.transactions?.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left">
                  <thead>
                    <tr className="border-b border-admin-border text-[11.5px] uppercase tracking-wider text-admin-muted">
                      <th className="px-5 py-3 font-medium">Restaurant</th>
                      <th className="px-3 py-3 font-medium">Plan</th>
                      <th className="px-3 py-3 font-medium">Period</th>
                      <th className="px-3 py-3 font-medium">Status</th>
                      <th className="px-3 py-3 text-right font-medium">Amount</th>
                      <th className="px-5 py-3 text-right font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-admin-border-soft">
                    {data.transactions.map((t) => (
                      <tr key={t.id} className="transition hover:bg-admin-elevated">
                        <td className="px-5 py-2.5 text-[13px] font-medium text-admin-fg">
                          {t.tenantName}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] capitalize text-admin-fg-body">
                          {t.plan_id}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] capitalize text-admin-fg-body">
                          {t.billing_period}
                        </td>
                        <td className="px-3 py-2.5">
                          <Pill status={t.status}>{t.status}</Pill>
                        </td>
                        <td className="px-3 py-2.5 text-right text-[13px] tabular-nums text-admin-fg">
                          {money(t.amount, t.currency === 'INR' ? '₹' : `${t.currency} `)}
                        </td>
                        <td className="px-5 py-2.5 text-right text-[12.5px] text-admin-muted">
                          {relativeTime(t.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 py-10 text-center text-[13px] text-admin-faint">
                No payments have been recorded yet.
              </p>
            )}
          </Panel>
        </div>
      </DataState>
    </div>
  )
}
