/**
 * Display rules for the billing views, kept pure and shared between the
 * billing tab and the Manage Billing view — and unit-tested without a
 * browser.
 *
 * The single source of naming truth is `planDirectory` from the server,
 * which covers EVERY plan including retired ones. The active-only catalogue
 * the plans grid uses must never name history: that is how a retired
 * one-time purchase got labelled "starter-onetime · Monthly".
 */

export type PlanDirectory = Record<string, { name: string; billingMode: 'onetime' | 'recurring' }>

/**
 * The timezone every billing date is read in.
 *
 * Billing dates are stored as UTC instants, but they are *business* days: the
 * day a trial ends, the day a renewal is due, the day access stops. Rendering
 * them with the viewer's clock made the same subscription read as two
 * different dates on two machines — the owner's phone in IST and a laptop in
 * UTC disagreed by a day, and so did the Billing tab and Manage Billing when
 * one of them built its own date text. So every billing date is formatted in
 * one declared timezone, the restaurant's own, and both views use this
 * formatter and nothing else.
 */
export const DEFAULT_BILLING_TIME_ZONE = 'Asia/Kolkata'

/** Where a billing date is read from the database in the first place. */
export const SUPABASE_TIME_ZONE = 'UTC'

/** "₹1,23,456" / "INR 1,234" — the money style the whole product uses. */
export function formatMoney(currency: string, amount: number): string {
  const n = Number(amount ?? 0).toLocaleString('en-IN')
  return currency === 'INR' ? `₹${n}` : `${currency} ${n}`
}

/** The calendar day of an instant, as the restaurant would read it (YYYY-MM-DD). */
function dayKeyIn(iso: string, timeZone: string): string | null {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  // en-CA is the one built-in locale whose short date is already YYYY-MM-DD,
  // which keeps this free of hand-rolled month tables.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const key = `${get('year')}-${get('month')}-${get('day')}`
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null
}

/** DD/MM/YYYY in the billing timezone. An unreadable date is a dash. */
export function formatBillingDate(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_BILLING_TIME_ZONE,
): string {
  if (!iso) return '—'
  const key = dayKeyIn(iso, timeZone)
  if (!key) return '—'
  const [y, m, d] = key.split('-')
  return `${d}/${m}/${y}`
}

/**
 * Whole calendar days from `now` to `iso`, read in the billing timezone.
 *
 * Calendar days, not a duration rounded up: the view prints this next to the
 * date ("Trial ends 10/11/2026 · 2 days left"), and a duration-based count
 * said 3 there — a number the owner cannot reconcile with the date beside it.
 * 0 means "today", a negative number means it has already passed, and null
 * means the date could not be read.
 */
