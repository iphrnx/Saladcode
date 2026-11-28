'use client'

import { useMemo, useState } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Clock, TrendingUp, Utensils } from 'lucide-react'
import {
  AnalyticsPayload,
  AXIS,
  COLORS,
  CORAL,
  DailyRevenue,
  PREV_LINE,
  TYPE_LABEL,
  ChartSkeleton,
  ChartTooltip,
  SectionEmpty,
  formatINR,
} from './types'

type TrendGrouping = 'daily' | 'weekly' | 'monthly'
type HourlyMetric = 'revenue' | 'orders'

interface RevenueAndChannelsProps {
  analytics: AnalyticsPayload | null
  loading: boolean
  compareEnabled: boolean
  rangeLabel: string
  sym: string
}

function groupSeries(
  rows: DailyRevenue[],
  grouping: TrendGrouping
): { key: string; label: string; periodLabel: string; revenue: number; orders: number }[] {
  if (grouping === 'daily') {
    return rows.map((d) => ({
      key: d.date,
      label: rows.length > 14 ? d.date.slice(5) : `${d.label} ${d.date.slice(8)}`,
      periodLabel: `${d.date} (${d.label})`,
      revenue: d.revenue,
      orders: d.orders,
    }))
  }

  const buckets = new Map<string, { label: string; periodLabel: string; revenue: number; orders: number }>()
  for (const d of rows) {
    let key: string
    let label: string
    let periodLabel: string
    if (grouping === 'monthly') {
      key = d.date.slice(0, 7) // YYYY-MM
      const dt = new Date(`${key}-01T00:00:00Z`)
      label = dt.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      periodLabel = dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    } else {
      // Weekly: bucket by Monday-start week
      const dt = new Date(`${d.date}T00:00:00Z`)
      const day = dt.getUTCDay()
      const diffToMon = (day + 6) % 7
      const mon = new Date(dt.getTime() - diffToMon * 86_400_000)
      key = mon.toISOString().slice(0, 10)
      label = `Wk ${key.slice(5)}`
      periodLabel = `Week of ${key}`
    }
    const existing = buckets.get(key)
    if (existing) {
      existing.revenue = +(existing.revenue + d.revenue).toFixed(2)
      existing.orders += d.orders
    } else {
      buckets.set(key, { label, periodLabel, revenue: d.revenue, orders: d.orders })
    }
  }
  return Array.from(buckets.entries()).map(([key, v]) => ({ key, ...v }))
}

