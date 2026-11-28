'use client'

import { cn } from '@/lib/utils'

export interface DailyRevenue {
  date: string
  label: string
  revenue: number
  orders: number
}

export interface TopItem {
  name: string
  qty: number
  revenue: number
}

export interface DetailedItem {
  menuItemId: string | null
  name: string
  category: string
  qty: number
  revenue: number
}

export interface TypeBreak {
  type: string
  count: number
  revenue: number
  share?: number
  avgOrder?: number
}

export interface TopTable {
  tableId?: string
  name: string
  orders: number
  sessions?: number
  revenue: number
  avgBill?: number
}

export interface CatBreak {
  name: string
  value: number
  units?: number
  share?: number
  prevValue?: number | null
  growthPct?: number | null
}

export interface HourlyDetailed {
  hour: number
  label: string
  displayHour: string
  orders: number
  revenue: number
}

export interface LocationOption {
  id: string
  name: string
  isPrimary: boolean
}

export interface PaymentBucket {
  amount: number
  count: number
  refunds?: number
  refundCount?: number
  net?: number
}

export interface PaymentMethodSummary {
  cash: PaymentBucket
  upi: PaymentBucket
  card: PaymentBucket
  other?: PaymentBucket
  unattributedRefunds?: { amount: number; count: number }
  totalCollected?: number
  totalRefunds?: number
  totalNet?: number
  total: number
}

export interface OperationsSummary {
  orderVolume: number
  prepTime: {
    available: boolean
    reason?: string
  }
  serviceTime: {
    available: boolean
    startEvent: string
    endEvent: string
    avgMinutes: number | null
    medianMinutes: number | null
    sampleCount: number
    excludedCount: number
  }
}

export interface DiscountsAndRefundsSummary {
  totalDiscounts: number
  discountedOrders: number
  discountBreakdown: { code: string; count: number; amount: number }[]
  totalRefunds: number
  refundCount: number
  refundBreakdown: { method: string; count: number; amount: number }[]
  trend: {
    date: string
    label: string
    discounts: number
    discountCount: number
    refunds: number
    refundCount: number
  }[]
}

export interface PreviousPeriodSummary {
  from: string
  to: string
  days: number
  totalRevenue: number
  totalOrders: number
  avgOrder: number
  netSales: number
  dailyRevenue: DailyRevenue[]
}

export interface AnalyticsPayload {
  range?: { from: string; to: string; days: number; timezone: string }
  previousPeriod?: PreviousPeriodSummary | null
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
  allItems?: DetailedItem[]
  zeroSaleItems?: DetailedItem[]
  typeBreakdown: TypeBreak[]
  topTables: TopTable[]
  hourly: number[]
  hourlyDetailed?: HourlyDetailed[]
  advanced?: boolean
  categoryBreakdown: CatBreak[]
  paymentMethods?: PaymentMethodSummary
  operations?: OperationsSummary | null
  discountsAndRefunds?: DiscountsAndRefundsSummary
  locations?: LocationOption[]
  multiLocationEnabled?: boolean
}

export const COLORS = ['#f97316', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899']
export const CORAL = '#f97316'
export const PREV_LINE = '#64748b'
export const AXIS = '#94a3b8'

export const TYPE_LABEL: Record<string, string> = {
  DINE_IN: 'Dine-in',
  TAKEAWAY: 'Takeaway',
  DELIVERY: 'Delivery',
}

export function formatINR(value: number, sym = '₹', decimals = 2): string {
  const num = Number(value) || 0
  return `${sym}${num.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`
}

export function calcPctChange(current: number, previous: number | undefined | null): number | null {
  if (previous === undefined || previous === null || previous <= 0) return null
  return +(((current - previous) / previous) * 100).toFixed(1)
}

export function ChartTooltip({ active, payload, label, currencySymbol = '₹' }: any) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="bg-popover/95 backdrop-blur-md border border-border rounded-xl p-3 text-xs shadow-lg max-w-[260px]">
      {label != null && <p className="font-semibold text-foreground mb-1.5">{label}</p>}
      <div className="space-y-1">
        {payload.map((p: any, i: number) => {
          const nameLower = String(p.name || '').toLowerCase()
          const isCurrency =
            p.dataKey === 'revenue' ||
            p.dataKey === 'prevRevenue' ||
            p.dataKey === 'value' ||
            p.dataKey === 'discounts' ||
            p.dataKey === 'refunds' ||
            nameLower.includes('revenue') ||
            nameLower.includes('avg') ||
            nameLower.includes('previous') ||
            nameLower.includes('discount') ||
            nameLower.includes('refund')
          const formattedVal = isCurrency
            ? formatINR(Number(p.value) || 0, currencySymbol)
            : Number(p.value ?? 0).toLocaleString('en-IN')
          return (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: p.color || p.fill }}
                />
                <span className="text-muted-foreground truncate">{p.name}:</span>
              </div>
              <span className="font-semibold tabular-nums text-foreground">{formattedVal}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ChartSkeleton({ className }: { className?: string }) {
  return <div className={cn('w-full rounded-xl bg-secondary/40 animate-pulse', className)} />
}

export function SectionEmpty({
  icon: Icon,
  message,
  className = 'h-[180px]',
}: {
  icon?: any
  message: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-xs text-muted-foreground gap-2', className)}>
      {Icon && <Icon className="size-5 opacity-40" />}
      <span>{message}</span>
    </div>
  )
}
