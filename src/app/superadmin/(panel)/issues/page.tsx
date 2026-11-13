'use client'

import { useCallback, useEffect, useState } from 'react'
import { MessageSquareWarning, Plus } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import {
  DataState,
  PageTitle,
  Panel,
  Pill,
  StatCard,
  relativeTime,
} from '@/components/superadmin/ui'

type Issue = {
  id: string
  subject: string
  detail: string | null
  status: string
  priority: string
  created_at: string
  resolved_at: string | null
  tenant: { id: string; name: string; slug: string } | null
}

export default function SuperAdminIssues() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [detail, setDetail] = useState('')
  const [priority, setPriority] = useState('normal')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const res = await superAdminFetch<Issue[]>('issues')
      if (!res.ok) {
        setError(res.error)
        return
      }
      setError(null)
      setIssues(res.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!subject.trim()) return
    setSaving(true)
    try {
      const res = await superAdminFetch('issues', {
        method: 'POST',
        body: JSON.stringify({ subject, detail, priority }),
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setSubject('')
      setDetail('')
      setPriority('normal')
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (id: string, status: string) => {
    const res = await superAdminFetch(`issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })
    if (!res.ok) {
      setError(res.error)
      return
    }
    load()
  }

  const open = issues.filter((i) => i.status !== 'resolved').length
  const urgent = issues.filter((i) => i.priority === 'urgent' || i.priority === 'high').length

  return (
    <div>
      <PageTitle
        title="Support Issues"
        description="Problems raised against a restaurant, and what has been done about them."
      />

      <DataState loading={loading} error={error} onRetry={load}>
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Open" value={open} tone="rose" />
            <StatCard label="High priority" value={urgent} tone="amber" />
            <StatCard label="Total" value={issues.length} tone="slate" />
          </div>

          <Panel
            title="Raise an issue"
            description="For a problem you have spotted yourself."
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <div className="space-y-3">
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="What is the problem?"
                  className="h-9 w-full rounded-lg border border-admin-border bg-admin-bg px-3 text-[13px] outline-none transition placeholder:text-admin-faint focus:border-admin-accent focus:bg-white"
                />
                <textarea
                  value={detail}
                  onChange={(e) => setDetail(e.target.value)}
                  rows={3}
                  placeholder="Any detail that helps…"
                  className="w-full resize-y rounded-lg border border-admin-border bg-admin-bg px-3 py-2 text-[13px] outline-none transition placeholder:text-admin-faint focus:border-admin-accent focus:bg-white"
                />
              </div>
              <div className="flex flex-col gap-3">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="h-9 rounded-lg border border-admin-border bg-white px-2.5 text-[13px] text-admin-fg-body outline-none focus:border-admin-accent"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <button
                  onClick={create}
                  disabled={saving || !subject.trim()}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-admin-accent px-3 text-[13px] font-medium text-white transition hover:bg-admin-accent-hover disabled:opacity-50"
                >
                  <Plus className="size-3.5" />
                  Raise
                </button>
              </div>
            </div>
          </Panel>

          <Panel title="All issues" bodyClassName="px-0 py-0">
            {issues.length ? (
              <ul className="divide-y divide-admin-border-soft">
                {issues.map((i) => (
                  <li key={i.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <MessageSquareWarning className="size-3.5 shrink-0 text-admin-faint" />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-admin-fg">
                        {i.subject}
                      </span>
                      {i.tenant && (
                        <span className="text-[12px] text-admin-muted">{i.tenant.name}</span>
                      )}
                      <Pill status={i.priority}>{i.priority}</Pill>
                      <Pill status={i.status}>{i.status}</Pill>
                      <span className="w-20 text-right text-[11.5px] text-admin-faint">
                        {relativeTime(i.created_at)}
                      </span>
                    </div>
                    {i.detail && (
                      <p className="mt-1.5 pl-6 text-[12.5px] text-admin-muted">{i.detail}</p>
                    )}
                    {i.status !== 'resolved' && (
                      <div className="mt-2 flex gap-2 pl-6">
                        {i.status === 'open' && (
                          <button
                            onClick={() => setStatus(i.id, 'in_progress')}
                            className="rounded-md border border-admin-border px-2 py-1 text-[11.5px] font-medium text-admin-fg-body transition hover:bg-admin-bg"
                          >
                            Start work
                          </button>
                        )}
                        <button
                          onClick={() => setStatus(i.id, 'resolved')}
                          className="rounded-md border border-emerald-200 px-2 py-1 text-[11.5px] font-medium text-emerald-700 transition hover:bg-emerald-50"
                        >
                          Resolve
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-10 text-center text-[13px] text-admin-faint">
                No issues have been raised.
              </p>
            )}
          </Panel>
        </div>
      </DataState>
    </div>
  )
}
