'use client'

import { ORDER_STATUS, ORDER_TYPE } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  // A held order has its own words: it exists, but nobody has accepted it, so
  // it is not kitchen work yet. "Waiting for table" read as though the table
  // were the thing being waited on; the order is.
  const s =
    status === 'PENDING_ACTIVATION'
      ? { label: 'Awaiting Acceptance', color: '#d97706' }
      : (ORDER_STATUS as any)[status] || { label: status, color: '#9aa3b2' }
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border', className)}
      style={{
        backgroundColor: `${s.color}14`,
        color: s.color,
        borderColor: `${s.color}30`,
      }}
    >
      <span className="relative flex h-1.5 w-1.5">
        {['PENDING', 'PREPARING', 'READY'].includes(status) && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ backgroundColor: s.color }} />
        )}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
      </span>
      {s.label}
    </span>
  )
}

export function OrderTypeBadge({ type, className }: { type: string; className?: string }) {
  const t = (ORDER_TYPE as any)[type] || { label: type, icon: '•' }
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md bg-secondary/60 border border-border px-2 py-0.5 text-xs font-medium text-secondary-foreground', className)}>
      <span className="text-[10px]">{t.icon}</span>
      {t.label}
    </span>
  )
}

export function Tag({ label, className }: { label: string; className?: string }) {
  const key = label.toLowerCase().trim()
  const tagStyles: Record<string, string> = {
    spicy: 'bg-red-500/15 text-red-400 border-red-500/20',
    bestseller: 'bg-primary/15 text-primary border-primary/20',
    signature: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    new: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    veg: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    vegan: 'bg-green-500/15 text-green-400 border-green-500/20',
    'non-veg': 'bg-rose-500/15 text-rose-400 border-rose-500/20',
    jain: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
    'gluten-free': 'bg-purple-500/15 text-purple-400 border-purple-500/20',
    healthy: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  }
  // Short display labels so all tags are uniform-sized (no long words wrapping)
  const displayLabels: Record<string, string> = {
    'gluten-free': 'GF',
    bestseller: 'BESTSELLER',
    signature: 'TOP',
    healthy: 'FIT',
    spicy: 'SPICY',
    new: 'NEW',
    veg: 'VEG',
    vegan: 'VEGAN',
    'non-veg': 'NON-VEG',
    jain: 'JAIN',
  }
  const style = tagStyles[key] || 'bg-secondary/70 text-muted-foreground border-border'
  const display = displayLabels[key] || label.toUpperCase()
  return (
    <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap', style, className)}>
      {display}
    </span>
  )
}
