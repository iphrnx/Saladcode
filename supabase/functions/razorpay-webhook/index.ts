// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { dispatchPending, queueForTenant } from "../_shared/email.ts";
import { cancelSubscription, fetchPayment, fetchRefund, fetchSubscription, verifyWebhookSignature } from "../_shared/razorpay.ts";
import { eventCreatedAt, fromMinorUnits, webhookEventId } from "../_shared/billing.ts";
import { issueInvoiceDocument, issueRefundDocument } from "../_shared/billing-documents.ts";
import { cancelSupersededLink } from "../_shared/mandate-switch.ts";
import { decideChargeLink, type LiveSubscription } from "../_shared/subscription-guard.ts";

/**
 * POST /functions/v1/razorpay-webhook — PUBLIC, signed.
 *
 * Razorpay tells the platform what happened to a subscription: it activated,
 * it was charged, it was cancelled, it was paused, a payment failed.
 *
 * Three things make this safe:
 *
 *   1. The signature is checked against the raw body before anything is
 *      parsed. A body that has been re-serialised has different bytes, and
 *      the signature would not match — so the raw body is the only thing
 *      that is ever verified.
 *   2. The event id is the primary key of `subscription_webhook_events`.
 *      Razorpay delivers every event at least once, so the second delivery
 *      cannot be inserted and the event is not acted on twice.
 *   3. Nothing is activated on the strength of the event alone. `created` is
 *      recorded and ignored — it fires before any money has moved — and even
 *      `activated` is only applied once the subscription has actually
 *      collected a payment, as Razorpay itself reports it.
 */

Deno.serve(async (req: Request) => {
  const pf = preflight(req);
  if (pf) return pf;

  if (req.method !== "POST") {
    return json(req, { error: "Method not allowed" }, 405);
  }

  // The raw body. It is the only form the signature can be checked against.
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  const check = await verifyWebhookSignature(rawBody, signature);
  if (!check.ok) {
    // A forged event is refused, and refused loudly — but without leaking
    // what was expected.
    console.error("razorpay webhook: signature check failed");
    return json(req, { error: check.error }, 400);
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(req, { error: "Malformed event" }, 400);
  }

  const eventType = String(event?.event ?? "");
  /**
   * The identity of this delivery.
   *
   * `event.event` is the event *type*, and using it as the key meant the first
   * `subscription.charged` was recorded and every later renewal, for every
   * restaurant, was discarded as a duplicate. Razorpay sends a per-delivery id
   * in the `x-razorpay-event-id` header; `webhookEventId` uses it, and falls
   * back to type + entity id + creation time when the header is missing.
   */
  const eventId = webhookEventId(req.headers.get("x-razorpay-event-id"), event);
  if (!eventId) {
    // Without an identity the delivery cannot be deduplicated, and processing
    // it twice could activate a plan twice. Refusing is the safe answer.
    return json(req, { error: "The event had no id" }, 400);
  }

  const db = admin();
  const subscriptionEntity = event?.payload?.subscription?.entity ?? null;
  const createdAt = eventCreatedAt(event);

  // Idempotency and ordering, in one transaction: the delivery is recorded once
  // and an event older than the subscription's newest is not acted on.
  const { data: gate, error: gateError } = await db.rpc("apply_subscription_event", {
    p_event_id: eventId,
    p_event_type: eventType,
    p_subscription_id: subscriptionEntity?.id ?? null,
    p_event_created_at: createdAt ? createdAt.toISOString() : null,
  });

  if (gateError) {
    // A gate that cannot be evaluated must not be treated as permission. A 500
    // makes Razorpay retry, and the retry is safe because nothing was applied.
    console.error("razorpay webhook: could not record the event", eventId, gateError.message);
    return json(req, { error: "Could not record the event" }, 500);
  }

  if (gate === "duplicate") {
    console.log("razorpay webhook: duplicate delivery", eventId, eventType);
    return json(req, { ok: true, duplicate: true });
  }

  if (gate === "in_progress") {
    console.log("razorpay webhook: event currently being processed by another worker", eventId, eventType);
    return json(req, { ok: true, in_progress: true });
  }

  if (gate === "stale") {
    console.log("razorpay webhook: stale delivery, not applied", eventId, eventType);
    return json(req, { ok: true, stale: true });
  }

  try {
    const result = await handleEvent(event, eventType, eventId);
    await db
      .from("subscription_webhook_events")
      .update({
        status: "processed",
        processed_at: new Date().toISOString(),
        result: result.summary,
        last_error: null,
      })
      .eq("event_id", eventId);
    return json(req, { ok: true, ...result });
  } catch (e) {
    const message = (e as Error).message ?? "Unexpected error";
    console.error("razorpay webhook: handling failed", eventId, message);
    await db
      .from("subscription_webhook_events")
      .update({
        status: "failed",
        last_error: message,
        result: `error: ${message}`,
      })
      .eq("event_id", eventId);
    // A 500 makes Razorpay retry. The apply_subscription_event gate allows retries when status is 'failed',
    // ensuring transient failures are safely retried rather than dropped as duplicates (Fix C5).
    return json(req, { error: message }, 500);
  }
});

type EventResult = { summary: string; tenantId?: string };

