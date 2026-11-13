/**
 * Issuing the financial documents — one immutable row + one stored PDF
 * per payment, and per refund. Shared by the subscriptions function
 * (verify issues eagerly, the endpoint replays) and the Razorpay webhook
 * (charged issues, refunded issues the refund document).
 *
 * The guarantees this module keeps:
 *  - a document is only ever issued from a payment row that exists in the
 *    ledger — i.e. after server-side verification or a signed webhook;
 *  - the unique payment_id index makes a duplicate impossible, and the
 *    loser of a race replays the winner's document;
 *  - issuance order is render → upload → insert, because the immutability
 *    trigger forbids any later UPDATE — the row is born complete;
 *  - issuance is best-effort: money already moved, so a PDF filing
 *    problem must never block an entitlement or an acknowledgement.
 */

import { fiscalYearOf, fmtDate, type InvoiceFacts, type RefundFacts } from "./invoices.ts";
import { buildInvoicePdf, buildRefundPdf } from "./pdf.ts";
import {
  businessDetailsConfigured,
  composeBusinessAddressLines,
} from "./platform-details.ts";

export const BILLING_BUCKET = "billing-documents";

/**
 * Who the invoice is from, in order of authority:
 *   1. the platform_business_details table (Super Admin → Settings →
 *      Billing & Invoices) once a legal name has been saved there;
 *   2. the PLATFORM_SELLER_* edge function secrets;
 *   3. the bare brand name.
 * Anything not configured is left off the document, never invented.
 * A failed read degrades to the next source rather than blocking an
 * issuance — money already moved, the document must still be born.
 */
export async function sellerIdentity(db?: any): Promise<SellerIdentity> {
  if (db) {
    const { data: row, error } = await db
      .from("platform_business_details")
      .select("legal_name, street, city, state, pin_code, country, email, phone")
      .eq("singleton", true)
      .maybeSingle();
    if (error) {
      console.error("billing documents: business details unreadable", error.message);
    } else if (businessDetailsConfigured(row)) {
      return {
        name: String(row.legal_name).trim(),
        addressLines: composeBusinessAddressLines(row),
        email: String(row.email ?? "").trim() || null,
        phone: String(row.phone ?? "").trim() || null,
      };
    }
  }
  const env = (globalThis as any).Deno?.env;
  return {
    name: env?.get?.("PLATFORM_SELLER_NAME") ?? "The Salad",
    addressLines: String(env?.get?.("PLATFORM_SELLER_ADDRESS") ?? "")
      .split("\n").map((l: string) => l.trim()).filter(Boolean),
    email: env?.get?.("PLATFORM_SELLER_EMAIL") || null,
    phone: env?.get?.("PLATFORM_SELLER_PHONE") || null,
  };
}

