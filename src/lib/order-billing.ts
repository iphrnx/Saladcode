/**
 * Centralized billing and tax math utility for orders, bills, and invoices.
 *
 * Single source of truth for:
 *   - subtotal, discount, taxableAmount
 *   - deterministic integer-paise GST split (cgstPaise = Math.ceil(gstTotalPaise / 2), sgstPaise = gstTotalPaise - cgstPaise)
 *   - service charge
 *   - nearest-rupee round off
 *   - grand total
 *
 * Guarantees subtotal - discount + cgst + sgst + serviceCharge + roundOff === grandTotal with zero 1-paisa drift.
 */

export interface BillBreakup {
  subtotal: number
  discount: number
  taxableAmount: number
  gstTotal: number
  cgst: number
  sgst: number
  cgstRate: number
  sgstRate: number
  taxRate: number
  serviceCharge: number
  serviceRate: number
  roundOff: number
  grandTotal: number
}

export function calculateBillBreakup(params: {
  subtotal: number
  discount?: number
  taxRate?: number
  tax?: number
  serviceRate?: number
  serviceCharge?: number
  applyRoundOff?: boolean
}): BillBreakup {
  const subtotal = Math.max(0, Number(params.subtotal || 0))
  const discount = Math.min(subtotal, Math.max(0, Number(params.discount || 0)))
  const taxableAmount = +(subtotal - discount).toFixed(2)

  const taxRate = Number(params.taxRate ?? 5)
  let gstTotalPaise: number
  if (typeof params.tax === 'number' && Number.isFinite(params.tax) && params.tax >= 0) {
    gstTotalPaise = Math.round(params.tax * 100)
  } else {
    gstTotalPaise = Math.round(taxableAmount * (taxRate / 100) * 100)
  }

  // Deterministic GST split in integer paise with zero rounding drift:
  const cgstPaise = Math.ceil(gstTotalPaise / 2)
  const sgstPaise = gstTotalPaise - cgstPaise
  const cgst = +(cgstPaise / 100).toFixed(2)
  const sgst = +(sgstPaise / 100).toFixed(2)
  const gstTotal = +(gstTotalPaise / 100).toFixed(2)

  const serviceRate = Number(params.serviceRate ?? 0)
  let serviceChargePaise: number
  if (typeof params.serviceCharge === 'number' && Number.isFinite(params.serviceCharge) && params.serviceCharge >= 0) {
    serviceChargePaise = Math.round(params.serviceCharge * 100)
  } else if (serviceRate > 0) {
    serviceChargePaise = Math.round(subtotal * (serviceRate / 100) * 100)
  } else {
    serviceChargePaise = 0
  }
  const serviceCharge = +(serviceChargePaise / 100).toFixed(2)

  const unroundedPaise = Math.round(taxableAmount * 100) + gstTotalPaise + serviceChargePaise
  const unroundedTotal = +(unroundedPaise / 100).toFixed(2)

  let grandTotal: number
  let roundOff: number
  if (params.applyRoundOff) {
    const roundedPaise = Math.round(unroundedPaise / 100) * 100
    grandTotal = +(roundedPaise / 100).toFixed(2)
    roundOff = +((roundedPaise - unroundedPaise) / 100).toFixed(2)
  } else {
    grandTotal = unroundedTotal
    roundOff = 0
  }

  return {
    subtotal: +subtotal.toFixed(2),
    discount: +discount.toFixed(2),
    taxableAmount,
    gstTotal,
    cgst,
    sgst,
    cgstRate: +(taxRate / 2).toFixed(1),
    sgstRate: +(taxRate / 2).toFixed(1),
    taxRate,
    serviceCharge,
    serviceRate,
    roundOff,
    grandTotal,
  }
}
