/**
 * Transactional email: what each message says, and the rules around it.
 *
 * Pure — no database, no provider. The dispatcher's behaviour is asserted
 * separately against the live queue.
 */
import { emailConfigured, emailConfig, renderEmail, validateEmailConfig, type EmailEvent } from "../supabase/functions/_shared/email.ts";

// A configured deployment, as the edge runtime would see it.
process.env.SITE_URL = "https://app.example.test";
process.env.SUPPORT_EMAIL = "help@example.test";
process.env.RESEND_FROM = "The Salad <billing@example.test>";
process.env.RESEND_REPLY_TO = "replies@example.test";
process.env.RESEND_API_KEY = "re_test";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};

const base: Omit<EmailEvent, "eventType"> = {
  eventKey: "k", tenantId: "t", recipient: "owner@example.com",
  recipientName: "Priya", restaurantName: "Spice Garden",
  planName: "starter", amount: 9990, currency: "INR", billingInterval: "annual",
  payload: { periodEnd: "2027-11-01T00:00:00Z", daysBefore: 7, trialEndsAt: "2026-11-15T00:00:00Z", paymentRef: "pay_123", reason: "Card declined", effectiveAt: "2026-12-01T00:00:00Z", deletedAt: "2026-11-01T00:00:00Z", invoiceNumber: "INV-2026-0001", invoiceDate: "2026-11-01T00:00:00Z", refundNumber: "RFND-2026-0001", refundId: "rfnd_x", refundedAt: "2026-11-01T00:00:00Z" },
};
const types = [
  "subscription_activated", "plan_changed", "payment_succeeded", "payment_failed",
  "subscription_cancelled", "renewal_reminder", "trial_started", "trial_ending",
  "trial_ended", "account_deleted", "invoice_issued", "payment_refunded",
];

