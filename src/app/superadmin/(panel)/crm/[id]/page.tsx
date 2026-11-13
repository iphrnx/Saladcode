'use client'

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CreditCard,
  History,
  MessageSquare,
  Plus,
  Receipt,
  Utensils,
  Users,
} from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  Pill,
  compactMoney,
  money,
  relativeTime,
} from '@/components/superadmin/ui'

type Detail = {
  tenant: any
  owners: any[]
  notes: any[]
  issues: any[]
  payments: any[]
  recentOrders: any[]
  menuItems: any[]
  staff: any[]
  dailyMetrics: any[]
}

const STATUSES = ['trial', 'active', 'past_due', 'cancelled', 'expired']
const PLANS = ['basic', 'pro', 'enterprise']

export default function RestaurantDetail({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()

  const [data, setData] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const res = await superAdminFetch<Detail>(`crm/${id}`)
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
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const addNote = async () => {
    const body = note.trim()
    if (!body) return
    setSaving(true)
    try {
      const res = await superAdminFetch(`crm/${id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body, kind: 'note' }),
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setNote('')
      setSaved('Note added')
      setTimeout(() => setSaved(null), 2500)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  const updateTenant = async (patch: Record<string, unknown>) => {
    setSaving(true)
    try {
      const res = await superAdminFetch(`tenants/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setError(null)
      setSaved('Updated')
      setTimeout(() => setSaved(null), 2500)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  const tenant = data?.tenant

  return (
    <div>
      <button
        onClick={() => router.push('/superadmin/crm')}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-admin-muted transition hover:text-admin-fg"
      >
        <ArrowLeft className="size-3.5" />
        All restaurants
      </button>

      <DataState loading={loading} error={error} onRetry={load}>
        {tenant && (
          <div className="space-y-5">
            <PageTitle
              title={tenant.name}
              description={`${tenant.slug} · joined ${relativeTime(tenant.created_at)}`}
              action={
                <div className="flex items-center gap-2">
                  {saved && (
                    <span className="inline-flex items-center gap-1 text-[12.5px] font-medium text-emerald-600">
                      <Check className="size-3.5" />
                      {saved}
                    </span>
                  )}
                  <Pill status={tenant.subscription_status ?? 'unknown'}>
                    {tenant.subscription_status ?? 'unknown'}
                  </Pill>
                </div>
              }
            />

            <div className="grid gap-5 lg:grid-cols-3">
              <Panel title="Account" description="Who owns it and what they pay.">
                <dl className="space-y-3 text-[13px]">
                  {[
                    {
                      label: 'Owner',
                      value: data?.owners?.[0]
                        ? `${data.owners[0].name ?? ''} · ${data.owners[0].email}`
                        : '—',
                    },
                    { label: 'Slug', value: tenant.slug },
                    { label: 'Created', value: new Date(tenant.created_at).toLocaleDateString('en-IN') },
                    {
                      label: 'Trial ends',
                      value: tenant.trial_ends_at
                        ? new Date(tenant.trial_ends_at).toLocaleDateString('en-IN')
                        : '—',
                    },
                    {
                      label: 'Period ends',
                      value: tenant.current_period_end
                        ? new Date(tenant.current_period_end).toLocaleDateString('en-IN')
                        : '—',
                    },
                    { label: 'Onboarding', value: tenant.onboarding_done ? 'Complete' : 'Incomplete' },
                    { label: 'Account', value: tenant.active ? 'Active' : 'Disabled' },
                  ].map((row) => (
                    <div key={row.label} className="flex items-baseline justify-between gap-4">
                      <dt className="text-admin-muted">{row.label}</dt>
                      <dd className="truncate text-right font-medium text-admin-fg">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </Panel>

              <Panel title="Subscription" description="Changes are written to the audit log.">
                <div className="space-y-3">
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-medium uppercase tracking-wider text-admin-muted">
                      Plan
                    </span>
                    <select
                      value={tenant.plan}
                      disabled={saving}
                      onChange={(e) => updateTenant({ plan: e.target.value })}
                      className="h-9 w-full rounded-lg border border-admin-border bg-white px-2.5 text-[13px] outline-none focus:border-admin-accent"
                    >
                      {PLANS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-[12px] font-medium uppercase tracking-wider text-admin-muted">
                      Status
                    </span>
                    <select
                      value={tenant.subscription_status ?? 'trial'}
                      disabled={saving}
                      onChange={(e) => updateTenant({ subscriptionStatus: e.target.value })}
                      className="h-9 w-full rounded-lg border border-admin-border bg-white px-2.5 text-[13px] outline-none focus:border-admin-accent"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-[12px] font-medium uppercase tracking-wider text-admin-muted">
                      Trial ends
                    </span>
                    <input
                      type="date"
                      disabled={saving}
                      defaultValue={tenant.trial_ends_at ? tenant.trial_ends_at.slice(0, 10) : ''}
                      onChange={(e) =>
                        updateTenant({
                          trialEndsAt: e.target.value ? new Date(e.target.value).toISOString() : null,
                        })
                      }
                      className="h-9 w-full rounded-lg border border-admin-border bg-white px-2.5 text-[13px] outline-none focus:border-admin-accent"
                    />
                  </label>

                  <button
                    onClick={() => updateTenant({ active: !tenant.active })}
                    disabled={saving}
                    className={`w-full rounded-lg border px-3 py-2 text-[13px] font-medium transition disabled:opacity-60 ${
                      tenant.active
                        ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                        : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                    }`}
                  >
                    {tenant.active ? 'Disable this account' : 'Re-enable this account'}
                  </button>
                </div>
              </Panel>

              <Panel title="At a glance">
                <div className="grid grid-cols-2 gap-4 text-[13px]">
                  {[
                    { label: 'Orders', value: String(data?.recentOrders?.length ?? 0), icon: Receipt },
                    { label: 'Menu items', value: String(data?.menuItems?.length ?? 0), icon: Utensils },
                    { label: 'Staff', value: String(data?.staff?.length ?? 0), icon: Users },
                    { label: 'Payments', value: String(data?.payments?.length ?? 0), icon: CreditCard },
                  ].map((row) => (
                    <div key={row.label}>
                      <row.icon className="size-3.5 text-admin-faint" />
                      <p className="mt-1 text-[20px] font-semibold tabular-nums text-admin-fg">
                        {row.value}
                      </p>
                      <p className="text-[12px] text-admin-muted">{row.label}</p>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Panel
                title="Follow-up notes"
                description="What was said, and when."
                action={
                  <button
                    onClick={addNote}
                    disabled={saving || !note.trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-admin-accent px-2.5 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-admin-accent-hover disabled:opacity-50"
                  >
                    <Plus className="size-3.5" />
                    Add note
                  </button>
                }
              >
                <div className="mb-3 flex gap-2">
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addNote()
                    }}
                    placeholder="Called about the trial ending…"
                    className="h-9 flex-1 rounded-lg border border-admin-border bg-admin-bg px-3 text-[13px] outline-none transition placeholder:text-admin-faint focus:border-admin-accent focus:bg-white"
                  />
                </div>

                {data?.notes?.length ? (
                  <ul className="space-y-2.5">
                    {data.notes.map((n: any) => (
                      <li key={n.id} className="rounded-xl border border-admin-border-soft bg-admin-bg p-3">
                        <p className="text-[13px] text-admin-fg-body">{n.body}</p>
                        <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-admin-faint">
                          <MessageSquare className="size-3" />
                          {n.kind} · {relativeTime(n.created_at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg border border-dashed border-admin-border px-3 py-6 text-center text-[13px] text-admin-faint">
                    No notes on this restaurant yet.
                  </p>
                )}
              </Panel>

              <Panel
                title="Recent orders"
                description="The last orders this restaurant took."
                bodyClassName="px-0 py-0"
              >
                {data?.recentOrders?.length ? (
                  <ul className="divide-y divide-admin-border-soft">
                    {data.recentOrders.map((o: any) => (
                      <li key={o.id} className="flex items-center gap-3 px-5 py-2.5">
                        <Receipt className="size-3.5 shrink-0 text-admin-faint" />
                        <span className="flex-1 truncate text-[13px] text-admin-fg-body">
                          {o.order_type} · {o.status}
                        </span>
                        <span className="text-[13px] tabular-nums text-admin-fg">
                          {money(o.total)}
                        </span>
                        <span className="w-20 text-right text-[11.5px] text-admin-faint">
                          {relativeTime(o.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-8 text-center text-[13px] text-admin-faint">
                    No orders yet.
                  </p>
                )}
              </Panel>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Panel
                title="Payments"
                description="Everything in the ledger for this restaurant."
                bodyClassName="px-0 py-0"
              >
                {data?.payments?.length ? (
                  <ul className="divide-y divide-admin-border-soft">
                    {data.payments.map((p: any) => (
                      <li key={p.id} className="flex items-center gap-3 px-5 py-2.5">
                        <CreditCard className="size-3.5 shrink-0 text-admin-faint" />
                        <span className="flex-1 truncate text-[13px] text-admin-fg-body">
                          {p.plan_id} · {p.billing_period}
                        </span>
                        <Pill status={p.status}>{p.status}</Pill>
                        <span className="w-24 text-right text-[13px] tabular-nums text-admin-fg">
                          {money(p.amount, p.currency === 'INR' ? '₹' : `${p.currency} `)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-8 text-center text-[13px] text-admin-faint">
                    No payments recorded.
                  </p>
                )}
              </Panel>

              <Panel title="Support issues" bodyClassName="px-0 py-0">
                {data?.issues?.length ? (
                  <ul className="divide-y divide-admin-border-soft">
                    {data.issues.map((i: any) => (
                      <li key={i.id} className="flex items-center gap-3 px-5 py-2.5">
                        <span className="flex-1 truncate text-[13px] text-admin-fg-body">{i.subject}</span>
                        <Pill status={i.status}>{i.status}</Pill>
                        <span className="w-20 text-right text-[11.5px] text-admin-faint">
                          {relativeTime(i.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-8 text-center text-[13px] text-admin-faint">
                    No support issues.
                  </p>
                )}
              </Panel>
            </div>

            <Panel
              title="Daily activity"
              description="Order counts and value per day, from the counters the orders table maintains."
            >
              {data?.dailyMetrics?.length ? (
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {data.dailyMetrics.slice(0, 12).map((d: any) => (
                    <li
                      key={d.date}
                      className="flex items-center gap-2.5 rounded-lg border border-admin-border-soft px-3 py-2"
                    >
                      <CalendarDays className="size-3.5 shrink-0 text-admin-faint" />
                      <span className="flex-1 text-[12.5px] text-admin-fg-body">{d.date}</span>
                      <span className="text-[12.5px] tabular-nums text-admin-muted">
                        {d.order_count} orders
                      </span>
                      <span className="w-20 text-right text-[12.5px] font-medium tabular-nums text-admin-fg">
                        {compactMoney(d.order_value)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-admin-faint">No activity recorded yet.</p>
              )}
            </Panel>

            <Link
              href="/superadmin/audit"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-admin-muted transition hover:text-admin-fg"
            >
              <History className="size-3.5" />
              See everything that has been done to this account
            </Link>
          </div>
        )}
      </DataState>
    </div>
  )
}