async function handleEvent(event: any, eventType: string, eventId: string): Promise<EventResult> {
  const db = admin();

  const subscription = event?.payload?.subscription?.entity ?? null;
  const payment = event?.payload?.payment?.entity ?? null;
  const orderEntity = event?.payload?.order?.entity ?? null;
  const refundEntity = event?.payload?.refund?.entity ?? null;

  const notes = subscription?.notes ?? payment?.notes ?? orderEntity?.notes ?? {};

  /**
   * Which restaurant is this event about? Razorpay does not guarantee the
   * notes — a subscription cancelled from the Razorpay dashboard, or a
   * payment entity on an event type that does not echo them, arrives with
   * nothing. Dropping those events silently was how cancellations stopped
   * syncing, so the lookup falls back through everything else the event
   * can be tied to:
   *
   *   1. the tenant_id in the notes (the common path — we put it there);
   *   2. the subscription id matching the tenant's linked subscription
   *      (dashboard-side actions on an already-linked subscription);
   *   3. the payment's order id matching a recorded checkout (first
   *      payments, where the checkout row is the only linkage that exists).
   */
  let tenantId: string | undefined = notes?.tenant_id ?? undefined;
  if (!tenantId && subscription?.id) {
    const { data: linked } = await db
      .from("tenants")
      .select("id")
      .eq("razorpay_subscription_id", String(subscription.id))
      .maybeSingle();
    tenantId = linked?.id ?? undefined;
  }
  const orderIdLookup = payment?.order_id ?? orderEntity?.id ?? null;
  if (!tenantId && orderIdLookup) {
    const { data: checkoutRow } = await db
      .from("subscription_checkouts")
      .select("tenant_id")
      .eq("razorpay_order_id", String(orderIdLookup))
      .maybeSingle();
    tenantId = checkoutRow?.tenant_id ?? undefined;
  }
  const refundPaymentId = payment?.id ?? refundEntity?.payment_id ?? null;
  if (!tenantId && refundPaymentId) {
    const { data: payRow } = await db
      .from("subscription_payments")
      .select("tenant_id")
      .eq("razorpay_payment_id", String(refundPaymentId))
      .maybeSingle();
    tenantId = payRow?.tenant_id ?? undefined;
  }
  if (!tenantId) {
    return { summary: "no tenant could be resolved from the event" };
  }

  const { data: tenant } = await db
    .from("tenants")
    .select("id, plan, subscription_plan, subscription_status, razorpay_subscription_id")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) {
    return { summary: "the restaurant in the event no longer exists", tenantId };
  }

  // Razorpay's plan id → our plan id.
  const razorpayPlanId = subscription?.plan_id ?? null;
  let planId: string | null = null;
  let planInterval: "monthly" | "annual" | null = null;
  if (razorpayPlanId) {
    const { data: planRow } = await db
      .from("subscription_plans")
      .select("id, razorpay_plan_id")
      .eq("razorpay_plan_id", razorpayPlanId)
      .maybeSingle();
    planId = planRow?.id ?? null;
    // Every Razorpay subscription is a monthly mandate: annual is paid once,
    // as an order, and never appears here.
    if (planRow) planInterval = "monthly";
  }
  if (!planId) planId = notes?.plan_id ?? tenant.subscription_plan ?? tenant.plan ?? "starter";

  const now = new Date().toISOString();
  const periodEnd = subscription?.current_end
    ? new Date(subscription.current_end * 1000).toISOString()
    : null;
  const periodStart = subscription?.current_start
    ? new Date(subscription.current_start * 1000).toISOString()
    : null;

  const razorpaySubscriptionId = subscription?.id ?? null;

  /**
   * Terminal and interruption events describe ONE subscription — the one
   * the tenant is linked to. A restaurant that scheduled a new
   * subscription to start when the old one ends gets both events at the
   * boundary: `charged` for the new subscription (which re-links the
   * tenant), then `completed` for the old. Applying the old
   * subscription's `completed` after the new `charged` would mark a
   * paying restaurant expired. So these events only count when they are
   * about the subscription the tenant currently has.
   */
  const aboutCurrentSubscription =
    razorpaySubscriptionId !== null &&
    String(tenant.razorpay_subscription_id ?? "") === razorpaySubscriptionId;

  switch (eventType) {
    case "subscription.authenticated":
    case "subscription.created": {
      // Authenticated/Created is not paid. Razorpay emits it before any money
      // has moved — so it must not activate anything.
      return { summary: `${eventType}, awaiting first payment`, tenantId };
    }

    case "subscription.activated": {
      // Activated means the first payment succeeded — but the event itself
      // carries no payment, so the proof is fetched from Razorpay: a
      // subscription that has collected money has paid_count >= 1. An
      // activation without collected money is not applied; a fetch that
      // cannot be completed is thrown so Razorpay retries the delivery.
      if (!razorpaySubscriptionId) {
        return { summary: "activated event without a subscription id", tenantId };
      }
      const proof = await fetchSubscription(razorpaySubscriptionId);
      if (!proof.ok) {
        throw new Error(`could not confirm the subscription with Razorpay: ${proof.error}`);
      }
      if (Number(proof.data.paid_count ?? 0) < 1) {
        await audit(db, tenantId, tenant.plan, planId, "activation_without_payment", eventId, {});
        return { summary: "activated event ignored: no collected payment", tenantId };
      }

      /**
       * Which subscription gets the link is a decision, not an assignment —
       * with two billable mandates in the wild, "whoever charged last wins"
       * flips the tenant between them forever. The decision is stable:
       * renewals on the linked mandate apply; a dead mandate never takes
       * over; a live incoming mandate yields to a live linked one.
       */
      const linkedId = (tenant.razorpay_subscription_id as string | null) ?? null;
      const linkedFetch = linkedId && linkedId !== razorpaySubscriptionId
        ? await fetchSubscription(linkedId)
        : null;
      const linkDecision = decideChargeLink({
        linkedId,
        incomingId: razorpaySubscriptionId,
        linkedLive: linkedFetch
          ? (linkedFetch.ok
            ? {
              status: String(linkedFetch.data.status ?? ""),
              paidCount: Number(linkedFetch.data.paid_count ?? 0),
            }
            : null)
          : null,
        incomingLive: {
          status: String(proof.data.status ?? ""),
          paidCount: Number(proof.data.paid_count ?? 0),
        },
      });

      if (linkDecision.kind !== "apply") {
        await rejectIncomingCharge(db, {
          tenantId,
          incomingId: razorpaySubscriptionId,
          linkedId,
          decision: linkDecision.kind,
          eventId,
          planId,
          oldPlan: tenant.plan,
        });
        return { summary: `activation not linked: ${linkDecision.kind}`, tenantId };
      }

      await db
        .from("tenants")
        .update({
          plan: planId,
          subscription_plan: planId,
          subscription_status: "active",
          subscription_started_at: periodStart ?? now,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          razorpay_subscription_id: razorpaySubscriptionId,
          ...(planInterval ? { billing_interval: planInterval } : {}),
        })
        .eq("id", tenantId);
      // The tenant may have been linked to a different subscription before —
      // an upgrade that started a new mandate, or a duplicate from before
      // checkout dedupe existed. Whatever it was, if it can still take money
      // it is cancelled now: one restaurant, one recurring charge.
      try {
        await cancelSupersededLink(db, {
          tenantId,
          previousSubscriptionId: linkedId,
          newSubscriptionId: razorpaySubscriptionId,
          source: "webhook:activated",
          oldPlan: tenant.plan,
          newPlan: planId,
        });
      } catch (e) {
        console.error("webhook: mandate switch check failed", (e as Error)?.message);
      }
      await audit(db, tenantId, tenant.plan, planId, "activated", eventId, { periodEnd });
      return { summary: `activated on ${planId}`, tenantId };
    }

    case "subscription.charged": {
      /**
       * The link decision again, this time with real money attached. Two
       * billable mandates must never trade the tenant back and forth: the
       * first-linked billable mandate keeps the link, and a charge from any
       * other mandate is recorded, flagged for refund review, and its
       * mandate cancelled — without moving the tenant an inch.
       */
      const linkedId = (tenant.razorpay_subscription_id as string | null) ?? null;
      const incomingFetch = razorpaySubscriptionId ? await fetchSubscription(razorpaySubscriptionId) : null;
      const linkedFetch = linkedId && linkedId !== razorpaySubscriptionId
        ? await fetchSubscription(linkedId)
        : null;
      const toLive = (
        f: { ok: true; data: Record<string, unknown> } | { ok: false; error: string } | null,
      ): LiveSubscription | null =>
        f && f.ok
          ? {
            status: String(f.data.status ?? ""),
            paidCount: Number(f.data.paid_count ?? 0),
          }
          : null;
      const linkDecision = razorpaySubscriptionId
        ? decideChargeLink({
          linkedId,
          incomingId: razorpaySubscriptionId,
          linkedLive: linkedFetch ? toLive(linkedFetch) : null,
          incomingLive: toLive(incomingFetch),
        })
        : { kind: "apply" as const };

      if (linkDecision.kind !== "apply") {
        // The money is real, so the ledger records it — the books always
        // describe reality — but the tenant does not move, no receipt or
        // invoice goes out, and the duplicate mandate is stopped.
        if (payment?.id) {
          const { error: ledgerError } = await db
            .from("subscription_payments")
            .upsert(
              {
                tenant_id: tenantId,
                amount: Number(payment.amount ?? 0) / 100,
                currency: payment.currency ?? "INR",
                status: "succeeded",
                payment_method: payment.method ?? "razorpay",
                transaction_id: String(payment.id),
                plan_id: planId,
                billing_period: planInterval ?? "monthly",
                payment_mode: "autopay",
                mandate_id: razorpaySubscriptionId,
                renewal_status: "not_applicable",
                razorpay_payment_id: String(payment.id),
                razorpay_order_id: payment.order_id ?? null,
                razorpay_invoice_id: payment.invoice_id ?? null,
                razorpay_subscription_id: razorpaySubscriptionId,
                webhook_event_id: eventId,
                failure_reason: null,
                created_at: now,
                updated_at: now,
              },
              { onConflict: "razorpay_payment_id" },
            );
          if (ledgerError) {
            throw new Error(`could not record the rejected charge: ${ledgerError.message}`);
          }
        }
        await rejectIncomingCharge(db, {
          tenantId,
          incomingId: razorpaySubscriptionId as string,
          linkedId,
          decision: linkDecision.kind,
          eventId,
          planId,
          oldPlan: tenant.plan,
          paymentId: payment?.id ?? null,
          amount: payment?.amount ? Number(payment.amount) / 100 : null,
        });
        return { summary: `charge not linked: ${linkDecision.kind}`, tenantId };
      }

      // A renewal. The period moves forward and the plan is kept.
      await db
        .from("tenants")
        .update({
          plan: planId,
          subscription_plan: planId,
          subscription_status: "active",
          current_period_end: periodEnd,
          subscription_started_at: periodStart ?? undefined,
          razorpay_subscription_id: razorpaySubscriptionId,
          ...(planInterval ? { billing_interval: planInterval } : {}),
        })
        .eq("id", tenantId);

      // Same one-mandate sweep as activation: a charge that re-links the
      // tenant retires whatever mandate the tenant pointed at before.
      try {
        await cancelSupersededLink(db, {
          tenantId,
          previousSubscriptionId: linkedId,
          newSubscriptionId: razorpaySubscriptionId,
          source: "webhook:charged",
          oldPlan: tenant.plan,
          newPlan: planId,
        });
      } catch (e) {
        console.error("webhook: mandate switch check failed", (e as Error)?.message);
      }

      // The checkout row this charge settles. A subscription bought to
      // start at the end of an already-paid period never passes through
      // `verify` — its authorisation carried no payment — so this is the
      // only moment the row becomes "paid". Without it, the record would
      // say "pending" for a subscription that has collected money, and the
      // paid-evidence check for plan changes would not find it.
      if (razorpaySubscriptionId) {
        await db
          .from("subscription_checkouts")
          .update({
            status: "paid",
            ...(payment?.id ? { razorpay_payment_id: String(payment.id) } : {}),
            updated_at: now,
          })
          .eq("razorpay_subscription_id", razorpaySubscriptionId)
          .eq("status", "pending");
      }

      if (payment?.id) {
        const { error: ledgerError } = await db
          .from("subscription_payments")
          .upsert(
            {
              tenant_id: tenantId,
              amount: Number(payment.amount ?? 0) / 100,
              currency: payment.currency ?? "INR",
              // "succeeded" is the status the Super Admin dashboard counts.
              status: "succeeded",
              payment_method: payment.method ?? "razorpay",
              transaction_id: String(payment.id),
              plan_id: planId,
              // The interval this charge was for. Hard-coded to "monthly"
              // here, every annual renewal was filed as a month's payment.
              billing_period: planInterval ?? "monthly",
              payment_mode: "autopay",
              mandate_id: razorpaySubscriptionId,
              mandate_expires_at: subscription?.end_at
                ? new Date(subscription.end_at * 1000).toISOString()
                : null,
              renewal_status: "succeeded",
              razorpay_payment_id: String(payment.id),
              razorpay_order_id: payment.order_id ?? null,
              razorpay_invoice_id: payment.invoice_id ?? null,
              razorpay_subscription_id: razorpaySubscriptionId,
              webhook_event_id: eventId,
              created_at: now,
              updated_at: now,
            },
            { onConflict: "razorpay_payment_id" },
          );
        if (ledgerError) {
          // A renewal whose payment cannot be recorded is thrown, not
          // swallowed: the ledger has to describe reality, and a 500 makes
          // Razorpay retry the delivery — safely, because the event gate
          // has already recorded this id.
          throw new Error(`could not record the renewal payment: ${ledgerError.message}`);
        }

        // Receipt for the charge that just landed. Keyed on the payment, so a
        // webhook Razorpay delivers twice produces one receipt.
        try {
          await queueForTenant(db, tenantId, {
            eventKey: `payment_succeeded:${payment.id}`,
            eventType: "payment_succeeded",
            planName: planId,
            amount: Number(payment.amount ?? 0) / 100,
            currency: payment.currency ?? "INR",
            billingInterval: planInterval ?? "monthly",
            payload: {
              periodEnd: periodEnd ? new Date(periodEnd).toISOString() : null,
              paidAt: now,
              paymentRef: String(payment.id),
            },
          });
          await dispatchPending(db, 5);
        } catch (e) {
          console.error("webhook: receipt email failed", (e as Error)?.message);
        }

        // The invoice for the renewal, issued eagerly from the recorded
        // payment. Best-effort: the event is already gated, the
        // entitlement is already granted — a filing problem is retried
        // lazily at download, never thrown back at Razorpay.
        try {
          const { data: ledgerRow } = await db
            .from("subscription_payments")
            .select(
              "id, amount, currency, status, payment_method, plan_id, billing_period, created_at, razorpay_payment_id, razorpay_order_id",
            )
            .eq("razorpay_payment_id", String(payment.id))
            .maybeSingle();
          if (ledgerRow) {
            const invoice = await issueInvoiceDocument(db, tenantId, ledgerRow, {
              periodStart: periodStart ? new Date(periodStart) : undefined,
              periodEnd: periodEnd ? new Date(periodEnd) : undefined,
            });
            // The invoice exists now, so the email can name it. Keyed on the
            // invoice number: a re-delivered charge cannot send it twice.
            const invoiceNumber = (invoice as any)?.invoice_number ?? (invoice as any)?.invoiceNumber ?? null;
            if (invoiceNumber) {
              try {
                await queueForTenant(db, tenantId, {
                  eventKey: `invoice_issued:${invoiceNumber}`,
                  eventType: "invoice_issued",
                  planName: planId,
                  amount: Number(payment.amount ?? 0) / 100,
                  currency: payment.currency ?? "INR",
                  payload: {
                    invoiceNumber,
                    invoiceDate: (invoice as any)?.invoice_date ?? now,
                    paymentRef: String(payment.id),
                  },
                });
                await dispatchPending(db, 5);
              } catch (e) {
                console.error("webhook: invoice email failed", (e as Error)?.message);
              }
            }
          }
        } catch (e) {
          console.error("razorpay webhook: renewal invoice issuance failed", (e as Error)?.message);
        }
      }
      await audit(db, tenantId, tenant.plan, planId, "renewed", eventId, { periodEnd });
      return { summary: `renewed on ${planId}`, tenantId };
    }

    case "subscription.cancelled":
    case "subscription.completed": {
      if (!aboutCurrentSubscription) {
        return { summary: `event for a previous subscription (${razorpaySubscriptionId})`, tenantId };
      }
      // A cancellation takes effect at the end of the period, so the plan
      // stays until the period ends and the access is restricted then.
      const ended = eventType === "subscription.completed";
      // `completed` is the mandate running out of cycles — for a one-year
      // annual mandate that is the normal end, not a cancellation. Both stop
      // future charges; only `completed` says the deal ended as agreed.
      await db
        .from("subscription_payments")
        .update({ renewal_status: ended ? "mandate_expired" : "mandate_cancelled" })
        .eq("razorpay_subscription_id", razorpaySubscriptionId)
        .eq("renewal_status", "scheduled");
      await db
        .from("tenants")
        .update({
          subscription_status: ended ? "expired" : "cancelled",
          cancel_at_period_end: !ended,
        })
        .eq("id", tenantId);
      await audit(db, tenantId, tenant.plan, planId, ended ? "completed" : "cancelled", eventId, {
        periodEnd,
      });

      // Only a cancellation is worth a letter. A completed mandate is the
      // normal end of the term and the reminder chain has already been through
      // it — a second "your plan ended" would just be noise.
      if (!ended) {
        try {
          await queueForTenant(db, tenantId, {
            eventKey: `subscription_cancelled:${razorpaySubscriptionId}:${periodEnd ?? ""}`,
            eventType: "subscription_cancelled",
            planName: planId,
            currency: "INR",
            payload: { periodEnd: periodEnd ? new Date(periodEnd).toISOString() : null },
          });
          await dispatchPending(db, 5);
        } catch (e) {
          console.error("webhook: cancellation email failed", (e as Error)?.message);
        }
      }
      return { summary: ended ? "completed" : "cancelled", tenantId };
    }

    case "subscription.paused": {
      if (!aboutCurrentSubscription) {
        return { summary: `event for a previous subscription (${razorpaySubscriptionId})`, tenantId };
      }
      await db.from("tenants").update({ subscription_status: "paused" }).eq("id", tenantId);
      await audit(db, tenantId, tenant.plan, planId, "paused", eventId, {});
      return { summary: "paused", tenantId };
    }

    case "subscription.pending":
    case "subscription.halted": {
      if (!aboutCurrentSubscription) {
        return { summary: `event for a previous subscription (${razorpaySubscriptionId})`, tenantId };
      }
      await db
        .from("subscription_payments")
        .update({ renewal_status: "mandate_halted" })
        .eq("razorpay_subscription_id", razorpaySubscriptionId)
        .eq("renewal_status", "scheduled");
      await db
        .from("tenants")
        .update({ subscription_status: eventType === "subscription.halted" ? "past_due" : "pending" })
        .eq("id", tenantId);
      await audit(db, tenantId, tenant.plan, planId, eventType.replace("subscription.", ""), eventId, {});
      return { summary: eventType, tenantId };
    }

    case "payment.failed": {
      /**
       * A failed payment is a fact for the ledger, not a status change.
       *
       * Razorpay pairs every failed recurring charge with subscription
       * lifecycle events — `pending` while the retries are in flight,
       * `halted` when they are exhausted — and those carry the tenant's
       * status, with grace. If this handler also flipped the tenant to
       * past_due, a failure that has nothing to do with the current
       * subscription (a declined one-time renewal attempt, an old
       * subscription's late delivery) would brand an active restaurant
       * "Payment failed" over money it never owed. The grace the past_due
       * status exists for is already provided by pending/halted.
       *
       * A failed FIRST purchase touches nothing at all: a declined card is
       * not a reason to end a trial or restrict an account that never had
       * a paid period.
       */
      if (payment?.id) {
        const { error: ledgerError } = await db
          .from("subscription_payments")
          .upsert(
            {
              tenant_id: tenantId,
              amount: Number(payment.amount ?? 0) / 100,
              currency: payment.currency ?? "INR",
              status: "failed",
              payment_method: payment.method ?? "razorpay",
              transaction_id: String(payment.id),
              plan_id: planId,
              billing_period: "monthly",
              razorpay_payment_id: String(payment.id),
              razorpay_order_id: payment.order_id ?? null,
              razorpay_subscription_id: razorpaySubscriptionId,
              webhook_event_id: eventId,
              failure_reason: payment.error_description ?? "The payment was declined.",
              created_at: now,
              updated_at: now,
            },
            { onConflict: "razorpay_payment_id" },
          );
        if (ledgerError) {
          throw new Error(`could not record the failed payment: ${ledgerError.message}`);
        }
      }
      await audit(db, tenantId, tenant.plan, planId, "payment_failed", eventId, {});

      // Tell the owner while the money can still be fixed. The charge is the
      // key, so retries of the same failed payment produce one email.
      if (payment?.id) {
        try {
          await queueForTenant(db, tenantId, {
            eventKey: `payment_failed:${payment.id}`,
            eventType: "payment_failed",
            planName: planId,
            amount: Number(payment.amount ?? 0) / 100,
            currency: payment.currency ?? "INR",
            payload: {
              reason: payment.error_description ?? "The payment was declined.",
              periodEnd: periodEnd ? new Date(periodEnd).toISOString() : null,
            },
          });
          await dispatchPending(db, 5);
        } catch (e) {
          console.error("webhook: payment-failed email failed", (e as Error)?.message);
        }
      }
      return { summary: "payment failed", tenantId };
    }

    case "subscription.resumed": {
      if (!aboutCurrentSubscription) {
        return { summary: `event for a previous subscription (${razorpaySubscriptionId})`, tenantId };
      }
      await db
        .from("tenants")
        .update({
          subscription_status: "active",
          ...(periodEnd ? { current_period_end: periodEnd } : {}),
        })
        .eq("id", tenantId);
      await audit(db, tenantId, tenant.plan, planId, "resumed", eventId, { periodEnd });
      return { summary: "resumed", tenantId };
    }

    case "order.paid":
    case "payment.captured": {
      if (payment?.subscription_id || orderEntity?.subscription_id) {
        return { summary: "subscription payment handled by subscription events", tenantId };
      }
      const razorpayOrderId = orderEntity?.id ?? payment?.order_id ?? null;
      const rawPaymentId = payment?.id ?? null;
      if (!razorpayOrderId || !rawPaymentId) {
        return { summary: `${eventType} missing order_id or payment_id`, tenantId };
      }

      const livePaymentRes = await fetchPayment(String(rawPaymentId));
      if (!livePaymentRes.ok) {
        throw new Error(`could not confirm payment ${rawPaymentId} with Razorpay: ${livePaymentRes.error}`);
      }
      const livePay = livePaymentRes.data;

      const { data: rpcRes, error: rpcErr } = await db.rpc("finalize_annual_order_payment", {
        p_tenant_id: tenantId,
        p_razorpay_order_id: String(razorpayOrderId),
        p_razorpay_payment_id: String(livePay.id),
        p_payment_order_id: livePay.order_id ?? null,
        p_amount_minor: Number(livePay.amount),
        p_currency: String(livePay.currency ?? "INR"),
        p_payment_status: String(livePay.status ?? ""),
        p_payment_method: livePay.method ?? "razorpay",
        p_razorpay_signature: null,
        p_webhook_event_id: eventId,
      });
      if (rpcErr || !rpcRes) {
        throw new Error(`could not finalize annual payment: ${rpcErr?.message ?? "empty RPC result"}`);
      }

      const outcome = String((rpcRes as any).outcome ?? "");
      if (outcome === "already") {
        return { summary: "annual checkout already verified/paid", tenantId };
      }
      if (outcome === "ignore") {
        return { summary: String((rpcRes as any).reason ?? "ignored"), tenantId };
      }
      if (outcome === "reject") {
        const reason = String((rpcRes as any).reason ?? "rejected");
        await audit(db, tenantId, tenant.plan, planId, "order_recovery_rejected", eventId, {
          reason,
          razorpayOrderId,
          paymentId: livePay.id,
        });
        return { summary: `rejected: ${reason}`, tenantId };
      }

      const activatedPlanId = String((rpcRes as any).plan_id ?? planId);
      const amountPaid = Number((rpcRes as any).amount_paid ?? fromMinorUnits(Number(livePay.amount), String(livePay.currency ?? "INR")));
      const recoveredPeriodEnd = String((rpcRes as any).period_end ?? "");
      const periodBase = new Date(String((rpcRes as any).period_base ?? now));
      const previousSubscriptionId = ((rpcRes as any).previous_subscription_id as string | null) ?? null;

      try {
        await cancelSupersededLink(db, {
          tenantId,
          previousSubscriptionId,
          newSubscriptionId: null,
          source: `webhook:${eventType}`,
          oldPlan: tenant.plan,
          newPlan: activatedPlanId,
        });
      } catch (e) {
        console.error("webhook: mandate switch check failed on order recovery", (e as Error)?.message);
      }

      try {
        await queueForTenant(db, tenantId, {
          eventKey: `subscription_activated:${tenantId}:${String(livePay.id)}`,
          eventType: "subscription_activated",
          planName: activatedPlanId,
          amount: amountPaid,
          currency: String(livePay.currency ?? "INR"),
          billingInterval: "annual",
          payload: { periodEnd: recoveredPeriodEnd, paymentRef: String(livePay.id), mode: "pay_once" },
        });
        await dispatchPending(db, 5);
      } catch (e) {
        console.error("webhook: order recovery activation email failed", (e as Error)?.message);
      }

      try {
        const { data: ledgerRow } = await db
          .from("subscription_payments")
          .select("id, amount, currency, status, payment_method, plan_id, billing_period, created_at, razorpay_payment_id, razorpay_order_id")
          .eq("razorpay_payment_id", String(livePay.id))
          .maybeSingle();
        if (ledgerRow && recoveredPeriodEnd) {
          await issueInvoiceDocument(db, tenantId, ledgerRow, {
            periodStart: periodBase,
            periodEnd: new Date(recoveredPeriodEnd),
          });
        }
      } catch (e) {
        console.error("webhook: order recovery invoice issuance failed", (e as Error)?.message);
      }

      await audit(db, tenantId, tenant.plan, activatedPlanId, "activated_via_webhook", eventId, {
        razorpayOrderId,
        paymentId: livePay.id,
        periodEnd: recoveredPeriodEnd,
      });
      return { summary: `recovered annual payment on ${activatedPlanId}`, tenantId };
    }

    case "refund.created": {
      const targetPaymentId = payment?.id ?? refundEntity?.payment_id ?? null;
      const refundId = refundEntity?.id ? String(refundEntity.id) : null;
      if (!targetPaymentId) {
        return { summary: "refund.created missing payment id", tenantId };
      }
      // refund.created indicates an initiated/pending refund unless Razorpay
      // explicitly marks it processed; do NOT mark payment refunded or issue
      // refund documents/emails while pending.
      const refundStatus = refundEntity?.status === "processed" ? "processed" : "pending";
      const refundAmt = refundEntity?.amount
        ? fromMinorUnits(Number(refundEntity.amount), String(refundEntity.currency ?? "INR"))
        : 0;
      const { error: refundRpcErr } = await db.rpc("record_subscription_refund", {
        p_tenant_id: tenantId,
        p_razorpay_payment_id: String(targetPaymentId),
        p_razorpay_refund_id: refundId,
        p_refund_amount: refundAmt,
        p_currency: String(refundEntity?.currency ?? "INR"),
        p_refund_status: refundStatus,
        p_webhook_event_id: eventId,
      });
      if (refundRpcErr) {
        throw new Error(`could not record refund.created: ${refundRpcErr.message}`);
      }
      return { summary: `refund created (${refundStatus})`, tenantId };
    }

    case "refund.failed": {
      const targetPaymentId = payment?.id ?? refundEntity?.payment_id ?? null;
      const refundId = refundEntity?.id ? String(refundEntity.id) : null;
      if (!targetPaymentId) {
        return { summary: "refund.failed missing payment id", tenantId };
      }
      const refundAmt = refundEntity?.amount
        ? fromMinorUnits(Number(refundEntity.amount), String(refundEntity.currency ?? "INR"))
        : 0;
      const { error: refundRpcErr } = await db.rpc("record_subscription_refund", {
        p_tenant_id: tenantId,
        p_razorpay_payment_id: String(targetPaymentId),
        p_razorpay_refund_id: refundId,
        p_refund_amount: refundAmt,
        p_currency: String(refundEntity?.currency ?? "INR"),
        p_refund_status: "failed",
        p_webhook_event_id: eventId,
      });
      if (refundRpcErr) {
        throw new Error(`could not record refund.failed: ${refundRpcErr.message}`);
      }
      await audit(db, tenantId, tenant.plan, planId, "refund_failed", eventId, {
        paymentId: targetPaymentId,
        refundId,
      });
      return { summary: "refund failed", tenantId };
    }

    case "refund.processed":
    case "payment.refunded": {
      const targetPaymentId = payment?.id ?? refundEntity?.payment_id ?? null;
      if (!targetPaymentId) {
        return { summary: `${eventType} missing payment id`, tenantId };
      }

      const verifiedRefundId: string | null = refundEntity?.id ? String(refundEntity.id) : null;
      let verifiedRefundStatus: "pending" | "processed" | "failed" = "processed";
      let verifiedRefundAmount = refundEntity?.amount
        ? fromMinorUnits(Number(refundEntity.amount), String(refundEntity.currency ?? "INR"))
        : 0;
      let verifiedCurrency = String(refundEntity?.currency ?? payment?.currency ?? "INR");

      if (verifiedRefundId) {
        const liveRefund = await fetchRefund(verifiedRefundId);
        if (!liveRefund.ok) {
          throw new Error(`could not confirm refund ${verifiedRefundId} with Razorpay: ${liveRefund.error}`);
        }
        const liveStatus = String(liveRefund.data.status ?? "");
        verifiedRefundStatus = liveStatus === "processed"
          ? "processed"
          : liveStatus === "failed"
            ? "failed"
            : "pending";
        verifiedRefundAmount = fromMinorUnits(
          Number(liveRefund.data.amount ?? 0),
          String(liveRefund.data.currency ?? verifiedCurrency),
        );
        verifiedCurrency = String(liveRefund.data.currency ?? verifiedCurrency);
      }

      const { data: refundRpcRes, error: refundRpcErr } = await db.rpc("record_subscription_refund", {
        p_tenant_id: tenantId,
        p_razorpay_payment_id: String(targetPaymentId),
        p_razorpay_refund_id: verifiedRefundId,
        p_refund_amount: verifiedRefundAmount,
        p_currency: verifiedCurrency,
        p_refund_status: verifiedRefundStatus,
        p_webhook_event_id: eventId,
      });
      if (refundRpcErr) {
        throw new Error(`could not record the refund: ${refundRpcErr.message}`);
      }

      const refundOutcome = String((refundRpcRes as any)?.outcome ?? "");
      if (refundOutcome === "pending_recorded" || refundOutcome === "failed_recorded") {
        return { summary: `refund ${verifiedRefundStatus} (not finalized)`, tenantId };
      }

      if (refundOutcome === "processed" || refundOutcome === "already_processed") {
        // Ensure the refund document and notification email are issued even on
        // retries where the ledger update already succeeded on an earlier run.
        // issueRefundDocument and queueForTenant are idempotent by refund/event key.
        const refund = refundEntity;
        const { data: ledgerRow, error: ledgerErr } = await db
          .from("subscription_payments")
          .select(
            "id, amount, currency, status, payment_method, plan_id, billing_period, created_at, razorpay_payment_id, razorpay_order_id",
          )
          .eq("razorpay_payment_id", String(targetPaymentId))
          .maybeSingle();
        if (ledgerErr) {
          throw new Error(`could not load refunded payment row: ${ledgerErr.message}`);
        }
        if (ledgerRow) {
          const docAmount = verifiedRefundAmount > 0 ? verifiedRefundAmount : Number((ledgerRow as any).amount ?? 0);
          const refundDoc = await issueRefundDocument(db, tenantId, ledgerRow, {
            refundedAt: refund?.created_at ? new Date(refund.created_at * 1000) : undefined,
            razorpayRefundId: verifiedRefundId,
            amount: docAmount,
          });
          if (!refundDoc) {
            throw new Error(`could not issue refund document for ${String(targetPaymentId)}`);
          }
          await queueForTenant(db, tenantId, {
            eventKey: `payment_refunded:${String(targetPaymentId)}:${verifiedRefundId ?? "doc"}`,
            eventType: "payment_refunded",
            planName: (ledgerRow as any).plan_id,
            amount: docAmount,
            currency: (ledgerRow as any).currency ?? verifiedCurrency,
            throwOnInsertError: true,
            payload: {
              refundedAt: refund?.created_at ? new Date(refund.created_at * 1000).toISOString() : now,
              refundId: verifiedRefundId,
              refundNumber: (refundDoc as any)?.refund_number ?? null,
              paymentRef: String(targetPaymentId),
            },
          });
          try {
            await dispatchPending(db, 5);
          } catch (e) {
            console.error("webhook: refund email dispatch failed", (e as Error)?.message);
          }
        }
      }

      await auditRefundIdempotent(db, tenantId, tenant.plan, planId, eventId, {
        paymentId: targetPaymentId,
        refundId: verifiedRefundId,
        totalRefunded: (refundRpcRes as any)?.total_refunded ?? null,
        isFullyRefunded: (refundRpcRes as any)?.is_fully_refunded ?? null,
      });

      if (refundOutcome === "already_processed") {
        return { summary: "refund already processed", tenantId };
      }

      return { summary: "payment refunded", tenantId };
    }

    default:
      return { summary: `ignored ${eventType}`, tenantId };
  }
}

