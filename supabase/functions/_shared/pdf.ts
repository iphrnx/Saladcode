/**
 * Branded invoice and refund PDFs, written by hand as PDF 1.4 with the
 * built-in Helvetica fonts. No dependency, no network: given the facts
 * the same document comes out every time, which is what an immutable
 * financial record needs. Text is WinAnsi (Latin-1) — safe for names,
 * addresses and punctuation; the rupee sign is not in the font, so
 * amounts print as "INR 999.00".
 */

import { formatMoney, type InvoiceFacts, type RefundFacts } from "./invoices.ts";

export function pdfEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else if (ch === "\\") out += "\\\\";
    // WinAnsi (CP1252) has the typographic punctuation plan names and
    // addresses actually use — emit the real byte, not an ASCII stand-in.
    else if (code === 0x2013) out += "\x96";      // en dash
    else if (code === 0x2014) out += "\x97";      // em dash
    else if (code === 0x2018) out += "\x91";      // '
    else if (code === 0x2019) out += "\x92";      // '
    else if (code === 0x201c) out += "\x93";      // "
    else if (code === 0x201d) out += "\x94";      // "
    else if (code === 0x2022) out += "\x95";      // •
    else if (code === 0x2026) out += "\x85";      // …
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else out += "?";
  }
  return out;
}

const CHAR_WIDTHS: Record<string, number> = {
  " ": 250, "!": 333, '"': 333, "#": 500, "$": 500, "%": 833, "&": 667, "'": 167,
  "(": 333, ")": 333, "*": 500, "+": 570, ",": 250, "-": 333, ".": 250, "/": 278,
  "0": 500, "1": 500, "2": 500, "3": 500, "4": 500, "5": 500, "6": 500, "7": 500,
  "8": 500, "9": 500, ":": 250, ";": 250, "<": 570, "=": 570, ">": 570, "?": 500,
  "@": 832, "A": 667, "B": 667, "C": 667, "D": 722, "E": 667, "F": 611, "G": 722,
  "H": 722, "I": 250, "J": 500, "K": 667, "L": 556, "M": 833, "N": 722, "O": 722,
  "P": 611, "Q": 722, "R": 667, "S": 611, "T": 611, "U": 722, "V": 667, "W": 944,
  "X": 667, "Y": 611, "Z": 611, "[": 333, "\\": 278, "]": 333, "^": 570, "_": 500,
  "`": 333, "a": 500, "b": 500, "c": 444, "d": 500, "e": 500, "f": 278, "g": 500,
  "h": 500, "i": 222, "j": 222, "k": 444, "l": 222, "m": 778, "n": 500, "o": 500,
  "p": 500, "q": 500, "r": 278, "s": 444, "t": 278, "u": 500, "v": 444, "w": 722,
  "x": 444, "y": 444, "z": 444, "{": 500, "|": 250, "}": 500, "~": 570,
};

export function textWidth(s: string, size: number): number {
  let width = 0;
  for (const ch of s) width += CHAR_WIDTHS[ch] ?? 500;
  return (width * size) / 1000;
}

type Rgb = [number, number, number];
const INK: Rgb = [0.106, 0.125, 0.173];          // near-black slate
const MUTED: Rgb = [0.42, 0.45, 0.50];           // gray labels
const ORANGE: Rgb = [0.976, 0.451, 0.086];       // The Salad #F97316
const BAND: Rgb = [0.122, 0.161, 0.216];         // header charcoal
const BAND_TEXT: Rgb = [0.78, 0.81, 0.85];       // header secondary
const WHITE: Rgb = [1, 1, 1];
const PANEL: Rgb = [0.953, 0.957, 0.965];        // light panel
const RULE: Rgb = [0.85, 0.86, 0.89];
const PAID_GREEN: Rgb = [0.086, 0.639, 0.29];
const REFUND_SLATE: Rgb = [0.278, 0.333, 0.412];

