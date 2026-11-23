'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, Line,
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
import { format, startOfMonth, subDays, differenceInCalendarDays } from 'date-fns'
import {
  IndianRupee, ShoppingBag, ClipboardList, CalendarDays,
  ArrowUpRight, ArrowDownRight, ArrowLeftRight, Download, Clock, Utensils, Trophy,
  CalendarIcon, ChevronDown, MapPin, Layers, Sparkles,
  CreditCard, Smartphone, Banknote, Receipt, Bike, TrendingUp, Check,
  Filter, X, Flame, Tag, AlertCircle, HelpCircle,
} from 'lucide-react'
import { formatCurrency } from '@/lib/constants'
import { toast } from 'sonner'

interface DailyRevenue { date: string; label: string; revenue: number; orders: number }
interface TopItem {
  id?: string
  name: string
  category?: string
  qty: number
  revenue: number
  isZeroSale?: boolean
}
interface TypeBreak { type: string; count: number; revenue: number; aov?: number; share?: number }
interface TopTable {
  tableId?: string
  name: string
  orders: number
  sessionCount?: number
  revenue: number
  averageBill?: number
  avgBill?: number
  utilization?: number | null
}
interface CatBreak {
  name: string
  value: number
  revenue?: number
  units?: number
  share?: number
  previousRevenue?: number
  growth?: number | null
}
interface LocationOption { id: string; name: string; isPrimary: boolean }
interface HourlyBreakdownItem { hour: number; orders: number; revenue: number }
interface PaymentMethodDetail {
  amount: number
  count: number
  refunds?: number
  net?: number
}
interface PaymentMethodSummary {
  cash: PaymentMethodDetail
  upi: PaymentMethodDetail
  card: PaymentMethodDetail
  other?: PaymentMethodDetail
  unattributedRefunds?: { amount: number; count: number }
  totalCollected?: number
  totalRefunds?: number
  totalNet?: number
  total: number
}

