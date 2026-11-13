// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { queueEmail } from "./email.ts";

/**
 * Which reminders are due today, and nothing else.
 *
 * Pure decision + queueing, separated from the HTTP entrypoint so it can be
 * exercised against real renewal dates without a provider.
 *
 * Only plans that end by themselves get a reminder: a monthly mandate renews
 * on its own, so "your plan expires" would be a lie. A pay-once year, a legacy
 * one-time purchase and a cancelled subscription all stop dead unless someone
 * acts — those are the ones worth warning.
 *
 * Every key carries the period end and the day offset, so tomorrow's run
 * queues the next reminder instead of repeating this one, and a re-run later
 * the same day queues nothing at all.
 */
const DAY_MS = 86_400_000;

/** Whole days between now and a future date, rounded up. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / DAY_MS);
}

/**
 * The reminders a person needs today.
 *
 * Only plans that end by themselves: a monthly mandate renews on its own, so
 * "your plan expires" would be untrue for it. A pay-once year and a trial both
 * stop dead unless someone acts, which is exactly when a reminder earns its
 * place.
 *
 * Keys carry the period end, so tomorrow's run — and next month's — queue the
 * next reminder rather than re-sending this one.
 */
export async function queueReminders(db: SupabaseClient): Promise<{ queued: number; kinds: string[] }> {
  const now = new Date().toISOString();
  const queue: Array<Record<string, unknown>> = [];

  const { data: tenants } = await db
    .from("tenants")
    .select(
      "id, name, email, plan, subscription_plan, subscription_status, current_period_end, trial_ends_at, billing_interval, payment_mode",
    )
    .in("subscription_status", ["trial", "active", "cancelled", "past_due", "pending"])
    .limit(2000);

  for (const t of (tenants ?? []) as any[]) {
    const { data: owner } = await db
      .from("profiles")
      .select("name, email")
      .eq("tenant_id", t.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const recipient = (owner as any)?.email ?? t.email ?? null;
    if (!recipient) continue;

    const base = {
      tenantId: t.id as string,
      recipient,
      recipientName: (owner as any)?.name ?? null,
      restaurantName: t.name as string,
      planName: t.subscription_plan ?? t.plan ?? null,
      currency: "INR",
    };

    // ── Trial reminders ────────────────────────────────────────────────
    if (t.subscription_status === "trial" && t.trial_ends_at) {
      const days = daysUntil(t.trial_ends_at);
      if (days !== null && days <= 0) {
        // One "your trial ended" per trial, not per day.
        queue.push({
          ...base,
          eventKey: `trial_ended:${t.id}:${t.trial_ends_at}`,
          eventType: "trial_ended",
          payload: { trialEndsAt: t.trial_ends_at },
        });
      } else if (days === 7 || days === 1) {
        queue.push({
          ...base,
          eventKey: `trial_ending:${t.id}:${t.trial_ends_at}:${days}`,
          eventType: "trial_ending",
          payload: { trialEndsAt: t.trial_ends_at, daysBefore: days },
        });
      }
    }

    // ── Paid period that will not renew itself ─────────────────────────
    const selfEnding =
      t.payment_mode === "pay_once" ||
      t.subscription_plan === "starter-onetime" ||
      t.subscription_status === "cancelled";
    if (selfEnding && t.current_period_end && ["active", "cancelled"].includes(t.subscription_status)) {
      const days = daysUntil(t.current_period_end);
      if (days !== null && days >= 0 && [30, 7, 1].includes(days)) {
        queue.push({
          ...base,
          eventKey: `renewal_reminder:${t.id}:${t.current_period_end}:${days}`,
          eventType: "renewal_reminder",
          billingInterval: t.billing_interval,
          payload: { periodEnd: t.current_period_end, daysBefore: days },
        });
      }
    }
  }

  // Price comes from the catalogue, never from a hardcoded number here.
  const { data: plans } = await db.from("subscription_plans").select("id, price_monthly, price_yearly");
  const priceOf = (planId: string | null, interval: string | null) => {
    const row = (plans ?? []).find((p: any) => p.id === planId);
    if (!row) return null;
    return interval === "annual" ? Number((row as any).price_yearly) : Number((row as any).price_monthly);
  };

  const kinds: string[] = [];
  let queued = 0;
  for (const item of queue) {
    const withPrice = {
      ...item,
      amount: priceOf(item.planName as string, (item as any).billingInterval ?? "monthly"),
    } as any;
    const id = await queueEmail(db, {
      eventKey: withPrice.eventKey,
      eventType: withPrice.eventType,
      tenantId: withPrice.tenantId,
      recipient: withPrice.recipient,
      recipientName: withPrice.recipientName,
      restaurantName: withPrice.restaurantName,
      planName: withPrice.planName,
      amount: withPrice.amount,
      currency: withPrice.currency,
      billingInterval: withPrice.billingInterval ?? null,
      payload: withPrice.payload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    if (id) {
      queued++;
      kinds.push(withPrice.eventType);
    }
  }
  void now;
  return { queued, kinds };
}

