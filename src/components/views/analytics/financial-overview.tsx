'use client'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  IndianRupee,
  ClipboardList,
  ShoppingBag,
  Receipt,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import { AnalyticsPayload, calcPctChange, formatINR } from './types'

interface FinancialOverviewProps {
  analytics: AnalyticsPayload | null
  loading: boolean
  compareEnabled: boolean
  sym: string
}

export function FinancialOverview({
  analytics,
  loading,
  compareEnabled,
  sym,
}: FinancialOverviewProps) {
  const prev = compareEnabled ? analytics?.previousPeriod : null
  const compDates = prev ? `vs ${prev.from} to ${prev.to}` : null

  const totalRevenue = analytics?.totalRevenue ?? 0
  const totalOrders = analytics?.totalOrders ?? 0
  const avgOrder = analytics?.avgOrder ?? 0
  const netSales =
    analytics?.netSales ??
    Math.max(0, totalRevenue - (analytics?.taxCollected ?? 0) - (analytics?.serviceChargeCollected ?? 0))

  const revChange = prev ? calcPctChange(totalRevenue, prev.totalRevenue) : null
  const ordChange = prev ? calcPctChange(totalOrders, prev.totalOrders) : null
  const aovChange = prev ? calcPctChange(avgOrder, prev.avgOrder) : null
  const netChange = prev ? calcPctChange(netSales, prev.netSales) : null

  return (
    <section aria-labelledby="section-financial-overview" className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 id="section-financial-overview" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          1. Financial Overview
        </h2>
        {compDates && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            Comparison: {compDates}
          </span>
        )}
      </div>

      {/* Exact order: Revenue, Completed Orders, Average Order Value, Net Sales */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={IndianRupee}
          label="Revenue"
          value={loading ? '—' : formatINR(totalRevenue, sym)}
          sub={
            analytics
              ? `Gross settled (${analytics.range?.days ?? 1}d)`
              : 'Loading...'
          }
          change={revChange}
          hasPrevBaseline={Boolean(prev)}
          accent="coral"
        />
        <KpiCard
          icon={ClipboardList}
          label="Completed Orders"
          value={loading ? '—' : totalOrders.toLocaleString('en-IN')}
          sub="Settled & fulfilled"
          change={ordChange}
          hasPrevBaseline={Boolean(prev)}
          accent="green"
        />
        <KpiCard
          icon={ShoppingBag}
          label="Average Order Value"
          value={loading ? '—' : formatINR(avgOrder, sym)}
          sub="Revenue / completed orders"
          change={aovChange}
          hasPrevBaseline={Boolean(prev)}
          accent="amber"
        />
        <KpiCard
          icon={Receipt}
          label="Net Sales"
          value={loading ? '—' : formatINR(netSales, sym)}
          sub={
            analytics
              ? `Pre-tax (${formatINR(analytics.taxCollected ?? 0, sym)} GST)`
              : 'Items net of discounts'
          }
          change={netChange}
          hasPrevBaseline={Boolean(prev)}
          accent="blue"
        />
      </div>
    </section>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  change,
  hasPrevBaseline,
  accent,
}: {
  icon: any
  label: string
  value: string
  sub?: string
  change: number | null
  hasPrevBaseline: boolean
  accent: 'coral' | 'green' | 'amber' | 'blue'
}) {
  const accents: Record<string, string> = {
    coral: 'bg-primary/10 text-primary border-primary/20',
    green: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  }

  const hasValidChange = change !== null && !Number.isNaN(change)
  const isZero = hasValidChange && Math.abs(change) < 0.05
  const isPositive = hasValidChange && change >= 0.05

  return (
    <Card className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm transition-all hover:border-border">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className={cn('size-8 rounded-lg flex items-center justify-center border shrink-0', accents[accent])}>
          <Icon className="size-4" />
        </div>
        {hasPrevBaseline && (
          hasValidChange ? (
            isZero ? (
              <span className="text-[11px] font-medium text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/60 tabular-nums">
                0.0%
              </span>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded tabular-nums',
                  isPositive
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-red-500/15 text-red-600 dark:text-red-400'
                )}
              >
                {isPositive ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                {Math.abs(change).toFixed(1)}%
              </span>
            )
          ) : (
            <span className="text-[10px] font-medium text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/40">
              No prior data
            </span>
          )
        )}
      </div>
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="text-xl md:text-2xl font-bold tracking-tight tabular-nums truncate text-foreground">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
    </Card>
  )
}