export function daysBetween(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  timeZone: string = DEFAULT_BILLING_TIME_ZONE,
): number | null {
  if (!fromIso || !toIso) return null
  const a = dayKeyIn(fromIso, timeZone)
  const b = dayKeyIn(toIso, timeZone)
  if (!a || !b) return null
  const toUtc = (key: string) => {
    const [y, m, d] = key.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}

/** "2 days left" / "1 day left" / "Ends today" / "Ended 3 days ago". */
export function daysLeftText(days: number | null): string | null {
  if (days === null) return null
  if (days === 0) return 'Ends today'
  if (days === 1) return '1 day left'
  if (days > 1) return `${days} days left`
  if (days === -1) return 'Ended yesterday'
  return `Ended ${Math.abs(days)} days ago`
}

/** A plan's display name. Directory first; a raw id only when nothing knows it. */
export function resolvePlanName(directory: PlanDirectory | null | undefined, planId: string | null | undefined): string {
  if (!planId) return '—'
  return directory?.[planId]?.name ?? planId
}

/**
 * The billing-period label for a historical payment. A retired one-time
 * plan says "One-time · 30 days" even though its payment row literally
 * records "monthly" — the directory's billingMode wins over the row.
 */
export function periodLabel(
  directory: PlanDirectory | null | undefined,
  planId: string | null | undefined,
  billingPeriod: string | null | undefined,
): string {
  if (planId && directory?.[planId]?.billingMode === 'onetime') return 'One-time · 30 days'
  const p = String(billingPeriod ?? '').trim()
  if (!p) return '—'
  return p.charAt(0).toUpperCase() + p.slice(1)
}

/** A human sentence for one plan-history entry's change type. */
export function changeLabel(changeType: string | null | undefined): string {
  switch (String(changeType ?? '')) {
    case 'activated': return 'Plan activated'
    case 'activation_without_payment': return 'Activation attempt without a collected payment'
    case 'renewed': return 'Subscription renewed'
    case 'plan_change_scheduled': return 'Plan change scheduled'
    case 'scheduled_change_cancelled': return 'Scheduled change cancelled'
    case 'cancelled': return 'Subscription cancelled'
    case 'completed': return 'Subscription completed'
    case 'paused': return 'Subscription paused'
    case 'halted': return 'Subscription halted'
    case 'expired': return 'Subscription expired'
    case 'payment_failed': return 'Payment failed'
    case 'refunded': return 'Payment refunded'
    default: {
      const raw = String(changeType ?? '').trim()
      if (!raw) return 'Change'
      return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ')
    }
  }
}

/** The kind of an upcoming item, for the icon/tone the view picks. */
export interface UpcomingItem {
  kind: 'debit' | 'start' | 'end' | 'renewal-due'
  label: string
  date: string | null
  amount: number | null
  currency: string
}

export interface ScheduledChange {
  checkoutId: string
  planId: string
  planName: string
  interval: 'monthly' | 'annual'
  paymentMode: 'autopay' | 'pay_once'
  amount: number
  currency: string
  scheduledStartAt: string
  mandateId: string | null
  mandateState: 'authorised' | 'active' | 'ended' | 'cancelled' | 'unverified'
}

export interface LiveMandate {
  subscriptionId: string
  state: 'authorised' | 'active' | 'ended' | 'cancelled' | 'unverified'
  status: string
  totalCycles: number | null
  chargesMade: number | null
  cyclesRemaining: number | null
  currentPeriodEnd: string | null
  endAt: string | null
  chargeable: boolean
}

export interface BillingHistoryItem {
  id: string
  changeType: string
  oldPlan: string | null
  newPlan: string | null
  oldPlanName: string | null
  newPlanName: string | null
  amountPaid: number | null
  createdAt: string
}

export interface BillingTotals {
  totalCharged: number
  totalRefunded: number
  netSpent: number
  paymentCount: number
  currency: string
}

/** The payload of GET /api/subscriptions/manage. */
export interface ManagePayload {
  /**
   * The plan in force, exactly as `/subscriptions/state` returns it. Both
   * views render this one object, so a plan, a price or a status can never
   * differ between them.
   */
  plan: BillingPlanFacts | null
  renewal: RenewalFacts
  upcoming: UpcomingItem[]
  scheduledChanges: ScheduledChange[]
  mandate: LiveMandate | null
  history: BillingHistoryItem[]
  totals: BillingTotals
  planDirectory: PlanDirectory
  locationCount: number
  warnings: string[]
}

/** A mandate status as the owner should read it. */
export function mandateStateLabel(m: LiveMandate | ScheduledChange | null | undefined): string {
  if (!m) return '—'
  const state = 'mandateState' in m ? m.mandateState : m.state
  switch (state) {
    case 'authorised': return 'Authorised'
    case 'active': return 'Active'
    case 'ended': return 'Ended'
    case 'cancelled': return 'Not charging'
    default: return 'Unverified'
  }
}

/** The tone a mandate state is shown in. */
export function mandateTone(
  m: LiveMandate | ScheduledChange | null | undefined,
): BillingTone {
  if (!m) return 'neutral'
  const state = 'mandateState' in m ? m.mandateState : m.state
  switch (state) {
    case 'active': return 'success'
    case 'authorised': return 'info'
    case 'ended': return 'warn'
    case 'cancelled': return 'warn'
    default: return 'warn'
  }
}

/** "Monthly · AutoPay" — the same words the server uses on its own labels. */
export function intervalModeLabel(interval: 'monthly' | 'annual', mode: 'autopay' | 'pay_once'): string {
  if (interval === 'annual') return 'Annual · Pay once'
  return mode === 'autopay' ? 'Monthly · AutoPay' : 'Monthly · Pay once'
}

/* ------------------------------------------------------------------------- *
 * The billing snapshot
 *
 * One derivation, rendered by two pages. Everything a page shows about the
 * subscription — its name, price, status, trial window, days left, renewal
 * and payment mode — is computed here from one plan object and one verified
 * `manage` payload. The pages do no arithmetic and no formatting of their
 * own, which is what keeps them from drifting apart again: the earlier
 * divergence was not one wrong number, it was two derivations of the same
 * facts, one reading the bootstrap snapshot and one reading the fresh
 * /subscriptions payload, and neither aware of the other.
 *
 * Two rules are enforced here rather than left to a page:
 *
 *   1. No date is ever rendered from the viewer's clock — see
 *      `formatBillingDate`.
 *   2. AutoPay is never asserted without a mandate Razorpay confirmed.
 *      A stored `payment_mode` of "autopay" is a record of what was
 *      intended at checkout; only a live, authorised mandate makes it true.
 * ------------------------------------------------------------------------- */

/** The plan facts both payloads carry (the `publicPlan` shape). */
export interface BillingPlanFacts {
  planId: string
  planName: string
  status: string
  isPaid: boolean
  isTrial: boolean
  isRestricted: boolean
  trialStartedAt: string | null
  trialEndsAt: string | null
  trialDaysRemaining: number | null
  subscriptionPlan?: string | null
  subscriptionStartedAt?: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  billingInterval?: 'monthly' | 'annual'
  paymentMode?: 'autopay' | 'pay_once' | null
  billingMode?: 'onetime' | 'recurring'
  priceMonthly: number
  priceYearly?: number | null
  currency: string
  limits?: { locations: number | null; staff: number | null; menuItems: number | null }
}

/** What the server decided about renewal — never a date in prose. */
export interface RenewalFacts {
  kind:
    | 'trial'
    | 'restricted'
    | 'past_due'
    | 'retrying'
    | 'cancelled'
    | 'scheduled'
    | 'onetime'
    | 'pay_once'
    | 'autopay'
    | 'unverified'
    | 'none'
  label: string
  detail: string
  /** The instant a scheduled change begins; formatted by the view. */
  startsAt?: string | null
}

export type BillingTone = 'success' | 'info' | 'warn' | 'danger' | 'neutral'

export interface BillingSnapshot {
  /** True when a plan is known at all — including the fallback one. */
  hasPlan: boolean
  /**
   * True when a paid plan or a running trial is actually in force. A
   * restaurant whose trial ran out has no plan even though the server still
   * names the fallback one, and the views must not present that as theirs.
   */
  inForce: boolean
  planName: string
  /** The price of the plan in force, in the interval it is sold on. */
  price: string
  statusLabel: string
  statusTone: BillingTone
  startedLabel: string
  startedValue: string
  periodLabel: string
  /** The date, with "· N days left" appended while a window is running. */
  periodValue: string
  periodDate: string | null
  daysLeft: number | null
  /** Null until the verified payload has loaded — never a local guess. */
  renewalLabel: string | null
  renewalDetail: string | null
  /**
   * False when the server could not confirm auto-renewal. The views show the
   * line in a warning tone rather than pretending the mandate is live.
   */
  renewalConfirmed: boolean
  modeLabel: string
  /** Present only while a trial is running. */
  trial: { started: string; ends: string; daysLeft: number | null } | null
}

const STATUS_COPY: Record<string, { label: string; tone: BillingTone }> = {
  trial: { label: 'Free trial', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  expired: { label: 'Trial expired', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'warn' },
  past_due: { label: 'Payment failed', tone: 'danger' },
  pending: { label: 'Pending', tone: 'warn' },
  paused: { label: 'Paused', tone: 'warn' },
  none: { label: 'No subscription', tone: 'neutral' },
}

export function statusFor(plan: BillingPlanFacts | null | undefined): { label: string; tone: BillingTone } {
  if (!plan) return { label: '—', tone: 'neutral' }
  // A restaurant with nothing in force reads "Ended", not the raw status:
  // "expired" describes the trial, while the restaurant is still there and
  // simply has no paid plan.
  if (plan.isRestricted) return { label: 'Ended', tone: 'warn' }
  const known = STATUS_COPY[plan.status]
  return known ?? { label: plan.status || '—', tone: 'neutral' }
}

/** The plan's list price, in the interval it is actually on. */
export function priceLabel(plan: BillingPlanFacts | null | undefined): string {
  if (!plan) return '—'
  const currency = plan.currency || 'INR'
  if (plan.billingMode === 'onetime') return `${formatMoney(currency, plan.priceMonthly)} once`
  const yearly = plan.billingInterval === 'annual'
  const amount = yearly ? (plan.priceYearly || plan.priceMonthly) : plan.priceMonthly
  return `${formatMoney(currency, amount)} / ${yearly ? 'year' : 'month'}`
}

/**
 * How the period was paid, stated only as far as it is known.
 *
 * "AutoPay" is a claim that money will be taken without the owner doing
 * anything, so it is made only when Razorpay confirms a live or authorised
 * mandate for this subscription. A `payment_mode` of "autopay" with nothing
 * behind it reads "renewal unverified" instead — the honest version of the
 * same fact — and an unrecorded mode says so rather than defaulting to the
 * busier of the two.
 */
export function paymentModeLabel(
  plan: BillingPlanFacts | null | undefined,
  mandate: LiveMandate | null | undefined,
): string {
  if (!plan) return '—'
  const interval = plan.billingInterval === 'annual' ? 'Annual' : 'Monthly'
  if (plan.billingMode === 'onetime') return 'One-time · retired'
  // A pay-once period was bought as a single order; nothing debits it, and a
  // mandate authorised for a *future* plan change does not change that.
  if (plan.paymentMode === 'pay_once') return `${interval} · Pay once`
  if (mandate && (mandate.state === 'active' || mandate.state === 'authorised')) {
    return `${interval} · AutoPay`
  }
  if (plan.paymentMode === 'autopay') return `${interval} · renewal unverified`
  return `${interval} · payment mode not recorded`
}

/**
 * The whole subscription, as one set of display values.
 *
 * `manage` is the verified payload. When it is absent — still loading, or the
 * call failed — the renewal line is null and both pages say the same thing:
 * that it could not be confirmed. It is deliberately not replaced by a local
 * guess, because a guess is exactly what the two pages used to disagree on.
 */
export function buildBillingSnapshot(args: {
  plan: BillingPlanFacts | null | undefined
  manage?: ManagePayload | null
  now?: Date | string | number
  timeZone?: string
}): BillingSnapshot {
  const { plan, manage } = args
  const tz = args.timeZone || DEFAULT_BILLING_TIME_ZONE
  const nowIso = new Date(args.now ?? Date.now()).toISOString()

  if (!plan) {
    return {
      hasPlan: false,
      inForce: false,
      planName: 'No plan yet',
      price: '—',
      statusLabel: '—',
      statusTone: 'neutral',
      startedLabel: 'Started',
      startedValue: '—',
      periodLabel: 'Status',
      periodValue: 'No active plan',
      periodDate: null,
      daysLeft: null,
      renewalLabel: manage?.renewal ? renewalLabelOf(manage.renewal, tz) : null,
      renewalDetail: manage?.renewal?.detail ?? null,
      renewalConfirmed: manage?.renewal?.kind !== 'unverified',
      modeLabel: '—',
      trial: null,
    }
  }

  const status = statusFor(plan)
  const onetime = plan.billingMode === 'onetime'

  // The start of the period in force: a trial starts at its own date, a paid
  // plan at its subscription start, and a legacy row with no start date falls
  // back to the trial's — the day the restaurant actually began.
  const startedLabel = plan.isTrial ? 'Trial started' : 'Started'
  const startedRaw = plan.isTrial
    ? plan.trialStartedAt
    : (plan.subscriptionStartedAt ?? plan.trialStartedAt)

  // The end of the window in force, and what to call it. A period that does
  // not renew itself has an end, not a next billing date.
  const nothingInForce = !plan.isTrial && !plan.isPaid
  const periodIso = nothingInForce ? null : plan.isTrial ? plan.trialEndsAt : plan.currentPeriodEnd
  const daysLeft = nothingInForce ? null : daysBetween(nowIso, periodIso, tz)
  const periodDate = periodIso ? formatBillingDate(periodIso, tz) : null
  // The label names what the date *is*. Three cases the old copy got wrong:
  // a cancelled subscription has an end date, not a next billing date; a
  // period that has already elapsed (a failed or retrying renewal) has ended,
  // and calling it "next" contradicts the date beside it.
  const periodLabel = nothingInForce
    ? 'Status'
    : plan.isTrial
      ? 'Trial ends'
      : onetime || plan.paymentMode === 'pay_once'
        ? 'Access expires on'
        : plan.cancelAtPeriodEnd
          ? 'Access ends on'
          : daysLeft !== null && daysLeft < 0
            ? 'Period ended on'
            : 'Next billing date'
  // A countdown only makes sense for a window still running; beside a date
  // that has passed it would read "Ended 3 days ago" under a future tense.
  const left = daysLeft !== null && daysLeft >= 0 ? daysLeftText(daysLeft) : null
  const periodValue = nothingInForce
    ? 'No active plan'
    : left && periodDate
      ? `${periodDate} · ${left}`
      : (periodDate ?? '—')

  const renewal = manage?.renewal ?? null
  return {
    hasPlan: true,
    inForce: !nothingInForce,
    planName: plan.planName,
    // A restaurant with nothing in force is shown the *fallback* plan's facts
    // by the server, so printing its price would quote a plan they do not
    // have. The plan name stays (it is what they would be on), the money does
    // not.
    price: nothingInForce ? '—' : priceLabel(plan),
    statusLabel: status.label,
    statusTone: status.tone,
    startedLabel,
    startedValue: formatBillingDate(startedRaw, tz),
    periodLabel,
    periodValue,
    periodDate,
    daysLeft,
    renewalLabel: renewal ? renewalLabelOf(renewal, tz) : null,
    renewalDetail: renewal?.detail || null,
    renewalConfirmed: renewal ? renewal.kind !== 'unverified' : true,
    // A trial is not being paid for in any mode; only say how once there is
    // something to pay.
    modeLabel: nothingInForce || plan.isTrial ? '—' : paymentModeLabel(plan, manage?.mandate ?? null),
    trial: plan.isTrial
      ? {
          started: formatBillingDate(plan.trialStartedAt, tz),
          ends: formatBillingDate(plan.trialEndsAt, tz),
          daysLeft: daysBetween(nowIso, plan.trialEndsAt, tz),
        }
      : null,
  }
}

/**
 * The renewal line, with any date formatted here rather than on the server.
 *
 * The server used to bake "starts 30/11/2027" into the label by slicing the
 * UTC date out of the timestamp, while the Upcoming list below it formatted
 * the same instant in local time — so a start at 20:00 UTC read as 30/11 in
 * one place and 01/12 in the other.
 */
export function renewalLabelOf(renewal: RenewalFacts, timeZone: string = DEFAULT_BILLING_TIME_ZONE): string {
  if (renewal.kind === 'scheduled' && renewal.startsAt) {
    return `${renewal.label} starts ${formatBillingDate(renewal.startsAt, timeZone)}`
  }
  return renewal.label
}
