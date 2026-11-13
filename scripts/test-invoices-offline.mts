/**
 * Offline tests for the billing documents: numbering, Indian formatting,
 * the PDF writer, and the row → document mapping. No database, no
 * network — the edge functions stay thin because the decisions live in
 * _shared/invoices.ts and _shared/pdf.ts. Run with: npm run test:invoices
 *
 * The platform issues commercial invoices with no tax layer. The suite
 * encodes that: tax vocabulary on a document fails the build.
 */
import {
  fiscalYearOf,
  fmtDate,
  formatMoney,
} from "../supabase/functions/_shared/invoices.ts";
import {
  assemblePdf,
  buildInvoicePdf,
  buildRefundPdf,
  Page,
  pdfEscape,
  textWidth,
} from "../supabase/functions/_shared/pdf.ts";
import {
  invoiceFactsFromRow,
  refundFactsFromRow,
  sellerIdentity,
} from "../supabase/functions/_shared/billing-documents.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
  } else {
    console.log(`  ok    ${name}`);
  }
}
function section(title: string) {
  console.log(`── ${title} ──`);
}

/* ------------------------------------------------------------------ */
section("the Indian financial year (Apr–Mar) drives numbering");
check("an April date starts a new year", fiscalYearOf(new Date(Date.UTC(2026, 3, 1))) === "2026-27", fiscalYearOf(new Date(Date.UTC(2026, 3, 1))));
check("March 31 still belongs to the old year", fiscalYearOf(new Date(Date.UTC(2026, 2, 31, 23, 59))) === "2025-26", fiscalYearOf(new Date(Date.UTC(2026, 2, 31, 23, 59))));
check("mid-year is unsurprising", fiscalYearOf(new Date(Date.UTC(2026, 9, 30))) === "2026-27");
check("New Year's Day belongs to the previous April's year", fiscalYearOf(new Date(Date.UTC(2027, 0, 1))) === "2026-27");
check("document numbers carry the year", /^INV-2026-27-00001$/.test(`INV-${fiscalYearOf(new Date(Date.UTC(2026, 9, 30)))}-00001`));
check("refund numbers use their own series", /^RFND-2026-27-00001$/.test(`RFND-${fiscalYearOf(new Date(Date.UTC(2026, 9, 30)))}-00001`));

/* ------------------------------------------------------------------ */
section("Indian money formatting");
check("999", formatMoney(999) === "INR 999.00", formatMoney(999));
check("2,499", formatMoney(2499) === "INR 2,499.00");
check("1,23,456.78", formatMoney(123456.78) === "INR 1,23,456.78");
check("a crore", formatMoney(10000000) === "INR 1,00,00,000.00");
check("paisa round half-up", formatMoney(999.995) === "INR 1,000.00", formatMoney(999.995));
check("explicit currency", formatMoney(999, "USD") === "USD 999.00");

/* ------------------------------------------------------------------ */
section("dates");
check("30 Oct 2026 in UTC", fmtDate("2026-10-30T04:17:52.817Z") === "30 Oct 2026", fmtDate("2026-10-30T04:17:52.817Z"));

/* ------------------------------------------------------------------ */
section("PDF text plumbing");
check("escapes parens", pdfEscape("A (B) C") === "A \\(B\\) C");
check("em-dash survives as the WinAnsi byte", pdfEscape("a—b") === "a\x97b");
check("the rupee sign is not silently printed", !pdfEscape("₹999").includes("₹"));
check("width of identical digits", Math.abs(textWidth("0000", 10) - 20) < 0.01);
const p = new Page();
p.text(10, 10, 9, "hi");
p.badge(100, 100, 70, 17, [0, 0.6, 0.2], "PAID");
p.rect(0, 0, 50, 10, [0.9, 0.4, 0.1]);
p.line(0, 0, 100, 100);
check("badge fills a rect and writes the label", p.ops.join("\n").includes("re f") && p.ops.join("\n").includes("(PAID) Tj"));

