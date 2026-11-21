'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
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
import {
  IndianRupee, ShoppingBag, ClipboardList, CalendarDays,
  ArrowUpRight, ArrowDownRight, Download, Clock, Utensils, Trophy,
  CalendarIcon, ChevronDown, MapPin, Layers, Sparkles,
  CreditCard, Smartphone, Banknote, Receipt,
} from 'lucide-react'
import { toast } from 'sonner'

interface DailyRevenue { date: string; label: string; revenue: number; orders: number }
interface TopItem { name: string; qty: number; revenue: number }
interface TypeBreak { type: string; count: number; revenue: number }
interface TopTable { name: string; orders: number; revenue: number }
interface CatBreak { name: string; value: number }
interface LocationOption { id: string; name: string; isPrimary: boolean }
interface PaymentMethodSummary {
  cash: { amount: number; count: number }
  upi: { amount: number; count: number }
  card: { amount: number; count: number }
  other?: { amount: number; count: number }
  total: number
}

interface AnalyticsPayload {
  range?: { from: string; to: string; days: number; timezone: string }
  totalRevenue: number
  totalOrders: number
  avgOrder: number
  netSales?: number
  taxCollected?: number
  serviceChargeCollected?: number
  todaysRevenue: number
  todaysOrders: number
  revenueChange: number
  dailyRevenue: DailyRevenue[]
  topItems: TopItem[]
  typeBreakdown: TypeBreak[]
  topTables: TopTable[]
  hourly: number[]
  advanced?: boolean
  categoryBreakdown: CatBreak[]
  paymentMethods?: PaymentMethodSummary
  locations?: LocationOption[]
  multiLocationEnabled?: boolean
}

