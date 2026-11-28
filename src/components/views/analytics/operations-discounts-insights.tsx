'use client'

import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Card } from '@/components/ui/card'
import { Activity, BadgePercent, Lightbulb, Timer } from 'lucide-react'
import {
  AnalyticsPayload,
  AXIS,
  TYPE_LABEL,
  ChartSkeleton,
  ChartTooltip,
  SectionEmpty,
  calcPctChange,
  formatINR,
} from './types'

interface OperationsDiscountsInsightsProps {
  analytics: AnalyticsPayload | null
  loading: boolean
  compareEnabled: boolean
  sym: string
}

export function OperationsDiscountsInsights({
  analytics,
  loading,
  compareEnabled,
  sym,
}: OperationsDiscountsInsightsProps) {
  const ops = analytics?.operations
  const dr = analytics?.discountsAndRefunds

  const hasTrend = Boolean(dr?.trend?.some((d) => d.discounts > 0 || d.refunds > 0))

  const insights = useMemo(() => {
    if (!analytics) return []
    const list: { title: string; detail: string }[] = []

    const rev = analytics.totalRevenue ?? 0
    const orders = analytics.totalOrders ?? 0
    if (orders === 0) {
      return [
        {
          title: 'No settled activity in this range',
          detail: 'Expand the date range or switch locations to view channel, item, and margin insights.',
        },
      ]
    }

    if (compareEnabled && analytics.previousPeriod) {
      const pct = calcPctChange(rev, analytics.previousPeriod.totalRevenue)
      if (pct !== null) {
        list.push({
          title: pct >= 0 ? `Revenue up ${pct.toFixed(1)}% vs prior period` : `Revenue down ${Math.abs(pct).toFixed(1)}% vs prior period`,
          detail: `${formatINR(rev, sym)} across ${orders} orders vs ${formatINR(analytics.previousPeriod.totalRevenue, sym)} (${analytics.previousPeriod.totalOrders} orders) in ${analytics.previousPeriod.from}–${analytics.previousPeriod.to}.`,
        })
      }
    }

    const topChannel = [...(analytics.typeBreakdown ?? [])].sort((a, b) => b.revenue - a.revenue)[0]
    if (topChannel && topChannel.revenue > 0) {
      list.push({
        title: `${TYPE_LABEL[topChannel.type] || topChannel.type} leads channel revenue`,
        detail: `Contributed ${formatINR(topChannel.revenue, sym)} (${(topChannel.share ?? 0).toFixed(1)}% share) across ${topChannel.count} settled orders.`,
      })
    }

    const peakHour = [...(analytics.hourlyDetailed ?? [])].sort((a, b) => b.revenue - a.revenue)[0]
    if (peakHour && peakHour.revenue > 0) {
      list.push({
        title: `Peak trading hour: ${peakHour.displayHour}`,
        detail: `Generated ${formatINR(peakHour.revenue, sym)} across ${peakHour.orders} orders (${analytics.range?.timezone || 'Asia/Kolkata'}).`,
      })
    }

    const topCat = analytics.categoryBreakdown?.[0]
    if (topCat && topCat.value > 0) {
      list.push({
        title: `Top category: ${topCat.name}`,
        detail: `${formatINR(topCat.value, sym)} (${(topCat.share ?? 0).toFixed(1)}% of item sales, ${topCat.units ?? 0} units).`,
      })
    }

    if (dr && (dr.totalDiscounts > 0 || dr.totalRefunds > 0)) {
      list.push({
        title: 'Discounts & refunds watch',
        detail: `${formatINR(dr.totalDiscounts, sym)} discounted (${dr.discountedOrders} orders) and ${formatINR(dr.totalRefunds, sym)} refunded (${dr.refundCount} txns).`,
      })
    }

    return list
  }, [analytics, compareEnabled, dr, sym])

  return (
    <div className="space-y-4">
      {/* 9. Operations Performance */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">9. Operations Performance</h2>
            <p className="text-[11px] text-muted-foreground">
              Fulfillment speed & volume from verified order timestamps
            </p>
          </div>
          <Activity className="size-4 text-muted-foreground" />
        </div>

        {loading ? (
          <ChartSkeleton className="h-[110px]" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Preparation Time */}
            <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium text-muted-foreground">Preparation Time</span>
                <Timer className="size-3.5 text-muted-foreground" />
              </div>
              <p className="text-base font-bold text-foreground">Not Tracked</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {ops?.prepTime?.reason || 'Kitchen stage timestamps (preparing_at / ready_at) are not recorded.'}
              </p>
            </div>

            {/* Service Time */}
            <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium text-muted-foreground">Service / Fulfillment Time</span>
                <Timer className="size-3.5 text-primary" />
              </div>
              <p className="text-base font-bold tabular-nums text-foreground">
                {ops?.serviceTime?.available && ops.serviceTime.avgMinutes !== null
                  ? `${ops.serviceTime.avgMinutes} min avg`
                  : '—'}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {ops?.serviceTime
                  ? `${ops.serviceTime.startEvent} → ${ops.serviceTime.endEvent} · ${ops.serviceTime.sampleCount} orders included${
                      ops.serviceTime.excludedCount > 0 ? ` (${ops.serviceTime.excludedCount} incomplete excluded)` : ''
                    }`
                  : 'No completed order timestamps'}
              </p>
            </div>

            {/* Order Volume */}
            <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium text-muted-foreground">Completed Order Volume</span>
                <Activity className="size-3.5 text-emerald-500" />
              </div>
              <p className="text-base font-bold tabular-nums text-foreground">
                {(ops?.orderVolume ?? analytics?.totalOrders ?? 0).toLocaleString('en-IN')}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Settled orders in selected scope
                {ops?.serviceTime?.medianMinutes !== null && ops?.serviceTime?.medianMinutes !== undefined
                  ? ` · Median fulfillment: ${ops.serviceTime.medianMinutes} min`
                  : ''}
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* 10. Discounts & Refunds */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <h2 className="text-sm font-bold tracking-tight">10. Discounts & Refunds</h2>
            <p className="text-[11px] text-muted-foreground">
              Reconciled with Financial Overview & Payment Method ledger under identical filters
            </p>
          </div>
          <BadgePercent className="size-4 text-muted-foreground" />
        </div>

        {loading ? (
          <ChartSkeleton className="h-[180px]" />
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
                <p className="text-[11px] text-muted-foreground">Total Discounts</p>
                <p className="text-lg font-bold tabular-nums text-foreground">
                  {formatINR(dr?.totalDiscounts ?? 0, sym)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
                <p className="text-[11px] text-muted-foreground">Discounted Orders</p>
                <p className="text-lg font-bold tabular-nums text-foreground">
                  {(dr?.discountedOrders ?? 0).toLocaleString('en-IN')}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
                <p className="text-[11px] text-muted-foreground">Total Refunds</p>
                <p className="text-lg font-bold tabular-nums text-red-600 dark:text-red-400">
                  {formatINR(dr?.totalRefunds ?? 0, sym)}
                </p>
              </div>
              <div className="rounded-lg border border-border/60 bg-secondary/20 p-3">
                <p className="text-[11px] text-muted-foreground">Refunded Transactions</p>
                <p className="text-lg font-bold tabular-nums text-foreground">
                  {(dr?.refundCount ?? 0).toLocaleString('en-IN')}
                </p>
              </div>
            </div>

            {hasTrend ? (
              <div className="h-[160px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dr?.trend ?? []} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border/40" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(d) => String(d).slice(5)} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${sym}${v}`} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }} />
                    <Bar dataKey="discounts" name="Discounts" fill="#f59e0b" radius={[3, 3, 0, 0]} barSize={12} />
                    <Bar dataKey="refunds" name="Refunds" fill="#ef4444" radius={[3, 3, 0, 0]} barSize={12} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <SectionEmpty
                icon={BadgePercent}
                message="No discounts or refunds recorded in this period"
                className="h-[100px]"
              />
            )}

            {((dr?.discountBreakdown?.length ?? 0) > 0 || (dr?.refundBreakdown?.length ?? 0) > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-border/40">
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Discount Breakdown</p>
                  <div className="space-y-1 text-xs">
                    {(dr?.discountBreakdown ?? []).map((d) => (
                      <div key={d.code} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                        <span className="font-medium text-foreground">{d.code} ({d.count})</span>
                        <span className="tabular-nums font-semibold">{formatINR(d.amount, sym)}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Refund Breakdown</p>
                  <div className="space-y-1 text-xs">
                    {(dr?.refundBreakdown ?? []).map((r) => (
                      <div key={r.method} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                        <span className="font-medium text-foreground">{r.method} ({r.count})</span>
                        <span className="tabular-nums font-semibold text-red-600 dark:text-red-400">
                          {formatINR(r.amount, sym)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </Card>

      {/* 11. Business Insights */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">11. Business Insights</h2>
            <p className="text-[11px] text-muted-foreground">
              Automated observations derived strictly from audited metrics
            </p>
          </div>
          <Lightbulb className="size-4 text-amber-500" />
        </div>

        {loading ? (
          <ChartSkeleton className="h-[100px]" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {insights.map((ins, idx) => (
              <div key={idx} className="rounded-lg border border-border/60 bg-secondary/20 p-3">
                <p className="text-xs font-semibold text-foreground">{ins.title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{ins.detail}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