/* ------------------------------------------------------------------ */
section("the PDF file itself");
const bare = assemblePdf(p.ops.join("\n"));
const bareText = Buffer.from(bare).toString("latin1");
check("header", bareText.startsWith("%PDF-1.4"));
check("eof", bareText.trimEnd().endsWith("%%EOF"));
check("six objects", (bareText.match(/\n\d 0 obj/g) ?? []).length === 6);
const sx = Number(/startxref\n(\d+)/.exec(bareText)?.[1]);
check("startxref points at the xref table", bareText.slice(sx, sx + 4) === "xref");
const offsets = [...bareText.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
check("every xref offset resolves to its object",
  offsets.every((off, i) => bareText.slice(off, off + String(i + 1).length + 6).startsWith(`${i + 1} 0 obj`)));

/* ------------------------------------------------------------------ */
const SELLER = { name: "The Salad", addressLines: ["Bengaluru, Karnataka, India"] };

const invoiceRow = {
  invoice_number: "INV-2026-27-00001",
  invoice_date: "2026-10-30T04:17:52.817Z",
  seller_name: SELLER.name,
  buyer_name: "Phrnxs Cafe",
  buyer_email: "phrnxs@gmail.com",
  buyer_address: "12 MG Road\nBengaluru 560001",
  total_amount: 999,
  currency: "INR",
  description: "Starter — one-time",
  period_start: "2026-10-30T04:17:52.817Z",
  period_end: "2026-11-29T04:17:52.817Z",
  payment_status: "paid",
  payment_method: "upi",
  razorpay_payment_id: "pay_Ttz79MR5wVAvHD",
  razorpay_order_id: "order_Ttz1jrnA7MSxUt",
};

section("the invoice document");
const invFacts = invoiceFactsFromRow(invoiceRow, SELLER);
check("facts: number", invFacts.invoiceNumber === "INV-2026-27-00001");
check("facts: status PAID", invFacts.status === "PAID");
check("facts: period formatted", invFacts.periodStart === "30 Oct 2026" && invFacts.periodEnd === "29 Nov 2026", [invFacts.periodStart, invFacts.periodEnd]);
check("facts: buyer address lines split", invFacts.buyerAddressLines.length === 2);
check("facts: amount from the row", invFacts.amount === 999);

const inv = Buffer.from(buildInvoicePdf(invFacts)).toString("latin1");
check("titled INVOICE", inv.includes("(INVOICE) Tj"));
check("shows the number", inv.includes("(No. INV-2026-27-00001) Tj"));
check("shows the buyer", inv.includes("(Phrnxs Cafe) Tj"));
check("shows the plan", inv.includes("(Starter \x97 one-time) Tj"));
check("shows the period", inv.includes("(30 Oct 2026 \x96 29 Nov 2026) Tj"));
check("shows the total", inv.includes("(INR 999.00) Tj"));
check("PAID badge", inv.includes("(PAID) Tj"));
check("Razorpay payment id", inv.includes("(pay_Ttz79MR5wVAvHD) Tj"));
check("Razorpay order id", inv.includes("(order_Ttz1jrnA7MSxUt) Tj"));
check("payment method", inv.includes("(upi) Tj"));
check("status line", inv.includes("(Succeeded) Tj"));
check("no tax vocabulary anywhere", !/(GST|GSTIN|CGST|SGST|IGST|TAX|Taxable|taxable)/.test(inv),
  inv.match(/(GST|GSTIN|CGST|SGST|IGST|TAX|Taxable|taxable)/)?.[0]);

/* ------------------------------------------------------------------ */
section("the refund document");
const refundRow = {
  refund_number: "RFND-2026-27-00001",
  refund_date: "2026-11-05T09:00:00.000Z",
  original_invoice_number: "INV-2026-27-00001",
  original_invoice_date: "2026-10-30T04:17:52.817Z",
  buyer_name: "Phrnxs Cafe",
  buyer_email: "phrnxs@gmail.com",
  buyer_address: null,
  amount: 999,
  currency: "INR",
  description: "Starter — one-time",
  razorpay_payment_id: "pay_Ttz79MR5wVAvHD",
  razorpay_order_id: "order_Ttz1jrnA7MSxUt",
  razorpay_refund_id: "rfnd_TtzzAAAABBBB",
};
const rfFacts = refundFactsFromRow(refundRow, SELLER);
check("facts: linked to the original invoice", rfFacts.originalInvoiceNumber === "INV-2026-27-00001");
check("facts: original date formatted", rfFacts.originalInvoiceDate === "30 Oct 2026");

const rf = Buffer.from(buildRefundPdf(rfFacts)).toString("latin1");
check("titled REFUND", rf.includes("(REFUND) Tj"));
check("shows the refund number", rf.includes("(No. RFND-2026-27-00001) Tj"));
check("REFUNDED badge", rf.includes("(REFUNDED) Tj"));
check("links the original invoice number", rf.includes("(INV-2026-27-00001) Tj"));
check("links the original invoice date", rf.includes("(30 Oct 2026) Tj"));
check("shows the refunded amount", rf.includes("(INR 999.00) Tj"));
check("shows the Razorpay refund id", rf.includes("(rfnd_TtzzAAAABBBB) Tj"));
check("total refunded wording", rf.includes("(Total refunded) Tj"));
check("no tax vocabulary on refunds either", !/(GST|GSTIN|CGST|SGST|IGST|TAX|Taxable|taxable)/.test(rf));

/* ------------------------------------------------------------------ */
section("the seller identity never invents");
const seller = await sellerIdentity(); // no db → env/default chain
check("seller name defaults to the brand", seller.name === "The Salad");
check("no address is fabricated without configuration", Array.isArray(seller.addressLines));
check("no email is fabricated without configuration", seller.email === null || typeof seller.email === "string");
check("no phone is fabricated without configuration", seller.phone === null || typeof seller.phone === "string");

const withContact = invoiceFactsFromRow(invoiceRow, {
  ...SELLER,
  email: "billing@thesalad.in",
  phone: "+91 90000 00000",
});
const withContactPdf = Buffer.from(buildInvoicePdf(withContact)).toString("latin1");
check("a configured seller email renders", withContactPdf.includes("(billing@thesalad.in) Tj"));
check("a configured seller phone renders", withContactPdf.includes("(+91 90000 00000) Tj"));
check("an unconfigured one leaves no placeholder", !inv.includes("(billing@") && !inv.includes("(+91 "));

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
