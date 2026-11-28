'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useApp, type AppData } from '@/components/app/data-context'
import { edgeFetch } from '@/lib/edge'
import { failIfNotOk } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { AccessDenied } from '@/components/shared/access-denied'
import { cn } from '@/lib/utils'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { useMediaQuery } from '@/lib/use-media-query'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { DateRange } from 'react-day-picker'
import { format, startOfMonth, subDays } from 'date-fns'
import {
  Download,
  CalendarIcon,
  ChevronDown,
  MapPin,
  Sparkles,
  GitCompare,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'

import { AnalyticsPayload } from './analytics/types'
import { FinancialOverview } from './analytics/financial-overview'
import { RevenueAndChannels } from './analytics/revenue-and-channels'
import { ItemsAndCategories } from './analytics/items-and-categories'
import { PaymentsAndTables } from './analytics/payments-and-tables'
import { OperationsDiscountsInsights } from './analytics/operations-discounts-insights'

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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [range, setRange] = useState<DateRange>(() => {
    const today = new Date()
    return { from: today, to: today }
  })
  const [rangeOpen, setRangeOpen] = useState(false)
  const [selectedLocationId, setSelectedLocationId] = useState<string>('')
  const [locationOpen, setLocationOpen] = useState(false)
  const [compareEnabled, setCompareEnabled] = useState(true)
  const { scrollRef } = useScrollCollapse()
  const isCompact = useMediaQuery('(max-width: 1023px)')

  const tenantId = data?.tenant?.id
  const requestSeq = useRef(0)
  const activeSkeletonSeq = useRef<number | null>(null)
  const activeFilters = useRef({ from: '', to: '', locationId: '', compare: true })
  const lastOrderBook = useRef<AppData['orders'] | null>(null)
  const bgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchAnalytics = useCallback(
    async (mode: 'skeleton' | 'silent') => {
      if (!tenantId) return
      const from = range.from ? format(range.from, 'yyyy-MM-dd') : ''
      const to = range.to ? format(range.to, 'yyyy-MM-dd') : from
      const locationId = selectedLocationId || ''
      const seq = ++requestSeq.current

      activeFilters.current = { from, to, locationId, compare: compareEnabled }
      if (mode === 'skeleton') {
        activeSkeletonSeq.current = seq
        setLoading(true)
        setLoadError(null)
      }

      let isFilterActive = false
      try {
        const locQuery = locationId ? `&location_id=${locationId}` : ''
        const cmpQuery = compareEnabled ? '&compare=1' : '&compare=0'
        const res = await edgeFetch(`/api/analytics?from=${from}&to=${to}${locQuery}${cmpQuery}`, {
          headers: { 'x-tenant-id': tenantId },
        })
        await failIfNotOk(res, 'analytics')
        const json = await res.json()

        isFilterActive =
          activeFilters.current.from === from &&
          activeFilters.current.to === to &&
          activeFilters.current.locationId === locationId &&
          activeFilters.current.compare === compareEnabled

        if (!isFilterActive || seq < requestSeq.current) return

        setAnalytics(json)
        setLoadError(null)
        setDenied(null)
      } catch (err: any) {
        isFilterActive =
          activeFilters.current.from === from &&
          activeFilters.current.to === to &&
          activeFilters.current.locationId === locationId &&
          activeFilters.current.compare === compareEnabled
        if (!isFilterActive || seq < requestSeq.current) return

        if (mode === 'skeleton') {
          setLoadError(err?.message || 'Failed to load analytics data')
          handleLoad(err, 'analytics')
        } else {
          handleLoadQuiet(err, 'analytics')
        }
      } finally {
        if (activeSkeletonSeq.current !== null && seq >= activeSkeletonSeq.current) {
          activeSkeletonSeq.current = null
          setLoading(false)
        }
      }
    },
    [tenantId, range, selectedLocationId, compareEnabled, handleLoad, handleLoadQuiet, setDenied]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load fetches analytics with skeleton
    fetchAnalytics('skeleton')
  }, [fetchAnalytics])

  useEffect(() => {
    const orders = data?.orders
    if (!orders) return
    if (lastOrderBook.current === null) {
      lastOrderBook.current = orders
      return
    }
    if (orders === lastOrderBook.current) return
    lastOrderBook.current = orders

    if (bgTimer.current) clearTimeout(bgTimer.current)
    bgTimer.current = setTimeout(() => {
      fetchAnalytics('silent')
    }, 350)
  }, [data?.orders, fetchAnalytics])

  useEffect(() => () => {
    if (bgTimer.current) clearTimeout(bgTimer.current)
  }, [])

  const sym =
    data?.tenant?.currencySymbol && data.tenant.currencySymbol !== '$'
      ? data.tenant.currencySymbol
      : '₹'

  const exportReport = () => {
    if (!analytics || !data) return
    const rows: (string | number)[][] = []
    const push = (...cells: (string | number)[]) => rows.push(cells)
    const blank = () => rows.push([])
    const money = (n: number) => n.toFixed(2)

    const selectedLoc = (analytics.locations ?? []).find((l) => l.id === selectedLocationId)

    push('Restrofi Analytics V2 Report')
    push('Restaurant', data.tenant.name)
    push('Location', selectedLoc ? selectedLoc.name : 'All Locations')
    push('From', analytics.range?.from ?? '')
    push('To', analytics.range?.to ?? '')
    push('Timezone', analytics.range?.timezone ?? 'Asia/Kolkata')
    push('Generated', new Date().toLocaleString())
    blank()

    push('Financial Overview')
    push('Metric', `Value (${sym})`)
    push('Revenue', money(analytics.totalRevenue))
    push('Completed Orders', analytics.totalOrders)
    push('Average Order Value', money(analytics.avgOrder))
    push('Net Sales', money(analytics.netSales ?? 0))
    push('Tax Collected (GST)', money(analytics.taxCollected ?? 0))
    if (analytics.serviceChargeCollected) {
      push('Service Charge Collected', money(analytics.serviceChargeCollected))
    }
    blank()

    if (analytics.paymentMethods) {
      const pm = analytics.paymentMethods
      push('Payment Method Breakdown')
      push('Method', 'Transactions', `Collected (${sym})`, `Refunds (${sym})`, `Net (${sym})`)
      push('Cash', pm.cash.count, money(pm.cash.amount), money(pm.cash.refunds ?? 0), money(pm.cash.net ?? pm.cash.amount))
      push('UPI', pm.upi.count, money(pm.upi.amount), money(pm.upi.refunds ?? 0), money(pm.upi.net ?? pm.upi.amount))
      push('Card', pm.card.count, money(pm.card.amount), money(pm.card.refunds ?? 0), money(pm.card.net ?? pm.card.amount))
      if (pm.other && pm.other.count > 0) {
        push('Other / Legacy', pm.other.count, money(pm.other.amount), money(pm.other.refunds ?? 0), money(pm.other.net ?? pm.other.amount))
      }
      if (pm.unattributedRefunds && pm.unattributedRefunds.count > 0) {
        push('Refunds (Method Unavailable)', pm.unattributedRefunds.count, '0.00', money(pm.unattributedRefunds.amount), money(-pm.unattributedRefunds.amount))
      }
      blank()
    }

    push('Daily Revenue')
    push('Date', 'Day', `Revenue (${sym})`, 'Orders')
    for (const d of analytics.dailyRevenue ?? []) push(d.date, d.label, money(d.revenue), d.orders)
    blank()

    push('Order Types')
    push('Type', 'Orders', `Revenue (${sym})`, 'Share (%)', `AOV (${sym})`)
    for (const t of analytics.typeBreakdown ?? []) {
      push(t.type, t.count, money(t.revenue), t.share ?? 0, money(t.avgOrder ?? 0))
    }
    blank()

    push('Top Selling Items')
    push('Item', 'Category', 'Units', `Revenue (${sym})`)
    for (const it of analytics.allItems ?? analytics.topItems ?? []) {
      push(it.name, (it as any).category ?? 'Other', it.qty, money(it.revenue))
    }
    blank()

    push('Top Tables')
    push('Table', 'Sessions', `Avg Bill (${sym})`, `Revenue (${sym})`)
    for (const t of analytics.topTables ?? []) {
      push(t.name, t.sessions ?? t.orders, money(t.avgBill ?? 0), money(t.revenue))
    }

    const esc = (v: string | number) => {
      const str = String(v ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    const locSlug = selectedLoc ? `${selectedLoc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_` : ''
    link.download = `restrofi-analytics_${locSlug}${analytics.range?.from ?? 'from'}_to_${analytics.range?.to ?? 'to'}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success('Report downloaded', {
      description: `${analytics.totalOrders} orders · ${sym}${money(analytics.totalRevenue)}`,
    })
  }

  if (!data) return null
  if (denied) return <AccessDenied failure={denied} onRetry={() => fetchAnalytics('skeleton')} view="analytics" />

  const rangeLabel = range.from
    ? range.to && format(range.from, 'yyyy-MM-dd') !== format(range.to, 'yyyy-MM-dd')
      ? `${format(range.from, 'd MMM')} – ${format(range.to, 'd MMM yyyy')}`
      : format(range.from, 'd MMM yyyy')
    : 'Select dates'

  const locations = analytics?.locations ?? []
  const hasMultipleLocations = locations.length > 1
  const selectedLocation = locations.find((l) => l.id === selectedLocationId)

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Shared Sticky Header: Date Range, Comparison Toggle, Location Selector, Export */}
      <header className="px-3.5 md:px-6 py-2.5 border-b border-border/60 bg-card/60 backdrop-blur-md sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2.5 flex-wrap">
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
              <Sparkles className="size-3.5 text-primary" />
              <span>Analytics V2</span>
            </span>
            <span className="hidden sm:inline opacity-40">·</span>
            <span className="truncate hidden sm:inline text-[11px] text-muted-foreground">
              Settled collections · {analytics?.range?.timezone || 'Asia/Kolkata'}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap ml-auto">
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

            <Button
              type="button"
              variant={compareEnabled ? 'secondary' : 'outline'}
              size="sm"
              className="h-8 gap-1.5 text-xs border-border/70"
              onClick={() => setCompareEnabled((v) => !v)}
              title="Toggle previous-period comparison"
            >
              <GitCompare className="size-3.5 text-primary" />
              <span className="hidden sm:inline">Compare</span>
            </Button>

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
                  <div
                    className={cn(
                      'shrink-0 p-2 border-border',
                      isCompact
                        ? 'grid grid-cols-3 gap-1 border-b'
                        : 'flex flex-col w-[136px] gap-1 border-b-0 border-r'
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

      {/* Main Scrollable Content: Sections 1 -> 11 in exact display order */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pt-3 pb-8 space-y-4">
        {loadError && !loading && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-600 dark:text-red-400">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              <span>{loadError}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => fetchAnalytics('skeleton')}
            >
              <RefreshCw className="size-3 mr-1" /> Retry
            </Button>
          </div>
        )}

        {/* 1. Financial Overview */}
        <FinancialOverview
          analytics={analytics}
          loading={loading}
          compareEnabled={compareEnabled}
          sym={sym}
        />

        {/* 2. Revenue Trend, 3. Order Types, 4. Sales by Hour */}
        <RevenueAndChannels
          analytics={analytics}
          loading={loading}
          compareEnabled={compareEnabled}
          rangeLabel={rangeLabel}
          sym={sym}
        />

        {/* 5. Top Selling Items, 6. Revenue by Category */}
        <ItemsAndCategories
          analytics={analytics}
          loading={loading}
          compareEnabled={compareEnabled}
          sym={sym}
        />

        {/* 7. Payment Method Breakdown, 8. Top Tables */}
        <PaymentsAndTables
          analytics={analytics}
          loading={loading}
          sym={sym}
        />

        {/* 9. Operations Performance, 10. Discounts & Refunds, 11. Business Insights */}
        <OperationsDiscountsInsights
          analytics={analytics}
          loading={loading}
          compareEnabled={compareEnabled}
          sym={sym}
        />
      </div>
    </div>
  )
}