const COLORS = ['#f97316', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899']
const CORAL = '#f97316'
const AXIS = '#94a3b8'

const TYPE_LABEL: Record<string, string> = {
  DINE_IN: 'Dine In',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
}

function ChartTooltip({ active, payload, label, currencySymbol = '₹' }: any) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border/80 rounded-xl p-3 text-xs shadow-xl shadow-black/40 max-w-[220px]">
      {label != null && <p className="font-semibold text-foreground mb-1.5">{label}</p>}
      <div className="space-y-1">
        {payload.map((p: any, i: number) => {
          const isCurrency = p.dataKey === 'revenue' || p.dataKey === 'value' || p.name?.toLowerCase().includes('revenue') || p.name?.toLowerCase().includes('avg')
          const prefix = isCurrency ? currencySymbol : ''
          const formattedVal = isCurrency ? (Number(p.value) || 0).toFixed(2) : String(p.value ?? 0)
          return (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: p.color || p.fill }} />
                <span className="text-muted-foreground truncate">{p.name}:</span>
              </div>
              <span className="font-semibold tabular-nums text-foreground">{prefix}{formattedVal}</span>
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
  const [range, setRange] = useState<DateRange>(() => {
    const today = new Date()
    return { from: today, to: today }
  })
  const [rangeOpen, setRangeOpen] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState<string>('')
  const [locationOpen, setLocationOpen] = useState(false)
  const { scrollRef } = useScrollCollapse()
  const isCompact = useMediaQuery('(max-width: 1023px)')

  const tenantId = data?.tenant?.id
  const requestSeq = useRef(0)
  const activeSkeletonSeq = useRef<number | null>(null)
  const activeFilters = useRef({ from: '', to: '', locationId: '' })
  const lastOrderBook = useRef<AppData['orders'] | null>(null)
  const bgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchAnalytics = useCallback(async (mode: 'skeleton' | 'silent') => {
    if (!tenantId) return
    const from = range.from ? format(range.from, 'yyyy-MM-dd') : ''
    const to = range.to ? format(range.to, 'yyyy-MM-dd') : from
    const locationId = selectedLocationId || ''
    const seq = ++requestSeq.current

    activeFilters.current = { from, to, locationId }
    if (mode === 'skeleton') {
      activeSkeletonSeq.current = seq
      setLoading(true)
    }

    let isFilterActive = false
    try {
      const locQuery = locationId ? `&location_id=${locationId}` : ''
      const res = await edgeFetch(`/api/analytics?from=${from}&to=${to}${locQuery}`, {
        headers: { 'x-tenant-id': tenantId },
      })
      await failIfNotOk(res, 'analytics')
      const json = await res.json()

      isFilterActive = activeFilters.current.from === from &&
                       activeFilters.current.to === to &&
                       activeFilters.current.locationId === locationId

      // Stale responses from old date ranges, locations, or superseded requests cannot overwrite
      if (!isFilterActive || seq < requestSeq.current) return

      setAnalytics(json)
      setDenied(null)
    } catch (err) {
      isFilterActive = activeFilters.current.from === from &&
                       activeFilters.current.to === to &&
                       activeFilters.current.locationId === locationId
      if (!isFilterActive || seq < requestSeq.current) return

      if (mode === 'skeleton') handleLoad(err, 'analytics')
      else handleLoadQuiet(err, 'analytics')
    } finally {
      // Clear loading state on both success and error, ensuring silent refreshes cannot leave loading stuck
      if (activeSkeletonSeq.current !== null && seq >= activeSkeletonSeq.current) {
        activeSkeletonSeq.current = null
        setLoading(false)
      }
    }
  }, [tenantId, range, selectedLocationId, handleLoad, handleLoadQuiet, setDenied])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load fetches analytics with skeleton
    fetchAnalytics('skeleton')
  }, [fetchAnalytics])

  // Realtime instant refresh on order changes / payments / settlements
  useEffect(() => {
    const orders = data?.orders
    if (!orders) return
    if (lastOrderBook.current === null) {
      lastOrderBook.current = orders
      return
    }
    if (orders === lastOrderBook.current) return
    lastOrderBook.current = orders

    // Immediate debounced refresh (350ms) to prevent stale data and eliminate 30s lag
    if (bgTimer.current) clearTimeout(bgTimer.current)
    bgTimer.current = setTimeout(() => {
      fetchAnalytics('silent')
    }, 350)
  }, [data?.orders, fetchAnalytics])

  useEffect(() => () => {
    if (bgTimer.current) clearTimeout(bgTimer.current)
  }, [])

  const exportReport = () => {
    if (!analytics || !data) return
    const rows: (string | number)[][] = []
    const push = (...cells: (string | number)[]) => rows.push(cells)
    const blank = () => rows.push([])
    const money = (n: number) => n.toFixed(2)

    const selectedLoc = (analytics.locations ?? []).find((l) => l.id === selectedLocationId)

    push('The Salad sales report')
    push('Restaurant', data.tenant.name)
    if (selectedLoc) {
      push('Location', selectedLoc.name)
    } else {
      push('Location', 'All Locations')
    }
    push('From', analytics.range?.from ?? '')
    push('To', analytics.range?.to ?? '')
    push('Timezone', analytics.range?.timezone ?? 'Asia/Kolkata')
    push('Basis', 'Gross settled collections (actual payment settlement timestamps)')
    push('Generated', new Date().toLocaleString())
    blank()

    push('Financial Summary')
    push('Metric', `Amount (${sym})`)
    push('Gross Collected', money(analytics.totalRevenue))
    push('Net Food & Beverage Sales', money(analytics.netSales ?? (analytics.totalRevenue - (analytics.taxCollected ?? 0))))
    push('Tax Collected (GST)', money(analytics.taxCollected ?? 0))
    if (analytics.serviceChargeCollected) {
      push('Service Charge Collected', money(analytics.serviceChargeCollected))
    }
    push('Completed Orders', analytics.totalOrders)
    push('Average Order Value', money(analytics.avgOrder))
    blank()

    if (analytics.paymentMethods) {
      push('Payment Method Breakdown')
      push('Method', 'Transactions', `Amount (${sym})`)
      push('Cash', analytics.paymentMethods.cash.count, money(analytics.paymentMethods.cash.amount))
      push('UPI', analytics.paymentMethods.upi.count, money(analytics.paymentMethods.upi.amount))
      push('Card', analytics.paymentMethods.card.count, money(analytics.paymentMethods.card.amount))
      if (analytics.paymentMethods.other && analytics.paymentMethods.other.count > 0) {
        push('Other / Legacy', analytics.paymentMethods.other.count, money(analytics.paymentMethods.other.amount))
      }
      const totalTx = analytics.paymentMethods.cash.count +
                      analytics.paymentMethods.upi.count +
                      analytics.paymentMethods.card.count +
                      (analytics.paymentMethods.other?.count ?? 0)
      push('Total Reconciled', totalTx, money(analytics.paymentMethods.total))
      blank()
    }

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
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    const locSlug = selectedLoc ? `${selectedLoc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_` : ''
    link.download = `the-salad-report_${locSlug}${analytics.range?.from ?? 'from'}_to_${analytics.range?.to ?? 'to'}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success('Report downloaded', {
      description: `${analytics.totalOrders} orders · ${sym}${money(analytics.totalRevenue)}${selectedLoc ? ` · ${selectedLoc.name}` : ''}`,
    })
  }

  if (!data) return null
  if (denied) return <AccessDenied failure={denied} onRetry={() => fetchAnalytics('skeleton')} view="analytics" />

  // Enforce rupee sign everywhere
  const sym = (data.tenant.currencySymbol && data.tenant.currencySymbol !== '$') ? data.tenant.currencySymbol : '₹'

  const rangeLabel = range.from
    ? range.to && format(range.from, 'yyyy-MM-dd') !== format(range.to, 'yyyy-MM-dd')
      ? `${format(range.from, 'd MMM')} – ${format(range.to, 'd MMM yyyy')}`
      : format(range.from, 'd MMM yyyy')
    : 'Select dates'

  const isSingleDay = Boolean(
    (analytics?.range?.days === 1) ||
    (range.from && range.to && format(range.from, 'yyyy-MM-dd') === format(range.to, 'yyyy-MM-dd'))
  )

  const typeTotal = (analytics?.typeBreakdown ?? []).reduce((s, t) => s + t.revenue, 0) || 1
  const locations = analytics?.locations ?? []
  const hasMultipleLocations = locations.length > 1
  const selectedLocation = locations.find((l) => l.id === selectedLocationId)

  // Find peak hour for sales by hour
  const hourlyData = (analytics?.hourly ?? []).map((orders, h) => ({
    hour: `${h}:00`,
    orders,
    displayHour: h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`,
  }))
  const peakHour = hourlyData.reduce((prev, curr) => (curr.orders > prev.orders ? curr : prev), { hour: '—', orders: 0, displayHour: '—' })
  const hasHourlyData = hourlyData.some((d) => d.orders > 0)

  // Payment method totals & percentages
  const pm = analytics?.paymentMethods
  const pmTotal = (pm?.cash.amount ?? 0) + (pm?.upi.amount ?? 0) + (pm?.card.amount ?? 0) + (pm?.other?.amount ?? 0) || 1

  // Category totals for inline percentages
  const catTotal = (analytics?.categoryBreakdown ?? []).reduce((s, c) => s + c.value, 0) || 1

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Sticky Header: Compact filter row without duplicate page title */}
      <header className="px-3.5 md:px-6 py-2.5 border-b border-border/60 bg-card/50 backdrop-blur-md sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2.5 flex-wrap">
          {/* Subtle subtitle identifying revenue definition */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <span className="inline-flex items-center gap-1 font-semibold text-foreground">
              <Sparkles className="size-3.5 text-primary" />
              <span>Settlement Analytics</span>
            </span>
            <span className="hidden sm:inline opacity-40">·</span>
            <span className="truncate hidden sm:inline text-[11px] text-muted-foreground">
              Gross settled revenue · {analytics?.range?.timezone || 'Asia/Kolkata'}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap ml-auto">
            {/* Multi-location selector (when multiple locations exist) */}
            {hasMultipleLocations && (
              <Popover open={locationOpen} onOpenChange={setLocationOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-normal border-border/70 bg-card">
                    <MapPin className="size-3.5 text-primary" />
                    <span className="truncate max-w-[120px]">{selectedLocation ? selectedLocation.name : 'All Locations'}</span>
                    <ChevronDown className="size-3 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 p-1">
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => { setSelectedLocationId(''); setLocationOpen(false) }}
                      className={cn(
                        'w-full text-left px-2.5 py-1.5 text-xs rounded-md font-medium transition-colors',
                        selectedLocationId === '' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-foreground'
                      )}
                    >
                      All Locations
                    </button>
                    {locations.map((loc) => (
                      <button
                        key={loc.id}
                        type="button"
                        onClick={() => { setSelectedLocationId(loc.id); setLocationOpen(false) }}
                        className={cn(
                          'w-full text-left px-2.5 py-1.5 text-xs rounded-md font-medium transition-colors flex items-center justify-between',
                          selectedLocationId === loc.id ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-foreground'
                        )}
                      >
                        <span className="truncate">{loc.name}</span>
                        {loc.isPrimary && <span className="text-[10px] opacity-75 font-normal ml-1">Primary</span>}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* Date range picker with non-clipped 2-row layout on mobile */}
            <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs font-normal border-border/70 bg-card">
                  <CalendarIcon className="size-3.5 text-muted-foreground" />
                  <span>{rangeLabel}</span>
                  <ChevronDown className="size-3 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align={isCompact ? 'center' : 'end'}
                sideOffset={6}
                className="w-auto max-w-[calc(100vw-2rem)] p-0"
              >
                <div className="flex max-h-[75vh] flex-col lg:flex-row">
                  {/* Presets: clean 3x2 grid on mobile prevents clipping of 'Last 30 days' */}
                  <div
                    className={cn(
                      'shrink-0 p-2 border-border',
                      isCompact
                        ? 'grid grid-cols-3 gap-1 border-b'
                        : 'flex flex-col w-[136px] gap-1 border-b-0 border-r',
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
                        className="rounded-md px-2 py-1.5 text-center lg:text-left text-xs transition-colors hover:bg-secondary font-medium"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
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
              variant="outline"
              size="sm"
              className="h-8 text-xs border-border/70 bg-card hover:bg-secondary"
              onClick={exportReport}
              disabled={!analytics || loading}
            >
              <Download className="size-3.5 mr-1 text-primary" /> Export
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pt-3 pb-6 space-y-4">
        {/* KPI Grid (4 balanced cards across) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            icon={IndianRupee}
            label="Total Revenue"
            value={loading ? '—' : `${sym}${(analytics?.totalRevenue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub={`Gross settled (${analytics?.range?.days ?? 0}d period)`}
            accent="coral"
          />
          <KpiCard
            icon={ClipboardList}
            label="Completed Orders"
            value={loading ? '—' : (analytics?.totalOrders ?? 0).toLocaleString('en-IN')}
            sub="Paid & fulfilled"
            accent="green"
          />
          <KpiCard
            icon={ShoppingBag}
            label="Avg Order Value"
            value={loading ? '—' : `${sym}${(analytics?.avgOrder ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            sub="Per settled ticket"
            accent="amber"
          />
          {/* Single-day displays Net Sales vs Tax Collected to eliminate duplicate KPI */}
          {isSingleDay ? (
            <KpiCard
              icon={Receipt}
              label="Net Sales"
              value={loading ? '—' : `${sym}${(analytics?.netSales ?? Math.max(0, (analytics?.totalRevenue ?? 0) - (analytics?.taxCollected ?? 0))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              sub={`${sym}${(analytics?.taxCollected ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GST / tax`}
              accent="blue"
            />
          ) : (
            <KpiCard
              icon={CalendarDays}
              label="Today's Sales"
              value={loading ? '—' : `${sym}${(analytics?.todaysRevenue ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              sub={`${analytics?.todaysOrders ?? 0} orders today`}
              change={analytics?.revenueChange}
              accent="blue"
            />
          )}
        </div>

        {/* Row 2: Revenue Trend (2 cols) + Order Types Donut (1 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Card className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold tracking-tight">Revenue Trend</h3>
                <p className="text-[11px] text-muted-foreground">Daily settled revenue · {rangeLabel}</p>
              </div>
              <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
                <span className="inline-block size-2 rounded-full bg-primary" />
                <span>Settled ({sym})</span>
              </div>
            </div>
            {loading ? (
              <ChartSkeleton className="h-[210px]" />
            ) : (
              <div className="h-[210px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics?.dailyRevenue ?? []} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
                    <defs>
                      <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CORAL} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={CORAL} stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v/1000).toFixed(1)}k` : v}`} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} />
                    <Area type="monotone" dataKey="revenue" name="Revenue" stroke={CORAL} strokeWidth={2.2} fill="url(#revGradient)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-sm font-bold tracking-tight">Order Types</h3>
                  <p className="text-[11px] text-muted-foreground">Revenue by fulfillment channel</p>
                </div>
                <Utensils className="size-4 text-muted-foreground" />
              </div>

              {loading ? (
                <ChartSkeleton className="h-[150px]" />
              ) : (analytics?.typeBreakdown ?? []).length === 0 ? (
                <div className="flex h-[150px] items-center justify-center text-xs text-muted-foreground">
                  No order types recorded
                </div>
              ) : (
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={analytics?.typeBreakdown ?? []}
                        dataKey="revenue"
                        nameKey="type"
                        cx="50%"
                        cy="50%"
                        innerRadius={42}
                        outerRadius={65}
                        paddingAngle={3}
                        stroke="none"
                      >
                        {(analytics?.typeBreakdown ?? []).map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip content={<ChartTooltip currencySymbol={sym} />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="space-y-1.5 pt-2 border-t border-border/40">
              {(analytics?.typeBreakdown ?? []).map((t, i) => {
                const pct = typeTotal ? (t.revenue / typeTotal) * 100 : 0
                return (
                  <div key={t.type} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="text-muted-foreground truncate">{TYPE_LABEL[t.type] || t.type}</span>
                      <span className="text-[10px] text-muted-foreground/70">({t.count})</span>
                    </div>
                    <div className="flex items-center gap-1.5 font-medium">
                      <span>{pct.toFixed(0)}%</span>
                      <span className="text-muted-foreground text-[11px]">·</span>
                      <span className="text-foreground">{sym}{t.revenue.toFixed(0)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        </div>

        {/* Row 3: Hourly Distribution (2 cols) + Top Tables (1 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Card className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold tracking-tight">Sales by Hour</h3>
                <p className="text-[11px] text-muted-foreground">Order volume distribution across the day ({analytics?.range?.timezone || 'Asia/Kolkata'})</p>
              </div>
              {peakHour.orders > 0 && (
                <div className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Clock className="size-3" />
                  <span>Peak: {peakHour.displayHour} ({peakHour.orders} orders)</span>
                </div>
              )}
            </div>
            {loading ? (
              <ChartSkeleton className="h-[200px]" />
            ) : !hasHourlyData ? (
              <div className="flex flex-col h-[200px] items-center justify-center text-xs text-muted-foreground gap-2">
                <Clock className="size-6 opacity-40 text-muted-foreground" />
                <span>No order activity recorded for this period</span>
              </div>
            ) : (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourlyData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="hour" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} interval={2} />
                    <YAxis tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="orders" name="Orders" fill={CORAL} radius={[3, 3, 0, 0]} barSize={12} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-sm font-bold tracking-tight">Top Tables</h3>
                  <p className="text-[11px] text-muted-foreground">Highest performing dine-in tables</p>
                </div>
                <Trophy className="size-4 text-amber-500" />
              </div>

              {loading ? (
                <div className="space-y-2 mt-2">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-9 rounded-lg bg-secondary/30 animate-pulse" />
                  ))}
                </div>
              ) : (analytics?.topTables ?? []).length === 0 ? (
                <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
                  No table data available
                </div>
              ) : (
                <div className="space-y-1.5 mt-1">
                  {(analytics?.topTables ?? []).slice(0, 5).map((t, i) => (
                    <div
                      key={t.name + i}
                      className="flex items-center justify-between p-2 rounded-lg bg-secondary/25 hover:bg-secondary/40 transition-colors text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn(
                          'inline-flex items-center justify-center size-5 rounded text-[10px] font-bold shrink-0',
                          i === 0 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                          i === 1 ? 'bg-slate-300/20 text-slate-300 border border-slate-400/30' :
                          i === 2 ? 'bg-orange-700/20 text-orange-400 border border-orange-600/30' :
                          'bg-secondary text-muted-foreground'
                        )}>
                          {i + 1}
                        </span>
                        <span className="font-medium truncate max-w-[100px]">{t.name}</span>
                        <span className="text-[10px] text-muted-foreground">{t.orders} orders</span>
                      </div>
                      <span className="font-semibold tabular-nums text-foreground">{sym}{t.revenue.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="pt-2 text-[10px] text-muted-foreground text-center">
              Ranked by total settled check revenue
            </div>
          </Card>
        </div>

        {/* Row 4: Top Selling Items (1 col) + Revenue by Category (1 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold tracking-tight">Top Selling Items</h3>
                <p className="text-[11px] text-muted-foreground">Highest quantity menu favorites</p>
              </div>
              <Trophy className="size-4 text-muted-foreground" />
            </div>
            {loading ? (
              <ChartSkeleton className="h-[210px]" />
            ) : (analytics?.topItems ?? []).length === 0 ? (
              <div className="flex h-[210px] items-center justify-center text-xs text-muted-foreground">
                No items sold yet
              </div>
            ) : (
              <div className="h-[210px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics?.topItems ?? []} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} width={85} />
                    <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="qty" name="Qty Sold" fill={CORAL} radius={[0, 4, 4, 0]} barSize={14}>
                      <LabelList
                        dataKey="qty"
                        position="right"
                        formatter={(v: any) => `${v} sold`}
                        className="text-[10px] font-semibold fill-muted-foreground"
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-bold tracking-tight">Revenue by Category</h3>
                  <p className="text-[11px] text-muted-foreground">Category contribution to gross revenue</p>
                </div>
                <Layers className="size-4 text-muted-foreground" />
              </div>
              {loading ? (
                <ChartSkeleton className="h-[140px]" />
              ) : (analytics?.categoryBreakdown ?? []).length === 0 ? (
                <div className="flex h-[140px] items-center justify-center text-xs text-muted-foreground">
                  No category data available
                </div>
              ) : (
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics?.categoryBreakdown ?? []} margin={{ top: 0, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v/1000).toFixed(1)}k` : v}`} />
                      <Tooltip content={<ChartTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Bar dataKey="value" name="Revenue" radius={[4, 4, 0, 0]} barSize={22}>
                        {(analytics?.categoryBreakdown ?? []).map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Inline Category Legend & Values ensuring small categories remain 100% readable */}
            {(analytics?.categoryBreakdown ?? []).length > 0 && (
              <div className="space-y-1 pt-2.5 mt-2 border-t border-border/40">
                {(analytics?.categoryBreakdown ?? []).slice(0, 4).map((c, i) => {
                  const pct = catTotal ? ((c.value / catTotal) * 100).toFixed(1) : '0.0'
                  return (
                    <div key={c.name} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="text-muted-foreground truncate max-w-[140px]">{c.name}</span>
                      </div>
                      <div className="flex items-center gap-2 font-medium tabular-nums">
                        <span className="text-muted-foreground text-[11px]">{pct}%</span>
                        <span className="text-foreground">{sym}{c.value.toFixed(2)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Row 5: Payment Method Analytics (Reconciled with Settled Transactions) */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight">Payment Method Breakdown</h3>
              <p className="text-[11px] text-muted-foreground">Actual settled transactions reconciled against payment ledger</p>
            </div>
            <CreditCard className="size-4 text-muted-foreground" />
          </div>

          <div className={cn("grid gap-3", (pm?.other && pm.other.count > 0) ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-3")}>
            <PaymentCard
              icon={Banknote}
              method="Cash"
              amount={pm?.cash.amount ?? 0}
              count={pm?.cash.count ?? 0}
              total={pmTotal}
              currencySymbol={sym}
              color="emerald"
            />
            <PaymentCard
              icon={Smartphone}
              method="UPI / QR"
              amount={pm?.upi.amount ?? 0}
              count={pm?.upi.count ?? 0}
              total={pmTotal}
              currencySymbol={sym}
              color="blue"
            />
            <PaymentCard
              icon={CreditCard}
              method="Card / POS"
              amount={pm?.card.amount ?? 0}
              count={pm?.card.count ?? 0}
              total={pmTotal}
              currencySymbol={sym}
              color="purple"
            />
            {pm?.other && pm.other.count > 0 && (
              <PaymentCard
                icon={Receipt}
                method="Other / Legacy"
                amount={pm.other.amount}
                count={pm.other.count}
                total={pmTotal}
                currencySymbol={sym}
                color="amber"
              />
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function PaymentCard({
  icon: Icon,
  method,
  amount,
  count,
  total,
  currencySymbol,
  color,
}: {
  icon: any
  method: string
  amount: number
  count: number
  total: number
  currencySymbol: string
  color: 'emerald' | 'blue' | 'purple' | 'amber'
}) {
  const pct = total > 0 ? ((amount / total) * 100).toFixed(1) : '0.0'
  const colorMap = {
    emerald: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    blue: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
    purple: 'text-purple-500 bg-purple-500/10 border-purple-500/20',
    amber: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
  }

  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-secondary/25 border border-border/50 text-xs">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={cn('size-8 rounded-lg flex items-center justify-center border shrink-0', colorMap[color])}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-foreground truncate">{method}</p>
          <p className="text-[10px] text-muted-foreground">{count} {count === 1 ? 'transaction' : 'transactions'}</p>
        </div>
      </div>
      <div className="text-right tabular-nums">
        <p className="font-bold text-foreground text-sm">{currencySymbol}{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        <p className="text-[10px] text-muted-foreground font-medium">{pct}% of settled</p>
      </div>
    </div>
  )
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  change,
  accent,
}: {
  icon: any
  label: string
  value: string
  sub?: string
  change?: number
  accent: 'coral' | 'green' | 'amber' | 'blue'
}) {
  const accents: Record<string, string> = {
    coral: 'bg-primary/10 text-primary border-primary/20',
    green: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  }

  // Growth indicator logic: neutral grey 0.0% or — when growth is zero or no baseline. Never green upward arrow for 0%.
  const hasValidChange = change !== undefined && change !== null && !Number.isNaN(change)
  const isZero = hasValidChange && Math.abs(change) < 0.05
  const isPositive = hasValidChange && change >= 0.05
  const isNegative = hasValidChange && change <= -0.05

  return (
    <Card className="rounded-xl border border-border/70 bg-card p-3.5 shadow-sm transition-all hover:border-border">
      <div className="flex items-start justify-between mb-2">
        <div className={cn('size-8 rounded-lg flex items-center justify-center border', accents[accent])}>
          <Icon className="size-4" />
        </div>
        {hasValidChange && (
          isZero ? (
            <span className="text-[11px] font-medium text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/50">
              0.0%
            </span>
          ) : (
            <span className={cn(
              'inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded',
              isPositive ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
            )}>
              {isPositive ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
              {Math.abs(change).toFixed(1)}%
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
