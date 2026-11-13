// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Transactional email: one dispatcher, one set of templates, one ledger.
 *
 * Every email is *queued* before it is sent. The queue row is keyed by the
 * event it describes (`event_key`), so a webhook Razorpay delivers twice, or a
 * reminder job that runs twice in a minute, can only produce one email — the
 * second insert hits a unique index and is dropped. Sending then happens from
 * the ledger, which is also what makes a retry possible and observable.
 *
 * These are billing and security notices. They are not marketing, so they are
 * not subject to unsubscribe preferences, and nothing here consults one.
 */

const RESEND_API = "https://api.resend.com/emails";

/**
 * Read a setting from whichever runtime we are in.
 *
 * The edge runtime exposes `Deno.env`; the offline test suite runs the same
 * file under Node. Reaching for one runtime directly would make the templates
 * untestable, and templates are exactly the part that should be testable.
 */
function env(name: string): string {
  const g = globalThis as any;
  const value = g?.Deno?.env?.get?.(name) ?? g?.process?.env?.[name] ?? "";
  return String(value).trim();
}

export function emailConfig() {
  const key = env("RESEND_API_KEY");
  /**
   * The sender is configuration, never code.
   *
   * There is deliberately no fallback address: a default would be an
   * unverified sender that silently ships from the wrong domain, and moving to
   * a new sending domain must cost a DNS record and a secret — not a deploy.
   * With `RESEND_FROM` unset the dispatcher is simply not configured, and says
   * so instead of sending from somewhere nobody chose.
   */
  const from = env("RESEND_FROM");
  /** Replies go to a person. Optional: an unset reply-to is better than an
   * invented address that nobody reads. */
  const replyTo = env("RESEND_REPLY_TO");
  /** Where the buttons point. Unset means the email carries no link rather
   * than a hardcoded domain that may no longer be ours. */
  const site = env("SITE_URL");
  /** The address printed in the footer, for people who want to write back. */
  const support = env("SUPPORT_EMAIL") || replyTo;
  return { key, from, replyTo, site, support };
}

export function emailConfigured(): boolean {
  const { key, from } = emailConfig();
  return Boolean(key && from);
}

/**
 * Check the configuration before anything is sent.
 *
 * A malformed sender reaches the provider as a rejection that looks like a
 * delivery failure; a `SITE_URL` with no scheme produces links that go
 * nowhere. Both are cheaper to catch here than to discover in someone's inbox,
 * and catching them turns a silent misconfiguration into one clear error on
 * every queued row.
 */
