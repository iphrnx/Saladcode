'use client'

import { useMemo, useState } from 'react'
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { ArrowDownRight, ArrowUpRight, Layers, Trophy, X } from 'lucide-react'
import {
  AnalyticsPayload,
  AXIS,
  COLORS,
  CORAL,
  ChartSkeleton,
  ChartTooltip,
  SectionEmpty,
  formatINR,
} from './types'

type ItemRankBy = 'qty' | 'revenue'
type ItemViewMode = 'top' | 'least_sold' | 'least_all'

interface ItemsAndCategoriesProps {
  analytics: AnalyticsPayload | null
  loading: boolean
  compareEnabled: boolean
  sym: string
}

export function ItemsAndCategories({
  analytics,
  loading,
  compareEnabled,
  sym,
}: ItemsAndCategoriesProps) {
  const [rankBy, setRankBy] = useState<ItemRankBy>('qty')
  const [viewMode, setViewMode] = useState<ItemViewMode>('top')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  const soldItems = useMemo(() => {
    if (analytics?.allItems && analytics.allItems.length > 0) return analytics.allItems
    return (analytics?.topItems ?? []).map((t) => ({
      menuItemId: null,
      name: t.name,
      category: 'Other',
      qty: t.qty,
      revenue: t.revenue,
    }))
  }, [analytics?.allItems, analytics?.topItems])

  const zeroItems = useMemo(() => analytics?.zeroSaleItems ?? [], [analytics?.zeroSaleItems])

  const displayedItems = useMemo(() => {
    let pool =
      viewMode === 'least_all'
        ? [...soldItems, ...zeroItems]
        : [...soldItems]

    if (selectedCategory) {
      pool = pool.filter((it) => it.category === selectedCategory)
    }

    pool.sort((a, b) => {
      const primary =
        rankBy === 'qty'
          ? a.qty - b.qty || a.revenue - b.revenue
          : a.revenue - b.revenue || a.qty - b.qty
      if (viewMode === 'top') {
        return -primary || a.name.localeCompare(b.name)
      }
      return primary || a.name.localeCompare(b.name)
    })

    return pool.slice(0, 8)
  }, [soldItems, zeroItems, viewMode, rankBy, selectedCategory])

  const categories = useMemo(() => {
    const raw = analytics?.categoryBreakdown ?? []
    const total = raw.reduce((s, c) => s + c.value, 0)
    return raw.map((c) => ({
      ...c,
      units: c.units ?? 0,
      share: c.share ?? (total > 0 ? +((c.value / total) * 100).toFixed(1) : 0),
    }))
  }, [analytics?.categoryBreakdown])

  const modeDescription =
    viewMode === 'top'
      ? 'Top selling items sold in period'
      : viewMode === 'least_sold'
        ? 'Least selling (items sold in period only)'
        : 'Least selling (includes 0-sale active menu items)'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* 5. Top Selling Items */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
        <div>
          <div className="flex items-start justify-between gap-2 flex-wrap mb-2">
            <div>
              <h2 className="text-sm font-bold tracking-tight">5. Top Selling Items</h2>
              <p className="text-[11px] text-muted-foreground">{modeDescription}</p>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="flex items-center gap-0.5 rounded-lg bg-secondary/50 p-0.5 border border-border/50">
                <button
                  type="button"
                  onClick={() => setRankBy('qty')}
                  className={cn(
                    'px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors',
                    rankBy === 'qty' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  By Units
                </button>
                <button
                  type="button"
                  onClick={() => setRankBy('revenue')}
                  className={cn(
                    'px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors',
                    rankBy === 'revenue' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  By Revenue
                </button>
              </div>
              <select
                aria-label="Item view mode"
                value={viewMode}
                onChange={(e) => setViewMode(e.target.value as ItemViewMode)}
                className="h-7 rounded-lg border border-border/60 bg-secondary/40 px-2 text-[11px] font-medium text-foreground focus:outline-none"
              >
                <option value="top">Top Selling</option>
                <option value="least_sold">Least (Sold Only)</option>
                <option value="least_all">Least (+ Zero-Sale)</option>
              </select>
            </div>
          </div>

          {selectedCategory && (
            <div className="mb-2 flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                Category: {selectedCategory}
                <button
                  type="button"
                  onClick={() => setSelectedCategory(null)}
                  className="hover:opacity-75"
                  aria-label="Clear category filter"
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          )}

          {loading ? (
            <ChartSkeleton className="h-[180px]" />
          ) : displayedItems.length === 0 ? (
            <SectionEmpty icon={Trophy} message="No items match the current filters" className="h-[180px]" />
          ) : (
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={displayedItems.slice(0, 6)} layout="vertical" margin={{ top: 0, right: 54, bottom: 0, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border/40" horizontal={false} />
                  <XAxis type="number" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} width={96} />
                  <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }} />
                  <Bar
                    dataKey={rankBy}
                    name={rankBy === 'qty' ? 'Units Sold' : 'Revenue'}
                    fill={CORAL}
                    radius={[0, 4, 4, 0]}
                    barSize={13}
                  >
                    <LabelList
                      dataKey={rankBy}
                      position="right"
                      formatter={(v: any) => (rankBy === 'qty' ? `${v}` : `${sym}${Number(v).toFixed(0)}`)}
                      className="text-[10px] font-semibold fill-muted-foreground"
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {!loading && displayedItems.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border/40 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left py-1 font-medium">Item</th>
                  <th className="text-left py-1 font-medium">Category</th>
                  <th className="text-right py-1 font-medium">Units</th>
                  <th className="text-right py-1 font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {displayedItems.map((it, idx) => (
                  <tr key={`${it.name}-${idx}`}>
                    <td className="py-1.5 font-medium text-foreground truncate max-w-[140px]">{it.name}</td>
                    <td className="py-1.5 text-muted-foreground truncate max-w-[100px]">{it.category}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{it.qty.toLocaleString('en-IN')}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold text-foreground">{formatINR(it.revenue, sym)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 6. Revenue by Category */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-bold tracking-tight">6. Revenue by Category</h2>
              <p className="text-[11px] text-muted-foreground">
                Gross item revenue by category · Click a row to filter items
              </p>
            </div>
            <Layers className="size-4 text-muted-foreground" />
          </div>

          {loading ? (
            <ChartSkeleton className="h-[180px]" />
          ) : categories.length === 0 ? (
            <SectionEmpty icon={Layers} message="No category data available" className="h-[180px]" />
          ) : (
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categories.slice(0, 8)} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border/40" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fill: AXIS, fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                  />
                  <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }} />
                  <Bar dataKey="value" name="Revenue" radius={[4, 4, 0, 0]} barSize={22}>
                    {categories.slice(0, 8).map((c, i) => (
                      <Cell
                        key={c.name}
                        fill={COLORS[i % COLORS.length]}
                        opacity={selectedCategory && selectedCategory !== c.name ? 0.35 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {!loading && categories.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border/40 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left py-1 font-medium">Category</th>
                  <th className="text-right py-1 font-medium">Units</th>
                  <th className="text-right py-1 font-medium">Share</th>
                  {compareEnabled && <th className="text-right py-1 font-medium">Growth</th>}
                  <th className="text-right py-1 font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {categories.map((c, i) => {
                  const isSelected = selectedCategory === c.name
                  return (
                    <tr
                      key={c.name}
                      onClick={() => setSelectedCategory(isSelected ? null : c.name)}
                      className={cn(
                        'cursor-pointer transition-colors hover:bg-secondary/40',
                        isSelected && 'bg-primary/10'
                      )}
                    >
                      <td className="py-1.5 flex items-center gap-1.5 font-medium text-foreground">
                        <span
                          className="inline-block size-2 rounded-full shrink-0"
                          style={{ background: COLORS[i % COLORS.length] }}
                        />
                        <span className="truncate max-w-[120px]">{c.name}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {c.units.toLocaleString('en-IN')}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {c.share.toFixed(1)}%
                      </td>
                      {compareEnabled && (
                        <td className="py-1.5 text-right tabular-nums">
                          {c.growthPct !== null && c.growthPct !== undefined ? (
                            <span
                              className={cn(
                                'inline-flex items-center gap-0.5 font-semibold',
                                c.growthPct >= 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-red-600 dark:text-red-400'
                              )}
                            >
                              {c.growthPct >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                              {Math.abs(c.growthPct).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      <td className="py-1.5 text-right tabular-nums font-semibold text-foreground">
                        {formatINR(c.value, sym)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
