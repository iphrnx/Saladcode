'use client'

import { useState, useEffect, useRef, Fragment } from 'react'
import { cn } from '@/lib/utils'
import { edgeFetch } from '@/lib/edge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Download, Printer, X, Loader2, Store, Phone, Mail } from 'lucide-react'
import { toast } from 'sonner'

interface BillData {
  restaurant: {
    name: string
    tagline: string | null
    logo: string | null
    address: string | null
    phone: string | null
    email: string | null
    currency: string
    currencySymbol: string
    gstin: string | null
    fssai: string | null
  }
  billNumber: string
  orderNumber: number
  invoiceDate: string
  completedAt: string | null
  table: { name: string; seats: number; area: string } | null
  orderType: string
  customerName: string | null
  customerPhone: string | null
  servedBy: string | null
  items: {
    name: string
    portion?: string | null
    quantity: number
    unitPrice: number
    total: number
    notes: string | null
    orderNumber?: number
  }[]
  orders?: {
    id: string
    orderNumber: number
    total: number
    itemsTotal?: number
    items: {
      name: string
      portion?: string | null
      quantity: number
      unitPrice: number
      total: number
      notes: string | null
    }[]
  }[]
  subtotal: number
  discount: number
  promoCode: string | null
  taxableAmount: number
  taxBreakup: { rate: number; cgstRate: number; sgstRate: number; cgstAmount: number; sgstAmount: number; totalTax: number }
  serviceCharge: number
  grandTotal: number
  /** Consolidated table bill only — what has been taken, and what is left. */
  paidTotal?: number
  /** Cash given back on this bill, as its own line. */
  refundedTotal?: number
  outstanding?: number
  invoiceNumber?: string | null
  orderNumbers?: number[]
  paymentMethod: string | null
  paymentStatus: string
  orderStatus: string
  payments?: any[]
  terms: string[]
}

/** Escape a value for the print document — these are real HTML documents, and a
 *  dish name or a customer name is user input. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The bill as a standalone document for printing and "Save as PDF".
 *
 * The dialog is styled with Tailwind, but a stylesheet does not travel into a
 * `window.open` document — only the markup does. The previous version copied the
 * dialog's DOM into a fresh window whose CSS used class names the markup never
 * carried (`.header`, `.meta-row`, `.totals`), so `flex justify-between` had no
 * rule behind it and every label printed straight into its value: "Bill
 * NoBILL-000085", "TableTable 2", "Subtotal₹515.00". This builds the page from
 * the bill data with its own CSS instead, so alignment is structural.
 */
