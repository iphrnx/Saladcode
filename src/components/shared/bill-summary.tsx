'use client'

import { Layers } from 'lucide-react'
import { formatCurrency } from '@/lib/constants'
import { cn } from '@/lib/utils'

export interface BillSummaryProps {
  subtotal: number
  discount?: number
  tax?: number
  cgst?: number
  sgst?: number
  cgstRate?: number
  sgstRate?: number
  taxRate?: number
  serviceCharge?: number
  serviceRate?: number
  roundOff?: number
  total: number
  paid?: number
  due?: number
  orderCount?: number
  itemCount?: number
  currencySymbol?: string
  mode?: 'pay' | 'done'
  className?: string
}

function fmtPct(n: number): string {
  return String(Number(n.toFixed(2)))
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

export function BillSummary({
  subtotal,
  discount = 0,
  tax,
  cgst,
  sgst,
  cgstRate = 2.5,
  sgstRate = 2.5,
  taxRate = 5,
  serviceCharge = 0,
  serviceRate,
  roundOff = 0,
  total,
  paid = 0,
  due = 0,
  orderCount,
  itemCount,
  currencySymbol = '₹',
  mode = 'pay',
  className,
}: BillSummaryProps) {
  const money = (n: number) => formatCurrency(n, currencySymbol)

  // Deterministic GST split in integer paise with zero rounding drift
  const totalTax = tax ?? ((cgst ?? 0) + (sgst ?? 0))
  const gstTotalPaise = Math.round(totalTax * 100)
  const derivedCgstPaise = Math.ceil(gstTotalPaise / 2)
  const derivedSgstPaise = gstTotalPaise - derivedCgstPaise
  const effectiveCgst = cgst ?? +(derivedCgstPaise / 100).toFixed(2)
  const effectiveSgst = sgst ?? +(derivedSgstPaise / 100).toFixed(2)

  const effectiveServiceRate = serviceRate ?? (subtotal > 0 && serviceCharge > 0 ? Math.round((serviceCharge / subtotal) * 100) : 0)
  const isFullyPaid = due <= 0

  const hasOrdersInfo = (orderCount !== undefined && orderCount > 0) || (itemCount !== undefined && itemCount > 0)
  const ordersLabel = orderCount !== undefined
    ? `${orderCount} Order${orderCount === 1 ? '' : 's'}`
    : ''
  const itemsLabel = itemCount !== undefined
    ? `${itemCount} Item${itemCount === 1 ? '' : 's'}`
    : ''
  const countBadge = [ordersLabel, itemsLabel].filter(Boolean).join(' · ')

  return (
    <div
      data-testid="bill-summary"
      className={cn(
        'rounded-2xl border bg-card p-3.5 shadow-xs sm:p-4',
        mode === 'done' ? 'mt-2.5 border-border/60 p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]' : 'mt-3.5 border-border/70',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/50 pb-2.5">
        <p className="flex items-center gap-1.5 text-[14px] sm:text-[14.5px] font-bold text-foreground">
          <Layers className="size-4 text-primary" />
          Bill Summary
        </p>
        {hasOrdersInfo && (
          <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground sm:text-[12px]">
            {mode === 'done' ? countBadge : `(${countBadge})`}
          </span>
        )}
      </div>

      <div className="mt-2.5 space-y-2 text-[12.5px] sm:text-[13px]">
        <Row label="Subtotal" value={money(subtotal)} />
        {discount > 0 && (
          <Row label="Discount" value={`−${money(discount)}`} />
        )}
        <Row label={`CGST (${fmtPct(cgstRate)}%)`} value={money(effectiveCgst)} />
        <Row label={`SGST (${fmtPct(sgstRate)}%)`} value={money(effectiveSgst)} />
        {serviceCharge > 0 && (
          <Row
            label={`Service Charge (${effectiveServiceRate ? `${effectiveServiceRate}%` : '2%'})`}
            value={money(serviceCharge)}
          />
        )}
        {roundOff !== 0 && (
          <Row
            label="Round Off"
            value={`${roundOff > 0 ? '+' : ''}${money(roundOff)}`}
          />
        )}
      </div>

      <div
        className={cn(
          'mt-3 flex items-center justify-between rounded-xl px-3.5 py-2.5',
          mode === 'done' ? 'bg-primary/10 py-2 border border-primary/20' : 'bg-primary/10 border border-primary/20',
        )}
      >
        <span className="text-[14px] sm:text-[14.5px] font-bold text-foreground">
          {mode === 'done' ? 'Total Paid' : isFullyPaid ? 'Amount Due' : due < total ? 'Amount Due' : 'Total Amount'}
        </span>
        <span className="text-[17px] sm:text-[18px] font-extrabold tabular-nums text-foreground">
          {mode === 'done' ? money(paid || total) : money(due)}
        </span>
      </div>
    </div>
  )
}

export function BillSummarySkeleton({ className }: { className?: string }) {
  return (
    <div
      data-testid="bill-summary-skeleton"
      className={cn('mt-3.5 space-y-3 rounded-2xl border border-border/70 bg-card p-3.5 sm:p-4', className)}
    >
      <div className="flex items-center justify-between pb-2.5 border-b border-border/50">
        <div className="h-4 w-28 bg-muted animate-pulse rounded" />
        <div className="h-3 w-24 bg-muted animate-pulse rounded" />
      </div>
      <div className="space-y-2.5 pt-1">
        <div className="flex justify-between">
          <div className="h-3.5 w-16 bg-muted animate-pulse rounded" />
          <div className="h-3.5 w-14 bg-muted animate-pulse rounded" />
        </div>
        <div className="flex justify-between">
          <div className="h-3.5 w-20 bg-muted animate-pulse rounded" />
          <div className="h-3.5 w-12 bg-muted animate-pulse rounded" />
        </div>
        <div className="flex justify-between">
          <div className="h-3.5 w-20 bg-muted animate-pulse rounded" />
          <div className="h-3.5 w-12 bg-muted animate-pulse rounded" />
        </div>
        <div className="flex justify-between">
          <div className="h-3.5 w-24 bg-muted animate-pulse rounded" />
          <div className="h-3.5 w-12 bg-muted animate-pulse rounded" />
        </div>
      </div>
      <div className="h-11 w-full bg-primary/[0.06] border border-primary/20 animate-pulse rounded-xl mt-3" />
    </div>
  )
}
