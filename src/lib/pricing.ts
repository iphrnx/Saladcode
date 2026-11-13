/**
 * Pricing shown to a person, and the intent they carried into signup.
 *
 * The amounts are not written here: they come from the plan catalogue, which
 * is the only copy. This module only decides how an interval is chosen,
 * labelled, priced and remembered between the landing page and the billing
 * tab — so the two screens cannot disagree about what "annual" means.
 */

export type BillingInterval = 'monthly' | 'annual'

export const INTERVALS: BillingInterval[] = ['monthly', 'annual']

export function intervalLabel(interval: BillingInterval): string {
  return interval === 'annual' ? 'Annual' : 'Monthly'
}

/** The per-period amount. Falls back to the monthly price if a plan has no
 * annual price, so a card never renders ₹0. */
export function priceFor(
  plan: { priceMonthly: number; priceYearly?: number | null },
  interval: BillingInterval,
): number {
  if (interval === 'annual') return Number(plan.priceYearly ?? 0) || plan.priceMonthly
  return plan.priceMonthly
}

/** What annual billing saves, in rupees and as a whole percent. Null when the
 * plan is not sold yearly or the yearly price would not save anything. */
export function annualSavings(plan: {
  priceMonthly: number
  priceYearly?: number | null
}): { amount: number; percent: number } | null {
  const yearly = Number(plan.priceYearly ?? 0)
  if (!yearly || !plan.priceMonthly) return null
  const full = plan.priceMonthly * 12
  const amount = full - yearly
  if (amount <= 0) return null
  return { amount, percent: Math.round((amount / full) * 1000) / 10 }
}

const INTENT_KEY = 'the-salad-plan-intent'

/**
 * The plan and interval a visitor chose on the landing page.
 *
 * A CTA has to survive sign-in and onboarding before it can reach billing, so
 * the choice is kept on the device rather than in the URL. It is read once,
 * when the billing tab opens, and then cleared — a stale intent must not
 * silently change what a returning owner sees months later.
 */
export function rememberPlanIntent(planId: string, interval: BillingInterval) {
  try {
    localStorage.setItem(INTENT_KEY, JSON.stringify({ planId, interval, at: Date.now() }))
  } catch {
    /* private mode — the CTA still works, it just lands on Monthly */
  }
}

export function consumePlanIntent(): { planId: string; interval: BillingInterval } | null {
  try {
    const raw = localStorage.getItem(INTENT_KEY)
    if (!raw) return null
    localStorage.removeItem(INTENT_KEY)
    const parsed = JSON.parse(raw)
    const interval: BillingInterval = parsed?.interval === 'annual' ? 'annual' : 'monthly'
    const planId = typeof parsed?.planId === 'string' ? parsed.planId : ''
    // An intent older than a day is not about this visit.
    if (!planId || Date.now() - Number(parsed?.at ?? 0) > 86_400_000) return null
    return { planId, interval }
  } catch {
    return null
  }
}