export function validateEmailConfig(): { ok: true } | { ok: false; problems: string[] } {
  const { key, from, replyTo, site, support } = emailConfig();
  const problems: string[] = [];
  const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  // "Name <addr>" or a bare address — both are valid senders.
  const senderAddress = (value: string) => {
    const m = value.match(/<([^>]+)>/);
    return (m ? m[1] : value).trim();
  };

  if (!key) problems.push("RESEND_API_KEY is not set");
  if (!from) problems.push("RESEND_FROM is not set");
  else if (!ADDRESS.test(senderAddress(from))) problems.push("RESEND_FROM is not a usable address");
  if (replyTo && !ADDRESS.test(senderAddress(replyTo))) problems.push("RESEND_REPLY_TO is not a usable address");
  if (support && !ADDRESS.test(senderAddress(support))) problems.push("SUPPORT_EMAIL is not a usable address");
  if (site && !/^https?:\/\/[^\s]+$/i.test(site)) problems.push("SITE_URL must be an absolute http(s) URL");

  return problems.length ? { ok: false, problems } : { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Templates                                                          */
/* ------------------------------------------------------------------ */

export type EmailEvent = {
  eventKey: string;
  eventType: string;
  tenantId: string | null;
  recipient: string;
  recipientName?: string | null;
  restaurantName?: string | null;
  planName?: string | null;
  amount?: number | null;
  currency?: string | null;
  billingInterval?: string | null;
  payload?: Record<string, unknown>;
};

type Rendered = { subject: string; html: string; text: string };

function money(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "";
  const symbol = (currency ?? "INR") === "INR" ? "\u20b9" : `${currency} `;
  return `${symbol}${Number(amount).toLocaleString("en-IN")}`;
}

function fmtDate(value: unknown): string {
  if (!value) return "";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The frame every email shares: brand bar, restaurant, the point of the
 * message, one action, and how to reach a human. Table-based with inline
 * styles because email clients are twenty years behind the web.
 */
function frame(opts: {
  heading: string;
  intro: string;
  rows?: Array<[string, string]>;
  cta?: { label: string; href: string };
  footnote?: string;
}): string {
  const { site, support } = emailConfig();
  const rows = (opts.rows ?? [])
    .filter(([, v]) => Boolean(v))
    .map(
      ([k, v]) => `<tr>
        <td style="padding:6px 0;color:#6b7280;font-size:13px;">${k}</td>
        <td style="padding:6px 0;color:#111827;font-size:13px;font-weight:600;text-align:right;">${v}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr><td style="background:#f97316;padding:16px 22px;">
          <span style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:-0.2px;">The Salad</span>
        </td></tr>
        <tr><td style="padding:22px;">
          <h1 style="margin:0 0 8px;font-size:18px;color:#111827;">${opts.heading}</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;">${opts.intro}</p>
          ${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0f3;border-bottom:1px solid #eef0f3;margin:0 0 18px;">${rows}</table>` : ""}
          ${
            opts.cta && opts.cta.href
              ? `<a href="${opts.cta.href}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:10px;font-size:14px;font-weight:600;">${opts.cta.label}</a>`
              : ""
          }
          ${opts.footnote ? `<p style="margin:16px 0 0;font-size:12.5px;line-height:1.6;color:#6b7280;">${opts.footnote}</p>` : ""}
        </td></tr>
        <tr><td style="padding:14px 22px;background:#fafafa;border-top:1px solid #eef0f3;">
          <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.6;">
            Sent by The Salad for your restaurant account.${
              support
                ? ` Need help? Reply to this email or write to <a href="mailto:${support}" style="color:#f97316;text-decoration:none;">${support}</a>.`
                : ""
            }${
              site
                ? `<br /><a href="${site}/?view=settings" style="color:#6b7280;">Manage billing and account</a>`
                : ""
            }
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Render one event to subject, HTML and plain text. */
export function renderEmail(event: EmailEvent): Rendered {
  const { site } = emailConfig();
  const restaurant = event.restaurantName || "your restaurant";
  const plan = event.planName || "your plan";
  const price = money(event.amount, event.currency);
  const cycle = event.billingInterval === "annual" ? "year" : "month";
  const p = (event.payload ?? {}) as Record<string, any>;
  const billingUrl = site ? `${site}/?view=settings` : "";

  switch (event.eventType) {
    case "subscription_activated":
      return {
        subject: `Your The Salad ${plan} plan is active`,
        html: frame({
          heading: `You're on ${plan}`,
          intro: `Thanks — <strong>${restaurant}</strong> is now on the ${plan} plan. Everything you had is still there, and the features you just bought are on.`,
          rows: [
            ["Plan", plan],
            ["Amount", price ? `${price} / ${cycle}` : ""],
            ["Billing", event.billingInterval === "annual" ? "Pay once, no auto-debit" : "AutoPay, renews automatically"],
            ["Paid through", fmtDate(p.periodEnd)],
          ],
          cta: { label: "Manage billing", href: billingUrl },
        }),
        text: `You're on ${plan}\n\n${restaurant} is now on the ${plan} plan.${price ? `\nAmount: ${price} / ${cycle}` : ""}${p.periodEnd ? `\nPaid through: ${fmtDate(p.periodEnd)}` : ""}\n\nManage billing: ${billingUrl}`,
      };

    case "plan_changed":
      return {
        subject: `Your The Salad plan changes to ${plan}`,
        html: frame({
          heading: `Switching to ${plan}`,
          intro: `The plan for <strong>${restaurant}</strong> changes to ${plan} at the end of your current billing period. Nothing extra is charged today.`,
          rows: [
            ["New plan", plan],
            ["Amount", price ? `${price} / ${cycle}` : ""],
            ["Takes effect", fmtDate(p.effectiveAt)],
          ],
          cta: { label: "Manage billing", href: billingUrl },
        }),
        text: `Switching to ${plan}\n\n${restaurant} moves to ${plan} at the end of the current period (${fmtDate(p.effectiveAt)}). Nothing is charged today.\n\n${billingUrl}`,
      };

    case "payment_succeeded":
      return {
        subject: `Payment received — ${price || plan}`,
        html: frame({
          heading: "Payment received",
          intro: `We've received your payment for <strong>${restaurant}</strong>. Your access is extended to the date below.`,
          rows: [
            ["Plan", plan],
            ["Amount", price],
            ["Paid on", fmtDate(p.paidAt) ?? ""],
            ["Paid through", fmtDate(p.periodEnd)],
            ["Reference", String(p.paymentRef ?? "")],
          ],
          cta: { label: "Download invoice", href: billingUrl },
        }),
        text: `Payment received\n\n${restaurant}: ${price} for ${plan}.\nPaid through: ${fmtDate(p.periodEnd)}\nReference: ${p.paymentRef ?? "-"}\n\n${billingUrl}`,
      };

    case "invoice_issued":
      return {
        subject: `Invoice ${String(p.invoiceNumber ?? "")} from The Salad`,
        html: frame({
          heading: "Your invoice is ready",
          intro: `The invoice for <strong>${restaurant}</strong> has been issued and is available in your billing page.`,
          rows: [
            ["Invoice", String(p.invoiceNumber ?? "")],
            ["Plan", plan],
            ["Amount", price],
            ["Invoice date", fmtDate(p.invoiceDate)],
          ],
          cta: { label: "View and download", href: billingUrl },
          footnote: "This is a tax invoice for a payment already received — no action is needed.",
        }),
        text: `Invoice ${p.invoiceNumber ?? ""} for ${restaurant}\n\n${price} — ${plan}, dated ${fmtDate(p.invoiceDate)}.\nDownload it: ${billingUrl}`,
      };

    case "payment_refunded":
      return {
        subject: `Refund issued — ${price || plan}`,
        html: frame({
          heading: "Refund issued",
          intro: `We've refunded a payment for <strong>${restaurant}</strong>. It returns to the original payment method; banks usually take 5–7 working days.`,
          rows: [
            ["Amount", price],
            ["Original payment", String(p.paymentRef ?? "")],
            ["Refund reference", String(p.refundNumber ?? p.refundId ?? "")],
            ["Refunded on", fmtDate(p.refundedAt)],
          ],
          cta: { label: "View billing", href: billingUrl },
          footnote: "Your plan is unchanged — a refund on its own does not end a subscription. Manage billing if you want to cancel.",
        }),
        text: `Refund issued\n\n${restaurant}: ${price} refunded (${fmtDate(p.refundedAt)}).\nYour plan is unchanged.\n\n${billingUrl}`,
      };

    case "payment_failed":
      return {
        subject: "We couldn't take your The Salad payment",
        html: frame({
          heading: "Payment didn't go through",
          intro: `The renewal payment for <strong>${restaurant}</strong> failed. Your access continues for now — please update the payment method so nothing is interrupted.`,
          rows: [
            ["Plan", plan],
            ["Amount", price],
            ["Reason", String(p.reason ?? "Payment was declined")],
          ],
          cta: { label: "Update payment method", href: billingUrl },
          footnote: "If the payment keeps failing, access is paused after a short grace period. Nothing is deleted.",
        }),
        text: `Payment didn't go through\n\nThe renewal for ${restaurant} failed: ${p.reason ?? "declined"}.\nUpdate your payment method: ${billingUrl}`,
      };

    case "subscription_cancelled":
      return {
        subject: "Your The Salad subscription is cancelled",
        html: frame({
          heading: "Subscription cancelled",
          intro: `<strong>${restaurant}</strong> will not be charged again. You keep access until the date below.`,
          rows: [
            ["Plan", plan],
            ["Access until", fmtDate(p.periodEnd)],
          ],
          cta: { label: "Resume or change plan", href: billingUrl },
        }),
        text: `Subscription cancelled\n\n${restaurant} keeps access until ${fmtDate(p.periodEnd)}. No further charges.\n\n${billingUrl}`,
      };

    case "renewal_reminder":
      return {
        subject: `${p.daysBefore} day${Number(p.daysBefore) === 1 ? "" : "s"} left on your The Salad plan`,
        html: frame({
          heading: `${p.daysBefore} day${Number(p.daysBefore) === 1 ? "" : "s"} left`,
          intro: `The ${plan} plan for <strong>${restaurant}</strong> ends on ${fmtDate(p.periodEnd)}. It does not renew by itself — renew to keep everything running.`,
          rows: [
            ["Plan", plan],
            ["Expires", fmtDate(p.periodEnd)],
            ["Renewal", price ? `${price} / ${cycle}` : ""],
          ],
          cta: { label: "Renew now", href: billingUrl },
          footnote: "Nothing is deleted when the plan ends — ordering stops until you renew.",
        }),
        text: `${p.daysBefore} days left\n\n${restaurant}: the ${plan} plan ends on ${fmtDate(p.periodEnd)}.${price ? ` Renew for ${price} / ${cycle}.` : ""}\n\n${billingUrl}`,
      };

    case "trial_started":
      return {
        subject: "Your The Salad trial has started",
        html: frame({
          heading: "Welcome to The Salad",
          intro: `<strong>${restaurant}</strong> is set up and your free trial is running until ${fmtDate(p.trialEndsAt)}. No card needed.`,
          rows: [
            ["Trial ends", fmtDate(p.trialEndsAt)],
            ["Days", String(p.days ?? "")],
          ],
          cta: { label: "Open The Salad", href: `${site}/?view=dashboard` },
        }),
        text: `Welcome to The Salad\n\n${restaurant}: your free trial runs until ${fmtDate(p.trialEndsAt)}.\n\n${site}/?view=dashboard`,
      };

    case "trial_ending":
      return {
        subject: `${p.daysBefore} day${Number(p.daysBefore) === 1 ? "" : "s"} left in your The Salad trial`,
        html: frame({
          heading: "Your trial is ending",
          intro: `The free trial for <strong>${restaurant}</strong> ends on ${fmtDate(p.trialEndsAt)}. Pick a plan to keep the paid features on.`,
          rows: [
            ["Trial ends", fmtDate(p.trialEndsAt)],
            ["Starter", "\u20b9999 / month or \u20b99,990 / year"],
            ["Pro", "\u20b92,499 / month or \u20b924,990 / year"],
          ],
          cta: { label: "Choose a plan", href: billingUrl },
          footnote: "Everything you have built stays where it is — nothing is deleted when a trial ends.",
        }),
        text: `Your trial ends ${fmtDate(p.trialEndsAt)}\n\n${restaurant}: choose a plan to keep the paid features.\n\n${billingUrl}`,
      };

    case "trial_ended":
      return {
        subject: "Your The Salad trial has ended",
        html: frame({
          heading: "Your trial has ended",
          intro: `The free trial for <strong>${restaurant}</strong> is over. Your menu, orders and staff are all still here — pick a plan to switch the paid features back on.`,
          cta: { label: "Choose a plan", href: billingUrl },
        }),
        text: `Your trial has ended\n\n${restaurant}: your data is intact. Choose a plan to continue.\n\n${billingUrl}`,
      };

    case "account_deleted":
      return {
        subject: "Your The Salad account has been deleted",
        html: frame({
          heading: "Your account has been deleted",
          intro: `<strong>${restaurant}</strong> and its data — menu, orders, staff, reservations — have been permanently removed, as you asked.`,
          rows: [
            ["Deleted on", fmtDate(p.deletedAt)],
            ["Plan at deletion", String(p.plan ?? "")],
          ],
          footnote: `This is the last email we will send to this address. If you did not request this, contact us at ${emailConfig().support} immediately.`,
        }),
        text: `Your The Salad account has been deleted\n\n${restaurant} and its data have been permanently removed (${fmtDate(p.deletedAt)}).\n\nIf you did not request this, contact ${emailConfig().support}.`,
      };

    default:
      return {
        subject: event.planName ? `${plan} — The Salad` : "The Salad",
        html: frame({
          heading: "The Salad",
          intro: `An update about <strong>${restaurant}</strong>.`,
          cta: { label: "Open The Salad", href: billingUrl },
        }),
        text: `An update about ${restaurant}.\n\n${billingUrl}`,
      };
  }
}

/* ------------------------------------------------------------------ */
/*  Queue + dispatch                                                   */
/* ------------------------------------------------------------------ */

/**
 * Record an email that should be sent.
 *
 * Returns the row id when it was queued, or null when this event already
 * exists — which is the normal outcome for a repeated webhook, and not an
 * error. The unique index on `event_key` is what decides, so two concurrent
 * deliveries cannot both queue.
 */
export async function queueEmail(db: SupabaseClient, event: EmailEvent): Promise<string | null> {
  if (!event.recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(event.recipient)) {
    console.error("email: not queuing an event with no usable recipient", event.eventType);
    return null;
  }
  const rendered = renderEmail(event);
  const { data, error } = await db
    .from("email_events")
    .insert({
      event_key: event.eventKey,
      event_type: event.eventType,
      tenant_id: event.tenantId,
      recipient: event.recipient,
      recipient_name: event.recipientName ?? null,
      restaurant_name: event.restaurantName ?? null,
      subject: rendered.subject,
      plan_name: event.planName ?? null,
      amount: event.amount ?? null,
      currency: event.currency ?? null,
      billing_interval: event.billingInterval ?? null,
      payload: event.payload ?? {},
      status: "pending",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = unique violation: this event was already queued. Anything else
    // is a real failure and is worth a log line, but never a throw — an email
    // must not be able to fail a payment webhook.
    if (!String(error.message).includes("duplicate key")) {
      console.error("email: could not queue", event.eventType, error.message);
    }
    return null;
  }
  return data?.id ?? null;
}

const MAX_ATTEMPTS = 5;

/**
 * Send queued emails that are due.
 *
 * `attempts` and `next_attempt_at` give a bounded exponential backoff, so a
 * provider outage delays delivery instead of losing it, and a permanently
 * failing address stops after five tries rather than retrying for ever.
 */
export async function dispatchPending(
  db: SupabaseClient,
  limit = 25,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const config = emailConfig();
  const configCheck = validateEmailConfig();
  if (!configCheck.ok) {
    console.error("email: refusing to send —", configCheck.problems.join("; "));
    return { sent: 0, failed: 0, skipped: 0, problems: configCheck.problems };
  }

  const { data: due } = await db
    .from("email_events")
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  let sent = 0, failed = 0, skipped = 0;
  for (const row of (due ?? []) as any[]) {
    const rendered = renderEmail({
      eventKey: row.event_key,
      eventType: row.event_type,
      tenantId: row.tenant_id,
      recipient: row.recipient,
      recipientName: row.recipient_name,
      restaurantName: row.restaurant_name,
      planName: row.plan_name,
      amount: row.amount === null ? null : Number(row.amount),
      currency: row.currency,
      billingInterval: row.billing_interval,
      payload: row.payload ?? {},
    });

    let res: Response | null = null;
    try {
      res = await fetch(RESEND_API, {
        method: "POST",
        headers: { authorization: `Bearer ${config.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: config.from,
          to: [row.recipient],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          // Set only when configured: an omitted reply-to is honest, an
          // invented one collects mail nobody reads.
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        }),
      });
    } catch (e) {
      res = null;
      void e;
    }

    const body = res ? await res.json().catch(() => null) : null;
    const ok = Boolean(res?.ok);
    const attempts = Number(row.attempts ?? 0) + 1;

    if (ok) {
      sent++;
      await db.from("email_events").update({
        status: "sent",
        attempts,
        provider_id: (body as any)?.id ?? null,
        sent_at: new Date().toISOString(),
        error: null,
      }).eq("id", row.id);
      continue;
    }

    failed++;
    const reason =
      (body as any)?.message ??
      (body as any)?.error?.message ??
      (res ? `provider answered ${res.status}` : "could not reach the provider");
    const exhausted = attempts >= MAX_ATTEMPTS;
    await db.from("email_events").update({
      status: exhausted ? "failed" : "pending",
      attempts,
      error: String(reason).slice(0, 400),
      // 1, 2, 4, 8 minutes — enough to ride out a blip, not enough to spam.
      next_attempt_at: new Date(Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 3_600_000)).toISOString(),
    }).eq("id", row.id);
  }

  if (due) skipped = Math.max(0, (due as any[]).length - sent - failed);
  return { sent, failed, skipped };
}

/** Queue and send in one step, for events where waiting for a job is wrong. */
export async function sendNow(db: SupabaseClient, event: EmailEvent): Promise<boolean> {
  const id = await queueEmail(db, event);
  if (!id) return false;
  const result = await dispatchPending(db, 5);
  return result.sent > 0;
}

/**
 * Queue an email for a restaurant, resolving who to write to.
 *
 * The owner is the first profile that belongs to the tenant — the account the
 * restaurant was created with. `recipient`/`restaurantName` can be passed
 * explicitly when the rows are about to disappear (account deletion), because
 * then there is nothing left to look up afterwards.
 */
export async function queueForTenant(
  db: SupabaseClient,
  tenantId: string,
  event: Omit<EmailEvent, "tenantId" | "recipient"> & { recipient?: string | null },
): Promise<string | null> {
  let recipient = event.recipient ?? null;
  let recipientName = event.recipientName ?? null;
  let restaurantName = event.restaurantName ?? null;

  if (!recipient || !restaurantName) {
    const [{ data: tenant }, { data: owner }] = await Promise.all([
      db.from("tenants").select("name, email").eq("id", tenantId).maybeSingle(),
      db
        .from("profiles")
        .select("name, email")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);
    recipient = recipient ?? (owner as any)?.email ?? (tenant as any)?.email ?? null;
    recipientName = recipientName ?? (owner as any)?.name ?? null;
    restaurantName = restaurantName ?? (tenant as any)?.name ?? null;
  }

  if (!recipient) {
    console.error("email: no address for tenant", tenantId, event.eventType);
    return null;
  }

  return queueEmail(db, { ...event, tenantId, recipient, recipientName, restaurantName });
}
