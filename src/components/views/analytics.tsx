'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  ComposedChart, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, Line,
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
import { format, startOfMonth, subDays, differenceInCalendarDays, parseISO } from 'date-fns'
import {
  IndianRupee, ShoppingBag, ClipboardList, CalendarDays,
  ArrowUpRight, ArrowDownRight, ArrowLeftRight, Download, Clock, Utensils, Trophy,
  CalendarIcon, ChevronDown, MapPin, Layers, Sparkles,
  CreditCard, Smartphone, Banknote, Receipt, Bike, TrendingUp, Check,
  Filter, X, Flame, Tag, AlertCircle, HelpCircle, Timer, Hourglass, Activity,
  Percent, RotateCcw, Lightbulb,
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
  unknownDateRefunds?: { amount: number; count: number; note?: string }
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

interface OperationsPerformance {
  orderVolume: number
  preparationTime: {
    averageMinutes: number | null
    contributingRecords: number
    startEvent: string
    endEvent: string
  }
  serviceTime: {
    averageMinutes: number | null
    contributingRecords: number
    startEvent: string
    endEvent: string
  }
}

interface DiscountsAndRefundsTrendItem {
  date: string
  label: string
  discounts: number
  refunds: number
}

interface DiscountsAndRefunds {
  totalDiscounts: number
  discountedOrdersCount: number
  totalRefunds: number
  refundedTransactionsCount: number
  unknownDateRefunds?: { amount: number; count: number; note?: string }
  discountsByOrderType: { type: string; amount: number; count: number }[]
  refundsByMethod: { method: string; amount: number; count: number }[]
  trend: DiscountsAndRefundsTrendItem[]
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
  operationsPerformance?: OperationsPerformance
  discountsAndRefunds?: DiscountsAndRefunds
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

function RevenueTrendTooltip({ active, payload, label, currencySymbol = '₹', compDateLabel, isComparisonEnabled = true }: any) {
  if (!active || !payload || !payload.length) return null
  const currentItem = payload.find((p: any) => p.dataKey === 'currentRevenue' || p.dataKey === 'revenue')
  const prevItem = isComparisonEnabled ? payload.find((p: any) => p.dataKey === 'prevRevenue') : null
  const curVal = Number(currentItem?.value ?? 0)
  const prevVal = prevItem ? Number(prevItem.value ?? 0) : null
  const curOrders = currentItem?.payload?.currentOrders
  const prevOrders = prevItem?.payload?.prevOrders
  const periodText = currentItem?.payload?.period || label
  const priorLabel = prevItem?.payload?.prevDate || prevItem?.payload?.prevPeriod || (compDateLabel ? compDateLabel : null)

  let pctChange: number | null = null
  if (isComparisonEnabled && prevVal !== null && prevVal !== undefined) {
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
        {isComparisonEnabled && prevItem && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-slate-400" />
              <span className="text-muted-foreground truncate max-w-[130px]">{priorLabel ? `Prior (${priorLabel}):` : 'Prior:'}</span>
            </div>
            <div className="text-right tabular-nums">
              <span className="font-medium text-muted-foreground">{currencySymbol}{(prevVal ?? 0).toFixed(2)}</span>
              {prevOrders !== undefined && (
                <span className="text-[10px] text-muted-foreground/75 ml-1.5">({prevOrders} {prevOrders === 1 ? 'order' : 'orders'})</span>
              )}
            </div>
          </div>
        )}
        {isComparisonEnabled && pctChange !== null && (
          <div className="flex items-center justify-between pt-1 border-t border-border/30 text-[11px]">
            <span className="text-muted-foreground">vs. Prior Period:</span>
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

function CategoryRevenueTooltip({ active, payload, currencySymbol = '₹', isComparisonEnabled = true }: any) {
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
        {isComparisonEnabled && growth !== undefined && growth !== null && (
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
      const prevStartDay = prevChunk[0]
      const prevEndDay = prevChunk[prevChunk.length - 1]
      const wNum = Math.floor(i / chunkSize) + 1
      const startLabel = startDay?.date ? startDay.date : `Day ${i + 1}`
      const endLabel = endDay?.date ? endDay.date : `Day ${i + curChunk.length}`
      const prevStartLabel = prevStartDay?.date ? prevStartDay.date : ''
      const prevEndLabel = prevEndDay?.date ? prevEndDay.date : ''
      const prevPeriod = prevStartLabel && prevEndLabel
        ? (prevStartLabel === prevEndLabel ? prevStartLabel : `${prevStartLabel} – ${prevEndLabel}`)
        : ''
      const curRev = +curChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2)
      const curOrders = curChunk.reduce((s, c) => s + c.orders, 0)
      const prevRev = +prevChunk.reduce((s, c) => s + c.revenue, 0).toFixed(2)
      const prevOrders = prevChunk.reduce((s, c) => s + c.orders, 0)
      chunks.push({
        key: `w-${wNum}`,
        label: `W${wNum}`,
        period: `Week ${wNum} (${startLabel} – ${endLabel})`,
        prevPeriod: prevPeriod ? `Week ${wNum} (${prevPeriod})` : '',
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
  const [isComparisonEnabled, setIsComparisonEnabled] = useState(true)
  const showRevenueComparison = isComparisonEnabled
  const setShowRevenueComparison = setIsComparisonEnabled
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

  const pm = analytics?.paymentMethods
  const pmTotal = (pm?.cash.amount ?? 0) + (pm?.upi.amount ?? 0) + (pm?.card.amount ?? 0) + (pm?.other?.amount ?? 0)
  const resolvedPaymentTotals = useMemo(() => {
    if (!pm) return { collected: 0, refunds: 0, net: 0 }

    const derivedCollected = pmTotal
    const derivedRefunds =
      (pm.cash?.refunds ?? 0) +
      (pm.upi?.refunds ?? 0) +
      (pm.card?.refunds ?? 0) +
      (pm.other?.refunds ?? 0) +
      (pm.unattributedRefunds?.amount ?? 0)

    const collected =
      pm.totalCollected !== undefined && pm.totalCollected !== null
        ? Number(pm.totalCollected)
        : derivedCollected

    const refunds =
      pm.totalRefunds !== undefined && pm.totalRefunds !== null
        ? Number(pm.totalRefunds)
        : derivedRefunds

    const net =
      pm.totalNet !== undefined && pm.totalNet !== null
        ? Number(pm.totalNet)
        : collected - refunds

    return { collected, refunds, net }
  }, [pm, pmTotal])

  const exportReport = () => {
    if (!analytics || !data) return
    const rows: (string | number)[][] = []
    const push = (...cells: (string | number)[]) => rows.push(cells)
    const blank = () => rows.push([])
    const money = (n: number | undefined | null) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '0.00')

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
      push('Method', 'Transactions', `Collected (${sym})`, `Refunds (${sym})`, `Net Amount (${sym})`)
      const cashNet = analytics.paymentMethods.cash.net !== undefined && analytics.paymentMethods.cash.net !== null
        ? Number(analytics.paymentMethods.cash.net)
        : (analytics.paymentMethods.cash.amount ?? 0) - (analytics.paymentMethods.cash.refunds ?? 0)
      push('Cash', analytics.paymentMethods.cash.count, money(analytics.paymentMethods.cash.amount), money(analytics.paymentMethods.cash.refunds ?? 0), money(cashNet))

      const upiNet = analytics.paymentMethods.upi.net !== undefined && analytics.paymentMethods.upi.net !== null
        ? Number(analytics.paymentMethods.upi.net)
        : (analytics.paymentMethods.upi.amount ?? 0) - (analytics.paymentMethods.upi.refunds ?? 0)
      push('UPI', analytics.paymentMethods.upi.count, money(analytics.paymentMethods.upi.amount), money(analytics.paymentMethods.upi.refunds ?? 0), money(upiNet))

      const cardNet = analytics.paymentMethods.card.net !== undefined && analytics.paymentMethods.card.net !== null
        ? Number(analytics.paymentMethods.card.net)
        : (analytics.paymentMethods.card.amount ?? 0) - (analytics.paymentMethods.card.refunds ?? 0)
      push('Card', analytics.paymentMethods.card.count, money(analytics.paymentMethods.card.amount), money(analytics.paymentMethods.card.refunds ?? 0), money(cardNet))

      if (analytics.paymentMethods.other && (analytics.paymentMethods.other.count > 0 || analytics.paymentMethods.other.amount > 0 || (analytics.paymentMethods.other.refunds ?? 0) > 0)) {
        const otherNet = analytics.paymentMethods.other.net !== undefined && analytics.paymentMethods.other.net !== null
          ? Number(analytics.paymentMethods.other.net)
          : (analytics.paymentMethods.other.amount ?? 0) - (analytics.paymentMethods.other.refunds ?? 0)
        push('Other / Legacy', analytics.paymentMethods.other.count, money(analytics.paymentMethods.other.amount), money(analytics.paymentMethods.other.refunds ?? 0), money(otherNet))
      }
      if (analytics.paymentMethods.unattributedRefunds && analytics.paymentMethods.unattributedRefunds.amount > 0) {
        push('Refunds (Method Unavailable)', analytics.paymentMethods.unattributedRefunds.count, money(0), money(analytics.paymentMethods.unattributedRefunds.amount), money(-analytics.paymentMethods.unattributedRefunds.amount))
      }
      if (analytics.paymentMethods.unknownDateRefunds && analytics.paymentMethods.unknownDateRefunds.count > 0) {
        push('Historical Reversals (Unknown Date - Excluded from Period)', analytics.paymentMethods.unknownDateRefunds.count, money(0), money(analytics.paymentMethods.unknownDateRefunds.amount), money(-analytics.paymentMethods.unknownDateRefunds.amount))
      }
      const totalTx = analytics.paymentMethods.cash.count +
        analytics.paymentMethods.upi.count +
        analytics.paymentMethods.card.count +
        (analytics.paymentMethods.other?.count ?? 0)
      push('Total Reconciled', totalTx, money(analytics.paymentMethods.totalCollected ?? resolvedPaymentTotals.collected), money(analytics.paymentMethods.totalRefunds ?? resolvedPaymentTotals.refunds), money(analytics.paymentMethods.totalNet ?? resolvedPaymentTotals.net))
      blank()
    } else {
      push('Payment Method Breakdown')
      push('Payment reconciliation data unavailable for this period')
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
    push('Table', 'Sessions', `Revenue (${sym})`, `Average Bill (${sym})`)
    for (const t of analytics.topTables ?? []) push(t.name, t.sessionCount ?? t.orders, money(t.revenue), money(t.averageBill ?? t.avgBill ?? 0))
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

  // Determine comparison period date range (use API's actual comparison dates when available)
  let compRangeLabel = ''
  if (analytics?.comparison?.period?.from && analytics?.comparison?.period?.to) {
    const apiPrevFrom = parseISO(analytics.comparison.period.from)
    const apiPrevTo = parseISO(analytics.comparison.period.to)
    compRangeLabel = analytics.comparison.period.from === analytics.comparison.period.to
      ? format(apiPrevFrom, 'd MMM yyyy')
      : `${format(apiPrevFrom, 'd MMM')} – ${format(apiPrevTo, 'd MMM yyyy')}`
  } else {
    const fromDate = range.from ?? new Date()
    const toDate = range.to ?? fromDate
    const daysDiff = Math.max(1, differenceInCalendarDays(toDate, fromDate) + 1)
    const prevTo = subDays(fromDate, 1)
    const prevFrom = subDays(prevTo, daysDiff - 1)
    compRangeLabel = daysDiff === 1
      ? format(prevFrom, 'd MMM yyyy')
      : `${format(prevFrom, 'd MMM')} – ${format(prevTo, 'd MMM yyyy')}`
  }

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
  const rankedCategories = [...rawCategories].map((c) => {
    const rev = c.revenue ?? c.value ?? 0
    const calculatedShare = totalCategoryRev > 0 ? +((rev / totalCategoryRev) * 100).toFixed(1) : 0
    const share = c.share !== undefined && c.share !== null && c.share > 0 ? c.share : calculatedShare
    return {
      ...c,
      revenue: rev,
      value: rev,
      share,
      units: c.units ?? 0,
    }
  }).sort((a, b) => {
    const revA = a.revenue ?? a.value ?? 0
    const revB = b.revenue ?? b.value ?? 0
    return (revB - revA) || a.name.localeCompare(b.name)
  })

  const displayCategories = isComparisonEnabled
    ? rankedCategories
    : rankedCategories.filter((c) => (c.revenue ?? c.value ?? 0) > 0)

  const availableCategories = Array.from(new Set(
    rawCategories.map((c) => c.name).concat(
      (analytics?.topItems ?? []).map((it) => it.category || 'Other')
    )
  )).sort()

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
  const revenueChangeVal = comparison !== undefined && comparison !== null
    ? (comparison.revenueChange ?? null)
    : (analytics?.revenueChange !== undefined && analytics?.revenueChange !== null ? analytics.revenueChange : null)
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
              {analytics?.range?.timezone || 'Asia/Kolkata'}
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

            {/* Previous-period comparison toggle */}
            <button
              type="button"
              role="switch"
              aria-checked={isComparisonEnabled}
              onClick={() => setIsComparisonEnabled((prev) => !prev)}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-xs font-medium transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                isComparisonEnabled
                  ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                  : 'border-border/70 bg-card text-muted-foreground hover:bg-secondary/40'
              )}
              title={isComparisonEnabled ? `Comparing against prior period: ${compRangeLabel}` : 'Comparison disabled. Click to enable'}
            >
              <ArrowLeftRight className={cn('size-3.5 shrink-0 transition-colors', isComparisonEnabled ? 'text-primary' : 'text-muted-foreground/60')} />
              <span className="truncate max-w-[140px] sm:max-w-[190px]">
                {isComparisonEnabled ? <>vs. {compRangeLabel}</> : 'Compare: Off'}
              </span>
            </button>

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
            </div>
          </div>

          {/* Cards in EXACT audited order: 1. Revenue, 2. Completed Orders, 3. Average Order Value, 4. Net Sales */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <FinancialKpiCard
              icon={IndianRupee}
              label="Revenue"
              value={totalRevFormatted}
              subtext="Gross settled collections (incl. taxes & charges)"
              comparisonDateLabel={compRangeLabel}
              change={revenueChangeVal}
              accent="coral"
              loading={loading}
              hasError={hasError}
              isEmpty={isEmptyPeriod}
              isRealZero={isRealZeroRev}
              isComparisonEnabled={isComparisonEnabled}
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
              isComparisonEnabled={isComparisonEnabled}
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
              isComparisonEnabled={isComparisonEnabled}
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
              isComparisonEnabled={isComparisonEnabled}
            />
          </div>
        </section>

        {/* Row 2: Revenue Trend (2 cols) + Order Types Donut (1 col) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Section 2: Revenue Trend */}
          <Card id="section-revenue-trend" className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                    <TrendingUp className="size-4 text-primary" />
                    Revenue Trend
                  </h3>
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
                      role="switch"
                      aria-checked={showRevenueComparison}
                      onClick={() => setShowRevenueComparison((prev) => !prev)}
                      className={cn(
                        'flex items-center gap-1 text-[11px] h-7 px-2 rounded-lg border font-medium transition-colors cursor-pointer',
                        showRevenueComparison
                          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                          : 'border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground'
                      )}
                      title={showRevenueComparison ? `Toggle comparison with prior period: ${compRangeLabel}` : 'Enable comparison'}
                    >
                      <ArrowLeftRight className="size-3" />
                      <span>{showRevenueComparison ? 'vs. Prior' : 'Compare: Off'}</span>
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
                  <ComposedChart data={groupedRevenueData} margin={{ top: 8, right: 12, bottom: 0, left: -16 }}>
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
                    <Tooltip content={<RevenueTrendTooltip currencySymbol={sym} compDateLabel={compRangeLabel} isComparisonEnabled={isComparisonEnabled} />} />
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
                  </ComposedChart>
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
        <Card id="section-sales-by-hour" className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
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
                  <span>Peak: —</span>
                </div>
              )}
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
                  {itemViewMode === 'least' && includeZeroSaleItems && (
                    <p className="text-[11px] text-muted-foreground">
                      Including zero-sale items
                    </p>
                  )}
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
                      Revenue
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

              {/* Active Filter Pill Bar */}
              {selectedCategoryFilter !== 'ALL' && (
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2 text-[10px]">
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
                </div>
              )}

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
          <Card id="section-revenue-by-category" className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <div>
                  <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                    <Layers className="size-4 text-primary" />
                    <span>Revenue by Category</span>
                  </h3>
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
              ) : displayCategories.length === 0 ? (
                <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
                  No category data available
                </div>
              ) : (
                <div className="h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={displayCategories} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: AXIS, fontSize: 10 }} axisLine={false} tickLine={false} />
                      <YAxis
                        tick={{ fill: AXIS, fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
                      />
                      <Tooltip content={<CategoryRevenueTooltip currencySymbol={sym} isComparisonEnabled={isComparisonEnabled} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                      <Bar dataKey="value" name="Revenue" radius={[4, 4, 0, 0]} barSize={22}>
                        {displayCategories.map((_, i) => (
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
                  {isComparisonEnabled && <span>vs Prior</span>}
                </div>
              </div>

              <div className="max-h-[220px] overflow-y-auto scrollbar-thin space-y-1">
                {displayCategories.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">No category data</p>
                ) : (
                  displayCategories.map((c, i) => {
                    const isSelected = selectedCategoryFilter === c.name
                    const hasValidGrowth = isComparisonEnabled && c.growth !== undefined && c.growth !== null
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
                          {isComparisonEnabled && (
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
                          )}
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
            </div>
            {/* Quick summary totals */}
            <div className="flex items-center gap-3 text-xs bg-secondary/30 px-3 py-1.5 rounded-lg border border-border/40">
              <div>
                <span className="text-[10px] text-muted-foreground block">Total Collected</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {!pm ? '—' : `${sym}${resolvedPaymentTotals.collected.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </span>
              </div>
              <div className="h-6 w-px bg-border/60" />
              <div>
                <span className="text-[10px] text-muted-foreground block">Refunds</span>
                <span className="font-semibold tabular-nums text-red-500">
                  {!pm ? '—' : (resolvedPaymentTotals.refunds > 0 ? `-${sym}${resolvedPaymentTotals.refunds.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`)}
                </span>
              </div>
              <div className="h-6 w-px bg-border/60" />
              <div>
                <span className="text-[10px] text-muted-foreground block">Net Settled</span>
                <span className={cn('font-semibold tabular-nums', !pm ? 'text-muted-foreground' : resolvedPaymentTotals.net < 0 ? 'text-red-500' : 'text-emerald-500')}>
                  {!pm ? '—' : (resolvedPaymentTotals.net < 0
                    ? `-${sym}${Math.abs(resolvedPaymentTotals.net).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : `${sym}${resolvedPaymentTotals.net.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}
                </span>
              </div>
            </div>
          </div>

          {!pm ? (
            <div className="py-8 text-center text-xs text-muted-foreground border border-dashed border-border/60 rounded-lg">
              <AlertCircle className="size-5 mx-auto mb-1.5 text-muted-foreground/60" />
              <p className="font-medium text-foreground">Payment reconciliation data unavailable</p>
              <p className="text-[10px] text-muted-foreground/75 mt-0.5">Could not load payment ledger records for this period</p>
            </div>
          ) : (
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
                      {(pm?.cash?.refunds ?? 0) > 0 ? `-${sym}${(pm?.cash?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`}
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
                      {(pm?.upi?.refunds ?? 0) > 0 ? `-${sym}${(pm?.upi?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`}
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
                      {(pm?.card?.refunds ?? 0) > 0 ? `-${sym}${(pm?.card?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`}
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
                        {(pm?.other?.refunds ?? 0) > 0 ? `-${sym}${(pm?.other?.refunds ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`}
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
                  {/* Total Footer */}
                  <tr className="border-t-2 border-border/80 font-semibold bg-secondary/15">
                    <td className="py-2.5 px-3 text-foreground">Total</td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-foreground">
                      {(pm?.cash?.count ?? 0) + (pm?.upi?.count ?? 0) + (pm?.card?.count ?? 0) + (pm?.other?.count ?? 0)}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-foreground">
                      {sym}{resolvedPaymentTotals.collected.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-right py-2.5 px-3 tabular-nums text-red-500">
                      {resolvedPaymentTotals.refunds > 0 ? `-${sym}${resolvedPaymentTotals.refunds.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`}
                    </td>
                    <td className={cn('text-right py-2.5 px-3 tabular-nums font-bold', resolvedPaymentTotals.net < 0 ? 'text-red-500' : 'text-emerald-500')}>
                      {resolvedPaymentTotals.net < 0
                        ? `-${sym}${Math.abs(resolvedPaymentTotals.net).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : `${sym}${resolvedPaymentTotals.net.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {Boolean((pm?.unknownDateRefunds?.count ?? 0) > 0) && (
            <div className="mt-3 flex items-center justify-between text-xs px-3 py-2 rounded-md bg-secondary/30 border border-border/40 text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <AlertCircle className="size-3.5 text-amber-500" />
                <span>{pm?.unknownDateRefunds?.count} historical reversals ({sym}{(pm?.unknownDateRefunds?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) with unverified dates excluded from dated totals.</span>
              </div>
            </div>
          )}
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
                  Ranked by settled revenue
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
                No table sessions for these dates.
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

        {/* Row 7: Section 9 - Operations Performance */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                <Activity className="size-4 text-emerald-500" />
                Operations Performance
              </h3>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 1. Preparation Time */}
            <div className="p-3.5 rounded-lg bg-secondary/25 border border-border/50 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Timer className="size-3.5 text-blue-500" />
                    Average Preparation Time
                  </span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {loading ? '—' : analytics?.operationsPerformance?.preparationTime?.averageMinutes != null ? `${analytics.operationsPerformance.preparationTime.averageMinutes}` : '—'}
                  </span>
                  {analytics?.operationsPerformance?.preparationTime?.averageMinutes != null && (
                    <span className="text-xs text-muted-foreground">mins</span>
                  )}
                </div>
              </div>
              <div className="mt-3 pt-2.5 border-t border-border/40 text-[11px] text-muted-foreground">
                From order placed to completed
              </div>
            </div>

            {/* 2. Service Time */}
            <div className="p-3.5 rounded-lg bg-secondary/25 border border-border/50 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Hourglass className="size-3.5 text-purple-500" />
                    Average Dine-in Duration
                  </span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {loading ? '—' : analytics?.operationsPerformance?.serviceTime?.averageMinutes != null ? `${analytics.operationsPerformance.serviceTime.averageMinutes}` : '—'}
                  </span>
                  {analytics?.operationsPerformance?.serviceTime?.averageMinutes != null && (
                    <span className="text-xs text-muted-foreground">mins</span>
                  )}
                </div>
              </div>
              <div className="mt-3 pt-2.5 border-t border-border/40 text-[11px] text-muted-foreground">
                From check opened to closed
              </div>
            </div>

            {/* 3. Order Volume */}
            <div className="p-3.5 rounded-lg bg-secondary/25 border border-border/50 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <ClipboardList className="size-3.5 text-amber-500" />
                    Settled Orders
                  </span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-1.5">
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {loading ? '—' : (analytics?.operationsPerformance?.orderVolume ?? analytics?.totalOrders ?? 0).toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">orders</span>
                </div>
              </div>
              <div className="mt-3 pt-2.5 border-t border-border/40 text-[11px] text-muted-foreground">
                Orders settled in this period
              </div>
            </div>
          </div>
        </Card>

        {/* Row 8: Section 10 - Discounts & Refunds */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <div>
              <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                <Percent className="size-4 text-rose-500" />
                Discounts & Refunds
              </h3>
            </div>
            {/* Quick summary totals */}
            <div className="flex items-center gap-3 text-xs bg-secondary/30 px-3 py-1.5 rounded-lg border border-border/40">
              <div>
                <span className="text-[10px] text-muted-foreground block">Total Discounts</span>
                <span className="font-semibold tabular-nums text-rose-500">
                  {sym}{(analytics?.discountsAndRefunds?.totalDiscounts ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="h-6 w-px bg-border/60" />
              <div>
                <span className="text-[10px] text-muted-foreground block">Total Refunds</span>
                <span className="font-semibold tabular-nums text-red-500">
                  {sym}{(analytics?.discountsAndRefunds?.totalRefunds ?? (analytics?.paymentMethods?.totalRefunds ?? 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Detail Breakdown Tables */}
            <div className="space-y-4">
              {/* Discounts Detail */}
              <div className="rounded-lg border border-border/50 bg-secondary/20 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Tag className="size-3.5 text-rose-400" />
                    Discounts by Channel
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {analytics?.discountsAndRefunds?.discountedOrdersCount ?? 0} orders affected
                  </span>
                </div>
                <div className="space-y-1.5 text-xs">
                  {(analytics?.discountsAndRefunds?.discountsByOrderType ?? []).map((d) => (
                    <div key={d.type} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                      <span className="text-muted-foreground">{TYPE_LABEL[d.type] || d.type}</span>
                      <div className="text-right tabular-nums">
                        <span className="font-medium text-foreground">{sym}{d.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <span className="text-[10px] text-muted-foreground ml-1.5">({d.count} orders)</span>
                      </div>
                    </div>
                  ))}
                  {(analytics?.discountsAndRefunds?.discountsByOrderType ?? []).length === 0 && (
                    <div className="text-xs text-muted-foreground/60 py-2 text-center">No discounts applied in this period</div>
                  )}
                </div>
              </div>

              {/* Refunds Detail */}
              <div className="rounded-lg border border-border/50 bg-secondary/20 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <RotateCcw className="size-3.5 text-red-400" />
                    Refunds by Payment Method
                  </span>
                </div>
                <div className="space-y-1.5 text-xs">
                  {(analytics?.discountsAndRefunds?.refundsByMethod ?? []).map((r) => (
                    <div key={r.method} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                      <span className="text-muted-foreground">{r.method}</span>
                      <div className="text-right tabular-nums">
                        <span className="font-medium text-red-400">
                          {r.amount > 0 ? `-${sym}${r.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${sym}0.00`}
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-1.5">({r.count})</span>
                      </div>
                    </div>
                  ))}
                  {(analytics?.discountsAndRefunds?.refundsByMethod ?? []).length === 0 && (
                    <div className="text-xs text-muted-foreground/60 py-2 text-center">No refunds recorded in this period</div>
                  )}
                  {Boolean((analytics?.discountsAndRefunds?.unknownDateRefunds?.count ?? 0) > 0) && (
                    <div className="mt-2 text-[11px] text-amber-500/90 flex items-center gap-1.5 pt-1 border-t border-border/30">
                      <AlertCircle className="size-3" />
                      <span>{analytics?.discountsAndRefunds?.unknownDateRefunds?.count} historical reversals ({sym}{(analytics?.discountsAndRefunds?.unknownDateRefunds?.amount ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) with unverified dates excluded from period totals.</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Daily Trend of Discounts & Refunds */}
            <div className="rounded-lg border border-border/50 bg-secondary/20 p-3 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <TrendingUp className="size-3.5 text-blue-400" />
                    Daily Trend
                  </span>
                  <div className="flex items-center gap-3 text-[10px]">
                    <span className="flex items-center gap-1 text-rose-400">
                      <span className="size-2 rounded-full bg-rose-400" /> Discounts
                    </span>
                    <span className="flex items-center gap-1 text-red-400">
                      <span className="size-2 rounded-full bg-red-400" /> Refunds
                    </span>
                  </div>
                </div>
                <div className="h-[140px] w-full mt-2">
                  {analytics?.discountsAndRefunds?.trend && analytics.discountsAndRefunds.trend.some((t) => (t.discounts ?? 0) > 0 || (t.refunds ?? 0) > 0) ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={analytics.discountsAndRefunds.trend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" opacity={0.15} vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
                        <Tooltip content={<ChartTooltip currencySymbol={sym} />} />
                        <Bar dataKey="discounts" name="Discounts" fill="#fb7185" radius={[2, 2, 0, 0]} />
                        <Bar dataKey="refunds" name="Refunds" fill="#f87171" radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground border border-dashed border-border/60 rounded-md">
                      No discounts or refunds for these dates
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* Row 9: Section 11 - Business Insights */}
        <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold tracking-tight flex items-center gap-1.5">
                <Lightbulb className="size-4 text-amber-500" />
                Business Insights
              </h3>
            </div>
            <Sparkles className="size-4 text-amber-500/70" />
          </div>

          {(() => {
            const insights: {
              id: string
              title: string
              observation: string
              badge: string
              dateRange: string
              targetSectionId: string
              targetSectionName: string
            }[] = []

            // Observation 1: Busiest Hour
            if (activePeakHour && (activePeakHour.orders > 0 || activePeakHour.revenue > 0)) {
              insights.push({
                id: 'busiest-hour',
                title: 'Peak Order Velocity',
                observation: `Busiest hour was ${activePeakHour.hourSpan} generating ${sym}${activePeakHour.revenue.toFixed(2)} across ${activePeakHour.orders} settled ${activePeakHour.orders === 1 ? 'order' : 'orders'}.`,
                badge: `${activePeakHour.orders} orders / hr`,
                dateRange: rangeLabel,
                targetSectionId: 'section-sales-by-hour',
                targetSectionName: 'Sales by Hour',
              })
            }

            // Observation 2: Highest-Revenue Category
            const topCat = rankedCategories.length > 0 ? rankedCategories[0] : null
            if (topCat && (topCat.revenue ?? topCat.value) > 0) {
              const catRev = topCat.revenue ?? topCat.value
              const topCatShare = topCat.share !== undefined && topCat.share !== null && topCat.share > 0
                ? topCat.share
                : (totalCategoryRev > 0 ? +((catRev / totalCategoryRev) * 100).toFixed(1) : 0)
              insights.push({
                id: 'top-category',
                title: 'Top Category',
                observation: `${topCat.name} leads total catalog sales with ${sym}${catRev.toFixed(2)} (${topCatShare}% share).`,
                badge: `${topCatShare}% catalog share`,
                dateRange: rangeLabel,
                targetSectionId: 'section-revenue-by-category',
                targetSectionName: 'Revenue by Category',
              })
            }

            // Observation 3: Sales change vs. previous period (suppressed when comparison data is missing/insufficient or comparison is disabled)
            if (
              isComparisonEnabled &&
              analytics?.comparison?.previous &&
              analytics.comparison.previous.revenue > 0 &&
              analytics.comparison.revenueChange !== null &&
              analytics.comparison.revenueChange !== undefined &&
              Math.abs(analytics.comparison.revenueChange) >= 0.1
            ) {
              const changeVal = analytics.comparison.revenueChange
              const isIncrease = changeVal > 0
              insights.push({
                id: 'period-comparison',
                title: isIncrease ? 'Growth Momentum' : 'Sales Adjustment',
                observation: `Settled revenue shifted by ${isIncrease ? '+' : ''}${changeVal.toFixed(1)}% (${sym}${analytics.totalRevenue.toFixed(2)} vs. ${sym}${analytics.comparison.previous.revenue.toFixed(2)}) compared to the preceding period.`,
                badge: `${isIncrease ? '+' : ''}${changeVal.toFixed(1)}% vs. prior`,
                dateRange: `${rangeLabel} vs. ${compRangeLabel}`,
                targetSectionId: 'section-revenue-trend',
                targetSectionName: 'Revenue Trend',
              })
            }

            if (loading) {
              return (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-24 rounded-lg bg-secondary/30 animate-pulse" />
                  ))}
                </div>
              )
            }

            if (insights.length === 0) {
              return (
                <div className="flex h-20 items-center justify-center text-xs text-muted-foreground border border-dashed border-border/60 rounded-lg">
                  Insufficient data in current scope to formulate business observations.
                </div>
              )
            }

            return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {insights.map((ins) => (
                  <div
                    key={ins.id}
                    className="p-3 rounded-lg bg-secondary/25 border border-border/50 flex flex-col justify-between hover:border-border transition-colors text-xs"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-1.5">
                        <span className="font-semibold text-foreground text-xs">{ins.title}</span>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
                          {ins.badge}
                        </span>
                      </div>
                      <p className="text-muted-foreground leading-relaxed text-[11px]">{ins.observation}</p>
                    </div>

                    <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between text-[10px]">
                      <span className="text-muted-foreground/75 truncate max-w-[130px]">{ins.dateRange}</span>
                      <a
                        href={`#${ins.targetSectionId}`}
                        onClick={(e) => {
                          e.preventDefault()
                          const el = document.getElementById(ins.targetSectionId)
                          el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        }}
                        className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                      >
                        {ins.targetSectionName}
                        <ArrowUpRight className="size-2.5" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
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
  isComparisonEnabled = true,
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
  isComparisonEnabled?: boolean
}) {
  const accents: Record<string, string> = {
    coral: 'bg-primary/10 text-primary border-primary/20',
    green: 'bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border-emerald-500/20',
    amber: 'bg-amber-500/10 text-amber-500 dark:text-amber-400 border-amber-500/20',
    blue: 'bg-blue-500/10 text-blue-500 dark:text-blue-400 border-blue-500/20',
  }

  const hasValidChange = isComparisonEnabled && !loading && !hasError && change !== undefined && change !== null && !Number.isNaN(change)
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
          ) : !isComparisonEnabled ? (
            null
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
            {isComparisonEnabled && comparisonDateLabel && (
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
