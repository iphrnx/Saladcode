/**
 * Offline checks for the platform business details — the Super Admin →
 * Settings → Billing & Invoices form and the seller identity it feeds.
 * Run: npm run test:platform-details
 */
import assert from "node:assert/strict";
import {
  businessDetailsConfigured,
  composeBusinessAddressLines,
  validateBusinessDetails,
} from "../supabase/functions/_shared/platform-details.ts";
import { invoiceFactsFromRow, sellerIdentity } from "../supabase/functions/_shared/billing-documents.ts";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}: ${(e as Error).message}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const VALID = {
  legalName: "Priyanshu Foods",
  street: "12, 4th Cross, Indiranagar",
  city: "Bengaluru",
  state: "Karnataka",
  pinCode: "560038",
  country: "India",
  email: "Billing@TheSalad.in",
  phone: "+91 90000-00000",
  gstin: "29abcde1234f1z5",
};

section("validation accepts a complete, honest form");
{
  const v = validateBusinessDetails(VALID);
  check("a complete form passes", () => assert.equal(v.ok, true));
  if (v.ok) {
    check("the email is normalised to lower case", () => assert.equal(v.value.email, "billing@thesalad.in"));
    check("the GSTIN is normalised to upper case", () => assert.equal(v.value.gstin, "29ABCDE1234F1Z5"));
    check("the phone is stored compact", () => assert.equal(v.value.phone, "+919000000000"));
  }
  check("GSTIN is optional", () => {
    const r = validateBusinessDetails({ ...VALID, gstin: "" });
    assert.equal(r.ok, true);
  });
}

section("validation rejects what should not save");
{
  const bad = (patch: Record<string, string>) => validateBusinessDetails({ ...VALID, ...patch });
  check("a missing legal name is caught", () => {
    const r = bad({ legalName: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.legalName);
  });
  check("a missing street is caught", () => {
    const r = bad({ street: "  " });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.street);
  });
  check("a 5-digit Indian PIN is caught", () => {
    const r = bad({ pinCode: "56003" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.pinCode);
  });
  check("a foreign country gets flexible postal rules", () => {
    const r = bad({ country: "Singapore", pinCode: "018956" });
    assert.equal(r.ok, true);
  });
  check("a broken email is caught", () => {
    const r = bad({ email: "billing@" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.email);
  });
  check("a broken phone is caught", () => {
    const r = bad({ phone: "900" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.phone);
  });
  check("a malformed GSTIN is caught", () => {
    const r = bad({ gstin: "29ABCDE1234F1Z" }); // 14 chars
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.gstin);
  });
  check("several errors come back together, keyed by field", () => {
    const r = validateBusinessDetails({});
    assert.equal(r.ok, false);
    if (!r.ok) {
      for (const f of ["legalName", "street", "city", "state", "pinCode", "email", "phone"]) {
        assert.ok(r.errors[f], `expected an error for ${f}`);
      }
    }
  });
}

section("the address composes into document lines");
{
  check("a full address is three lines", () => {
    assert.deepEqual(composeBusinessAddressLines({
      street: "12, 4th Cross, Indiranagar",
      city: "Bengaluru",
      state: "Karnataka",
      pin_code: "560038",
      country: "India",
    }), ["12, 4th Cross, Indiranagar", "Bengaluru, Karnataka – 560038", "India"]);
  });
  check("empty parts drop out rather than leaving commas", () => {
    assert.deepEqual(composeBusinessAddressLines({
      street: "", city: "Bengaluru", state: "", pin_code: "", country: "India",
    }), ["Bengaluru", "India"]);
  });
}

section("the seller identity follows the chain of authority");
{
  const dbWith = (row: any) => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
    }),
  });

  check("a configured row wins, with the composed address", async () => {
    const s = await sellerIdentity(dbWith({
      legal_name: "Priyanshu Foods",
      street: "12, 4th Cross", city: "Bengaluru", state: "Karnataka",
      pin_code: "560038", country: "India",
      email: "billing@thesalad.in", phone: "+919000000000",
    }));
    assert.equal(s.name, "Priyanshu Foods");
    assert.deepEqual(s.addressLines, ["12, 4th Cross", "Bengaluru, Karnataka – 560038", "India"]);
    assert.equal(s.email, "billing@thesalad.in");
    assert.equal(s.phone, "+919000000000");
  });

  check("an unconfigured row falls through to the env/default identity", async () => {
    const s = await sellerIdentity(dbWith({ legal_name: "" }));
    assert.equal(s.name, "The Salad");
  });

  check("a failed read never blocks issuance", async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }) };
    const s = await sellerIdentity(broken);
    assert.equal(s.name, "The Salad");
  });

  check("no db at all uses the env/default identity", async () => {
    const s = await sellerIdentity();
    assert.equal(s.name, "The Salad");
  });

  check("a row without a legal name is not 'configured'", () => {
    assert.equal(businessDetailsConfigured({ legal_name: "  " }), false);
    assert.equal(businessDetailsConfigured({ legal_name: "Priyanshu Foods" }), true);
  });
}

section("issued documents keep the identity they were issued with");
{
  const live = { name: "New Name Pvt Ltd", addressLines: ["New Street"], email: "new@co.in", phone: "+911111111111" };
  const row = {
    invoice_number: "INV-2026-27-00002",
    invoice_date: "2026-10-30T00:00:00Z",
    seller_name: "Priyanshu Foods",
    seller_address: "Old Street\nBengaluru, Karnataka – 560038\nIndia",
    seller_email: "old@co.in",
    seller_phone: "+910000000000",
    buyer_name: "Cafe", buyer_email: "cafe@x.in", buyer_address: null,
    description: "Pro", total_amount: 1999, currency: "INR",
    period_start: null, period_end: null,
    razorpay_payment_id: "pay_x", razorpay_order_id: "order_x", payment_method: "upi",
  };
  check("the row snapshot beats the live identity", () => {
    const f = invoiceFactsFromRow(row, live);
    assert.equal(f.sellerName, "Priyanshu Foods");
    assert.equal(f.sellerAddressLines[0], "Old Street");
    assert.equal(f.sellerEmail, "old@co.in");
    assert.equal(f.sellerPhone, "+910000000000");
  });
  check("a legacy row without a snapshot falls back to the live identity", () => {
    const f = invoiceFactsFromRow({ ...row, seller_name: "", seller_address: null, seller_email: "", seller_phone: "" }, live);
    assert.equal(f.sellerName, "New Name Pvt Ltd");
    assert.equal(f.sellerEmail, "new@co.in");
  });
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