interface ComparisonSummary {
  period: { from: string; to: string; days: number }
  previous: {
    revenue: number
    orders: number
    avgOrder: number
    netSales: number
  }
  dailyRevenue?: DailyRevenue[]
  revenueChange: number | null
  ordersChange: number | null
  avgOrderChange: number | null
  netSalesChange: number | null
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
  comparison?: ComparisonSummary
  dailyRevenue: DailyRevenue[]
  topItems: TopItem[]
  allItems?: TopItem[]
  typeBreakdown: TypeBreak[]
  topTables: TopTable[]
  hourly: number[]
  hourlyBreakdown?: HourlyBreakdownItem[]
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

function RevenueTrendTooltip({ active, payload, label, currencySymbol = '₹', compDateLabel }: any) {
  if (!active || !payload || !payload.length) return null
  const currentItem = payload.find((p: any) => p.dataKey === 'currentRevenue' || p.dataKey === 'revenue')
  const prevItem = payload.find((p: any) => p.dataKey === 'prevRevenue')
  const curVal = Number(currentItem?.value ?? 0)
  const prevVal = prevItem ? Number(prevItem.value ?? 0) : null
  const curOrders = currentItem?.payload?.currentOrders
  const prevOrders = prevItem?.payload?.prevOrders
  const periodText = currentItem?.payload?.period || label

  let pctChange: number | null = null
  if (prevVal !== null && prevVal !== undefined) {
    if (prevVal > 0) {
      pctChange = +(((curVal - prevVal) / prevVal) * 100).toFixed(1)
    } else if (prevVal === 0 && curVal > 0) {
      pctChange = 100.0
    } else if (prevVal === 0 && curVal === 0) {
      pctChange = 0.0
    }
  }

  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border/80 rounded-xl p-3 text-xs shadow-xl shadow-black/40 min-w-[210px] space-y-2">
      <div>
        <p className="font-semibold text-foreground">{periodText}</p>
        <p className="text-[10px] text-muted-foreground">Settled collections</p>
      </div>
      <div className="space-y-1.5 pt-1 border-t border-border/40">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full bg-primary" />
            <span className="text-muted-foreground">Current:</span>
          </div>
          <div className="text-right tabular-nums">
            <span className="font-bold text-foreground">{currencySymbol}{curVal.toFixed(2)}</span>
            {curOrders !== undefined && (
              <span className="text-[10px] text-muted-foreground ml-1.5">({curOrders} {curOrders === 1 ? 'order' : 'orders'})</span>
            )}
          </div>
        </div>
        {prevItem && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-slate-400" />
              <span className="text-muted-foreground truncate max-w-[100px]">{compDateLabel ? `Prior period:` : 'Prior:'}</span>
            </div>
            <div className="text-right tabular-nums">
              <span className="font-medium text-muted-foreground">{currencySymbol}{(prevVal ?? 0).toFixed(2)}</span>
              {prevOrders !== undefined && (
                <span className="text-[10px] text-muted-foreground/75 ml-1.5">({prevOrders} {prevOrders === 1 ? 'order' : 'orders'})</span>
              )}
            </div>
          </div>
        )}
        {pctChange !== null && (
          <div className="flex items-center justify-between pt-1 border-t border-border/30 text-[11px]">
            <span className="text-muted-foreground">Change:</span>
            <span className={cn(
              'font-semibold tabular-nums',
              pctChange > 0 ? 'text-emerald-500' : pctChange < 0 ? 'text-red-500' : 'text-muted-foreground'
            )}>
              {pctChange > 0 ? `+${pctChange}%` : `${pctChange}%`}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function HourlySalesTooltip({ active, payload, label, currencySymbol = '₹', timezone = 'Asia/Kolkata' }: any) {
  if (!active || !payload || !payload.length) return null
  const item = payload[0]?.payload
  const orders = Number(item?.orders ?? 0)
  const revenue = Number(item?.revenue ?? 0)
  const aov = orders > 0 ? +(revenue / orders).toFixed(2) : 0
  const hourSpan = item?.hourSpan || label

  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border/80 rounded-xl p-3 text-xs shadow-xl shadow-black/40 min-w-[200px] space-y-1.5">
      <div>
        <p className="font-semibold text-foreground">{hourSpan}</p>
        <p className="text-[10px] text-muted-foreground">Timezone: {timezone}</p>
      </div>
      <div className="space-y-1 pt-1 border-t border-border/40">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Settled Revenue:</span>
          <span className="font-bold tabular-nums text-foreground">{currencySymbol}{revenue.toFixed(2)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Completed Orders:</span>
          <span className="font-semibold tabular-nums text-foreground">{orders} {orders === 1 ? 'order' : 'orders'}</span>
        </div>
        {orders > 0 && (
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground pt-0.5">
            <span>Avg / Order:</span>
            <span className="font-medium tabular-nums">{currencySymbol}{aov.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function OrderTypesTooltip({ active, payload, currencySymbol = '₹', metric = 'revenue' }: any) {
  if (!active || !payload || !payload.length) return null
  const item = payload[0]?.payload
  const isRev = metric === 'revenue'
  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border/80 rounded-xl p-2.5 text-xs shadow-xl shadow-black/40 min-w-[170px]">
      <div className="flex items-center gap-1.5 mb-1.5 font-semibold text-foreground">
        <span className="inline-block size-2 rounded-full" style={{ background: payload[0]?.payload?.fill || payload[0]?.color }} />
        <span>{item?.label || item?.type}</span>
      </div>
      <div className="space-y-1 text-muted-foreground">
        <div className="flex items-center justify-between gap-2">
          <span>{isRev ? 'Settled Revenue:' : 'Completed Orders:'}</span>
          <span className="font-bold tabular-nums text-foreground">
            {isRev ? `${currencySymbol}${(item?.revenue ?? 0).toFixed(2)}` : `${item?.count ?? 0}`}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span>{isRev ? 'Revenue Share:' : 'Order Share:'}</span>
          <span className="font-medium tabular-nums text-foreground">
            {isRev ? `${item?.share ?? 0}%` : `${item?.orderShare ?? 0}%`}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] pt-1 border-t border-border/30">
          <span>{isRev ? `Orders: ${item?.count ?? 0}` : `Revenue: ${currencySymbol}${(item?.revenue ?? 0).toFixed(2)}`}</span>
          <span>AOV: {currencySymbol}{(item?.aov ?? 0).toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

function ItemSalesTooltip({ active, payload, currencySymbol = '₹' }: any) {
  if (!active || !payload || !payload.length) return null
  const item = payload[0]?.payload
  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border/80 rounded-xl p-2.5 text-xs shadow-xl shadow-black/40 min-w-[180px] space-y-1">
      <p className="font-semibold text-foreground truncate">{item?.name}</p>
      <p className="text-[10px] text-muted-foreground">{item?.category || 'Menu item'}</p>
      <div className="pt-1 border-t border-border/40 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Units Sold:</span>
          <span className="font-bold tabular-nums text-foreground">{item?.qty ?? 0}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Settled Revenue:</span>
          <span className="font-bold tabular-nums text-foreground">{currencySymbol}{(item?.revenue ?? 0).toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

function CategoryRevenueTooltip({ active, payload, currencySymbol = '₹' }: any) {
  if (!active || !payload || !payload.length) return null
  const item = payload[0]?.payload
  const rev = Number(item?.revenue ?? item?.value ?? 0)
  const units = Number(item?.units ?? 0)
  const share = item?.share !== undefined ? item.share : 0
  const growth = item?.growth

  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border/80 rounded-xl p-2.5 text-xs shadow-xl shadow-black/40 min-w-[190px] space-y-1.5">
      <div>
        <p className="font-semibold text-foreground">{item?.name}</p>
        <p className="text-[10px] text-muted-foreground">Category breakdown</p>
      </div>
      <div className="pt-1 border-t border-border/40 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Settled Revenue:</span>
          <span className="font-bold tabular-nums text-foreground">{currencySymbol}{rev.toFixed(2)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Units Sold:</span>
          <span className="font-medium tabular-nums text-foreground">{units}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Revenue Share:</span>
          <span className="font-medium tabular-nums text-foreground">{share}%</span>
        </div>
        {growth !== undefined && growth !== null && (
          <div className="flex items-center justify-between gap-2 text-[11px] pt-0.5 border-t border-border/30">
            <span className="text-muted-foreground">vs. Prior Period:</span>
            <span className={cn(
              'font-semibold tabular-nums',
              growth > 0 ? 'text-emerald-500' : growth < 0 ? 'text-red-500' : 'text-muted-foreground'
            )}>
              {growth > 0 ? `+${growth}%` : `${growth}%`}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function groupRevenueData(
  daily: DailyRevenue[] = [],
  prevDaily: DailyRevenue[] = [],
  grouping: 'daily' | 'weekly' | 'monthly'
) {
  if (grouping === 'daily') {
    return daily.map((d, i) => {
      const p = prevDaily[i]
      return {
        key: d.date || `day-${i}`,
        date: d.date,
        label: d.label,
        period: d.date,
        currentRevenue: d.revenue,
        currentOrders: d.orders,
        prevRevenue: p ? p.revenue : 0,
        prevOrders: p ? p.orders : 0,
        prevDate: p?.date ?? '',
      }
    })
  }

  if (grouping === 'weekly') {
    const chunks: any[] = []
    const chunkSize = 7
    for (let i = 0; i < daily.length; i += chunkSize) {
      const curChunk = daily.slice(i, i + chunkSize)
      const prevChunk = prevDaily.slice(i, i + chunkSize)
      const startDay = curChunk[0]
      const endDay = curChunk[curChunk.length - 1]
      const wNum = Math.floor(i / chunkSize) + 1
      const startLabel = startDay?.date ? startDay.date : `Day ${i + 1}`
      const endLabel = endDay?.date ? endDay.date : `Day ${i + curChunk.length}`
      const curRev = +curChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2)
      const curOrders = curChunk.reduce((s, c) => s + c.orders, 0)
      const prevRev = +prevChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2)
      const prevOrders = prevChunk.reduce((s, c) => s + c.orders, 0)
      chunks.push({
        key: `w-${wNum}`,
        label: `W${wNum}`,
        period: `Week ${wNum} (${startLabel} – ${endLabel})`,
        currentRevenue: curRev,
        currentOrders: curOrders,
        prevRevenue: prevRev,
        prevOrders: prevOrders,
      })
    }
    return chunks
  }

  // grouping === 'monthly'
  const monthMap = new Map<string, {
    key: string
    label: string
    period: string
    currentRevenue: number
    currentOrders: number
    prevRevenue: number
    prevOrders: number
  }>()

  daily.forEach((d, i) => {
    const monthKey = d.date ? d.date.slice(0, 7) : 'all'
    const p = prevDaily[i]
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        key: monthKey,
        label: monthKey,
        period: monthKey,
        currentRevenue: 0,
        currentOrders: 0,
        prevRevenue: 0,
        prevOrders: 0,
      })
    }
    const entry = monthMap.get(monthKey)!
    entry.currentRevenue = +(entry.currentRevenue + d.revenue).toFixed(2)
    entry.currentOrders += d.orders
    if (p) {
      entry.prevRevenue = +(entry.prevRevenue + p.revenue).toFixed(2)
      entry.prevOrders += p.orders
    }
  })

  return Array.from(monthMap.values())
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
  const [revenueGrouping, setRevenueGrouping] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [showRevenueComparison, setShowRevenueComparison] = useState(true)
  const [orderTypeMetric, setOrderTypeMetric] = useState<'revenue' | 'orders'>('revenue')
  const [hourlyRankMetric, setHourlyRankMetric] = useState<'orders' | 'revenue'>('orders')
  const [itemRankMetric, setItemRankMetric] = useState<'qty' | 'revenue'>('qty')
  const [itemViewMode, setItemViewMode] = useState<'top' | 'least'>('top')
  const [includeZeroSaleItems, setIncludeZeroSaleItems] = useState(false)
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('ALL')
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

  // Determine comparison period date range (same duration immediately preceding)
  const fromDate = range.from ?? new Date()
  const toDate = range.to ?? fromDate
  const daysDiff = Math.max(1, differenceInCalendarDays(toDate, fromDate) + 1)
  const prevTo = subDays(fromDate, 1)
  const prevFrom = subDays(prevTo, daysDiff - 1)
  const compRangeLabel = daysDiff === 1
    ? format(prevFrom, 'd MMM yyyy')
    : `${format(prevFrom, 'd MMM')} – ${format(prevTo, 'd MMM yyyy')}`

  const locations = analytics?.locations ?? []
  const hasMultipleLocations = locations.length > 1
  const selectedLocation = locations.find((l) => l.id === selectedLocationId)

  // Section 2: Grouped Revenue Trend Data
  const groupedRevenueData = groupRevenueData(
    analytics?.dailyRevenue ?? [],
    analytics?.comparison?.dailyRevenue ?? [],
    revenueGrouping
  )
  const hasComparisonData = Boolean(
    analytics?.comparison && (
      (analytics.comparison.dailyRevenue && analytics.comparison.dailyRevenue.length > 0) ||
      analytics.comparison.previous.revenue > 0 ||
      analytics.comparison.previous.orders > 0
    )
  )

  // Section 3: Reconciled 3-Channel Order Types Breakdown
  const ALL_ORDER_TYPES = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const
  const ORDER_TYPE_LABELS: Record<string, string> = {
    DINE_IN: 'Dine In',
    TAKEAWAY: 'Takeaway',
    DELIVERY: 'Delivery',
  }
  const ORDER_TYPE_COLORS: Record<string, string> = {
    DINE_IN: '#f97316',
    TAKEAWAY: '#10b981',
    DELIVERY: '#3b82f6',
  }

  const typeBreakdownRaw = analytics?.typeBreakdown ?? []
  const totalOrderTypesRevenue = +typeBreakdownRaw.reduce((s, t) => s + t.revenue, 0).toFixed(2)
  const totalOrderTypesCount = typeBreakdownRaw.reduce((s, t) => s + t.count, 0)

  const reconciledOrderTypes = ALL_ORDER_TYPES.map((typeKey) => {
    const found = typeBreakdownRaw.find((t) => t.type === typeKey)
    const count = found?.count ?? 0
    const revenue = found?.revenue ?? 0
    const aov = count > 0 ? +(revenue / count).toFixed(2) : 0
    const share = totalOrderTypesRevenue > 0 ? +((revenue / totalOrderTypesRevenue) * 100).toFixed(1) : 0
    const orderShare = totalOrderTypesCount > 0 ? +((count / totalOrderTypesCount) * 100).toFixed(1) : 0
    return {
      type: typeKey,
      label: ORDER_TYPE_LABELS[typeKey],
      count,
      revenue,
      aov,
      share,
      orderShare,
      color: ORDER_TYPE_COLORS[typeKey],
    }
  })
  const hasOrderTypeData = reconciledOrderTypes.some((t) => t.count > 0 || t.revenue > 0)

  // Section 4: Sales by Hour & Peak Hour
  const restaurantTimezone = analytics?.range?.timezone || 'Asia/Kolkata'
  const hourlyData = Array.from({ length: 24 }, (_, h) => {
    const breakdownItem = analytics?.hourlyBreakdown?.[h]
    const orders = breakdownItem ? breakdownItem.orders : (analytics?.hourly?.[h] ?? 0)
    const revenue = breakdownItem ? breakdownItem.revenue : 0
    const displayHour = h === 0 ? '12 AM' : h === 12 ? '12 PM' : h > 12 ? `${h - 12} PM` : `${h} AM`
    const nextH = (h + 1) % 24
    const nextDisplay = nextH === 0 ? '12 AM' : nextH === 12 ? '12 PM' : nextH > 12 ? `${nextH - 12} PM` : `${nextH} AM`
    const hourSpan = `${displayHour} – ${nextDisplay}`
    return {
      hourNum: h,
      hour: `${h}:00`,
      displayHour,
      hourSpan,
      orders,
      revenue,
    }
  })
  const hasHourlyData = hourlyData.some((d) => d.orders > 0 || d.revenue > 0)
  const activePeakHour = hasHourlyData
    ? hourlyData.reduce((best, curr) => {
        if (hourlyRankMetric === 'orders') {
          if (curr.orders > best.orders) return curr
          if (curr.orders === best.orders && curr.revenue > best.revenue) return curr
          return best
        } else {
          if (curr.revenue > best.revenue) return curr
          if (curr.revenue === best.revenue && curr.orders > best.orders) return curr
          return best
        }
      }, hourlyData[0])
    : null

  // Section 5: Top / Least Selling Items Computations
  const itemSourcePool: TopItem[] = (includeZeroSaleItems && itemViewMode === 'least' && analytics?.allItems)
    ? analytics.allItems
    : (analytics?.topItems ?? [])

  const filteredItems = selectedCategoryFilter === 'ALL'
    ? itemSourcePool
    : itemSourcePool.filter((it) => (it.category || 'Other') === selectedCategoryFilter)

  const rankedItems = [...filteredItems].sort((a, b) => {
    if (itemViewMode === 'top') {
      if (itemRankMetric === 'qty') {
        return (b.qty - a.qty) || (b.revenue - a.revenue) || a.name.localeCompare(b.name)
      } else {
        return (b.revenue - a.revenue) || (b.qty - a.qty) || a.name.localeCompare(b.name)
      }
    } else {
      if (itemRankMetric === 'qty') {
        return (a.qty - b.qty) || (a.revenue - b.revenue) || a.name.localeCompare(b.name)
      } else {
        return (a.revenue - b.revenue) || (a.qty - b.qty) || a.name.localeCompare(b.name)
      }
    }
  })
  const chartItems = rankedItems.slice(0, 6)

  // Section 6: Category Breakdown Computations
  const rawCategories = analytics?.categoryBreakdown ?? []
  const totalCategoryRev = rawCategories.reduce((s, c) => s + (c.revenue ?? c.value ?? 0), 0)
  const rankedCategories = [...rawCategories].sort((a, b) => {
    const revA = a.revenue ?? a.value ?? 0
    const revB = b.revenue ?? b.value ?? 0
    return (revB - revA) || a.name.localeCompare(b.name)
  })

  const availableCategories = Array.from(new Set(
    rawCategories.map((c) => c.name).concat(
      (analytics?.topItems ?? []).map((it) => it.category || 'Other')
    )
  )).sort()

  // Payment method totals & percentages
  const pm = analytics?.paymentMethods
  const pmTotal = (pm?.cash.amount ?? 0) + (pm?.upi.amount ?? 0) + (pm?.card.amount ?? 0) + (pm?.other?.amount ?? 0) || 1

  // Category totals for inline percentages
  const catTotal = (analytics?.categoryBreakdown ?? []).reduce((s, c) => s + c.value, 0) || 1

  // Financial Overview Core Metrics (audited definitions)
  const totalRev = analytics?.totalRevenue ?? 0
  const totalOrders = analytics?.totalOrders ?? 0
  const avgOrder = analytics?.avgOrder ?? 0
  const netSales = analytics?.netSales !== undefined && analytics.netSales !== null
    ? analytics.netSales
    : Math.max(0, totalRev - (analytics?.taxCollected ?? 0) - (analytics?.serviceChargeCollected ?? 0))
  const taxCollected = analytics?.taxCollected ?? 0

  const hasError = !loading && denied !== null
  const isEmptyPeriod = !loading && !hasError && analytics !== null && totalOrders === 0 && totalRev === 0
  const isRealZeroRev = !loading && !hasError && analytics !== null && totalRev === 0 && totalOrders > 0
  const isRealZeroOrders = !loading && !hasError && analytics !== null && totalOrders === 0
  const isRealZeroAvg = !loading && !hasError && analytics !== null && avgOrder === 0
  const isRealZeroNet = !loading && !hasError && analytics !== null && netSales === 0 && totalOrders > 0

  const totalRevFormatted = formatCurrency(totalRev, sym)
  const totalOrdersFormatted = totalOrders.toLocaleString('en-IN')
  const avgOrderFormatted = formatCurrency(avgOrder, sym)
  const netSalesFormatted = formatCurrency(netSales, sym)
  const taxSubtext = taxCollected > 0
    ? `Excl. ${formatCurrency(taxCollected, sym)} GST / tax`
    : 'Excl. taxes / charges'

  const comparison = analytics?.comparison
  const revenueChangeVal = comparison?.revenueChange ?? (analytics?.revenueChange !== undefined && analytics?.revenueChange !== null ? analytics.revenueChange : null)
  const ordersChangeVal = comparison?.ordersChange ?? null
  const avgOrderChangeVal = comparison?.avgOrderChange ?? null
  const netSalesChangeVal = comparison?.netSalesChange ?? null

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

            {/* Previous-period comparison badge */}
            <div
              className="hidden sm:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border/70 bg-card text-xs text-muted-foreground shadow-xs select-none"
              title={`Comparing against previous period: ${compRangeLabel}`}
            >
              <ArrowLeftRight className="size-3.5 text-primary shrink-0" />
              <span className="truncate max-w-[160px] md:max-w-[190px]">vs. {compRangeLabel}</span>
            </div>

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
        {/* Section 1: Financial Overview */}
        <section aria-labelledby="financial-overview-title" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div>
              <h2 id="financial-overview-title" className="text-sm font-bold tracking-tight text-foreground flex items-center gap-1.5">
                Financial Overview
              </h2>
              <p className="text-[11px] text-muted-foreground">
                Audited core revenue & sales metrics · Compared with {compRangeLabel}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
              <span>Settlement Basis</span>
            </div>
          </div>

          {/* Cards in EXACT audited order: 1. Revenue, 2. Completed Orders, 3. Average Order Value, 4. Net Sales */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <FinancialKpiCard
              icon={IndianRupee}
              label="Revenue"
              value={totalRevFormatted}
              subtext="Gross settled collections"
              comparisonDateLabel={compRangeLabel}
              change={revenueChangeVal}
              accent="coral"
              loading={loading}
              hasError={hasError}
              isEmpty={isEmptyPeriod}
              isRealZero={isRealZeroRev}
            />
            <FinancialKpiCard
              icon={ClipboardList}
              label="Completed Orders"
              value={totalOrdersFormatted}
              subtext="Paid & fulfilled"
              comparisonDateLabel={compRangeLabel}
              change={ordersChangeVal}
              accent="green"
              loading={loading}
              hasError={hasError}
              isEmpty={isEmptyPeriod}
              isRealZero={isRealZeroOrders}
            />
            <FinancialKpiCard
              icon={ShoppingBag}
              label="Average Order Value"
              value={avgOrderFormatted}
              subtext="Per completed order"
              comparisonDateLabel={compRangeLabel}
              change={avgOrderChangeVal}
              accent="amber"
              loading={loading}
              hasError={hasError}
              isEmpty={isEmptyPeriod}
              isRealZero={isRealZeroAvg}
            />
            <FinancialKpiCard
              icon={Receipt}
              label="Net Sales"
              value={netSalesFormatted}
              subtext={taxSubtext}
              comparisonDateLabel={compRangeLabel}
              change={netSalesChangeVal}
              accent="blue"
              loading={loading}
              hasError={hasError}
              isEmpty={isEmptyPeriod}
              isRealZero={isRealZeroNet}
            />
          </div>
        </section>

        {/* Row 2: Revenue Trend (2 cols) + Order Types Donut (1 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Section 2: Revenue Trend */}
          <Card className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                    <TrendingUp className="size-4 text-primary" />
                    Revenue Trend
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    Settled revenue over time ({revenueGrouping}) · {rangeLabel}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Grouping segmented control: Daily, Weekly, Monthly */}
                  <div className="flex items-center rounded-lg bg-secondary/60 p-0.5 border border-border/50 text-[11px]">
                    {(['daily', 'weekly', 'monthly'] as const).map((grp) => (
                      <button
                        key={grp}
                        type="button"
                        onClick={() => setRevenueGrouping(grp)}
                        className={cn(
                          'px-2 py-1 rounded-md font-medium capitalize transition-colors',
                          revenueGrouping === grp
                            ? 'bg-card text-foreground shadow-xs'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {grp}
                      </button>
                    ))}
                  </div>

                  {/* Comparison toggle */}
                  {hasComparisonData && (
                    <button
                      type="button"
                      onClick={() => setShowRevenueComparison((prev) => !prev)}
                      className={cn(
                        'flex items-center gap-1 text-[11px] h-7 px-2 rounded-lg border font-medium transition-colors',
                        showRevenueComparison
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground'
                      )}
                      title={`Toggle comparison with prior period: ${compRangeLabel}`}
                    >
                      <ArrowLeftRight className="size-3" />
                      <span>vs. Prior</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Legend with explicit labels */}
              <div className="flex items-center gap-3 text-[11px] font-medium text-muted-foreground mb-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="inline-block size-2 rounded-full bg-primary" />
                  <span>Current Period ({sym})</span>
                </div>
                {showRevenueComparison && hasComparisonData && (
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-0.5 border-t-2 border-dashed border-slate-400" />
                    <span className="text-muted-foreground/80">Previous ({compRangeLabel})</span>
                  </div>
                )}
              </div>
            </div>

            {loading ? (
              <ChartSkeleton className="h-[210px]" />
            ) : (
              <div className="h-[210px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={groupedRevenueData} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
                    <defs>
                      <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CORAL} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={CORAL} stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis
                      tick={{ fill: AXIS, fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                    />
                    <Tooltip content={<RevenueTrendTooltip currencySymbol={sym} compDateLabel={compRangeLabel} />} />
                    <Area
                      type="monotone"
                      dataKey="currentRevenue"
                      name="Current Period"
                      stroke={CORAL}
                      strokeWidth={2.2}
                      fill="url(#revGradient)"
                    />
                    {showRevenueComparison && hasComparisonData && (
                      <Line
                        type="monotone"
                        dataKey="prevRevenue"
                        name={`Previous (${compRangeLabel})`}
                        stroke="#94a3b8"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                        dot={false}
                      />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Section 3: Order Types */}
          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-1 mb-2">
                <div>
                  <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                    <Utensils className="size-4 text-muted-foreground" />
                    Order Types
                  </h3>
                  <p className="text-[11px] text-muted-foreground">Fulfillment channel comparison</p>
                </div>

                {/* Metric driver toggle */}
                <div className="flex items-center rounded-lg bg-secondary/60 p-0.5 border border-border/50 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setOrderTypeMetric('revenue')}
                    className={cn(
                      'px-2 py-0.5 rounded-md font-medium transition-colors',
                      orderTypeMetric === 'revenue'
                        ? 'bg-card text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Revenue
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderTypeMetric('orders')}
                    className={cn(
                      'px-2 py-0.5 rounded-md font-medium transition-colors',
                      orderTypeMetric === 'orders'
                        ? 'bg-card text-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    Orders
                  </button>
                </div>
              </div>

              {/* Driver label */}
              <div className="mb-2">
                <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground bg-secondary/70 px-1.5 py-0.5 rounded">
                  Driven by: {orderTypeMetric === 'revenue' ? 'Settled Revenue' : 'Completed Orders'}
                </span>
              </div>

              {loading ? (
                <ChartSkeleton className="h-[140px]" />
              ) : !hasOrderTypeData ? (
                <div className="flex h-[140px] items-center justify-center text-xs text-muted-foreground">
                  No order types recorded
                </div>
              ) : (
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={reconciledOrderTypes}
                        dataKey={orderTypeMetric === 'revenue' ? 'revenue' : 'count'}
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={42}
                        outerRadius={65}
                        paddingAngle={3}
                        stroke="none"
                      >
                        {reconciledOrderTypes.map((t) => (
                          <Cell key={t.type} fill={t.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<OrderTypesTooltip currencySymbol={sym} metric={orderTypeMetric} />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* 3-Channel Breakdown Table: Dine-in, Takeaway, Delivery */}
            <div className="space-y-2 pt-2 border-t border-border/40">
              {reconciledOrderTypes.map((t) => (
                <div key={t.type} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: t.color }} />
                    <span className="text-muted-foreground truncate font-medium">{t.label}</span>
                    <span className="text-[10px] text-muted-foreground/75">({t.count} orders)</span>
                  </div>
                  <div className="flex items-center gap-2 font-medium tabular-nums text-right">
                    <span className="text-[11px] text-muted-foreground">{t.share}%</span>
                    <span className="text-foreground">{sym}{t.revenue.toFixed(2)}</span>
                    <span className="text-[10px] text-muted-foreground/80 hidden sm:inline">AOV {sym}{t.aov.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Row 3: Section 4 - Sales by Hour */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                <Clock className="size-4 text-primary" />
                Sales by Hour
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Order volume & revenue distribution across the day ({restaurantTimezone})
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* Ranking Metric Toggle */}
              <div className="flex items-center rounded-lg bg-secondary/60 p-0.5 border border-border/50 text-[11px]">
                <button
                  type="button"
                  onClick={() => setHourlyRankMetric('orders')}
                  className={cn(
                    'px-2 py-1 rounded-md font-medium transition-colors',
                    hourlyRankMetric === 'orders'
                      ? 'bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  By Orders
                </button>
                <button
                  type="button"
                  onClick={() => setHourlyRankMetric('revenue')}
                  className={cn(
                    'px-2 py-1 rounded-md font-medium transition-colors',
                    hourlyRankMetric === 'revenue'
                      ? 'bg-card text-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  By Revenue
                </button>
              </div>

              {/* Peak Hour Banner */}
              {activePeakHour && (activePeakHour.orders > 0 || activePeakHour.revenue > 0) ? (
                <div className="flex items-center gap-1.5 rounded-lg bg-primary/10 border border-primary/20 px-2.5 py-1 text-xs font-medium text-primary">
                  <Clock className="size-3.5 shrink-0" />
                  <span>
                    Peak: <strong>{activePeakHour.hourSpan}</strong> · {sym}{activePeakHour.revenue.toFixed(2)} ({activePeakHour.orders} {activePeakHour.orders === 1 ? 'order' : 'orders'})
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-lg bg-secondary/50 border border-border/40 px-2.5 py-1 text-xs text-muted-foreground">
                  <Clock className="size-3.5 shrink-0 opacity-60" />
                  <span>Peak: — (No activity recorded)</span>
                </div>
              )}

              {/* Ranking label */}
              <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground bg-secondary/70 px-2 py-1 rounded">
                {hourlyRankMetric === 'orders' ? 'Ranked by Order Count' : 'Ranked by Settled Revenue'}
              </span>
            </div>
          </div>

          {loading ? (
            <ChartSkeleton className="h-[200px]" />
          ) : !hasHourlyData ? (
            <div className="flex flex-col h-[200px] items-center justify-center text-xs text-muted-foreground gap-2">
              <Clock className="size-6 opacity-40 text-muted-foreground" />
              <span>No order activity recorded for this period</span>
            </div>
          ) : (
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="displayHour" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} interval={2} />
                  <YAxis tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<HourlySalesTooltip currencySymbol={sym} timezone={restaurantTimezone} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Bar
                    dataKey={hourlyRankMetric === 'revenue' ? 'revenue' : 'orders'}
                    name={hourlyRankMetric === 'revenue' ? 'Revenue' : 'Orders'}
                    fill={CORAL}
                    radius={[3, 3, 0, 0]}
                    barSize={14}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Row 4: Section 5 - Top Selling Items (1 col) + Section 6 - Revenue by Category (1 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Section 5: Top Selling Items */}
          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between space-y-3">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2.5">
                <div>
                  <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                    {itemViewMode === 'top' ? (
                      <Trophy className="size-4 text-amber-500" />
                    ) : (
                      <ArrowDownRight className="size-4 text-orange-500" />
                    )}
                    <span>{itemViewMode === 'top' ? 'Top Selling Items' : 'Least Selling Items'}</span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    Ranked by {itemRankMetric === 'qty' ? 'quantity sold' : 'settled revenue'} · {
                      itemViewMode === 'top'
                        ? 'Items sold in period'
                        : includeZeroSaleItems
                          ? 'Including zero-sale items'
                          : 'Sold items only'
                    }
                  </p>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* View Mode Toggle: Top vs Least */}
                  <div className="flex items-center rounded-lg bg-secondary/60 p-0.5 border border-border/50 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setItemViewMode('top')}
                      className={cn(
                        'px-2 py-0.5 rounded-md font-medium transition-colors',
                        itemViewMode === 'top'
                          ? 'bg-card text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      Top
                    </button>
                    <button
                      type="button"
                      onClick={() => setItemViewMode('least')}
                      className={cn(
                        'px-2 py-0.5 rounded-md font-medium transition-colors',
                        itemViewMode === 'least'
                          ? 'bg-card text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      Least
                    </button>
                  </div>

                  {/* Metric Toggle: Units vs Revenue */}
                  <div className="flex items-center rounded-lg bg-secondary/60 p-0.5 border border-border/50 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setItemRankMetric('qty')}
                      className={cn(
                        'px-2 py-0.5 rounded-md font-medium transition-colors',
                        itemRankMetric === 'qty'
                          ? 'bg-card text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      Units
                    </button>
                    <button
                      type="button"
                      onClick={() => setItemRankMetric('revenue')}
                      className={cn(
                        'px-2 py-0.5 rounded-md font-medium transition-colors',
                        itemRankMetric === 'revenue'
                          ? 'bg-card text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {sym}
                    </button>
                  </div>

                  {/* Zero-sale toggle when in Least Selling view */}
                  {itemViewMode === 'least' && (
                    <button
                      type="button"
                      onClick={() => setIncludeZeroSaleItems((prev) => !prev)}
                      className={cn(
                        'text-[10px] h-6 px-2 rounded border font-medium transition-colors',
                        includeZeroSaleItems
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground'
                      )}
                      title="Toggle inclusion of active menu items with 0 sales"
                    >
                      {includeZeroSaleItems ? 'Inc. 0-sale: Yes' : 'Inc. 0-sale: No'}
                    </button>
                  )}
                </div>
              </div>

              {/* Scope & Active Filter Pill Bar */}
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2 text-[10px]">
                <span className="uppercase font-semibold tracking-wider text-muted-foreground bg-secondary/70 px-1.5 py-0.5 rounded">
                  {itemViewMode === 'top'
                    ? 'Covering: Items sold in period'
                    : includeZeroSaleItems
                      ? 'Covering: All active menu items (including 0 sales)'
                      : 'Covering: Items sold in period (units > 0)'}
                </span>

                {selectedCategoryFilter !== 'ALL' && (
                  <div className="flex items-center gap-1 bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded">
                    <span>Category: {selectedCategoryFilter}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedCategoryFilter('ALL')}
                      className="hover:text-foreground"
                      title="Clear category drill-down filter"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                )}
              </div>

              {/* Chart */}
              {loading ? (
                <ChartSkeleton className="h-[180px]" />
              ) : chartItems.length === 0 ? (
                <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
                  No items sold in this period
                </div>
              ) : (
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartItems} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fill: AXIS, fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        width={90}
                      />
                      <Tooltip content={<ItemSalesTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Bar
                        dataKey={itemRankMetric === 'qty' ? 'qty' : 'revenue'}
                        name={itemRankMetric === 'qty' ? 'Units' : 'Revenue'}
                        fill={itemViewMode === 'top' ? CORAL : '#f59e0b'}
                        radius={[0, 4, 4, 0]}
                        barSize={14}
                      >
                        <LabelList
                          dataKey={itemRankMetric === 'qty' ? 'qty' : 'revenue'}
                          position="right"
                          formatter={(v: any) =>
                            itemRankMetric === 'qty' ? `${v} sold` : `${sym}${Number(v || 0).toFixed(0)}`
                          }
                          className="text-[10px] font-semibold fill-muted-foreground"
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Ranked Item Table */}
            <div className="pt-2 border-t border-border/40 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground pb-1">
                <span>Rank & Item</span>
                <div className="flex items-center gap-4">
                  <span className="hidden sm:inline">Category</span>
                  <span>Units</span>
                  <span>Revenue</span>
                </div>
              </div>

              <div className="max-h-[220px] overflow-y-auto scrollbar-thin space-y-1">
                {rankedItems.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">No matching items</p>
                ) : (
                  rankedItems.slice(0, 15).map((it, idx) => (
                    <div
                      key={it.name + idx}
                      className="flex items-center justify-between p-1.5 rounded-lg bg-secondary/20 hover:bg-secondary/35 text-xs transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            'inline-flex items-center justify-center size-4 rounded text-[9px] font-bold shrink-0',
                            idx === 0
                              ? 'bg-amber-500/20 text-amber-400'
                              : idx === 1
                              ? 'bg-slate-300/20 text-slate-300'
                              : idx === 2
                              ? 'bg-orange-700/20 text-orange-400'
                              : 'bg-secondary text-muted-foreground'
                          )}
                        >
                          {idx + 1}
                        </span>
                        <span className="font-medium truncate max-w-[130px] sm:max-w-[170px]" title={it.name}>
                          {it.name}
                        </span>
                        {it.isZeroSale && (
                          <span className="text-[9px] text-muted-foreground/70 bg-secondary/80 px-1 rounded">0-sale</span>
                        )}
                      </div>

                      <div className="flex items-center gap-4 text-right tabular-nums">
                        <span className="text-[10px] text-muted-foreground hidden sm:inline truncate max-w-[90px]">
                          {it.category || 'Other'}
                        </span>
                        <span className="font-semibold text-foreground w-10 text-right">{it.qty}</span>
                        <span className="font-semibold text-foreground w-16 text-right">
                          {sym}{it.revenue.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Card>

          {/* Section 6: Revenue by Category */}
          <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <div>
                  <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                    <Layers className="size-4 text-primary" />
                    <span>Revenue by Category</span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    Category contribution · {compRangeLabel ? `Compared with vs. ${compRangeLabel}` : rangeLabel}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-[10px] text-muted-foreground">Total Category Sales</p>
                  <p className="text-xs font-bold text-foreground tabular-nums">
                    {sym}{totalCategoryRev.toFixed(2)}
                  </p>
                </div>
              </div>

              {/* Chart */}
              {loading ? (
                <ChartSkeleton className="h-[180px]" />
              ) : rankedCategories.length === 0 ? (
                <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
                  No category data available
                </div>
              ) : (
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={rankedCategories} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis
                        tick={{ fill: AXIS, fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                      />
                      <Tooltip content={<CategoryRevenueTooltip currencySymbol={sym} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Bar dataKey="value" name="Revenue" radius={[4, 4, 0, 0]} barSize={22}>
                        {rankedCategories.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Category Performance Table */}
            <div className="pt-2 border-t border-border/40 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground pb-1">
                <span>Category (click to drill-down)</span>
                <div className="flex items-center gap-3">
                  <span>Revenue</span>
                  <span className="hidden sm:inline">Units</span>
                  <span>Share</span>
                  <span>vs Prior</span>
                </div>
              </div>

              <div className="max-h-[220px] overflow-y-auto scrollbar-thin space-y-1">
                {rankedCategories.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">No category data</p>
                ) : (
                  rankedCategories.map((c, i) => {
                    const isSelected = selectedCategoryFilter === c.name
                    const hasValidGrowth = c.growth !== undefined && c.growth !== null
                    const isPos = hasValidGrowth && c.growth! > 0.05
                    const isNeg = hasValidGrowth && c.growth! < -0.05
                    const isZeroGrowth = hasValidGrowth && Math.abs(c.growth!) <= 0.05

                    return (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() => setSelectedCategoryFilter((prev) => (prev === c.name ? 'ALL' : c.name))}
                        className={cn(
                          'w-full flex items-center justify-between p-1.5 rounded-lg text-xs transition-colors text-left',
                          isSelected
                            ? 'bg-primary/15 border border-primary/30 text-foreground'
                            : 'bg-secondary/20 hover:bg-secondary/35 text-muted-foreground hover:text-foreground'
                        )}
                        title={`Click to ${isSelected ? 'clear drill-down' : 'filter Top Selling Items by ' + c.name}`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className="inline-block size-2 shrink-0 rounded-full"
                            style={{ background: COLORS[i % COLORS.length] }}
                          />
                          <span className={cn('truncate font-medium max-w-[110px] sm:max-w-[130px]', isSelected && 'text-primary font-bold')}>
                            {c.name}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 text-right tabular-nums">
                          <span className="font-semibold text-foreground w-16 text-right">
                            {sym}{(c.revenue ?? c.value).toFixed(2)}
                          </span>
                          <span className="text-[10px] text-muted-foreground w-10 text-right hidden sm:inline">
                            {c.units ?? 0}
                          </span>
                          <span className="text-[11px] text-muted-foreground w-10 text-right">
                            {c.share ?? 0}%
                          </span>
                          <div className="w-14 text-right">
                            {hasValidGrowth ? (
                              isZeroGrowth ? (
                                <span className="text-[10px] text-muted-foreground">0.0%</span>
                              ) : isPos ? (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                                  <ArrowUpRight className="size-2.5 shrink-0" />
                                  +{c.growth}%
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                                  <ArrowDownRight className="size-2.5 shrink-0" />
                                  {c.growth}%
                                </span>
                              )
                            ) : (
                              <span className="text-[10px] text-muted-foreground/60">—</span>
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* Row 5: Section 7 - Payment Method Breakdown (Reconciliation Table) */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <div>
              <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                <CreditCard className="size-4 text-primary" />
                Payment Method Breakdown
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Actual settled transactions reconciled against payment ledger and refund records
              </p>
            </div>
            {/* Quick summary totals */}
            <div className="flex items-center gap-3 text-xs bg-secondary/30 px-3 py-1.5 rounded-lg border border-border/40">
              <div>
                <span className="text-[10px] text-muted-foreground block">Total Collected</span>
                <span className="font-semibold tabular-nums text-foreground">{sym}{(pm?.totalCollected ?? pmTotal).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div className="h-6 w-px bg-border/60" />
              <div>
                <span className="text-[10px] text-muted-foreground block">Refunds</span>
                <span className="font-semibold tabular-nums text-red-500">-{sym}{(pm?.totalRefunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div className="h-6 w-px bg-border/60" />
              <div>
                <span className="text-[10px] text-muted-foreground block">Net Settled</span>
                <span className="font-semibold tabular-nums text-emerald-500">{sym}{(pm?.totalNet ?? (pmTotal - (pm?.totalRefunds ?? 0))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground text-[11px]">
                  <th className="text-left font-medium py-2 px-3">Payment Method</th>
                  <th className="text-right font-medium py-2 px-3">Transactions</th>
                  <th className="text-right font-medium py-2 px-3">Collected Amount</th>
                  <th className="text-right font-medium py-2 px-3">Refunds</th>
                  <th className="text-right font-medium py-2 px-3">Net Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {/* Cash */}
                <tr className="hover:bg-secondary/20 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="size-6 rounded-md flex items-center justify-center bg-emerald-500/10 border border-emerald-500/20 text-emerald-500">
                        <Banknote className="size-3.5" />
                      </div>
                      <span className="font-medium text-foreground">Cash</span>
                    </div>
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">
                    {pm?.cash?.count ?? 0}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums font-medium text-foreground">
                    {sym}{(pm?.cash?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-red-400">
                    {(pm?.cash?.refunds ?? 0) > 0 ? `-${sym}${(pm?.cash?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums font-semibold text-foreground">
                    {sym}{((pm?.cash?.net ?? ((pm?.cash?.amount ?? 0) - (pm?.cash?.refunds ?? 0)))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>

                {/* UPI */}
                <tr className="hover:bg-secondary/20 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="size-6 rounded-md flex items-center justify-center bg-blue-500/10 border border-blue-500/20 text-blue-500">
                        <Smartphone className="size-3.5" />
                      </div>
                      <span className="font-medium text-foreground">UPI / QR</span>
                    </div>
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">
                    {pm?.upi?.count ?? 0}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums font-medium text-foreground">
                    {sym}{(pm?.upi?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-red-400">
                    {(pm?.upi?.refunds ?? 0) > 0 ? `-${sym}${(pm?.upi?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums font-semibold text-foreground">
                    {sym}{((pm?.upi?.net ?? ((pm?.upi?.amount ?? 0) - (pm?.upi?.refunds ?? 0)))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>

                {/* Card */}
                <tr className="hover:bg-secondary/20 transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="size-6 rounded-md flex items-center justify-center bg-purple-500/10 border border-purple-500/20 text-purple-500">
                        <CreditCard className="size-3.5" />
                      </div>
                      <span className="font-medium text-foreground">Card / POS</span>
                    </div>
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">
                    {pm?.card?.count ?? 0}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums font-medium text-foreground">
                    {sym}{(pm?.card?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-red-400">
                    {(pm?.card?.refunds ?? 0) > 0 ? `-${sym}${(pm?.card?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums font-semibold text-foreground">
                    {sym}{((pm?.card?.net ?? ((pm?.card?.amount ?? 0) - (pm?.card?.refunds ?? 0)))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>

                {/* Other / Legacy */}
                {Boolean((pm?.other?.count ?? 0) > 0 || (pm?.other?.amount ?? 0) > 0 || (pm?.other?.refunds ?? 0) > 0) && (
                  <tr className="hover:bg-secondary/20 transition-colors">
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="size-6 rounded-md flex items-center justify-center bg-amber-500/10 border border-amber-500/20 text-amber-500">
                          <Receipt className="size-3.5" />
                        </div>
                        <span className="font-medium text-foreground">Other / Legacy</span>
                      </div>
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">
                      {pm?.other?.count ?? 0}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums font-medium text-foreground">
                      {sym}{(pm?.other?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-red-400">
                      {(pm?.other?.refunds ?? 0) > 0 ? `-${sym}${(pm?.other?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums font-semibold text-foreground">
                      {sym}{((pm?.other?.net ?? ((pm?.other?.amount ?? 0) - (pm?.other?.refunds ?? 0)))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                )}

                {/* Unattributed Refunds (Refunds where payment method is unavailable) */}
                {Boolean((pm?.unattributedRefunds?.amount ?? 0) > 0) && (
                  <tr className="hover:bg-secondary/20 transition-colors bg-amber-500/5">
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <div className="size-6 rounded-md flex items-center justify-center bg-amber-500/10 border border-amber-500/20 text-amber-500">
                          <AlertCircle className="size-3.5" />
                        </div>
                        <div>
                          <span className="font-medium text-foreground">Refunds (Method Unavailable)</span>
                          <span className="block text-[10px] text-muted-foreground">Check-level refund without attributed payment method</span>
                        </div>
                      </div>
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">
                      {pm?.unattributedRefunds?.count ?? 0}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">—</td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-red-400 font-medium">
                      -{sym}{(pm?.unattributedRefunds?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums font-semibold text-red-400">
                      -{sym}{(pm?.unattributedRefunds?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                {/* Total Reconciled Footer */}
                <tr className="border-t-2 border-border/80 font-semibold bg-secondary/15">
                  <td className="py-2.5 px-3 text-foreground">Total (Reconciled)</td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-foreground">
                    {(pm?.cash?.count ?? 0) + (pm?.upi?.count ?? 0) + (pm?.card?.count ?? 0) + (pm?.other?.count ?? 0)}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-foreground">
                    {sym}{(pm?.totalCollected ?? pmTotal).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-red-500">
                    {(pm?.totalRefunds ?? 0) > 0 ? `-${sym}${(pm?.totalRefunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td className="text-right py-2.5 px-3 tabular-nums text-emerald-500 font-bold">
                    {sym}{(pm?.totalNet ?? (pmTotal - (pm?.totalRefunds ?? 0))).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        {/* Row 6: Section 8 - Top Tables */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                  <Trophy className="size-4 text-amber-500" />
                  Top Tables
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  Highest performing dine-in tables · Ranked by settled revenue across independent diner sessions
                </p>
              </div>
            </div>

            {loading ? (
              <div className="space-y-2 mt-2">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-10 rounded-lg bg-secondary/30 animate-pulse" />
                ))}
              </div>
            ) : (analytics?.topTables ?? []).length === 0 ? (
              <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
                No table session data available for this period
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/60 text-muted-foreground text-[11px]">
                      <th className="text-left font-medium py-2 px-3 w-12">#</th>
                      <th className="text-left font-medium py-2 px-3">Table Name</th>
                      <th className="text-right font-medium py-2 px-3">Settled Revenue</th>
                      <th className="text-right font-medium py-2 px-3">Session Count</th>
                      <th className="text-right font-medium py-2 px-3">Average Bill</th>
                      <th className="text-right font-medium py-2 px-3">
                        <span className="inline-flex items-center gap-1 justify-end">
                          Utilization
                          <span title="Table utilization requires operating hours denominator (unavailable in source data)">
                            <HelpCircle className="size-3 text-muted-foreground/70" />
                          </span>
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {(analytics?.topTables ?? []).map((t, i) => {
                      const sessions = t.sessionCount ?? t.orders ?? 0
                      const avgBill = t.averageBill ?? t.avgBill ?? (sessions > 0 ? t.revenue / sessions : 0)
                      return (
                        <tr key={t.tableId || t.name + i} className="hover:bg-secondary/20 transition-colors">
                          <td className="py-2.5 px-3">
                            <span className={cn(
                              'inline-flex items-center justify-center size-5 rounded text-[10px] font-bold shrink-0',
                              i === 0 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                              i === 1 ? 'bg-slate-300/20 text-slate-300 border border-slate-400/30' :
                              i === 2 ? 'bg-orange-700/20 text-orange-400 border border-orange-600/30' :
                              'bg-secondary text-muted-foreground'
                            )}>
                              {i + 1}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-medium text-foreground">
                            {t.name}
                          </td>
                          <td className="text-right py-2.5 px-3 tabular-nums font-semibold text-foreground">
                            {sym}{t.revenue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="text-right py-2.5 px-3 tabular-nums text-muted-foreground">
                            {sessions} {sessions === 1 ? 'session' : 'sessions'}
                          </td>
                          <td className="text-right py-2.5 px-3 tabular-nums text-foreground">
                            {sym}{avgBill.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td className="text-right py-2.5 px-3 text-muted-foreground/60 tabular-nums">
                            {t.utilization != null ? `${t.utilization.toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function FinancialKpiCard({
  icon: Icon,
  label,
  value,
  subtext,
  change,
  comparisonDateLabel,
  accent,
  loading = false,
  hasError = false,
  isEmpty = false,
  isRealZero = false,
}: {
  icon: any
  label: string
  value: string
  subtext?: string
  change?: number | null
  comparisonDateLabel?: string
  accent: 'coral' | 'green' | 'amber' | 'blue'
  loading?: boolean
  hasError?: boolean
  isEmpty?: boolean
  isRealZero?: boolean
}) {
  const accents: Record<string, string> = {
    coral: 'bg-primary/10 text-primary border-primary/20',
    green: 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-500 dark:text-amber-400 border-amber-500/20',
    blue: 'bg-blue-500/10 text-blue-500 dark:text-blue-400 border-blue-500/20',
  }

  const hasValidChange = !loading && !hasError && change !== undefined && change !== null && !Number.isNaN(change)
  const isZeroChange = hasValidChange && Math.abs(change) < 0.05
  const isPositive = hasValidChange && change >= 0.05
  const isNegative = hasValidChange && change <= -0.05

  return (
    <Card className="rounded-xl border border-border/70 bg-card p-3 sm:p-3.5 shadow-sm transition-all hover:border-border flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between gap-1.5 mb-2">
          <div className={cn('size-8 rounded-lg flex items-center justify-center border shrink-0', accents[accent])}>
            <Icon className="size-4" />
          </div>
          {loading ? (
            <div className="h-5 w-14 rounded bg-secondary/50 animate-pulse" />
          ) : hasError ? (
            <span className="text-[10px] font-medium text-destructive/80 px-1.5 py-0.5 rounded bg-destructive/10">
              Error
            </span>
          ) : hasValidChange ? (
            isZeroChange ? (
              <span className="text-[11px] font-medium text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/60">
                0.0%
              </span>
            ) : (
              <span className={cn(
                'inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded',
                isPositive ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/15 text-red-600 dark:text-red-400'
              )}>
                {isPositive ? <ArrowUpRight className="size-3 shrink-0" /> : <ArrowDownRight className="size-3 shrink-0" />}
                {isPositive ? `+${change.toFixed(1)}%` : `-${Math.abs(change).toFixed(1)}%`}
              </span>
            )
          ) : (
            <span className="text-[10px] text-muted-foreground/60 px-1.5 py-0.5 rounded bg-secondary/30">
              —
            </span>
          )}
        </div>
        <p className="text-[11px] font-medium text-muted-foreground truncate">{label}</p>
        {loading ? (
          <div className="h-7 w-28 my-1 rounded bg-secondary/50 animate-pulse" />
        ) : hasError ? (
          <p className="text-xl md:text-2xl font-bold tracking-tight text-muted-foreground/50">—</p>
        ) : (
          <p className={cn(
            'text-xl md:text-2xl font-bold tracking-tight tabular-nums truncate',
            isEmpty ? 'text-muted-foreground' : 'text-foreground'
          )}>
            {value}
          </p>
        )}
      </div>

      <div className="mt-2 pt-2 border-t border-border/40">
        {loading ? (
          <div className="h-3 w-32 rounded bg-secondary/30 animate-pulse" />
        ) : hasError ? (
          <p className="text-[11px] text-destructive/70">Failed to load metric</p>
        ) : (
          <div className="space-y-0.5 min-w-0">
            <p className="text-[11px] text-muted-foreground truncate">{subtext}</p>
            {comparisonDateLabel && (
              <p className="text-[10px] text-muted-foreground/75 truncate">
                vs. {comparisonDateLabel}
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
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
  return (
    <FinancialKpiCard
      icon={Icon}
      label={label}
      value={value}
      subtext={sub}
      change={change}
      accent={accent}
    />
  )
}
