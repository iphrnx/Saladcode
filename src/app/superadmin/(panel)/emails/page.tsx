'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Mail, RotateCcw, Send } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import { DataState, PageTitle, Panel, Pill, StatCard, relativeTime } from '@/components/superadmin/ui'

/**
 * Are the billing emails actually going out?
 *
 * Counts, when the last one left, whether the daily job ran, and what failed
 * and why. Recipients are masked by the server — an operator needs to know a
 * message reached a restaurant, not who the person is, and no key is ever part
 * of this response.
 */
type EmailDelivery = {
  totals: { total: number; sent: number; pending: number; failed: number; retrying: number }
  last24h: { total: number; sent: number; failed: number }
  lastSentAt: string | null
  lastDailyRunAt: string | null
  lastError: { at: string; type: string; message: string } | null
  recent: Array<{
    id: string
    type: string
    recipient: string
    restaurant: string | null
    plan: string | null
    status: string
    attempts: number
    providerId: string | null
    createdAt: string
    sentAt: string | null
    error: string | null
  }>
}

const STATUS_TONE: Record<string, string> = {
  sent: 'text-emerald-400',
  pending: 'text-amber-400',
  failed: 'text-red-400',
  skipped: 'text-admin-fg-muted',
}

export default function SuperAdminEmails() {
  const [data, setData] = useState<EmailDelivery | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await superAdminFetch<EmailDelivery>('emails')
      if ('error' in res) {
        setError(res.error)
        return
      }
      setData(res)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-5">
      <PageTitle
        title="Email Delivery"
        description="Transactional mail: what was sent, what is waiting, and what failed."
      />

      <DataState
        loading={loading && !data}
        error={error}
        empty={false}
        onRetry={load}
      >
        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Sent" value={data.totals.sent} icon={<CheckCircle2 className="size-4" />} tone="emerald" />
              <StatCard label="Pending" value={data.totals.pending} icon={<Clock className="size-4" />} tone="amber" />
              <StatCard label="Retrying" value={data.totals.retrying} icon={<RotateCcw className="size-4" />} tone="amber" />
              <StatCard label="Failed" value={data.totals.failed} icon={<AlertTriangle className="size-4" />} tone="rose" />
            </div>

            <Panel title="Dispatch health">
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <div>
                  <dt className="text-admin-fg-muted text-xs">Last email sent</dt>
                  <dd className="mt-0.5">{data.lastSentAt ? relativeTime(data.lastSentAt) : 'never'}</dd>
                </div>
                <div>
                  <dt className="text-admin-fg-muted text-xs">Last daily run</dt>
                  <dd className="mt-0.5">{data.lastDailyRunAt ? relativeTime(data.lastDailyRunAt) : 'never'}</dd>
                </div>
                <div>
                  <dt className="text-admin-fg-muted text-xs">Last 24h</dt>
                  <dd className="mt-0.5">
                    {data.last24h.sent} sent · {data.last24h.failed} failed
                  </dd>
                </div>
                <div>
                  <dt className="text-admin-fg-muted text-xs">Last error</dt>
                  <dd className="mt-0.5">
                    {data.lastError ? (
                      <span className="text-red-400" title={data.lastError.message}>
                        {data.lastError.type} · {relativeTime(data.lastError.at)}
                      </span>
                    ) : (
                      'none'
                    )}
                  </dd>
                </div>
              </dl>
              {data.lastError && (
                <p className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {data.lastError.message}
                </p>
              )}
              {!data.lastDailyRunAt && (
                <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  The daily scheduler has not run yet. Renewal and trial reminders are only queued when it
                  does.
                </p>
              )}
            </Panel>

            <Panel title="Recent deliveries">
              {data.recent.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-admin-fg-muted">
                  <Mail className="size-4" /> No emails have been queued yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-admin-fg-muted">
                        <th className="pb-2 font-medium">Event</th>
                        <th className="pb-2 font-medium">Recipient</th>
                        <th className="pb-2 font-medium">Restaurant</th>
                        <th className="pb-2 font-medium">Status</th>
                        <th className="pb-2 font-medium">Tries</th>
                        <th className="pb-2 font-medium">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((row) => (
                        <tr key={row.id} className="border-t border-admin-line/60">
                          <td className="py-2 pr-3">{row.type.replace(/_/g, ' ')}</td>
                          <td className="py-2 pr-3 font-mono text-xs">{row.recipient}</td>
                          <td className="py-2 pr-3">{row.restaurant ?? '—'}</td>
                          <td className={`py-2 pr-3 ${STATUS_TONE[row.status] ?? ''}`}>{row.status}</td>
                          <td className="py-2 pr-3">{row.attempts}</td>
                          <td className="py-2 text-admin-fg-muted" title={row.sentAt ?? row.createdAt}>
                            {relativeTime(row.sentAt ?? row.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <p className="flex items-center gap-2 text-xs text-admin-fg-muted">
              <Send className="size-3.5" />
              &ldquo;Sent&rdquo; means the provider accepted the message. It is not proof the inbox received
              it — provider webhooks would be needed for that, and none are configured.
            </p>
          </>
        )}
      </DataState>
    </div>
  )
}
