'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Save, Settings as SettingsIcon } from 'lucide-react'
import { superAdminFetch } from '@/lib/superadmin'
import { PageTitle, Panel } from '@/components/superadmin/ui'

type BusinessDetails = {
  legalName: string
  street: string
  city: string
  state: string
  pinCode: string
  country: string
  email: string
  phone: string
  gstin: string
}

type LoadResponse = {
  configured: boolean
  details: BusinessDetails
  updatedAt: string | null
}

const EMPTY: BusinessDetails = {
  legalName: '',
  street: '',
  city: '',
  state: '',
  pinCode: '',
  country: 'India',
  email: '',
  phone: '',
  gstin: '',
}

const FIELDS: {
  key: keyof BusinessDetails
  label: string
  placeholder: string
  required?: boolean
  hint?: string
  span2?: boolean
  inputMode?: 'text' | 'email' | 'numeric' | 'tel'
}[] = [
  { key: 'legalName', label: 'Legal business / proprietor name', placeholder: 'As on your registration or PAN', required: true, span2: true },
  { key: 'street', label: 'Street / area', placeholder: 'Shop, street, locality', required: true, span2: true },
  { key: 'city', label: 'City', placeholder: 'Bengaluru', required: true },
  { key: 'state', label: 'State', placeholder: 'Karnataka', required: true },
  { key: 'pinCode', label: 'PIN code', placeholder: '560001', required: true, inputMode: 'numeric' },
  { key: 'country', label: 'Country', placeholder: 'India', required: true },
  { key: 'email', label: 'Business email', placeholder: 'billing@yourbusiness.com', required: true, inputMode: 'email' },
  { key: 'phone', label: 'Contact number', placeholder: '+91 90000 00000', required: true, inputMode: 'tel' },
  {
    key: 'gstin',
    label: 'GSTIN',
    placeholder: '29ABCDE1234F1Z5',
    hint: 'Optional — stored for future use. It is not shown on invoices yet.',
    span2: true,
  },
]

function inputClass(invalid: boolean) {
  return `h-10 w-full rounded-lg border bg-white px-3 text-sm text-admin-fg outline-none transition placeholder:text-admin-faint-3 focus:border-admin-accent focus:ring-2 focus:ring-admin-accent-ring ${
    invalid ? 'border-red-400' : 'border-admin-border'
  }`
}

export default function SuperAdminSettings() {
  const [form, setForm] = useState<BusinessDetails>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof BusinessDetails, string>>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await superAdminFetch<LoadResponse>('platform/business-details')
      if (!res.ok || !res.data) {
        setLoadError(res.error ?? 'Could not load the business details')
        return
      }
      setLoadError(null)
      setForm({ ...EMPTY, ...res.data.details })
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const set = (key: keyof BusinessDetails) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }))
    setFieldErrors((fe) => ({ ...fe, [key]: undefined }))
    setSavedAt(null)
  }

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    setFieldErrors({})
    try {
      const res = await superAdminFetch<{ updatedAt: string } & { fieldErrors?: Record<string, string> }>(
        'platform/business-details',
        { method: 'PUT', body: JSON.stringify(form) },
      )
      if (!res.ok) {
        const fe = (res.data as { fieldErrors?: Record<string, string> } | null)?.fieldErrors
        if (fe) setFieldErrors(fe)
        setSaveError(res.error ?? 'Could not save')
        return
      }
      setSavedAt(new Date().toISOString())
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageTitle
        title="Settings"
        description="Platform-wide configuration. Everything here changes how The Salad itself operates."
      />

      <div className="mb-4 flex items-center gap-2 text-[13px] font-medium uppercase tracking-wider text-admin-muted">
        <SettingsIcon className="size-4" />
        Billing &amp; Invoices
      </div>

      <Panel
        title="Platform Business Details"
        description="This identity appears in the “From” block of every The Salad subscription invoice. Applies to newly generated invoices only — issued invoices always keep the details they were created with."
        action={
          <button
            type="button"
            onClick={save}
            disabled={loading || saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-admin-accent px-4 text-sm font-medium text-white transition hover:bg-admin-accent-hover disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {saving ? 'Saving…' : 'Save details'}
          </button>
        }
      >
        {loading ? (
          <p className="text-sm text-admin-muted">Loading…</p>
        ) : loadError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-red-600">{loadError}</p>
            <button type="button" onClick={load} className="text-sm font-medium text-admin-accent hover:underline">
              Retry
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {savedAt && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] font-medium text-emerald-800">
                <CheckCircle2 className="size-4" />
                Saved — newly generated invoices will use these details.
              </div>
            )}
            {saveError && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700">
                {saveError}
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.key} className={f.span2 ? 'sm:col-span-2' : ''}>
                  <label htmlFor={`bd-${f.key}`} className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-admin-muted">
                    {f.label}
                    {f.required && <span className="text-admin-accent"> *</span>}
                  </label>
                  <input
                    id={`bd-${f.key}`}
                    value={form[f.key]}
                    onChange={set(f.key)}
                    placeholder={f.placeholder}
                    inputMode={f.inputMode ?? 'text'}
                    className={inputClass(!!fieldErrors[f.key])}
                  />
                  {fieldErrors[f.key] ? (
                    <p className="mt-1 text-[12.5px] font-medium text-red-600">{fieldErrors[f.key]}</p>
                  ) : f.hint ? (
                    <p className="mt-1 text-[12.5px] text-admin-faint-3">{f.hint}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}
