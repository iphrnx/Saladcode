'use client'

import { useCallback, useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import { DataState, PageTitle, Panel, relativeTime } from '@/components/superadmin/ui'

type AuditEntry = {
  id: string
  admin_id: string
  action: string
  target_tenant_id: string | null
  details: any
  created_at: string
  admin: { email: string; name: string } | null
}

const ACTION_TONES: Record<string, string> = {
  'tenant.updated': 'bg-admin-accent-soft text-[#c2410c]',
  'tenant.note_added': 'bg-admin-elevated text-admin-fg-body',
  'issue.created': 'bg-rose-50 text-rose-700',
  'issue.updated': 'bg-amber-50 text-amber-700',
}

export default function SuperAdminAudit() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // The flag is cleared in `finally` so a throw can never strand the spinner.
    setLoading(true)
    try {
      const res = await superAdminFetch<AuditEntry[]>('audit')
      if (!res.ok) {
        setError(res.error)
        return
      }
      setError(null)
      setEntries(res.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      <PageTitle
        title="Audit Log"
        description="Every administrative action, who did it, and when."
      />

      <DataState loading={loading} error={error} onRetry={load}>
        <Panel bodyClassName="px-0 py-0">
          {entries.length ? (
            <ul className="divide-y divide-admin-border-soft">
              {entries.map((e) => (
                <li key={e.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <ScrollText className="size-3.5 shrink-0 text-admin-faint" />
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ${
                        ACTION_TONES[e.action] ?? 'bg-admin-elevated text-admin-fg-body'
                      }`}
                    >
                      {e.action}
                    </span>
                    <span className="text-[13px] text-admin-fg-body">
                      by {e.admin?.name || e.admin?.email || 'an administrator'}
                    </span>
                    <span className="ml-auto text-[11.5px] text-admin-faint">
                      {relativeTime(e.created_at)}
                    </span>
                  </div>
                  {e.details && Object.keys(e.details).length > 0 && (
                    <pre className="mt-1.5 ml-6 overflow-x-auto rounded-lg bg-admin-bg px-3 py-2 text-[11.5px] text-admin-fg-body">
                      {JSON.stringify(e.details, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-12 text-center text-[13px] text-admin-faint">
              Nothing has been done from the admin panel yet.
            </p>
          )}
        </Panel>
      </DataState>
    </div>
  )
}
