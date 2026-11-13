/**
 * Commercial invoice facts, computed in pure code so every rule is
 * covered by the offline suite (`npm run test:invoices`).
 *
 * These documents record money that actually moved: numbers come from
 * the payment row, never from a plan's list price, and nothing is
 * estimated. There is deliberately no tax computation here — The Salad
 * issues commercial invoices, and a tax layer is a separate decision.
 */

/** Round to 2 decimals the way a bill needs: half-up, not banker's. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The Indian financial year, April to March, in the form document
 * numbers are sequenced by: March 2026 belongs to "2025-26",
 * April 2026 to "2026-27". Numbering restarts every financial year.
 */
export function fiscalYearOf(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1; // months 0-based; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/**
 * Indian digit grouping for document amounts: 1,23,456.00 (the last
 * three digits stay together, then groups of two). "INR" prefixes the
 * figure because the PDF fonts cannot draw the rupee sign.
 */
export function formatMoney(amount: number, currency = "INR"): string {
  const negative = amount < 0;
  const [whole, decimals = "00"] = round2(Math.abs(amount)).toFixed(2).split(".");
  let grouped = whole;
  if (whole.length > 3) {
    const last3 = whole.slice(-3);
    grouped = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }
  return `${negative ? "-" : ""}${currency} ${grouped}.${decimals}`;
}

/** "30 Oct 2026" in UTC — the timezone the payment row is stored in. */
export function fmtDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/**
 * What an issued invoice shows. Every field traces to a database row:
 * the amounts and Razorpay ids to the payment, the parties to the
 * tenant and the platform constants, the period to what the payment
 * actually purchased.
 */
export type InvoiceFacts = {
  invoiceNumber: string;
  invoiceDate: string; // formatted
  status: "PAID";
  sellerName: string;
  sellerAddressLines: string[];
  sellerEmail?: string | null;
  sellerPhone?: string | null;
  buyerName: string;
  buyerEmail: string | null;
  buyerAddressLines: string[];
  planName: string;
  periodStart: string | null; // formatted
  periodEnd: string | null;
  amount: number;
  currency: string;
  razorpayPaymentId: string | null;
  razorpayOrderId: string | null;
  paymentMethod: string | null;
  paidOn: string; // formatted
};

/** What a refund document shows, with the original invoice it reverses. */
export type RefundFacts = {
  refundNumber: string;
  refundDate: string; // formatted
  originalInvoiceNumber: string | null;
  originalInvoiceDate: string | null; // formatted
  sellerName: string;
  sellerAddressLines: string[];
  sellerEmail?: string | null;
  sellerPhone?: string | null;
  buyerName: string;
  buyerEmail: string | null;
  buyerAddressLines: string[];
  planName: string;
  amount: number;
  currency: string;
  razorpayPaymentId: string | null;
  razorpayOrderId: string | null;
  razorpayRefundId: string | null;
};