export function RevenueAndChannels({
  analytics,
  loading,
  compareEnabled,
  rangeLabel,
  sym,
}: RevenueAndChannelsProps) {
  const [grouping, setGrouping] = useState<TrendGrouping>('daily')
  const [hourlyMetric, setHourlyMetric] = useState<HourlyMetric>('revenue')

  const timezone = analytics?.range?.timezone || 'Asia/Kolkata'
  const prev = compareEnabled ? analytics?.previousPeriod : null

  const trendData = useMemo(() => {
    const cur = groupSeries(analytics?.dailyRevenue ?? [], grouping)
    const prv = prev ? groupSeries(prev.dailyRevenue ?? [], grouping) : []
    return cur.map((pt, idx) => ({
      ...pt,
      prevRevenue: prv[idx]?.revenue ?? undefined,
      prevPeriodLabel: prv[idx]?.periodLabel ?? undefined,
    }))
  }, [analytics?.dailyRevenue, prev, grouping])

  const hasTrendData = trendData.some((d) => d.revenue > 0 || (d.prevRevenue ?? 0) > 0)

  const orderTypes = useMemo(() => {
    const raw = analytics?.typeBreakdown ?? []
    const totalRev = raw.reduce((s, t) => s + t.revenue, 0)
    return raw.map((t) => ({
      ...t,
      name: TYPE_LABEL[t.type] || t.type,
      share: t.share ?? (totalRev > 0 ? +((t.revenue / totalRev) * 100).toFixed(1) : 0),
      avgOrder: t.avgOrder ?? (t.count > 0 ? +(t.revenue / t.count).toFixed(2) : 0),
    }))
  }, [analytics?.typeBreakdown])

  const hasOrderTypeData = orderTypes.some((t) => t.count > 0 || t.revenue > 0)

  const hourlyData = useMemo(() => {
    if (analytics?.hourlyDetailed && analytics.hourlyDetailed.length === 24) {
      return analytics.hourlyDetailed
    }
    return (analytics?.hourly ?? []).map((orders, h) => ({
      hour: h,
      label: `${h}:00`,
      displayHour: h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`,
      orders,
      revenue: 0,
    }))
  }, [analytics?.hourlyDetailed, analytics?.hourly])

  const hasHourlyData = hourlyData.some((d) => d.orders > 0 || d.revenue > 0)
  const peakHour = useMemo(() => {
    return hourlyData.reduce(
      (best, curr) => (curr[hourlyMetric] > best[hourlyMetric] ? curr : best),
      { hour: -1, label: '—', displayHour: '—', orders: 0, revenue: 0 }
    )
  }, [hourlyData, hourlyMetric])

  return (
    <div className="space-y-4">
      {/* Row: 2. Revenue Trend + 3. Order Types */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* 2. Revenue Trend */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2 shadow-sm">
          <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">2. Revenue Trend</h2>
              <p className="text-[11px] text-muted-foreground">
                Settled revenue ({grouping}) · {rangeLabel}
                {prev ? ` · vs ${prev.from} to ${prev.to}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-secondary/50 p-0.5 border border-border/50">
              {(['daily', 'weekly', 'monthly'] as TrendGrouping[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGrouping(g)}
                  className={cn(
                    'px-2 py-1 text-[11px] font-medium rounded-md capitalize transition-colors',
                    grouping === g
                      ? 'bg-background text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-4 mb-2 text-[11px] text-muted-foreground flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full" style={{ background: CORAL }} />
              Current Period ({sym})
            </span>
            {prev && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full" style={{ background: PREV_LINE }} />
                Previous Period ({prev.from} – {prev.to})
              </span>
            )}
          </div>

          {loading ? (
            <ChartSkeleton className="h-[220px]" />
          ) : !hasTrendData ? (
            <SectionEmpty
              icon={TrendingUp}
              message="No settled revenue recorded for this period"
              className="h-[220px]"
            />
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border/40" />
                  <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fill: AXIS, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null
                      const row = payload[0]?.payload
                      return (
                        <div className="bg-popover/95 backdrop-blur-md border border-border rounded-xl p-3 text-xs shadow-lg max-w-[260px]">
                          <p className="font-semibold text-foreground mb-1">{row?.periodLabel}</p>
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-muted-foreground">Current Revenue:</span>
                              <span className="font-semibold tabular-nums text-foreground">
                                {formatINR(row?.revenue ?? 0, sym)}
                              </span>
                            </div>
                            {row?.prevRevenue !== undefined && (
                              <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">
                                  Prev ({row.prevPeriodLabel}):
                                </span>
                                <span className="font-semibold tabular-nums text-muted-foreground">
                                  {formatINR(row.prevRevenue, sym)}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    name="Current Revenue"
                    stroke={CORAL}
                    strokeWidth={2.3}
                    dot={trendData.length <= 15 ? { r: 3, fill: CORAL } : false}
                    activeDot={{ r: 5 }}
                  />
                  {prev && (
                    <Line
                      type="monotone"
                      dataKey="prevRevenue"
                      name="Previous Revenue"
                      stroke={PREV_LINE}
                      strokeWidth={1.75}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* 3. Order Types */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-sm font-bold tracking-tight">3. Order Types</h2>
                <p className="text-[11px] text-muted-foreground">
                  Chart driven by Settled Revenue ({sym})
                </p>
              </div>
              <Utensils className="size-4 text-muted-foreground" />
            </div>

            {loading ? (
              <ChartSkeleton className="h-[135px]" />
            ) : !hasOrderTypeData ? (
              <SectionEmpty icon={Utensils} message="No completed orders in this period" className="h-[135px]" />
            ) : (
              <div className="h-[135px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={orderTypes.filter((t) => t.revenue > 0)}
                      dataKey="revenue"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={38}
                      outerRadius={58}
                      paddingAngle={3}
                      stroke="none"
                    >
                      {orderTypes
                        .filter((t) => t.revenue > 0)
                        .map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-border/40 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left py-1 font-medium">Channel</th>
                  <th className="text-right py-1 font-medium">Orders</th>
                  <th className="text-right py-1 font-medium">Share</th>
                  <th className="text-right py-1 font-medium">AOV</th>
                  <th className="text-right py-1 font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {orderTypes.map((t, i) => (
                  <tr key={t.type}>
                    <td className="py-1.5 flex items-center gap-1.5 font-medium text-foreground">
                      <span
                        className="inline-block size-2 rounded-full shrink-0"
                        style={{ background: COLORS[i % COLORS.length] }}
                      />
                      <span>{t.name}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {t.count.toLocaleString('en-IN')}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {t.share.toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatINR(t.avgOrder, sym)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-foreground">
                      {formatINR(t.revenue, sym)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* 4. Sales by Hour */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">4. Sales by Hour</h2>
            <p className="text-[11px] text-muted-foreground">
              Hourly settlement distribution · Timezone: {timezone} · Peak ranked by{' '}
              <span className="font-medium text-foreground">
                {hourlyMetric === 'revenue' ? 'Revenue' : 'Order Count'}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {hasHourlyData && peakHour.hour >= 0 && (
              <div className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary tabular-nums">
                <Clock className="size-3" />
                <span>
                  Peak: {peakHour.displayHour} ({formatINR(peakHour.revenue, sym)} · {peakHour.orders} orders)
                </span>
              </div>
            )}
            <div className="flex items-center gap-1 rounded-lg bg-secondary/50 p-0.5 border border-border/50">
              <button
                type="button"
                onClick={() => setHourlyMetric('revenue')}
                className={cn(
                  'px-2 py-1 text-[11px] font-medium rounded-md transition-colors',
                  hourlyMetric === 'revenue'
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Revenue
              </button>
              <button
                type="button"
                onClick={() => setHourlyMetric('orders')}
                className={cn(
                  'px-2 py-1 text-[11px] font-medium rounded-md transition-colors',
                  hourlyMetric === 'orders'
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Orders
              </button>
            </div>
          </div>
        </div>

        {loading ? (
          <ChartSkeleton className="h-[200px]" />
        ) : !hasHourlyData ? (
          <SectionEmpty
            icon={Clock}
            message="No order activity recorded for this period"
            className="h-[200px]"
          />
        ) : (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border/40" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} interval={2} />
                <YAxis
                  tick={{ fill: AXIS, fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) =>
                    hourlyMetric === 'revenue'
                      ? `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`
                      : String(v)
                  }
                />
                <Tooltip
                  cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null
                    const row = payload[0]?.payload
                    return (
                      <div className="bg-popover/95 backdrop-blur-md border border-border rounded-xl p-3 text-xs shadow-lg">
                        <p className="font-semibold text-foreground mb-1">
                          {row?.displayHour} ({row?.label} {timezone})
                        </p>
                        <div className="space-y-0.5 tabular-nums">
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Revenue:</span>
                            <span className="font-semibold text-foreground">{formatINR(row?.revenue ?? 0, sym)}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Orders:</span>
                            <span className="font-semibold text-foreground">{row?.orders ?? 0}</span>
                          </div>
                        </div>
                      </div>
                    )
                  }}
                />
                <Bar
                  dataKey={hourlyMetric}
                  name={hourlyMetric === 'revenue' ? 'Revenue' : 'Orders'}
                  fill={CORAL}
                  radius={[3, 3, 0, 0]}
                  barSize={14}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  )
}