console.log("\n── every template ──");
for (const t of types) {
  const r = renderEmail({ ...base, eventType: t });
  const html = r.html ?? "";
  check(`${t}: has a subject`, r.subject.length > 5, r.subject);
  check(`${t}: branded`, html.includes("The Salad") && html.includes("#f97316"));
  check(`${t}: names the restaurant`, html.includes("Spice Garden"));
  check(`${t}: has plain text`, r.text.length > 20 && !/<[a-z]/i.test(r.text));
  check(`${t}: has a support route`, html.includes("mailto:") && /support|Manage billing/i.test(html));
  check(`${t}: has an action`, /href="https?:\/\//.test(html));
  check(`${t}: no template placeholders left`, !/undefined|\[object Object\]|NaN/.test(html + r.text));
}

console.log("\n── money and dates ──");
{
  const r = renderEmail({ ...base, eventType: "subscription_activated" });
  check("amount is rendered in rupees", r.html.includes("9,990"), "expected 9,990");
  check("period end is a readable date", /Nov 2027/.test(r.html), "");
  const monthly = renderEmail({ ...base, eventType: "subscription_activated", amount: 999, billingInterval: "monthly" });
  check("monthly says per month", monthly.html.includes("/ month"), "");
  check("annual says pay once, not auto-debit", r.html.includes("Pay once, no auto-debit"), "");
}

console.log("\n── the wording that matters ──");
{
  const reminder = renderEmail({ ...base, eventType: "renewal_reminder" });
  check("a renewal reminder never claims it renews itself", !/renews automatically/i.test(reminder.html + reminder.text));
  check("it says the plan ends", /ends on/i.test(reminder.html));
  const failed = renderEmail({ ...base, eventType: "payment_failed" });
  check("a failed payment carries the reason", failed.html.includes("Card declined"));
  check("and does not claim access has ended", !/access (has ended|is over)/i.test(failed.html));
  const deleted = renderEmail({ ...base, eventType: "account_deleted" });
  check("the deletion mail says what was removed", /permanently removed/i.test(deleted.html));
  check("and offers a 'did not request this' route", /did not request/i.test(deleted.html));
  check("no session or account ids leak into any template",
    types.every((t) => !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(renderEmail({ ...base, eventType: t }).html)));
}

console.log("\n── configuration, not code ──");
{
  const cfg = emailConfig();
  check("the sender comes from RESEND_FROM", cfg.from === "The Salad <billing@example.test>", cfg.from);
  check("the reply-to comes from RESEND_REPLY_TO", cfg.replyTo === "replies@example.test", cfg.replyTo);
  check("configured only when key AND sender exist", emailConfigured() === true);

  // A different verified domain later: no code change, just secrets.
  process.env.RESEND_FROM = "The Salad <billing@newdomain.test>";
  process.env.SITE_URL = "https://newdomain.test";
  delete process.env.SUPPORT_EMAIL;
  const moved = emailConfig();
  const rendered = renderEmail({ ...base, eventType: "subscription_activated" });
  check("changing RESEND_FROM changes the sender immediately", moved.from.includes("newdomain.test"), moved.from);
  check("the email now points at the new domain", rendered.html.includes("https://newdomain.test/?view=settings"));
  check("and nowhere mentions the old one", !/app\.example\.test|restrofi|thesalad/.test(rendered.html), "");
  check("reply-to falls back to nothing rather than an invented address", moved.support === "replies@example.test");

  // Nothing configured: no sender means nothing is sent.
  delete process.env.RESEND_FROM;
  check("an unset sender means not configured", emailConfigured() === false);
  check("and no default sender is invented", emailConfig().from === "", JSON.stringify(emailConfig().from));

  process.env.RESEND_FROM = "The Salad <billing@example.test>";
  process.env.SUPPORT_EMAIL = "help@example.test";
  delete process.env.RESEND_REPLY_TO;
  const noReply = emailConfig();
  check("an unset reply-to stays unset", noReply.replyTo === "", JSON.stringify(noReply.replyTo));
  check("support falls back to SUPPORT_EMAIL", noReply.support === "help@example.test", noReply.support);
}

console.log("\n── configuration is validated before sending ──");
{
  check("a good configuration passes", validateEmailConfig().ok === true, JSON.stringify(validateEmailConfig()));

  const cases: Array<[string, () => void, string, RegExp]> = [
    ["a sender with no domain", () => { process.env.RESEND_FROM = "The Salad"; }, "RESEND_FROM", /RESEND_FROM/],
    ["an empty sender", () => { delete process.env.RESEND_FROM; }, "no sender", /RESEND_FROM is not set/],
    ["a malformed reply-to", () => { process.env.RESEND_REPLY_TO = "not-an-address"; }, "reply-to", /RESEND_REPLY_TO/],
    ["a site without a scheme", () => { process.env.SITE_URL = "thesalad.in"; }, "site", /SITE_URL/],
    ["a malformed support address", () => { process.env.SUPPORT_EMAIL = "nope@"; }, "support", /SUPPORT_EMAIL/],
  ];
  // Capture once: capturing per iteration would restore the *previous*
  // mutation and let one bad value leak into the next case.
  const clean = {
    RESEND_FROM: process.env.RESEND_FROM,
    RESEND_REPLY_TO: process.env.RESEND_REPLY_TO,
    SITE_URL: process.env.SITE_URL,
    SUPPORT_EMAIL: process.env.SUPPORT_EMAIL,
  };
  for (const [label, mutate, , pattern] of cases) {
    mutate();
    const result = validateEmailConfig();
    const message = result.ok ? "" : result.problems.join("; ");
    check(`refuses ${label}`, result.ok === false && pattern.test(message), message);
    // Restore by assignment *or* deletion: assigning undefined would store the
    // string "undefined" and quietly poison the next case.
    for (const [k, v] of Object.entries(clean)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // A "Name <addr>" sender is valid, a bare address is valid, a name alone is not.
  process.env.RESEND_FROM = "billing@example.test";
  check("a bare sender address is accepted", validateEmailConfig().ok === true);
  process.env.RESEND_FROM = "The Salad <billing@example.test>";
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