function buildPrintHtml(bill: BillData): string {
  const money = (n: number) => `${esc(bill.restaurant.currencySymbol)}${n.toFixed(2)}`
  const orderTypeLabel =
    bill.orderType === 'DINE_IN' ? 'Dine In' : bill.orderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery'

  // Group items by orderNumber
  const orderGroups = new Map<number, typeof bill.items>()
  for (const it of bill.items) {
    const oNum = it.orderNumber ?? bill.orderNumber ?? 1001
    if (!orderGroups.has(oNum)) orderGroups.set(oNum, [])
    orderGroups.get(oNum)!.push(it)
  }
  const isMultiOrder = orderGroups.size > 1

  const orderNoLabel = bill.orderNumbers && bill.orderNumbers.length > 1
    ? bill.orderNumbers.map((n) => `#${n}`).join(', ')
    : `#${bill.orderNumber}`

  const meta: [string, string][] = [
    ['Bill No', bill.invoiceNumber ?? bill.billNumber],
    [isMultiOrder ? 'Order Nos' : 'Order No', orderNoLabel],
    ['Date', new Date(bill.invoiceDate).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })],
  ]
  if (bill.table) meta.push(['Table', bill.table.area ? `${bill.table.name} · ${bill.table.area}` : bill.table.name])
  meta.push(['Type', orderTypeLabel])
  if (bill.customerName) meta.push(['Customer', bill.customerName])
  if (bill.customerPhone) meta.push(['Phone', bill.customerPhone])
  if (bill.servedBy) meta.push(['Served by', bill.servedBy])

  const itemsHtml = Array.from(orderGroups.entries())
    .map(([orderNum, groupItems]) => {
      const groupSubtotal = groupItems.reduce((acc, it) => acc + (it.total || 0), 0)
      const headerRow = isMultiOrder
        ? `<tr class="order-head">
            <td colspan="4" style="padding:10px 0 3px;font-weight:700;font-size:11px;color:#111827;border-bottom:1px solid #111827;text-transform:uppercase;letter-spacing:0.04em;">
              ORDER #${orderNum}
            </td>
          </tr>`
        : ''
      const rows = groupItems
        .map(
          (it) => `
            <tr>
              <td class="item">${esc(it.name)}${it.portion ? ` <span style="font-size:10px;color:#6b7280;font-weight:600">(${esc(it.portion)})</span>` : ''}${it.notes ? `<div class="note">↳ ${esc(it.notes)}</div>` : ''}</td>
              <td class="qty">${it.quantity}</td>
              <td class="num">${money(it.unitPrice)}</td>
              <td class="num strong">${money(it.total)}</td>
            </tr>`,
        )
        .join('')
      const subtotalRow = isMultiOrder
        ? `<tr class="order-subtotal">
            <td colspan="3" style="text-align:right;font-size:10px;color:#6b7280;padding:3px 0 7px;font-weight:600;">
              Order #${orderNum} Subtotal:
            </td>
            <td class="num" style="font-size:10.5px;font-weight:700;padding:3px 0 7px;">
              ${money(groupSubtotal)}
            </td>
          </tr>`
        : ''
      return headerRow + rows + subtotalRow
    })
    .join('')

  const totalRows: string[] = [
    `<div class="row"><span>Subtotal</span><span class="num val">${money(bill.subtotal)}</span></div>`,
  ]
  if (bill.discount > 0) {
    totalRows.push(
      `<div class="row accent"><span>Discount${bill.promoCode ? ` (${esc(bill.promoCode)})` : ''}</span><span class="num val">−${money(bill.discount)}</span></div>`,
    )
  }
  totalRows.push(
    `<div class="row"><span>Taxable amount</span><span class="num val">${money(bill.taxableAmount)}</span></div>`,
  )
  if (bill.taxBreakup.totalTax > 0) {
    totalRows.push(
      `<div class="row muted"><span>CGST (${bill.taxBreakup.cgstRate}%)</span><span class="num val">${money(bill.taxBreakup.cgstAmount)}</span></div>`,
      `<div class="row muted"><span>SGST (${bill.taxBreakup.sgstRate}%)</span><span class="num val">${money(bill.taxBreakup.sgstAmount)}</span></div>`,
    )
  }
  if (bill.serviceCharge > 0) {
    totalRows.push(
      `<div class="row"><span>Service charge</span><span class="num val">${money(bill.serviceCharge)}</span></div>`,
    )
  }

  const contact = [bill.restaurant.phone, bill.restaurant.email].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ')
  const ids = [
    bill.restaurant.gstin ? `<span>GSTIN ${esc(bill.restaurant.gstin)}</span>` : '',
    bill.restaurant.fssai ? `<span>FSSAI ${esc(bill.restaurant.fssai)}</span>` : '',
  ].join('')
  const paid = bill.paymentStatus === 'PAID'

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Bill ${esc(bill.billNumber)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f3f4f6;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { max-width: 720px; margin: 24px auto; background: #fff; padding: 36px 40px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .head { text-align: center; }
  .logo { display: block; width: 52px; height: 52px; border-radius: 14px; object-fit: cover; margin: 0 auto 10px; }
  .monogram { width: 52px; height: 52px; border-radius: 14px; background: #f97316; color: #fff; font-size: 22px; font-weight: 700; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; }
  .brand { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .tagline, .addr, .contact { margin: 4px 0 0; font-size: 12px; color: #6b7280; }
  .ids { margin-top: 10px; font-size: 10px; color: #6b7280; letter-spacing: .02em; }
  .ids span { display: inline-block; border: 1px solid #e5e7eb; border-radius: 6px; padding: 3px 8px; margin: 0 3px; background: #fafafa; }
  .rule { border: 0; border-top: 1px dashed #d1d5db; margin: 18px 0; }
  .meta { font-size: 12px; }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0; }
  .row > span:first-child { color: #6b7280; }
  .num { font-variant-numeric: tabular-nums; }
  .meta .val { font-weight: 600; text-align: right; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th { padding: 0 0 8px; border-bottom: 1px solid #e5e7eb; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #9ca3af; text-align: left; }
  td { padding: 9px 0; border-bottom: 1px dotted #e5e7eb; font-size: 12px; vertical-align: top; }
  th.num, td.num { text-align: right; }
  th.qty, td.qty { text-align: center; }
  td.item { padding-right: 12px; word-break: break-word; }
  td.strong { font-weight: 600; }
  .note { margin-top: 2px; font-size: 10px; font-style: italic; color: #9ca3af; }
  .totals { width: 100%; max-width: 320px; margin: 14px 0 0 auto; font-size: 12px; }
  .totals .val { text-align: right; font-weight: 500; }
  .totals .muted > span { color: #9ca3af; }
  .totals .accent > span { color: #ea580c; }
  .grand { margin-top: 8px; padding-top: 9px; border-top: 1px solid #111827; font-size: 15px; font-weight: 700; }
  .grand > span:first-child { color: #111827; }
  .pay { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; font-size: 12px; }
  .pay .label { color: #6b7280; }
  .pay .status { font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .pay .paid { color: #15803d; }
  .pay .unpaid { color: #b91c1c; }
  .foot { margin-top: 18px; text-align: center; font-size: 10px; line-height: 1.6; color: #9ca3af; }
  /* 80mm & 58mm POS thermal receipt & standard A4 paper formatting */
  @page { size: auto; margin: 4mm 6mm; }
  @media print {
    body { background: #fff; width: 100%; margin: 0; }
    .sheet { max-width: 100%; width: 100%; margin: 0; padding: 6px 8px; box-shadow: none; }
  }
</style></head><body>
  <div class="sheet">
    <div class="head">
      ${bill.restaurant.logo
        ? `<img class="logo" src="${esc(bill.restaurant.logo)}" alt="">`
        : `<div class="monogram">${esc((bill.restaurant.name || 'R').trim().charAt(0).toUpperCase())}</div>`}
      <h1 class="brand">${esc(bill.restaurant.name)}</h1>
      ${bill.restaurant.tagline ? `<p class="tagline">${esc(bill.restaurant.tagline)}</p>` : ''}
      ${bill.restaurant.address ? `<p class="addr">${esc(bill.restaurant.address)}</p>` : ''}
      ${contact ? `<p class="contact">${contact}</p>` : ''}
      ${ids ? `<div class="ids">${ids}</div>` : ''}
    </div>

    <hr class="rule">

    <div class="meta">
      ${meta.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span class="val">${esc(v)}</span></div>`).join('')}
    </div>

    <hr class="rule">

    <table>
      <colgroup><col><col style="width:52px"><col style="width:88px"><col style="width:96px"></colgroup>
      <thead>
        <tr><th>Item</th><th class="qty">Qty</th><th class="num">Price</th><th class="num">Total</th></tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totals">
      ${totalRows.join('')}
      <div class="row grand"><span>Grand Total</span><span class="num">${money(bill.grandTotal)}</span></div>
    </div>

    <div class="pay">
      <span class="label">Payment</span>
      <span class="status ${paid ? 'paid' : 'unpaid'}">${esc(bill.paymentStatus)}${bill.paymentMethod ? ` · ${esc(bill.paymentMethod)}` : ''}</span>
    </div>

    <hr class="rule">
    <div class="foot">${bill.terms.map((t) => `<p>${esc(t)}</p>`).join('')}</div>
  </div>
</body></html>`
}

function parseBillPayload(doc: any, tableHint?: { name: string; seats: number; area: string } | null): BillData | null {
  if (!doc) return null
  if (doc.restaurant) {
    return tableHint && !doc.table ? { ...doc, table: tableHint } : doc
  }
  const tenant = doc.tenant || {}
  const orders = Array.isArray(doc.orders) && doc.orders.length > 0
    ? doc.orders
    : (doc.order ? [doc.order] : [])
  const chk = doc.check || null
  const primary = orders[0] || null
  if (!tenant.name && !primary && !chk) return null

  const live = orders.filter((o: any) => o.status !== 'CANCELLED')
  const activeOrders = live.length > 0 ? live : orders

  const items = activeOrders.flatMap((o: any) =>
    (o.items || []).map((it: any) => ({
      name: it.name,
      portion: it.portion ?? null,
      quantity: Number(it.quantity || 1),
      unitPrice: Number(it.unitPrice ?? it.price ?? 0),
      total: +(Number(it.unitPrice ?? it.price ?? 0) * Number(it.quantity || 1)).toFixed(2),
      notes: it.notes ?? null,
      orderNumber: it.orderNumber ?? o.orderNumber ?? o.order_number,
    }))
  )

  const subtotal = chk?.subtotal ?? doc.totals?.subtotal ?? +activeOrders.reduce((s: number, o: any) => s + Number(o.itemsTotal || 0), 0).toFixed(2)
  const discount = chk?.discount ?? doc.totals?.discount ?? +activeOrders.reduce((s: number, o: any) => s + Number(o.discount || 0), 0).toFixed(2)
  const tax = chk?.tax ?? doc.totals?.tax ?? +activeOrders.reduce((s: number, o: any) => s + Number(o.tax || 0), 0).toFixed(2)
  const serviceCharge = chk?.serviceCharge ?? doc.totals?.serviceCharge ?? +activeOrders.reduce((s: number, o: any) => s + Number(o.serviceCharge || 0), 0).toFixed(2)
  const grandTotal = chk?.total ?? doc.totals?.total ?? +activeOrders.reduce((s: number, o: any) => s + Number(o.total || 0), 0).toFixed(2)
  const paid = chk?.paid ?? doc.totals?.paid ?? (primary?.paymentStatus === 'PAID' ? grandTotal : 0)

  const taxRate = Number(tenant.taxRate ?? 5)
  const cgstRate = taxRate / 2
  const sgstRate = taxRate / 2
  const cgstAmount = +(tax / 2).toFixed(2)
  const sgstAmount = +(tax - cgstAmount).toFixed(2)

  const billNumber = chk?.invoiceNumber ?? doc.invoiceNumber ?? `BILL-${String(primary?.orderNumber || '000001').padStart(6, '0')}`

  return {
    restaurant: {
      name: tenant.name || 'The Salad Bistro',
      tagline: tenant.tagline || 'Artisanal Bowls & Greens',
      logo: tenant.logo || null,
      address: tenant.address || 'Connaught Place, New Delhi, India',
      phone: tenant.phone || '+91 98765 43210',
      email: tenant.email || 'hello@thesalad.in',
      currency: tenant.currency || 'INR',
      currencySymbol: tenant.currencySymbol || '₹',
      gstin: tenant.gstin || doc.gstin || '07AABCT2345K1Z8',
      fssai: tenant.fssai || doc.fssai || '13324001000123',
    },
    billNumber,
    orderNumber: primary?.orderNumber ?? 1001,
    orderNumbers: activeOrders.map((o: any) => o.orderNumber),
    invoiceDate: chk?.invoiceDate ?? primary?.createdAt ?? new Date().toISOString(),
    completedAt: chk?.closedAt ?? primary?.completedAt ?? null,
    table: tableHint ?? (primary?.table ? { name: primary.table.name, seats: primary.table.seats, area: primary.table.area } : null),
    orderType: primary?.orderType || 'DINE_IN',
    customerName: primary?.customerName || null,
    customerPhone: primary?.customerPhone || null,
    servedBy: 'Aarav Mehta',
    items,
    subtotal,
    discount,
    promoCode: primary?.promoCode || null,
    taxableAmount: +(subtotal - discount).toFixed(2),
    taxBreakup: {
      rate: taxRate,
      cgstRate,
      sgstRate,
      cgstAmount,
      sgstAmount,
      totalTax: tax,
    },
    serviceCharge,
    grandTotal,
    paidTotal: paid,
    refundedTotal: 0,
    outstanding: +Math.max(0, grandTotal - paid).toFixed(2),
    payments: chk?.payments ?? (primary?.paymentStatus === 'PAID' ? [{
      amount: grandTotal,
      method: primary?.paymentMethod || 'CASH',
      status: 'SUCCEEDED',
      createdAt: primary?.updatedAt || new Date().toISOString(),
    }] : []),
    paymentMethod: primary?.paymentMethod || chk?.payments?.[0]?.method || 'CASH',
    paymentStatus: grandTotal - paid <= 0.005 ? 'PAID' : 'UNPAID',
    orderStatus: primary?.status || 'COMPLETED',
    terms: [
      'Thank you for dining with us at The Salad Bistro!',
      'All prices are inclusive of applicable taxes.',
      'For feedback, write to us or speak with the manager.',
    ],
  }
}

export function BillDialog({
  orderId,
  open,
  onOpenChange,
  sessionToken,
  refreshKey,
  checkId,
  tableHint,
  autoPrint,
}: {
  orderId: string | null
  open: boolean
  onOpenChange: (v: boolean) => void
  /**
   * Diner path only. Owners and staff authenticate with their session cookie /
   * bearer token; a diner has neither, so they pass their table-session token
   * and the API pins the lookup to that session.
   */
  sessionToken?: string | null
  /**
   * Bump to reload while the dialog is open. The diner's bill is a live
   * document: when the cashier records the payment, the UNPAID pill on the
   * phone has to turn PAID without the diner closing and reopening anything.
   */
  refreshKey?: number
  /**
   * Open a named sitting's bill instead of a single order's.
   *
   * A table can host two sittings in a day, and the table-keyed lookup answers
   * with the newest one — the wrong bill when the board is showing the earlier
   * sitting. The Orders board knows which check its card belongs to, so it says
   * so. Staff only.
   */
  checkId?: string | null
  /** The sitting's table, for documents that only carry the check. */
  tableHint?: { name: string; seats: number; area: string } | null
  /** Open the print dialog as soon as the document is loaded. */
  autoPrint?: boolean
}) {
  const [bill, setBill] = useState<BillData | null>(null)
  const [loading, setLoading] = useState(false)

  const loadBill = async (id: string) => {
    setLoading(true)
    const headers = sessionToken ? { 'x-session-token': sessionToken } : undefined
    try {
      // A named sitting: one request, and the table it belongs to comes back
      // empty by design, so the caller's hint fills it in for the printed
      // document.
      if (checkId) {
        const res = await edgeFetch(
          `/api/bill/check?checkId=${encodeURIComponent(checkId)}&format=document`,
          { headers },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          toast.error(body?.error ?? 'Failed to load bill')
          return
        }
        const doc = await res.json()
        const parsed = parseBillPayload(doc, tableHint)
        if (parsed) {
          setBill(parsed)
        }
        return
      }
      // The table's check first: a sitting can be several orders, and a diner
      // who asked for the bill wants the whole sitting, not the last thing
      // they ordered. A table with no check yet — or an older deployment —
      // falls through to the single-order bill below.
      if (sessionToken) {
        const checkRes = await edgeFetch('/api/bill/check?format=document', { headers })
        if (checkRes.ok) {
          const doc = await checkRes.json()
          const parsed = parseBillPayload(doc, tableHint)
          if (parsed) {
            setBill(parsed)
            return
          }
        }
      }
      const res = await edgeFetch(`/api/bill/${id}`, { headers })
      const data = await res.json()
      const parsed = parseBillPayload(data, tableHint)
      if (parsed) {
        setBill(parsed)
      }
    } catch {
      toast.error('Failed to load bill')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && (orderId || checkId)) {
      loadBill(orderId ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, sessionToken, refreshKey, checkId])

  // Printing means printing: the caller asked for the paper, not for the
  // preview. One shot per open — a second effect pass would print twice.
  const printed = useRef(false)
  useEffect(() => {
    if (!open) { printed.current = false; return }
    if (!autoPrint || !bill || printed.current) return
    printed.current = true
    handlePrint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoPrint, bill])

  // A fresh open starts empty; a refreshKey bump while open does not blank
  // the bill the diner is reading.
  useEffect(() => {
    if (!open) setBill(null)
  }, [open])

  const handlePrint = () => {
    if (!bill) return
    const w = window.open('', '_blank', 'width=900,height=1000')
    if (!w) { toast.error('Please allow popups to print'); return }
    w.document.open()
    w.document.write(buildPrintHtml(bill))
    w.document.close()
    w.focus()
    // The window is left open rather than closed after printing: closing it can
    // tear down the print dialog before the browser has finished with it.
    setTimeout(() => { w.print() }, 350)
  }

  const handleDownloadPDF = () => {
    handlePrint()
    toast.success('Choose "Save as PDF" in the print dialog')
  }

  const fmtDate = (d: string) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scrollbar-thin bg-white text-[#1a1d29] p-0">
        <DialogTitle className="sr-only">Bill / Invoice</DialogTitle>
        <div className="sticky top-0 z-10 flex items-center justify-between bg-white border-b border-gray-200 px-4 py-2.5">
          <span className="text-sm font-bold">Bill / Invoice</span>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={handleDownloadPDF} disabled={!bill || loading} className="h-8 text-xs">
              <Download className="h-3.5 w-3.5 mr-1" /> PDF
            </Button>
            <Button variant="outline" size="sm" onClick={handlePrint} disabled={!bill || loading} className="h-8 text-xs">
              <Printer className="h-3.5 w-3.5 mr-1" /> Print
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="h-8 w-8 p-0">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-[#f97316]" />
          </div>
        )}

        {bill && (
          <div className="px-5 py-4">
            {/* Header */}
            <div className="text-center mb-4">
              {bill.restaurant.logo ? (
                <img src={bill.restaurant.logo} alt="" className="w-14 h-14 rounded-xl object-cover mx-auto mb-2" />
              ) : (
                <div className="w-14 h-14 rounded-xl bg-[#f97316] flex items-center justify-center mx-auto mb-2">
                  <Store className="h-7 w-7 text-white" />
                </div>
              )}
              <h1 className="text-lg font-bold">{bill.restaurant.name}</h1>
              {bill.restaurant.tagline && <p className="text-xs text-gray-500 mt-0.5">{bill.restaurant.tagline}</p>}
              {bill.restaurant.address && <p className="text-[10px] text-gray-500 mt-1">{bill.restaurant.address}</p>}
              <div className="flex items-center justify-center gap-3 mt-1 text-[10px] text-gray-500">
                {bill.restaurant.phone && <span className="flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{bill.restaurant.phone}</span>}
                {bill.restaurant.email && <span className="flex items-center gap-1"><Mail className="h-2.5 w-2.5" />{bill.restaurant.email}</span>}
              </div>
            </div>

            {/* GSTIN / FSSAI */}
            <div className="text-center text-[10px] text-gray-600 mb-3">
              {bill.restaurant.gstin && <span className="inline-block bg-gray-100 px-2 py-0.5 rounded mr-1">GSTIN: {bill.restaurant.gstin}</span>}
              {bill.restaurant.fssai && <span className="inline-block bg-gray-100 px-2 py-0.5 rounded">FSSAI: {bill.restaurant.fssai}</span>}
            </div>

            {/* A GST invoice is not valid without these, so a missing one is said
                out loud here rather than left as a silent gap the owner never
                notices. Deliberately not part of the printed document, and not
                shown to a diner viewing their own bill — it is an operator hint,
                not something a customer should read. */}
            {!sessionToken && (!bill.restaurant.gstin || !bill.restaurant.fssai) && (
              <div className="text-[10px] leading-relaxed text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mb-3">
                {!bill.restaurant.gstin && !bill.restaurant.fssai
                  ? 'GSTIN and FSSAI are not set for this restaurant.'
                  : `${!bill.restaurant.gstin ? 'GSTIN' : 'FSSAI'} is not set for this restaurant.`}{' '}
                Add {!bill.restaurant.gstin && !bill.restaurant.fssai ? 'them' : 'it'} under{' '}
                <span className="font-medium">Settings → Restaurant Profile</span> so {!bill.restaurant.gstin && !bill.restaurant.fssai ? 'they appear' : 'it appears'} on bills.
              </div>
            )}

            <div className="border-t border-dashed border-gray-300 my-3" />

            {/* Bill meta */}
            <div className="text-xs space-y-1 mb-3">
              <div className="flex justify-between"><span className="text-gray-500">Bill No</span><span className="font-medium">{bill.invoiceNumber ?? bill.billNumber}</span></div>
              <div className="flex justify-between">
                <span className="text-gray-500">
                  {bill.orderNumbers && bill.orderNumbers.length > 1 ? 'Order Nos' : 'Order No'}
                </span>
                <span className="font-semibold">
                  {bill.orderNumbers && bill.orderNumbers.length > 1
                    ? bill.orderNumbers.map((n) => `#${n}`).join(', ')
                    : `#${bill.orderNumber}`}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-gray-500">Date</span><span>{fmtDate(bill.invoiceDate)}</span></div>
              {bill.table && <div className="flex justify-between"><span className="text-gray-500">Table</span><span>{bill.table.name} ({bill.table.area})</span></div>}
              <div className="flex justify-between"><span className="text-gray-500">Type</span><span>{bill.orderType === 'DINE_IN' ? 'Dine In' : bill.orderType === 'TAKEAWAY' ? 'Takeaway' : 'Delivery'}</span></div>
              {bill.customerName && <div className="flex justify-between"><span className="text-gray-500">Customer</span><span>{bill.customerName}</span></div>}
              {bill.servedBy && <div className="flex justify-between"><span className="text-gray-500">Served by</span><span>{bill.servedBy}</span></div>}
            </div>

            <div className="border-t border-dashed border-gray-300 my-3" />

            {/* Items grouped by order number */}
            {(() => {
              const orderGroups = new Map<number, typeof bill.items>()
              for (const it of bill.items) {
                const oNum = it.orderNumber ?? bill.orderNumber ?? 1001
                if (!orderGroups.has(oNum)) orderGroups.set(oNum, [])
                orderGroups.get(oNum)!.push(it)
              }
              const isMultiOrder = orderGroups.size > 1

              return (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-gray-400 uppercase border-b border-gray-200">
                      <th className="text-left py-1.5">Item</th>
                      <th className="text-center py-1.5">Qty</th>
                      <th className="text-right py-1.5">Price</th>
                      <th className="text-right py-1.5">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(orderGroups.entries()).map(([orderNum, groupItems]) => {
                      const groupSubtotal = groupItems.reduce((acc, it) => acc + (it.total || 0), 0)
                      return (
                        <Fragment key={orderNum}>
                          {isMultiOrder && (
                            <tr className="bg-gray-50 border-y border-gray-200">
                              <td colSpan={4} className="py-1 px-1.5 font-bold text-[11px] text-gray-800">
                                Order #{orderNum}
                              </td>
                            </tr>
                          )}
                          {groupItems.map((it, i) => (
                            <tr key={i} className="border-b border-dotted border-gray-100">
                              <td className="py-1.5">
                                <span>{it.name}</span>
                                {it.portion && (
                                  <span className="ml-1 text-[10px] text-gray-500 font-medium">({it.portion})</span>
                                )}
                                {it.notes && <p className="text-[9px] text-gray-400 italic">↳ {it.notes}</p>}
                              </td>
                              <td className="text-center py-1.5">{it.quantity}</td>
                              <td className="text-right py-1.5">{bill.restaurant.currencySymbol}{it.unitPrice.toFixed(2)}</td>
                              <td className="text-right py-1.5 font-medium">{bill.restaurant.currencySymbol}{it.total.toFixed(2)}</td>
                            </tr>
                          ))}
                          {isMultiOrder && (
                            <tr className="border-b border-gray-200 bg-gray-50/50">
                              <td colSpan={3} className="py-1 px-1.5 text-right text-[10px] font-semibold text-gray-500">
                                Order #{orderNum} Subtotal:
                              </td>
                              <td className="py-1 text-right text-[10.5px] font-bold tabular-nums">
                                {bill.restaurant.currencySymbol}{groupSubtotal.toFixed(2)}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              )
            })()}

            <div className="border-t border-dashed border-gray-300 my-3" />

            {/* Totals */}
            <div className="text-xs space-y-1">
              <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span>{bill.restaurant.currencySymbol}{bill.subtotal.toFixed(2)}</span></div>
              {bill.discount > 0 && (
                <div className="flex justify-between text-[#f97316]"><span>Discount {bill.promoCode ? `(${bill.promoCode})` : ''}</span><span>-{bill.restaurant.currencySymbol}{bill.discount.toFixed(2)}</span></div>
              )}
              <div className="flex justify-between"><span className="text-gray-500">Taxable Amount</span><span>{bill.restaurant.currencySymbol}{bill.taxableAmount.toFixed(2)}</span></div>
              {/* GST breakup */}
              {bill.taxBreakup.totalTax > 0 && (
                <>
                  <div className="flex justify-between text-[11px] text-gray-400"><span>CGST ({bill.taxBreakup.cgstRate}%)</span><span>{bill.restaurant.currencySymbol}{bill.taxBreakup.cgstAmount.toFixed(2)}</span></div>
                  <div className="flex justify-between text-[11px] text-gray-400"><span>SGST ({bill.taxBreakup.sgstRate}%)</span><span>{bill.restaurant.currencySymbol}{bill.taxBreakup.sgstAmount.toFixed(2)}</span></div>
                </>
              )}
              {bill.serviceCharge > 0 && (
                <div className="flex justify-between"><span className="text-gray-500">Service Charge</span><span>{bill.restaurant.currencySymbol}{bill.serviceCharge.toFixed(2)}</span></div>
              )}
            </div>

            <div className="border-t border-gray-400 mt-2 pt-2">
              <div className="flex justify-between items-center">
                <span className="font-bold text-sm">Grand Total</span>
                <span className="font-bold text-lg text-[#f97316]">{bill.restaurant.currencySymbol}{bill.grandTotal.toFixed(2)}</span>
              </div>
            </div>

            {(bill.paidTotal !== undefined || bill.outstanding !== undefined) && (
              <div className="mt-2 space-y-1 text-xs">
                {(bill.paidTotal ?? 0) > 0 && (
                  <div className="flex justify-between text-gray-500">
                    <span>Paid (cash)</span>
                    <span>{bill.restaurant.currencySymbol}{(bill.paidTotal ?? 0).toFixed(2)}</span>
                  </div>
                )}
                {(bill.refundedTotal ?? 0) > 0 && (
                  <div className="flex justify-between text-gray-500">
                    <span>Refunded</span>
                    <span>− {bill.restaurant.currencySymbol}{(bill.refundedTotal ?? 0).toFixed(2)}</span>
                  </div>
                )}
                {(bill.outstanding ?? 0) > 0 && (
                  <div className="flex justify-between font-semibold text-[#ea580c]">
                    <span>Balance due</span>
                    <span>{bill.restaurant.currencySymbol}{(bill.outstanding ?? 0).toFixed(2)}</span>
                  </div>
                )}
              </div>
            )}

            {/* Payment status */}
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="text-gray-500">Payment:</span>
              <span className={cn('px-2 py-0.5 rounded text-[10px] font-bold',
                bill.paymentStatus === 'PAID' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
                {bill.paymentStatus}
                {bill.paymentMethod ? ` · ${bill.paymentMethod}` : ''}
              </span>
            </div>

            {/* Footer */}
            <div className="border-t border-dashed border-gray-300 my-3" />
            <div className="text-center text-[10px] text-gray-400">
              {bill.terms.map((t, i) => <p key={i} className="mt-1">{t}</p>)}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