export type SellerIdentity = {
  name: string;
  addressLines: string[];
  email?: string | null;
  phone?: string | null;
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function invoiceFactsFromRow(
  row: any,
  seller: SellerIdentity,
): InvoiceFacts {
  return {
    invoiceNumber: row.invoice_number,
    invoiceDate: fmtDate(row.invoice_date),
    status: "PAID",
    // The snapshot on the row wins — an issued document always shows the
    // identity it was issued with. The live seller is only the fallback
    // for rows written before the snapshot existed.
    sellerName: row.seller_name || seller.name,
    sellerAddressLines: row.seller_address
      ? String(row.seller_address).split("\n").map((l: string) => l.trim()).filter(Boolean)
      : seller.addressLines,
    sellerEmail: row.seller_email || seller.email || null,
    sellerPhone: row.seller_phone || seller.phone || null,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    buyerAddressLines: String(row.buyer_address ?? "").split("\n").map((l: string) => l.trim()).filter(Boolean),
    planName: row.description,
    periodStart: row.period_start ? fmtDate(row.period_start) : null,
    periodEnd: row.period_end ? fmtDate(row.period_end) : null,
    amount: Number(row.total_amount),
    currency: row.currency ?? "INR",
    razorpayPaymentId: row.razorpay_payment_id,
    razorpayOrderId: row.razorpay_order_id,
    paymentMethod: row.payment_method,
    paidOn: fmtDate(row.invoice_date),
  };
}

export function refundFactsFromRow(
  row: any,
  seller: SellerIdentity,
): RefundFacts {
  return {
    refundNumber: row.refund_number,
    refundDate: fmtDate(row.refund_date),
    originalInvoiceNumber: row.original_invoice_number,
    originalInvoiceDate: row.original_invoice_date ? fmtDate(row.original_invoice_date) : null,
    sellerName: row.seller_name || seller.name,
    sellerAddressLines: row.seller_address
      ? String(row.seller_address).split("\n").map((l: string) => l.trim()).filter(Boolean)
      : seller.addressLines,
    sellerEmail: row.seller_email || seller.email || null,
    sellerPhone: row.seller_phone || seller.phone || null,
    buyerName: row.buyer_name,
    buyerEmail: row.buyer_email,
    buyerAddressLines: String(row.buyer_address ?? "").split("\n").map((l: string) => l.trim()).filter(Boolean),
    planName: row.description,
    amount: Number(row.amount),
    currency: row.currency ?? "INR",
    razorpayPaymentId: row.razorpay_payment_id,
    razorpayOrderId: row.razorpay_order_id,
    razorpayRefundId: row.razorpay_refund_id,
  };
}

async function takeNumber(db: any, series: "INV" | "RFND", fiscalYear: string): Promise<string | null> {
  const { data, error } = await db
    .rpc("billing_next_document_number", { p_series: series, p_fiscal_year: fiscalYear });
  if (error || !data) {
    console.error(`billing documents: could not take a ${series} number`, error?.message);
    return null;
  }
  return String(data);
}

async function uploadPdf(db: any, path: string, bytes: Uint8Array): Promise<boolean> {
  const { error } = await db.storage.from(BILLING_BUCKET).upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (error) {
    console.error("billing documents: could not store the PDF", error.message);
    return false;
  }
  return true;
}

/** Read a stored PDF back out of the private bucket. */
export async function readStoredPdf(db: any, path: string | null): Promise<Uint8Array | null> {
  if (!path) return null;
  const { data, error } = await db.storage.from(BILLING_BUCKET).download(path);
  if (error || !data) {
    console.error("billing documents: stored PDF unreadable", error?.message);
    return null;
  }
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Issue the invoice for a payment that has already been verified
 * server-side. Returns the row — the caller's or, on a race, the
 * winner's. Null on failure: the caller logs and moves on.
 */
export async function issueInvoiceDocument(
  db: any,
  tenantId: string,
  payment: any,
  opts: { periodStart?: Date | string; periodEnd?: Date | string } = {},
): Promise<any | null> {
  const { data: tenant } = await db
    .from("tenants")
    .select("name, email, address")
    .eq("id", tenantId)
    .maybeSingle();
  const { data: planRow } = await db
    .from("subscription_plans")
    .select("name")
    .eq("id", payment.plan_id)
    .maybeSingle();

  const seller = await sellerIdentity(db);
  const paidAt = new Date(payment.created_at);
  const fiscalYear = fiscalYearOf(paidAt);
  // Callers compute periods in their own units — verify passes an ISO
  // string from periodEndFrom(), the webhook passes Dates. Coerce at the
  // boundary: a string has no toISOString(), and letting that slip
  // through once failed every eager issuance after takeNumber() had
  // already burned the document number.
  const periodStart = opts.periodStart ? new Date(opts.periodStart) : paidAt;
  const periodEnd = opts.periodEnd ? new Date(opts.periodEnd) : new Date(paidAt.getTime() + MONTH_MS);

  const number = await takeNumber(db, "INV", fiscalYear);
  if (!number) return null;

  const insert = {
    tenant_id: tenantId,
    payment_id: payment.id,
    invoice_number: number,
    invoice_date: paidAt.toISOString(),
    fiscal_year: fiscalYear,
    seller_name: seller.name,
    seller_address: seller.addressLines.join("\n") || null,
    seller_email: seller.email ?? "",
    seller_phone: seller.phone ?? "",
    buyer_name: tenant?.name ?? "Restaurant",
    buyer_email: tenant?.email ?? null,
    buyer_address: tenant?.address ?? null,
    total_amount: Number(payment.amount),
    currency: payment.currency ?? "INR",
    description: planRow?.name ?? payment.plan_id,
    period_start: periodStart.toISOString(),
    period_end: periodEnd.toISOString(),
    payment_status: "paid",
    payment_method: payment.payment_method ?? null,
    razorpay_payment_id: payment.razorpay_payment_id ?? null,
    razorpay_order_id: payment.razorpay_order_id ?? null,
    pdf_path: `${tenantId}/${number}.pdf`,
  };

  const bytes = buildInvoicePdf(invoiceFactsFromRow(insert, seller));
  await uploadPdf(db, insert.pdf_path, bytes); // failure degrades to re-render at download

  const { data: inserted, error } = await db
    .from("billing_invoices")
    .insert(insert)
    .select("*")
    .single();
  if (error) {
    if (String(error.code) === "23505") {
      const { data: raced } = await db
        .from("billing_invoices")
        .select("*")
        .eq("payment_id", payment.id)
        .maybeSingle();
      return raced ?? null;
    }
    console.error("billing documents: could not issue the invoice", error.message);
    return null;
  }
  return inserted;
}

/**
 * Issue the refund document for a refunded payment, linked to the
 * original invoice (issuing that invoice first if it does not exist yet
 * — the payment succeeded at some point, so its invoice is a fact).
 */
export async function issueRefundDocument(
  db: any,
  tenantId: string,
  payment: any,
  details: { refundedAt?: Date; razorpayRefundId?: string | null; amount?: number } = {},
): Promise<any | null> {
  // The original invoice must exist for the link.
  let { data: invoice } = await db
    .from("billing_invoices")
    .select("*")
    .eq("payment_id", payment.id)
    .maybeSingle();
  if (!invoice) {
    invoice = await issueInvoiceDocument(db, tenantId, payment);
  }

  const { data: tenant } = await db
    .from("tenants")
    .select("name, email, address")
    .eq("id", tenantId)
    .maybeSingle();
  const { data: planRow } = await db
    .from("subscription_plans")
    .select("name")
    .eq("id", payment.plan_id)
    .maybeSingle();

  const seller = await sellerIdentity(db);
  const refundedAt = details.refundedAt ?? new Date();
  const fiscalYear = fiscalYearOf(refundedAt);

  const number = await takeNumber(db, "RFND", fiscalYear);
  if (!number) return null;

  const insert = {
    tenant_id: tenantId,
    payment_id: payment.id,
    invoice_id: invoice?.id ?? null,
    refund_number: number,
    refund_date: refundedAt.toISOString(),
    fiscal_year: fiscalYear,
    seller_name: seller.name,
    seller_address: seller.addressLines.join("\n") || null,
    seller_email: seller.email ?? "",
    seller_phone: seller.phone ?? "",
    buyer_name: tenant?.name ?? "Restaurant",
    buyer_email: tenant?.email ?? null,
    buyer_address: tenant?.address ?? null,
    original_invoice_number: invoice?.invoice_number ?? null,
    original_invoice_date: invoice?.invoice_date ?? null,
    // What Razorpay actually returned, not the payment's full amount:
    // a partial refund documents the partial figure.
    amount: details.amount ?? Number(payment.amount),
    currency: payment.currency ?? "INR",
    description: planRow?.name ?? payment.plan_id,
    razorpay_payment_id: payment.razorpay_payment_id ?? null,
    razorpay_order_id: payment.razorpay_order_id ?? null,
    razorpay_refund_id: details.razorpayRefundId ?? null,
    pdf_path: `${tenantId}/${number}.pdf`,
  };

  const bytes = buildRefundPdf(refundFactsFromRow(insert, seller));
  await uploadPdf(db, insert.pdf_path, bytes);

  const { data: inserted, error } = await db
    .from("billing_refunds")
    .insert(insert)
    .select("*")
    .single();
  if (error) {
    if (String(error.code) === "23505") {
      const { data: raced } = await db
        .from("billing_refunds")
        .select("*")
        .eq("payment_id", payment.id)
        .maybeSingle();
      return raced ?? null;
    }
    console.error("billing documents: could not issue the refund document", error.message);
    return null;
  }
  return inserted;
}
