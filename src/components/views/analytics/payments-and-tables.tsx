'use client'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { CreditCard, Banknote, Smartphone, Receipt, Trophy, AlertCircle } from 'lucide-react'
import { AnalyticsPayload, ChartSkeleton, SectionEmpty, formatINR } from './types'

interface PaymentsAndTablesProps {
  analytics: AnalyticsPayload | null
  loading: boolean
  sym: string
}

export function PaymentsAndTables({ analytics, loading, sym }: PaymentsAndTablesProps) {
  const pm = analytics?.paymentMethods
  const totalCollected =
    pm?.totalCollected ??
    (pm?.cash.amount ?? 0) + (pm?.upi.amount ?? 0) + (pm?.card.amount ?? 0) + (pm?.other?.amount ?? 0)
  const totalRefunds = pm?.totalRefunds ?? 0
  const totalNet = pm?.totalNet ?? +(totalCollected - totalRefunds).toFixed(2)

  const rows = [
    {
      key: 'cash',
      label: 'Cash',
      icon: Banknote,
      color: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      bucket: pm?.cash,
    },
    {
      key: 'upi',
      label: 'UPI / QR',
      icon: Smartphone,
      color: 'text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20',
      bucket: pm?.upi,
    },
    {
      key: 'card',
      label: 'Card / POS',
      icon: CreditCard,
      color: 'text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/20',
      bucket: pm?.card,
    },
    ...(pm?.other && (pm.other.count > 0 || (pm.other.refundCount ?? 0) > 0)
      ? [
          {
            key: 'other',
            label: 'Other / Legacy',
            icon: Receipt,
            color: 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20',
            bucket: pm.other,
          },
        ]
      : []),
  ]

  const unattributed = pm?.unattributedRefunds
  const hasUnattributedRefunds = Boolean(unattributed && unattributed.count > 0)
  const topTables = analytics?.topTables ?? []

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
      {/* 7. Payment Method Breakdown */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 lg:col-span-2 shadow-sm">
        <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
          <div>
            <h2 className="text-sm font-bold tracking-tight">7. Payment Method Breakdown</h2>
            <p className="text-[11px] text-muted-foreground">
              Ledger-reconciled collections, refunds, and net settlement
            </p>
          </div>
          <div className="text-right tabular-nums">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total Collected</p>
            <p className="text-sm font-bold text-foreground">
              {loading ? '—' : formatINR(totalCollected, sym)}
            </p>
          </div>
        </div>

        {loading ? (
          <ChartSkeleton className="h-[180px]" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border/60 text-[11px]">
                  <th className="text-left py-2 font-medium">Method</th>
                  <th className="text-right py-2 font-medium">Txns</th>
                  <th className="text-right py-2 font-medium">Collected</th>
                  <th className="text-right py-2 font-medium">Refunds</th>
                  <th className="text-right py-2 font-medium">Net Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {rows.map((r) => {
                  const Icon = r.icon
                  const amt = r.bucket?.amount ?? 0
                  const cnt = r.bucket?.count ?? 0
                  const refAmt = r.bucket?.refunds ?? 0
                  const netAmt = r.bucket?.net ?? +(amt - refAmt).toFixed(2)
                  return (
                    <tr key={r.key}>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <span className={cn('size-6 rounded-md flex items-center justify-center border shrink-0', r.color)}>
                            <Icon className="size-3.5" />
                          </span>
                          <span className="font-medium text-foreground">{r.label}</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                        {cnt.toLocaleString('en-IN')}
                      </td>
                      <td className="py-2.5 text-right tabular-nums font-medium text-foreground">
                        {formatINR(amt, sym)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">
                        {refAmt > 0 ? `-${formatINR(refAmt, sym)}` : formatINR(0, sym)}
                      </td>
                      <td className="py-2.5 text-right tabular-nums font-semibold text-foreground">
                        {formatINR(netAmt, sym)}
                      </td>
                    </tr>
                  )
                })}

                {hasUnattributedRefunds && unattributed && (
                  <tr className="bg-amber-500/5">
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="size-6 rounded-md flex items-center justify-center border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                          <AlertCircle className="size-3.5" />
                        </span>
                        <div>
                          <span className="font-medium text-foreground">Refunds (Method Unavailable)</span>
                          <p className="text-[10px] text-muted-foreground">
                            Order-level refund without ledger method attribution
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                      {unattributed.count}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">—</td>
                    <td className="py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">
                      -{formatINR(unattributed.amount, sym)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums font-semibold text-red-600 dark:text-red-400">
                      -{formatINR(unattributed.amount, sym)}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold text-foreground">
                  <td className="py-2.5">Total Reconciled</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {rows.reduce((s, r) => s + (r.bucket?.count ?? 0), 0).toLocaleString('en-IN')}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{formatINR(totalCollected, sym)}</td>
                  <td className="py-2.5 text-right tabular-nums text-red-600 dark:text-red-400">
                    {totalRefunds > 0 ? `-${formatINR(totalRefunds, sym)}` : formatINR(0, sym)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{formatINR(totalNet, sym)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* 8. Top Tables */}
      <Card className="rounded-xl border border-border/70 bg-card p-4 shadow-sm flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-sm font-bold tracking-tight">8. Top Tables</h2>
              <p className="text-[11px] text-muted-foreground">
                Ranked by settled revenue · Independent sessions counted
              </p>
            </div>
            <Trophy className="size-4 text-amber-500" />
          </div>

          {loading ? (
            <ChartSkeleton className="h-[180px]" />
          ) : topTables.length === 0 ? (
            <SectionEmpty icon={Trophy} message="No dine-in table settlements in this period" className="h-[180px]" />
          ) : (
            <div className="overflow-x-auto mt-1">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted-foreground border-b border-border/40">
                    <th className="text-left py-1.5 font-medium">Table</th>
                    <th className="text-right py-1.5 font-medium">Sessions</th>
                    <th className="text-right py-1.5 font-medium">Avg Bill</th>
                    <th className="text-right py-1.5 font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {topTables.slice(0, 6).map((t, i) => {
                    const sessions = t.sessions ?? t.orders
                    const avgBill = t.avgBill ?? (sessions > 0 ? +(t.revenue / sessions).toFixed(2) : 0)
                    return (
                      <tr key={t.tableId || `${t.name}-${i}`}>
                        <td className="py-2 flex items-center gap-1.5 font-medium text-foreground">
                          <span className="inline-flex items-center justify-center size-4 rounded text-[10px] font-bold bg-secondary text-muted-foreground shrink-0">
                            {i + 1}
                          </span>
                          <span className="truncate max-w-[90px]">{t.name}</span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{sessions}</td>
                        <td className="py-2 text-right tabular-nums text-muted-foreground">{formatINR(avgBill, sym)}</td>
                        <td className="py-2 text-right tabular-nums font-semibold text-foreground">
                          {formatINR(t.revenue, sym)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="pt-2 text-[10px] text-muted-foreground border-t border-border/30">
          Utilization omitted (operating-hours denominator not configured).
        </p>
      </Card>
    </div>
  )
}
