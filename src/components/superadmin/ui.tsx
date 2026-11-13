'use client'

import { ReactNode } from 'react'
import { AlertTriangle, Inbox, Loader2, ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Shared pieces for the Super Admin panel.
 *
 * The panel used to be a bare shell: hardcoded labels, a search box that
 * did nothing, and a page that showed a red box when a request failed.
 * These primitives give every page the same loading, empty, error and
 * status treatment, so the whole surface reads as one product.
 */

export function Panel({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-admin-border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]',
        className,
      )}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-admin-border-soft px-5 py-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[15px] font-semibold tracking-tight text-admin-fg">{title}</h2>
            )}
            {description && (
              <p className="mt-0.5 text-[13px] text-admin-muted">{description}</p>
            )}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn('px-5 py-4', bodyClassName)}>{children}</div>
    </section>
  )
}

const TONES = {
  /** The brand accent — the restaurant app's orange. */
  orange: 'bg-admin-accent-soft text-admin-accent ring-admin-accent-soft',
  emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
  amber: 'bg-amber-50 text-amber-600 ring-amber-100',
  rose: 'bg-rose-50 text-rose-600 ring-rose-100',
  slate: 'bg-admin-elevated text-admin-fg-body ring-admin-border',
  sky: 'bg-sky-50 text-sky-600 ring-sky-100',
  /** A second accent, kept distinct from the brand so neighbouring cards
      never look like the same tile. */
  violet: 'bg-violet-50 text-violet-600 ring-violet-100',
} as const

export type Tone = keyof typeof TONES

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'orange',
  delta,
  className,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  tone?: Tone
  /** Percentage change. `null` means no comparison is available. */
  delta?: number | null
  className?: string
}) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-admin-border bg-white p-5',
        'shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-16px_rgba(15,23,42,0.16)]',
        'transition-shadow hover:shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_32px_-16px_rgba(15,23,42,0.22)]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] font-medium uppercase tracking-wider text-admin-muted">{label}</p>
        {icon && (
          <span className={cn('grid size-9 place-items-center rounded-xl ring-1', TONES[tone])}>
            {icon}
          </span>
        )}
      </div>

      <p className="mt-3 text-[28px] font-semibold leading-none tracking-tight text-admin-fg tabular-nums">
        {value}
      </p>

      <div className="mt-2 flex items-center gap-2 text-[12.5px] text-admin-muted">
        {typeof delta === 'number' && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium',
              delta >= 0
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-rose-50 text-rose-700',
            )}
          >
            {delta >= 0 ? (
              <ArrowUpRight className="size-3" />
            ) : (
              <ArrowDownRight className="size-3" />
            )}
            {Math.abs(delta).toFixed(1)}%
          </span>
        )}
        {hint && <span className="truncate">{hint}</span>}
      </div>
    </div>
  )
}

const STATUS_TONES: Record<string, Tone> = {
  active: 'emerald',
  trial: 'sky',
  cancelled: 'rose',
  canceled: 'rose',
  past_due: 'amber',
  succeeded: 'emerald',
  failed: 'rose',
  refunded: 'amber',
  pending: 'slate',
  open: 'rose',
  in_progress: 'amber',
  resolved: 'emerald',
  urgent: 'rose',
  high: 'amber',
  normal: 'slate',
  low: 'slate',
}

export function Pill({
  children,
  tone,
  status,
}: {
  children: ReactNode
  tone?: Tone
  status?: string
}) {
  const resolved = tone ?? STATUS_TONES[(status ?? '').toLowerCase()] ?? 'slate'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium capitalize ring-1',
        TONES[resolved],
      )}
    >
      {children}
    </span>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-[rgba(0,0,0,0.06)]', className)} />
}

/**
 * The one place a page decides what to show: a skeleton while it loads, the
 * real error when something failed, an empty state when there is nothing yet.
 */
export function DataState({
  loading,
  error,
  empty,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  onRetry,
  children,
}: {
  loading: boolean
  error?: string | null
  empty?: boolean
  emptyTitle?: string
  emptyDescription?: string
  onRetry?: () => void
  children: ReactNode
}) {
  if (loading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-3/4" />
        <Skeleton className="h-9 w-1/2" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-rose-200 bg-rose-50/70 p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-600" />
          <div>
            <p className="text-sm font-medium text-rose-900">Could not load this</p>
            <p className="mt-0.5 text-[13px] text-rose-700">{error}</p>
          </div>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[13px] font-medium text-rose-700 transition hover:bg-rose-50"
          >
            Try again
          </button>
        )}
      </div>
    )
  }

  if (empty) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-admin-border bg-admin-bg px-6 py-10 text-center">
        <Inbox className="size-6 text-admin-faint" />
        <p className="text-sm font-medium text-admin-fg-body">{emptyTitle}</p>
        {emptyDescription && (
          <p className="max-w-sm text-[13px] text-admin-muted">{emptyDescription}</p>
        )}
      </div>
    )
  }

  return <>{children}</>
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-admin-muted">
      <Loader2 className="size-4 animate-spin" />
      {label}…
    </div>
  )
}

export function PageTitle({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-admin-fg">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-admin-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

/** Money, in the currency the tenant charges in. */
export function money(value: number, symbol = '₹'): string {
  return `${symbol}${Number(value ?? 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function compactMoney(value: number, symbol = '₹'): string {
  const n = Number(value ?? 0)
  if (Math.abs(n) >= 1_000_000) return `${symbol}${(n / 1_000_000).toFixed(1)}Cr`
  if (Math.abs(n) >= 1000) return `${symbol}${(n / 1000).toFixed(1)}k`
  return `${symbol}${n.toFixed(0)}`
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diff = Date.now() - then
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}
