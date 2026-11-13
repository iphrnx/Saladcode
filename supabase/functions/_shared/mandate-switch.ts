/**
 * The writes that keep one restaurant on one billable mandate.
 *
 * Two moments can leave a restaurant with two mandates that can both take
 * money:
 *
 *   1. Linking the tenant to a new subscription while the old one is still
 *      billable at Razorpay (an upgrade that started a new mandate, a
 *      resubscribe after cancellation, a duplicate mandate that slipped
 *      through before checkout dedupe existed).
 *   2. Paid time moving past a scheduled mandate's start (a pay-once
 *      purchase extending the boundary the mandate was computed from).
 *
 * Both are handled the same way: look at Razorpay, cancel only what has
 * never charged, verify the final state, and write the audit row. Every
 * path that can switch or supersede a mandate goes through here, so the
 * rules live once.
 *
 * These helpers never throw: money has often already moved by the time they
 * run, and a bookkeeping failure must not roll back a real entitlement.
 * They return what they did; the caller logs it.
 */
import { cancelSubscription, fetchSubscription } from "./razorpay.ts";
import {
  canCancelWithoutPaymentImpact,
  decideSwitchAction,
  isDeadStatus,
  type LiveSubscription,
} from "./subscription-guard.ts";

export type SupersedeResult =
  | { kind: "cancelled"; razorpayStatus: string }
  | { kind: "already-dead"; razorpayStatus: string }
  | { kind: "kept"; reason: string }
  | { kind: "unknown"; reason: string };

function liveFromFetch(
  fetched: { ok: true; data: Record<string, unknown> } | { ok: false; error: string },
): LiveSubscription | null {
  if (!fetched.ok) return null;
  return {
    status: String(fetched.data.status ?? ""),
    paidCount: Number(fetched.data.paid_count ?? 0),
  };
}

/**
 * The tenant's link moved from one Razorpay subscription to another (or to
 * none). If the previous subscription can still take money, cancel it and
 * confirm the cancellation — one restaurant, one recurring charge.
 *
 * Never touches the tenant's access: the period the previous mandate paid
 * for lives in `current_period_end`, not in the mandate's liveness.
 */
export async function cancelSupersededLink(
  db: any,
  args: {
    tenantId: string;
    previousSubscriptionId: string | null;
    newSubscriptionId: string | null;
    /** Which code path is doing this — for the audit row. */
    source: string;
    oldPlan?: string | null;
    newPlan?: string | null;
  },
): Promise<SupersedeResult> {
  const { tenantId, previousSubscriptionId, newSubscriptionId, source } = args;

  let previousLive: LiveSubscription | null = null;
  if (previousSubscriptionId && previousSubscriptionId !== newSubscriptionId) {
    previousLive = liveFromFetch(await fetchSubscription(previousSubscriptionId));
  }

  const decision = decideSwitchAction({
    previousSubscriptionId,
    newSubscriptionId,
    previousLive,
  });

  if (decision.kind === "leave") return { kind: "already-dead", razorpayStatus: previousLive?.status ?? "none" };

  if (decision.kind === "unknown") {
    await db.from("subscription_audit_logs").insert({
      tenant_id: tenantId,
      old_plan: args.oldPlan ?? null,
      new_plan: args.newPlan ?? null,
      change_type: "mandate_supersede_unverified",
      detail: {
        previousSubscriptionId,
        newSubscriptionId,
        source,
        reason: "Razorpay did not answer the status check; the previous mandate was left untouched.",
      },
    });
    return { kind: "unknown", reason: "razorpay fetch failed" };
  }

  // decision.kind === "cancel-previous"
  const cancelled = await cancelSubscription(previousSubscriptionId as string, false);
  if (!cancelled.ok) {
    await db.from("subscription_audit_logs").insert({
      tenant_id: tenantId,
      old_plan: args.oldPlan ?? null,
      new_plan: args.newPlan ?? null,
      change_type: "mandate_supersede_unverified",
      detail: {
        previousSubscriptionId,
        newSubscriptionId,
        source,
        reason: `Razorpay refused the cancellation: ${cancelled.error}`,
      },
    });
    return { kind: "unknown", reason: cancelled.error };
  }

  // The cancel is not believed until Razorpay says it back.
  const after = liveFromFetch(await fetchSubscription(previousSubscriptionId as string));
  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    old_plan: args.oldPlan ?? null,
    new_plan: args.newPlan ?? null,
    change_type: "mandate_superseded",
    detail: {
      previousSubscriptionId,
      newSubscriptionId,
      source,
      razorpayStatusBefore: previousLive?.status ?? null,
      razorpayStatusAfter: after?.status ?? "unconfirmed",
    },
  });
  return { kind: "cancelled", razorpayStatus: after?.status ?? "unconfirmed" };
}

/**
 * Retire a *pending* mandate checkout that has been superseded — replaced by
 * a different purchase, or stranded by paid time moving past its start.
 *
 * Only a mandate that has never collected money is touched, and only after
 * Razorpay has said what it is. The row is marked `expired` (never deleted —
 * the record of what was created stays) and the cancellation is audited.
 */
export async function retirePendingMandate(
  db: any,
  args: {
    tenantId: string;
    checkoutId: string;
    razorpaySubscriptionId: string;
    /** Why it is being retired — "replaced", "superseded-by-purchase", "dead". */
    reason: string;
    /** A live read the caller already made, to avoid fetching twice. */
    live: LiveSubscription | null;
  },
): Promise<SupersedeResult> {
  const { tenantId, checkoutId, razorpaySubscriptionId, reason, live } = args;

  if (!live) {
    return { kind: "unknown", reason: "razorpay fetch failed" };
  }

  // A mandate that can never charge again — whatever it collected before it
  // died — needs no cancellation, only its row retired. This comes FIRST:
  // a cancelled mandate with past payments is history, not a live bill.
  if (isDeadStatus(live.status)) {
    await db
      .from("subscription_checkouts")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", checkoutId)
      .eq("status", "pending");
    return { kind: "already-dead", razorpayStatus: live.status };
  }

  if (!canCancelWithoutPaymentImpact(live)) {
    // Still alive and has charged: cancelling it is a human decision, not
    // an automatic one.
    return { kind: "kept", reason: "the mandate has collected payments" };
  }

  const cancelled = await cancelSubscription(razorpaySubscriptionId, false);
  if (!cancelled.ok) {
    return { kind: "unknown", reason: cancelled.error };
  }
  const after = liveFromFetch(await fetchSubscription(razorpaySubscriptionId));

  await db
    .from("subscription_checkouts")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .eq("id", checkoutId)
    .eq("status", "pending");

  await db.from("subscription_audit_logs").insert({
    tenant_id: tenantId,
    change_type: "scheduled_change_cancelled",
    detail: {
      checkoutId,
      razorpaySubscriptionId,
      reason,
      razorpayStatusBefore: live.status,
      razorpayStatusAfter: after?.status ?? "unconfirmed",
    },
  });
  return { kind: "cancelled", razorpayStatus: after?.status ?? "unconfirmed" };
}
