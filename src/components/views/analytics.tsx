'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { useApp, type AppData } from '@/components/app/data-context'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { AccessDenied } from '@/components/shared/access-denied'
import { cn } from '@/lib/utils'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { useMediaQuery } from '@/lib/use-media-query'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DateRange } from 'react-day-picker'
import { format, startOfMonth, subDays } from 'date-fns'
import { Separator } from '@/components/ui/separator'
import {
  TrendingUp, TrendingDown, IndianRupee, ShoppingBag, ClipboardList, CalendarDays,
  ArrowUpRight, ArrowDownRight, Download, Clock, Users, Utensils, Trophy,
  CalendarIcon, ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'

interface DailyRevenue { date: string; label: string; revenue: number; orders: number }
interface TopItem { name: string; qty: number; revenue: number }
interface TypeBreak { type: string; count: number; revenue: number }
interface TopTable { name: string; orders: number; revenue: number }
interface CatBreak { name: string; value: number }

interface AnalyticsPayload {
  range?: { from: string; to: string; days: number; timezone: string }
  totalRevenue: number
  totalOrders: number
  avgOrder: number
  todaysRevenue: number
  todaysOrders: number
  revenueChange: number
  dailyRevenue: DailyRevenue[]
  topItems: TopItem[]
  typeBreakdown: TypeBreak[]
  topTables: TopTable[]
  hourly: number[]
  /** False when the plan does not include Advanced analytics — panels empty. */
  advanced?: boolean
  categoryBreakdown: CatBreak[]
}

const COLORS = ['#f97316', '#4ade80', '#fbbf24', '#60a5fa', '#c084fc', '#f472b6']
const CORAL = '#f97316'
const AXIS = '#9aa3b2'

const TYPE_LABEL: Record<string, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
}

