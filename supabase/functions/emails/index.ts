// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { dispatchPending, emailConfig, emailConfigured, validateEmailConfig } from "../_shared/email.ts";
import { queueReminders } from "../_shared/reminders.ts";
import { razorpayConfig } from "../_shared/razorpay.ts";

/**
 * /functions/v1/emails
 *   POST dispatch   send everything queued and due
 *   POST daily      queue the day's reminders, then dispatch
 *
 * Both are for a scheduler, not a browser: the caller must present the
 * service-role key. That key is already the most powerful credential in the
 * system, so requiring it here adds no new one to protect — and the endpoint
 * sends no data back beyond counts.
 */

function isTrusted(req: Request): boolean {
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const apikey = (req.headers.get("apikey") ?? "").trim();
  const presented = [auth, apikey].filter(Boolean);
  // A scheduler presents its own secret, so the job does not need the most
  // powerful key in the system to run. The service-role key also works, for
  // running the job by hand.
  const cron = (Deno.env.get("EMAIL_CRON_SECRET") ?? "").trim();
  const service = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  return presented.some((value) => (cron && value === cron) || (service && value === service));
}

/**
 * What is configured — never the values.
 *
 * An operator needs to know whether a secret is set and which domain it points
 * at; they must never see the key, and a status page is exactly where a secret
 * leaks by accident. So this reports presence and the *host* of addresses,
 * nothing else.
 */
function status(req: Request): Response {
  const cfg = emailConfig();
  const check = validateEmailConfig();
  const hostOf = (value: string) => {
    if (!value) return null;
    const addr = value.match(/<([^>]+)>/)?.[1] ?? value;
    const at = addr.lastIndexOf("@");
    return at >= 0 ? addr.slice(at + 1) : null;
  };
  let siteHost: string | null = null;
  try {
    siteHost = cfg.site ? new URL(cfg.site).host : null;
  } catch {
    siteHost = null;
  }
  return json(req, {
    // Each of the six secrets, by presence only.
    secrets: {
      RESEND_API_KEY: Boolean(cfg.key),
      RESEND_FROM: Boolean(cfg.from),
      RESEND_REPLY_TO: Boolean(cfg.replyTo),
      SITE_URL: Boolean(cfg.site),
      SUPPORT_EMAIL: Boolean(cfg.support),
      EMAIL_CRON_SECRET: Boolean((Deno.env.get("EMAIL_CRON_SECRET") ?? "").trim()),
    },
    domains: {
      sending: hostOf(cfg.from),
      replyTo: hostOf(cfg.replyTo),
      support: hostOf(cfg.support),
      site: siteHost,
    },
    sendable: check.ok,
    problems: check.ok ? [] : check.problems,
  });
}

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
  if (!isTrusted(req)) return json(req, { error: "Unauthorized" }, 401);

  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";

  // Status answers without requiring the provider to be usable, so a
  // misconfiguration can be diagnosed before anything is queued.
  if (route === "status") return status(req);

  try {
    if (!emailConfigured()) {
      const check = validateEmailConfig();
      return json(req, { error: "Email is not configured.", configured: false, problems: check.ok ? [] : check.problems }, 503);
    }

    if (route === "daily") {
      const db = admin();
      const reminders = await queueReminders(db);
      const result = await dispatchPending(db, 50);
      // Record the run so "did the scheduler fire today?" is a fact on the
      // dashboard rather than something to be inferred from email timestamps.
      await db.from("super_admin_audit_logs").insert({
        action: "email.daily_run",
        details: { queued: reminders.queued, kinds: reminders.kinds, ...result },
      });
      return json(req, { ok: true, queued: reminders.queued, kinds: reminders.kinds, ...result, razorpay: razorpayConfig().keyId ? "configured" : "missing" });
    }

    if (route === "dispatch") {
      const result = await dispatchPending(admin(), 50);
      return json(req, { ok: true, ...result });
    }

    return json(req, { error: "Not found. Use /emails/dispatch or /emails/daily." }, 404);
  } catch (err) {
    console.error("emails:", err);
    return json(req, { error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});