/**
 * A charge (or first-payment activation) that lost the link decision.
 *
 * The money is already in the ledger by the time this runs. What remains is
 * stopping it from happening again and leaving a trail a human can act on:
 *
 *   - a charge from a dead mandate needs nothing but the audit row (the
 *     mandate cannot charge again by definition);
 *   - a charge from a live DUPLICATE — while another billable mandate holds
 *     the link — is cancelled immediately so it can never charge twice, and
 *     the audit row carries `refundReview: true`: cancelling stops future
 *     debits, it does not return the money already taken.
 *
 * Best-effort throughout: the event has already been gated, and throwing
 * here would make Razorpay retry a delivery that has done its job.
 */
async function rejectIncomingCharge(
  db: any,
  args: {
    tenantId: string;
    incomingId: string;
    linkedId: string | null;
    decision: "reject-dead-incoming" | "reject-linked-billable";
    eventId: string;
    planId: string | null;
    oldPlan: string | null;
    paymentId?: string | null;
    amount?: number | null;
  },
): Promise<void> {
  const { tenantId, incomingId, linkedId, decision, eventId, planId } = args;

  let cancelResult: string | null = null;
  if (decision === "reject-linked-billable") {
    try {
      const cancelled = await cancelSubscription(incomingId, false);
      cancelResult = cancelled.ok ? "cancelled" : `cancel failed: ${cancelled.error}`;
    } catch (e) {
      cancelResult = `cancel failed: ${(e as Error)?.message}`;
    }
  }

  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: args.oldPlan ?? null,
    new_plan: planId,
    change_type: decision === "reject-dead-incoming"
      ? "charge_from_dead_subscription"
      : "duplicate_mandate_charge_rejected",
    razorpay_event_id: eventId,
    detail: {
      incomingSubscriptionId: incomingId,
      linkedSubscriptionId: linkedId,
      decision,
      paymentId: args.paymentId ?? null,
      amount: args.amount ?? null,
      cancelResult,
      // A human looks at this: the charge is real money on a mandate that
      // should never have existed, and cancelling does not return it.
      refundReview: decision === "reject-linked-billable",
    },
  });
}

async function auditRefundIdempotent(
  db: any,
  tenantId: string,
  oldPlan: string | null,
  newPlan: string | null,
  eventId: string,
  detail: {
    paymentId: unknown;
    refundId: string | null;
    totalRefunded: unknown;
    isFullyRefunded: unknown;
  },
) {
  let existingQuery = db
    .from("subscription_audit_logs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("change_type", "refunded");

  if (detail.refundId) {
    existingQuery = existingQuery.eq("detail->>refundId", detail.refundId);
  } else {
    existingQuery = existingQuery.eq("razorpay_event_id", eventId);
  }

  const { data: existing } = await existingQuery.limit(1).maybeSingle();
  if (existing) return;

  await audit(db, tenantId, oldPlan, newPlan, "refunded", eventId, detail);
}

async function audit(
  db: any,
  tenantId: string,
  oldPlan: string | null,
  newPlan: string | null,
  changeType: string,
  eventId: string,
  detail: Record<string, unknown>,
) {
  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: oldPlan,
    new_plan: newPlan,
    change_type: changeType,
    razorpay_event_id: eventId,
    detail,
  });
}