function ChartTooltip({ active, payload, label, currencySymbol = '₹' }: any) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="bg-popover border border-border rounded-lg p-3 text-xs shadow-xl shadow-black/40 max-w-[220px]">
      {label != null && <p className="font-medium mb-1">{label}</p>}
      <div className="space-y-1">
        {payload.map((p: any, i: number) => {
          const isCurrency = p.dataKey === 'revenue' || p.name?.toLowerCase().includes('revenue') || p.name?.toLowerCase().includes('avg')
          const prefix = isCurrency ? currencySymbol : ''
          const formattedVal = isCurrency ? (p.value ?? 0).toFixed(2) : String(p.value ?? 0)
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
              <span className="text-muted-foreground">{p.name}:</span>
              <span className="font-medium">{prefix}{formattedVal}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ChartSkeleton({ className }: { className?: string }) {
  return <div className={cn('w-full rounded-xl bg-secondary/30 animate-pulse', className)} />
}

/** Quick ranges. Each returns a fresh object so the picker always gets new refs. */
const RANGE_PRESETS: { label: string; build: () => DateRange }[] = [
  { label: 'Today', build: () => { const t = new Date(); return { from: t, to: t } } },
  { label: 'Yesterday', build: () => { const y = subDays(new Date(), 1); return { from: y, to: y } } },
  { label: 'Last 7 days', build: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: 'Last 14 days', build: () => ({ from: subDays(new Date(), 13), to: new Date() }) },
  { label: 'Last 30 days', build: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  { label: 'This month', build: () => ({ from: startOfMonth(new Date()), to: new Date() }) },
]

export function AnalyticsView() {
  const { data } = useApp()
  const { denied, setDenied, handleLoad, handleLoadQuiet } = useAccessDenied()
  const [analytics, setAnalytics] = useState<AnalyticsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  // Defaults to today alone. A single day is what an owner checks during
  // service; longer windows are one tap away in the presets.
  const [range, setRange] = useState<DateRange>(() => {
    const today = new Date()
    return { from: today, to: today }
  })
  const [rangeOpen, setRangeOpen] = useState(false)
  const { scrollRef, collapsed } = useScrollCollapse()
  // Below lg the popover switches to the compact mobile layout: presets as a
  // horizontal strip, a single scrollable month, capped to the viewport.
  const isCompact = useMediaQuery('(max-width: 1023px)')

  // The tenant id is a stable string. `data` itself is replaced by the realtime
  // layer's 4-second delta poll (a summary spread) even when nothing changed,
  // so the fetch must key on the id — keying on `data` re-fired the load on
  // every empty poll, flashed the skeletons, and re-requested /api/analytics
  // every four seconds forever.
  const tenantId = data?.tenant?.id
  // A slow response for an older range must never overwrite a newer one.
  const requestSeq = useRef(0)
  const lastOrderBook = useRef<AppData['orders'] | null>(null)
  const lastBgRefreshAt = useRef(0)
  const bgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Fetch analytics for the current range.
   *
   * `mode` decides what the screen does while the request is in flight:
   *   - 'skeleton' (first load, explicit date change) may show the loading
   *     placeholders — the user asked for a new dataset;
   *   - 'silent' (background refresh after the order book changed) keeps the
   *     current data on screen and swaps it when the response lands.
   */
  const fetchAnalytics = useCallback(async (mode: 'skeleton' | 'silent') => {
    if (!tenantId) return
    const seq = ++requestSeq.current
    if (mode === 'skeleton') {
      setLoading(true)
      // A fresh skeleton load also satisfies any just-arrived order change, so
      // the background path does not immediately duplicate it.
      lastBgRefreshAt.current = Date.now()
    }
    try {
      const from = range.from ? format(range.from, 'yyyy-MM-dd') : ''
      const to = range.to ? format(range.to, 'yyyy-MM-dd') : from
      const res = await edgeFetch(`/api/analytics?from=${from}&to=${to}`, {
        headers: { 'x-tenant-id': tenantId },
      })
      await failIfNotOk(res, 'analytics')
      const json = await res.json()
      if (seq !== requestSeq.current) return // a newer request owns the screen
      setAnalytics(json)
      // A retry that succeeds must clear the refusal, or the screen would stay
      // on Access Denied after the role was granted the permission.
      setDenied(null)
    } catch (err) {
      if (seq !== requestSeq.current) return
      if (mode === 'skeleton') handleLoad(err, 'analytics')
      else handleLoadQuiet(err, 'analytics')
    } finally {
      if (mode === 'skeleton' && seq === requestSeq.current) setLoading(false)
    }
  }, [tenantId, range, handleLoad, handleLoadQuiet])

  // Primary load: on mount and on every explicit date change. `fetchAnalytics`
  // is recreated only when the tenant or the range changes, so this effect
  // never refires for the realtime layer's data-object churn.
  useEffect(() => {
    fetchAnalytics('skeleton')
  }, [fetchAnalytics])

  /**
   * Background refresh: when the order book actually changed (a new array
   * identity — the 4s summary poll does not create one), fetch the new
   * aggregates silently, at most once per 30s, with a trailing fetch that
   * collects changes arriving inside the quiet window. Existing charts stay
   * visible the whole time.
   */
  useEffect(() => {
    const orders = data?.orders
    if (!orders) return
    if (lastOrderBook.current === null) {
      lastOrderBook.current = orders // first sight — the skeleton load covers it
      return
    }
    if (orders === lastOrderBook.current) return
    lastOrderBook.current = orders
    const wait = Math.max(0, 30_000 - (Date.now() - lastBgRefreshAt.current))
    if (wait === 0) {
      lastBgRefreshAt.current = Date.now()
      fetchAnalytics('silent')
    } else if (!bgTimer.current) {
      bgTimer.current = setTimeout(() => {
        bgTimer.current = null
        lastBgRefreshAt.current = Date.now()
        fetchAnalytics('silent')
      }, wait)
    }
  }, [data?.orders, fetchAnalytics])

  // Clear a pending background timer on unmount.
  useEffect(() => () => {
    if (bgTimer.current) clearTimeout(bgTimer.current)
  }, [])

  /**
   * Download the report as CSV.
   *
   * Built from the payload already on screen, so what you export is exactly
   * what you are looking at. A BOM is prepended so Excel reads the rupee sign
   * correctly, and the file is named for the range it covers.
   */
  const exportReport = () => {
    if (!analytics || !data) return
    const rows: (string | number)[][] = []
    const push = (...cells: (string | number)[]) => rows.push(cells)
    const blank = () => rows.push([])
    const money = (n: number) => n.toFixed(2)

    push('The Salad sales report')
    push('Restaurant', data.tenant.name)
    push('From', analytics.range?.from ?? '')
    push('To', analytics.range?.to ?? '')
    push('Timezone', analytics.range?.timezone ?? '')
    push('Generated', new Date().toLocaleString())
    blank()

    push('Summary')
    push('Metric', `Amount (${sym})`)
    push('Total revenue', money(analytics.totalRevenue))
    push('Completed orders', analytics.totalOrders)
    push('Average order', money(analytics.avgOrder))
    push(`Revenue on ${analytics.range?.to ?? 'today'}`, money(analytics.todaysRevenue))
    blank()

    push('Daily revenue')
    push('Date', 'Day', `Revenue (${sym})`, 'Orders')
    for (const d of analytics.dailyRevenue ?? []) push(d.date, d.label, money(d.revenue), d.orders)
    blank()

    push('Top items')
    push('Item', 'Quantity sold', `Revenue (${sym})`)
    for (const t of analytics.topItems ?? []) push(t.name, t.qty, money(t.revenue))
    blank()

    push('Order types')
    push('Type', 'Orders', `Revenue (${sym})`)
    for (const t of analytics.typeBreakdown ?? []) push(t.type, t.count, money(t.revenue))
    blank()

    push('Top tables')
    push('Table', 'Orders', `Revenue (${sym})`)
    for (const t of analytics.topTables ?? []) push(t.name, t.orders, money(t.revenue))
    blank()

    push('Categories')
    push('Category', `Revenue (${sym})`)
    for (const c of analytics.categoryBreakdown ?? []) push(c.name, money(c.value))

    const esc = (v: string | number) => {
      const str = String(v ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    // The BOM is what makes Excel render ₹ rather than mojibake.
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `the-salad-report_${analytics.range?.from ?? 'from'}_to_${analytics.range?.to ?? 'to'}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success('Report downloaded', {
      description: `${analytics.totalOrders} orders · ${sym}${money(analytics.totalRevenue)}`,
    })
  }

  if (!data) return null
  // A permission failure must not fall through to the dashboard: every KPI
  // reads `?? 0`, so a role that may not see analytics would be shown
  // "₹0.00" revenue — a claim about the business rather than about the role.
  if (denied) return <AccessDenied failure={denied} onRetry={() => fetchAnalytics('skeleton')} view="analytics" />
  const sym = data.tenant.currencySymbol
  const rangeLabel = range.from
    ? range.to && format(range.from, 'yyyy-MM-dd') !== format(range.to, 'yyyy-MM-dd')
      ? `${format(range.from, 'd MMM')} – ${format(range.to, 'd MMM yyyy')}`
      : format(range.from, 'd MMM yyyy')
    : 'Select dates'
  const typeTotal = (analytics?.typeBreakdown ?? []).reduce((s, t) => s + t.revenue, 0) || 1

  return (
    <div className="h-full flex flex-col">
      {/* Header (collapsible on scroll) */}
      <header
        className={cn(
          'px-3.5 md:px-6 border-b border-border/60 transition-all duration-200 ease-out',
          collapsed ? 'pt-1.5 pb-1.5' : 'pt-3 md:pt-6 pb-2.5',
        )}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2
              className={cn(
                'font-bold tracking-tight transition-all duration-200 ease-out truncate',
                collapsed ? 'text-base md:text-lg' : 'text-lg md:text-2xl',
              )}
            >
              Analytics
            </h2>
            <p
              className={cn(
                'text-sm text-muted-foreground transition-all duration-200 ease-out',
                collapsed ? 'max-h-0 opacity-0 overflow-hidden mt-0' : 'max-h-8 opacity-100 mt-0.5',
              )}
            >
              Performance insights · {data.tenant.name}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
              <PopoverTrigger asChild>
                <Button variant="secondary" size="sm" className="h-9 gap-2 font-normal">
                  <CalendarIcon className="h-4 w-4 opacity-70" />
                  {rangeLabel}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align={isCompact ? 'center' : 'end'}
                sideOffset={6}
                className="w-auto max-w-[calc(100vw-2rem)] p-0"
              >
                <div className="flex max-h-[75vh] flex-col lg:flex-row">
                  {/* Presets: horizontal scroll strip on mobile, vertical rail on desktop */}
                  <div
                    className={cn(
                      'flex shrink-0 gap-1 border-border p-2',
                      isCompact
                        ? 'flex-row overflow-x-auto scrollbar-thin whitespace-nowrap border-b'
                        : 'flex-wrap lg:w-[136px] lg:flex-col lg:flex-nowrap lg:border-b-0 lg:border-r',
                    )}
                  >
                    {RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setRange(preset.build())
                          setRangeOpen(false)
                        }}
                        className="rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-secondary"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  {/* Calendar: one scrollable month on mobile, two side by side on desktop */}
                  <div className="flex-1 overflow-y-auto scrollbar-thin">
                    <Calendar
                      mode="range"
                      selected={range}
                      onSelect={(next) => setRange(next ?? { from: undefined, to: undefined })}
                      defaultMonth={range.from}
                      numberOfMonths={isCompact ? 1 : 2}
                      disabled={{ after: new Date() }}
                      className="p-3"
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportReport}
              disabled={!analytics || loading}
            >
              <Download className="h-4 w-4 mr-1.5" /> Export
            </Button>
          </div>
        </div>
      </header>

      {/* Scrollable content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pt-1 pb-4 md:pb-6 space-y-5">
        {/* KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard icon={IndianRupee} label="Total Revenue" value={loading ? '—' : `${sym}${(analytics?.totalRevenue ?? 0).toFixed(2)}`} sub={`${analytics?.range?.days ?? 0} ${(analytics?.range?.days ?? 0) === 1 ? 'day' : 'days'}`} tint="coral" />
          <KpiCard icon={ClipboardList} label="Total Orders" value={loading ? '—' : String(analytics?.totalOrders ?? 0)} sub="completed" tint="green" />
          <KpiCard icon={ShoppingBag} label="Avg Order" value={loading ? '—' : `${sym}${(analytics?.avgOrder ?? 0).toFixed(2)}`} sub="per transaction" tint="amber" />
          <KpiCard icon={CalendarDays} label="Today's Revenue" value={loading ? '—' : `${sym}${(analytics?.todaysRevenue ?? 0).toFixed(2)}`} sub={`${analytics?.todaysOrders ?? 0} orders today`} change={analytics?.revenueChange} tint="blue" />
        </div>

        {/* Revenue trend */}
        <Card className="rounded-2xl border border-border bg-card p-4 md:p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">Revenue Trend</h3>
              <p className="text-xs text-muted-foreground">Daily revenue · {rangeLabel}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block w-2 h-2 rounded-full" style={{ background: CORAL }} /> Revenue
            </div>
          </div>
          {loading ? (
            <ChartSkeleton className="h-[200px] md:h-[280px]" />
          ) : (
            <div className="h-[200px] md:h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analytics?.dailyRevenue ?? []} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <defs>
                    <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CORAL} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={CORAL} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${sym}${v}`} />
                  <Tooltip content={<ChartTooltip currencySymbol={sym} />} />
                  <Area type="monotone" dataKey="revenue" stroke={CORAL} strokeWidth={2.5} fill="url(#revGradient)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Top items + Order types */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="rounded-2xl border border-border bg-card p-4 md:p-4 md:p-6 lg:col-span-2">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Top Selling Items</h3>
                <p className="text-xs text-muted-foreground">By quantity sold</p>
              </div>
              <Trophy className="h-4 w-4 text-muted-foreground" />
            </div>
            {loading ? (
              <ChartSkeleton className="h-[240px] md:h-[260px]" />
            ) : (
              <div className="h-[240px] md:h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics?.topItems ?? []} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={90} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                    <Bar dataKey="qty" name="Quantity" fill={CORAL} radius={[0, 6, 6, 0]} barSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="rounded-2xl border border-border bg-card p-4 md:p-4 md:p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Order Types</h3>
                <p className="text-xs text-muted-foreground">Revenue share</p>
              </div>
              <Utensils className="h-4 w-4 text-muted-foreground" />
            </div>
            {analytics?.advanced === false && (
              <p className="mb-3 rounded-lg border border-amber-200/70 bg-amber-50/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-900">
                Order types are part of Advanced analytics, which is not on your current plan.
              </p>
            )}
            {loading ? (
              <ChartSkeleton className="h-[200px]" />
            ) : (
              <>
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={analytics?.typeBreakdown ?? []} dataKey="revenue" nameKey="type" cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={3} stroke="none">
                        {(analytics?.typeBreakdown ?? []).map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip currencySymbol={sym} />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 space-y-2">
                  {(analytics?.typeBreakdown ?? []).map((t, i) => {
                    const pct = typeTotal ? (t.revenue / typeTotal) * 100 : 0
                    return (
                      <div key={t.type} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                          <span className="text-muted-foreground">{TYPE_LABEL[t.type] || t.type}</span>
                        </div>
                        <span className="font-medium">{pct.toFixed(1)}%</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Hourly + Category */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="rounded-2xl border border-border bg-card p-4 md:p-4 md:p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Sales by Hour</h3>
                <p className="text-xs text-muted-foreground">Order volume per hour</p>
              </div>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            {analytics?.advanced === false && (
              <p className="mb-3 rounded-lg border border-amber-200/70 bg-amber-50/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-900">
                Sales by hour is part of Advanced analytics, which is not on your current plan.
              </p>
            )}
            {loading ? (
              <ChartSkeleton className="h-[240px]" />
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(analytics?.hourly ?? []).map((v, h) => ({ hour: `${h}:00`, orders: v }))} margin={{ top: 0, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} interval={3} />
                    <YAxis tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                    <Bar dataKey="orders" name="Orders" fill={CORAL} radius={[4, 4, 0, 0]} barSize={14} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="rounded-2xl border border-border bg-card p-4 md:p-4 md:p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold">Revenue by Category</h3>
                <p className="text-xs text-muted-foreground">Top performing categories</p>
              </div>
              <Users className="h-4 w-4 text-muted-foreground" />
            </div>
            {loading ? (
              <ChartSkeleton className="h-[240px]" />
            ) : (
              <div className="h-[240px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics?.categoryBreakdown ?? []} margin={{ top: 0, right: 8, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${sym}${v}`} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                    <Bar dataKey="value" name="Revenue" radius={[4, 4, 0, 0]} barSize={28}>
                      {(analytics?.categoryBreakdown ?? []).map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </div>

        {/* Top tables */}
        <Card className="rounded-2xl border border-border bg-card p-4 md:p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">Top Tables</h3>
              <p className="text-xs text-muted-foreground">Highest revenue tables</p>
            </div>
            <Users className="h-4 w-4 text-muted-foreground" />
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-12 rounded-xl bg-secondary/30 animate-pulse" />
              ))}
            </div>
          ) : (analytics?.topTables ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {analytics?.advanced === false ? 'Not included in your plan' : 'No table data'}
            </p>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-12 gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                <span className="col-span-1">#</span>
                <span className="col-span-5 sm:col-span-6">Table</span>
                <span className="col-span-2 text-right">Orders</span>
                <span className="col-span-4 whitespace-nowrap text-right sm:col-span-3">Revenue</span>
              </div>
              <Separator />
              <div className="max-h-96 overflow-y-auto scrollbar-thin">
                {(analytics?.topTables ?? []).map((t, i) => (
                  <div key={t.name + i} className="grid grid-cols-12 gap-3 items-center px-3 py-2.5 rounded-xl hover:bg-secondary/40 transition-colors">
                    <span className={cn('col-span-1 inline-flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold', i === 0 ? 'bg-amber-500/15 text-amber-400' : i === 1 ? 'bg-zinc-300/15 text-zinc-300' : i === 2 ? 'bg-orange-700/20 text-orange-500' : 'bg-secondary text-muted-foreground')}>
                      {i + 1}
                    </span>
                    <span className="col-span-5 sm:col-span-6 font-medium text-sm truncate">{t.name}</span>
                    <span className="col-span-2 text-right text-sm text-muted-foreground">{t.orders}</span>
                    <span className="col-span-4 whitespace-nowrap text-right text-sm font-semibold sm:col-span-3">{sym}{t.revenue.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function KpiCard({ icon: Icon, label, value, sub, change, tint }: { icon: any; label: string; value: string; sub?: string; change?: number; tint: 'coral' | 'green' | 'amber' | 'blue' }) {
  const tints: Record<string, string> = {
    coral: 'bg-primary/15 text-primary',
    green: 'bg-green-500/15 text-green-400',
    amber: 'bg-amber-500/15 text-amber-400',
    blue: 'bg-blue-500/15 text-blue-400',
  }
  const up = (change ?? 0) >= 0
  return (
    <Card className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start justify-between mb-3">
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', tints[tint])}>
          <Icon className="h-5 w-5" />
        </div>
        {change !== undefined && (
          <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md', up ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400')}>
            {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {Math.abs(change).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      <p className="text-lg md:text-2xl font-bold tabular-nums truncate">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1 truncate">{sub}</p>}
    </Card>
  )
}