export class Page {
  ops: string[] = [];
  text(x: number, y: number, size: number, s: string, bold = false, color: Rgb = INK) {
    const [r, g, b] = color;
    this.ops.push(
      `${r} ${g} ${b} rg BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfEscape(s)}) Tj ET`,
    );
  }
  right(x: number, y: number, size: number, s: string, bold = false, color: Rgb = INK) {
    this.text(x - textWidth(s, size), y, size, s, bold, color);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.7, color: Rgb = RULE) {
    const [r, g, b] = color;
    this.ops.push(`${r} ${g} ${b} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number, color: Rgb) {
    const [r, g, b] = color;
    this.ops.push(`${r} ${g} ${b} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  badge(x: number, y: number, w: number, h: number, color: Rgb, label: string) {
    this.rect(x, y, w, h, color);
    const size = 8.5;
    this.text(x + (w - textWidth(label, size)) / 2, y + (h - size) / 2 + 2.5, size, label, true, WHITE);
  }
}

// ---- layout metrics ----
// One scale, used by every section, so spacing and alignment stay
// consistent no matter how tall the content above a section is.
// Sections flow: each takes the y it should start at and returns the y
// the next section may start from — nothing is pinned mid-page, so a
// tall FROM block can never crowd or collide with the table below it.
const MARGIN = 50;              // left/right page margin
const RIGHT = 545;              // right page edge of the content area
const COLUMN_X = 330;           // second column: BILLED TO, BILLING PERIOD, totals
const TEXT_RIGHT = RIGHT - 10;  // right edge of text inside panels/rules
const LEADING = 13;             // line height for 9pt body text
const GAP_SECTION = 28;         // whitespace between major sections
const PARTIES_TOP = 710;        // first section below the fixed header band

function headerBand(p: Page, docTitle: string, number: string, date: string) {
  p.rect(0, 750, 595, 92, BAND);
  p.text(MARGIN, 800, 22, "The Salad", true, WHITE);
  p.text(MARGIN, 784, 8.5, "Restaurant management platform", false, BAND_TEXT);
  p.right(RIGHT, 800, 15, docTitle, true, WHITE);
  p.right(RIGHT, 800 - LEADING, 9, `No. ${number}`, false, BAND_TEXT);
  p.right(RIGHT, 800 - 2 * LEADING, 9, date, false, BAND_TEXT);
  p.rect(0, 744, 595, 3, ORANGE);
}

function parties(p: Page, f: { sellerName: string; sellerAddressLines: string[]; sellerEmail?: string | null; sellerPhone?: string | null; buyerName: string; buyerEmail: string | null; buyerAddressLines: string[] }): number {
  p.text(MARGIN, PARTIES_TOP, 7.5, "FROM", true, MUTED);
  p.text(COLUMN_X, PARTIES_TOP, 7.5, "BILLED TO", true, MUTED);
  const nameY = PARTIES_TOP - 16;
  p.text(MARGIN, nameY, 11, f.sellerName, true);
  p.text(COLUMN_X, nameY, 11, f.buyerName, true);

  let sellerY = nameY - 14;
  for (const line of f.sellerAddressLines.slice(0, 4)) { p.text(MARGIN, sellerY, 9, line); sellerY -= LEADING; }
  if (f.sellerEmail) { p.text(MARGIN, sellerY, 9, f.sellerEmail); sellerY -= LEADING; }
  if (f.sellerPhone) { p.text(MARGIN, sellerY, 9, f.sellerPhone); sellerY -= LEADING; }

  let buyerY = nameY - 14;
  if (f.buyerEmail) { p.text(COLUMN_X, buyerY, 9, f.buyerEmail); buyerY -= LEADING; }
  for (const line of f.buyerAddressLines.slice(0, 3)) { p.text(COLUMN_X, buyerY, 9, line); buyerY -= LEADING; }

  return Math.min(sellerY, buyerY);
}

function amountTable(p: Page, top: number, planName: string, period: string | null, money: string): number {
  p.line(MARGIN, top, RIGHT, top);
  const bandBottom = top - 8 - 20;
  p.rect(MARGIN, bandBottom, RIGHT - MARGIN, 20, PANEL);
  p.text(MARGIN + 10, bandBottom + 6.5, 7.5, "DESCRIPTION", true, MUTED);
  p.text(COLUMN_X, bandBottom + 6.5, 7.5, "BILLING PERIOD", true, MUTED);
  p.right(TEXT_RIGHT, bandBottom + 6.5, 7.5, "AMOUNT", true, MUTED);
  const rowY = bandBottom - 22;
  p.text(MARGIN + 10, rowY, 10, planName, true);
  if (period) p.text(COLUMN_X, rowY, 9, period);
  p.right(TEXT_RIGHT, rowY, 10, money);
  const bottom = rowY - 18;
  p.line(MARGIN, bottom, RIGHT, bottom);
  return bottom;
}

function totals(p: Page, top: number, label: string, money: string): number {
  p.line(COLUMN_X, top, TEXT_RIGHT, top, 1.2, ORANGE);
  const y = top - 18;
  p.text(COLUMN_X, y, 11, label, true);
  p.right(TEXT_RIGHT, y, 11, money, true);
  return y;
}

function paymentBox(p: Page, top: number, title: string, rows: Array<[string, string | null]>): number {
  const height = 34 + rows.length * 15;
  p.rect(MARGIN, top - height, RIGHT - MARGIN, height, PANEL);
  p.text(MARGIN + 12, top - 18, 7.5, title, true, MUTED);
  let y = top - 36;
  for (const [label, value] of rows) {
    p.text(MARGIN + 12, y, 9, label, false, MUTED);
    p.text(220, y, 9, value ?? "—");
    y -= 15;
  }
  return top - height;
}

/**
 * The domain printed in the footer of every invoice and refund document.
 *
 * Configuration, not a constant: a business that moves to a new domain should
 * not have to ship a code change to stop printing the old one on its invoices.
 * Falls back to nothing rather than to a domain that may no longer be ours.
 */
function siteHost(): string {
  const g = globalThis as any;
  const raw = String(g?.Deno?.env?.get?.("SITE_URL") ?? g?.process?.env?.SITE_URL ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function footer(p: Page, notes: string[]) {
  p.line(MARGIN, 128, RIGHT, 128);
  let y = 112;
  for (const note of notes.slice(0, 3)) { p.text(MARGIN, y, 7.5, note, false, MUTED); y -= 11; }
  const host = siteHost();
  const line = host ? `The Salad  ·  ${host}` : "The Salad";
  p.text(595 / 2 - textWidth(line, 7.5) / 2, 60, 7.5, line, false, MUTED);
}

export function buildInvoicePdf(f: InvoiceFacts): Uint8Array {
  const p = new Page();
  headerBand(p, "INVOICE", f.invoiceNumber, f.invoiceDate);
  p.badge(475, PARTIES_TOP - 4, 70, 17, PAID_GREEN, "PAID");
  const afterParties = parties(p, f);
  const period = f.periodStart && f.periodEnd ? `${f.periodStart} – ${f.periodEnd}` : null;
  const afterTable = amountTable(p, afterParties - GAP_SECTION, f.planName, period, formatMoneyFacts(f));
  const totalsBaseline = totals(p, afterTable - 24, "Total paid", formatMoneyFacts(f));
  paymentBox(p, totalsBaseline - 40, "PAYMENT DETAILS", [
    ["Razorpay payment ID", f.razorpayPaymentId],
    ["Razorpay order ID", f.razorpayOrderId],
    ["Method", f.paymentMethod],
    ["Paid on", f.paidOn],
    ["Status", "Succeeded"],
  ]);
  footer(p, [
    "This is a computer-generated invoice for a payment made through Razorpay.",
    "The amounts and reference numbers above are recorded exactly as the payment was settled.",
  ]);
  return assemblePdf(p.ops.join("\n"));
}

export function buildRefundPdf(f: RefundFacts): Uint8Array {
  const p = new Page();
  headerBand(p, "REFUND", f.refundNumber, f.refundDate);
  p.badge(455, PARTIES_TOP - 4, 90, 17, REFUND_SLATE, "REFUNDED");
  const afterParties = parties(p, f);
  const afterTable = amountTable(p, afterParties - GAP_SECTION, f.planName, null, formatMoneyFacts(f));
  const totalsBaseline = totals(p, afterTable - 24, "Total refunded", formatMoneyFacts(f));
  const afterInvoiceBox = paymentBox(p, totalsBaseline - 40, "ORIGINAL INVOICE", [
    ["Invoice number", f.originalInvoiceNumber],
    ["Invoice date", f.originalInvoiceDate],
  ]);
  paymentBox(p, afterInvoiceBox - 16, "REFUND DETAILS", [
    ["Razorpay refund ID", f.razorpayRefundId],
    ["Razorpay payment ID", f.razorpayPaymentId],
    ["Razorpay order ID", f.razorpayOrderId],
    ["Refunded on", f.refundDate],
    ["Status", "Refunded"],
  ]);
  footer(p, [
    "This document records a refund of the payment on the original invoice referenced above.",
    "Both documents together are the complete record of the transaction.",
  ]);
  return assemblePdf(p.ops.join("\n"));
}

function formatMoneyFacts(f: { amount: number; currency: string }): string {
  return formatMoney(f.amount, f.currency);
}

export function assemblePdf(content: string): Uint8Array {
  const objs: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>");
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
