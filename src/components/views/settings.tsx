'use client'

import { useMemo, useState, useEffect, useCallback } from 'react'
import { useApp } from '@/components/app/data-context'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { useScrollCollapse } from '@/lib/use-scroll-collapse'
import { ImageUpload } from '@/components/shared/image-upload'
import { PhoneInput } from '@/components/shared/phone-input'
import { applyTheme } from '@/lib/theme'
import { createClient } from '@/lib/supabase/client'
import {
  MENU_THEMES,
  normaliseMenuTheme,
  type MenuTheme,
} from '@/lib/menu-theme'
import { edgeFetch } from '@/lib/edge'
import { apiError, describeFailure, failIfNotOk, isAuthFailure, isPermissionFailure } from '@/lib/api-error'
import { useAccessDenied } from '@/lib/use-access-denied'
import { hasPermission } from '@/lib/permissions'
import { AccessDenied } from '@/components/shared/access-denied'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Settings, Store, SlidersHorizontal, CreditCard, AlertTriangle, Save, Building2, MapPin, Phone, Mail, Globe, Clock, Trash2, Check, Sparkles, User, Palette, Bell, Lock, KeyRound, Smartphone, Moon, Sun, Languages, ShieldCheck, ChevronDown, FileText, Star, ExternalLink, RefreshCw, MessageSquare, Send, Loader2, ChevronRight, Instagram, Facebook, Youtube,
  CheckCircle2, XCircle, Receipt, Clock as ClockIcon,
  Printer, RotateCcw, FileDown,
  ArrowLeft, CalendarClock, History, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import { LANGUAGES } from '@/lib/i18n'
import {
  type BillingInterval,
  annualSavings,
  consumePlanIntent,
  priceFor,
} from '@/lib/pricing'
import {
  DEFAULT_BILLING_TIME_ZONE,
  buildBillingSnapshot,
  changeLabel,
  formatBillingDate,
  formatMoney,
  intervalModeLabel,
  mandateStateLabel,
  mandateTone,
  periodLabel,
  resolvePlanName,
  type BillingPlanFacts,
  type BillingSnapshot,
  type BillingTotals,
  type ManagePayload,
  type PlanDirectory,
  type ScheduledChange,
} from '@/lib/billing-view'

const CURRENCIES = [
  { code: 'INR', symbol: '₹' },
]

/**
 * A failed write, in the shape the caller can show it in.
 *
 * A refusal keeps its `ApiError` so `handleAction` can name the permission
 * ("You do not have permission to change settings.") instead of the guard's
 * bare `Forbidden`. Anything else becomes a plain `Error` carrying the
 * server's own sentence, which is what these call sites used to display.
 */
async function writeFailure(res: Response, subject: string): Promise<Error> {
  const failure = await apiError(res, subject, { action: 'save' })
  return isPermissionFailure(failure) || isAuthFailure(failure)
    ? failure
    : new Error(failure.serverMessage || failure.message)
}


/**
 * Timezone options — restricted to India and Nepal.
 */
const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Kathmandu',
]

/**
 * The Operations toggles.
 */
const OPS_TOGGLES = [
  { key: 'auto_accept_orders', label: 'Auto Accept Orders', desc: 'Automatically accept incoming table orders into the kitchen' },
  { key: 'auto_bill_print', label: 'Auto Bill Print', desc: 'Automatically print bill when session ends' },
]

// ---- billing display helpers (pure, file-scope so the tab and the Manage
// Billing view share them) ----

// One money formatter for the whole app, so a price in a plan card, a fact
// tile and an invoice row can never be punctuated two different ways.
function money(currency: string, amount: number): string {
  return formatMoney(currency, amount)
}

// How the customer paid, as Razorpay recorded it.
function methodLabel(method: string | null): string {
  switch ((method ?? '').toLowerCase()) {
    case 'card': return 'Card'
    case 'upi': return 'UPI'
    case 'netbanking': return 'NetBanking'
    case 'wallet': return 'Wallet'
    case 'emi': return 'EMI'
    case 'razorpay': return 'Razorpay'
    case '': return '—'
    default: return method as string
  }
}

/**
 * A billing date, in the restaurant's own timezone.
 *
 * `toLocaleDateString('en-IN')` reads the viewer's clock: the same renewal
 * read as 29/11 on a machine set to UTC and 30/11 on the owner's phone in IST,
 * and two sections of the same page could disagree when one of them derived
 * its own date. Every billing date goes through this, with the timezone the
 * restaurant works in — never the browser's.
 */
function fmtDate(iso: string | null | undefined, timeZone: string = DEFAULT_BILLING_TIME_ZONE): string {
  return formatBillingDate(iso, timeZone)
}

/* ---- shared billing presentation atoms --------------------------------
 * One card anatomy for the Billing tab and Manage Billing view: a consistent
 * card, a section header with an icon chip, a label/value fact tile, and a
 * status pill with a dot. All are pure wrappers — the data and handlers stay
 * exactly where they are. */

function BillingCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    // `gap-0` is deliberate: the base Card carries `flex flex-col gap-6`, so
    // every extra child silently added 24px and a section with three children
    // was 48px taller than one with two. Spacing inside a card is set by the
    // elements themselves (mt-*), which is what makes every section read at
    // the same rhythm.
    <Card data-billing-card className={cn('gap-0 rounded-2xl border-border bg-card p-5 md:p-6', className)}>
      {children}
    </Card>
  )
}

function BillingSectionHead({
  icon,
  title,
  count,
  extra,
}: {
  icon: React.ReactNode
  title: string
  count?: number
  extra?: React.ReactNode
}) {
  return (
    <div className="mb-4 flex items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      {count !== undefined && count > 0 && (
        <Badge variant="secondary" className="text-[10px]">{count}</Badge>
      )}
      {extra}
    </div>
  )
}

function BillingFact({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div data-billing-tile data-label={label} className="rounded-xl border border-border bg-secondary/20 px-3.5 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium leading-snug break-words" title={title}>{value}</p>
    </div>
  )
}

/** A status pill with a coloured dot, so the state reads at a glance. */
function StatusPill({ tone, label }: { tone: 'success' | 'info' | 'warn' | 'danger' | 'neutral'; label: string }) {
  const tones: Record<string, string> = {
    success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    info: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    danger: 'bg-red-500/15 text-red-600 dark:text-red-400',
    neutral: 'bg-secondary text-muted-foreground',
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium', tones[tone])}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function BillingEmpty({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 py-8 text-center">
      <span className="mb-2 flex size-8 items-center justify-center rounded-lg bg-secondary/60 text-muted-foreground">
        {icon}
      </span>
      <p className="text-[13px] font-medium text-foreground/80">{title}</p>
      {hint && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * A fact tile whose value is a sentence, so it wraps rather than truncating.
 *
 * `BillingFact` cuts its value to one line — right for a date or a price, and
 * wrong for "Cancelled — access continues until the period ends". Same
 * anatomy, same radius, same padding; only the line rule differs.
 */
function BillingNote({
  label,
  children,
  tone = 'neutral',
}: {
  label: string
  children: React.ReactNode
  tone?: 'neutral' | 'warn' | 'danger'
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-3.5 py-3',
        tone === 'neutral' && 'border-border bg-secondary/20',
        tone === 'warn' && 'border-amber-200/70 bg-amber-50/60 dark:border-amber-500/25 dark:bg-amber-500/10',
        tone === 'danger' && 'border-red-200/70 bg-red-50/60 dark:border-red-500/25 dark:bg-red-500/10',
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium leading-snug">{children}</div>
    </div>
  )
}

/**
 * One list entry on a billing page — upcoming charges, scheduled changes,
 * plan history.
 *
 * Every list on both pages is built from this, so a row is the same height,
 * the same radius and the same type scale wherever it appears. Titles wrap to
 * two lines at most; the meta line is the date and the money.
 */
function BillingRow({
  icon,
  title,
  meta,
  trailing,
  tone = 'neutral',
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  trailing?: React.ReactNode
  tone?: 'neutral' | 'success' | 'info' | 'warn' | 'danger'
}) {
  const iconTone: Record<string, string> = {
    neutral: 'bg-secondary text-muted-foreground',
    success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    info: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    danger: 'bg-red-500/15 text-red-600 dark:text-red-400',
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/20 px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && (
          <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', iconTone[tone])}>
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-[13px] font-medium leading-snug">{title}</p>
          {meta && <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{meta}</p>}
        </div>
      </div>
      {trailing && <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{trailing}</div>}
    </div>
  )
}

/** One payment row, as the subscriptions state endpoint returns it. */
type BillingPayment = {
  id: string
  amount: number
  currency: string
  status: string
  payment_method: string | null
  transaction_id: string | null
  plan_id: string
  billing_period: string
  created_at: string
  razorpay_payment_id: string | null
  razorpay_order_id: string | null
  failure_reason: string | null
  document: {
    invoice_number: string
    invoice_date: string
    period_start: string | null
    period_end: string | null
    description: string
    seller_name: string
    seller_address: string | null
    seller_email: string | null
    seller_phone: string | null
    buyer_name: string
    buyer_email: string | null
    buyer_address: string | null
  } | null
  refundDocument: {
    refund_number: string
    refund_date: string
    original_invoice_number: string | null
    original_invoice_date: string | null
    razorpay_refund_id: string | null
  } | null
}

/**
 * The payment-history rows, shared by the billing tab and the Manage Billing
 * view. Plan names and period labels resolve through the full directory, so
 * retired plans read correctly everywhere; invoice numbers come from the
 * issued document, never recomputed.
 */
function PaymentHistoryRows(props: {
  payments: BillingPayment[]
  directory: PlanDirectory
  timeZone: string
  invoiceBusy: string | null
  onDownload: (p: BillingPayment, kind?: 'invoice' | 'refund') => void
  onReceipt: (p: BillingPayment) => void
}) {
  const { payments, directory, timeZone, invoiceBusy, onDownload, onReceipt } = props
  const pillTone = (status: string): 'success' | 'warn' | 'danger' =>
    status === 'succeeded' ? 'success' : status === 'refunded' ? 'warn' : 'danger'
  return (
    <div className="space-y-2">
      {payments.map((p) => (
        <div
          key={p.id}
          className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/15 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-lg',
                p.status === 'succeeded'
                  ? 'bg-emerald-500/15 text-emerald-600'
                  : p.status === 'refunded'
                    ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-red-500/15 text-red-600',
              )}
            >
              {p.status === 'succeeded' ? (
                <CheckCircle2 className="size-4" />
              ) : p.status === 'refunded' ? (
                <RotateCcw className="size-4" />
              ) : (
                <XCircle className="size-4" />
              )}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-snug">
                {money(p.currency, Number(p.amount))}
                <span className="font-normal text-muted-foreground">
                  {' '}· {resolvePlanName(directory, p.plan_id)}
                  {p.payment_method && p.payment_method !== 'razorpay' ? ` · ${methodLabel(p.payment_method)}` : ''}
                </span>
              </p>
              <p className="truncate text-[11.5px] text-muted-foreground">
                {fmtDate(p.created_at, timeZone)} · {periodLabel(directory, p.plan_id, p.billing_period)}
                {p.document?.invoice_number ? ` · Inv ${p.document.invoice_number}` : ''}
                {p.transaction_id ? ` · ${p.transaction_id}` : ''}
                {p.failure_reason ? ` · ${p.failure_reason}` : ''}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {(p.status === 'succeeded' || p.status === 'refunded') && (
              <Button
                size="sm"
                className="h-9 gap-1.5 rounded-lg bg-[#f97316] px-3.5 text-[12.5px] font-semibold text-white shadow-sm hover:bg-[#ea580c]"
                title="Download the invoice (PDF)"
                disabled={invoiceBusy === `invoice:${p.id}`}
                onClick={() => onDownload(p)}
              >
                {invoiceBusy === `invoice:${p.id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileDown className="h-4 w-4" />
                )}
                Download
              </Button>
            )}
            {p.status === 'refunded' && (
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5 rounded-lg border-[#f97316]/40 bg-[#f97316]/5 px-3.5 text-[12.5px] font-semibold text-[#ea580c] hover:bg-[#f97316]/15 hover:text-[#ea580c]"
                title="Download the refund document (PDF)"
                disabled={invoiceBusy === `refund:${p.id}`}
                onClick={() => onDownload(p, 'refund')}
              >
                {invoiceBusy === `refund:${p.id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                Refund
              </Button>
            )}
            {(p.status === 'succeeded' || p.status === 'refunded') && (
              <Button
                size="sm"
                variant="outline"
                className="h-9 gap-1.5 rounded-lg border-[#f97316]/40 bg-[#f97316]/5 px-3.5 text-[12.5px] font-semibold text-[#ea580c] hover:bg-[#f97316]/15 hover:text-[#ea580c]"
                title="Print the bill"
                onClick={() => onReceipt(p)}
              >
                <Printer className="h-4 w-4" />
                Print
              </Button>
            )}
            <StatusPill tone={pillTone(p.status)} label={p.status} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The subscription summary — the same component on both pages.
 *
 * The Billing tab and Manage Billing previously each assembled this from
 * different fields of different payloads: the tab read the bootstrap
 * snapshot, the Manage view recomputed the plan line from
 * `subscription_plan`, defaulted an unrecorded payment mode to AutoPay and
 * showed no trial window at all. Same restaurant, two answers. Now both
 * render this, from one `BillingSnapshot`, so they cannot disagree — there
 * is only one place a value comes from.
 */
function BillingSummary({
  snapshot,
  plan,
  heading,
  icon,
  actions,
  renewalState = 'verified',
}: {
  snapshot: BillingSnapshot
  plan: BillingPlanFacts | null
  heading: string
  icon: React.ReactNode
  actions?: React.ReactNode
  /**
   * Whether the verified payload has answered yet. The renewal line is the
   * one fact that cannot be derived locally, so while it is in flight — or
   * after it failed — both pages say the same thing instead of one of them
   * quietly substituting a guess.
   */
  renewalState?: 'loading' | 'failed' | 'verified'
}) {
  return (
    <div data-billing-summary>
      <BillingSectionHead
        icon={icon}
        title={heading}
        extra={
          snapshot.statusLabel !== '—' ? (
            <span className="ml-auto">
              <StatusPill tone={snapshot.statusTone} label={snapshot.statusLabel} />
            </span>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 className="truncate text-xl font-bold tracking-tight">
            {snapshot.inForce ? snapshot.planName : 'No plan'}
          </h2>
          {plan?.isPaid && plan.billingMode === 'onetime' && (
            <Badge variant="secondary" className="text-[10px] bg-primary/10 text-primary">
              Legacy one-time
            </Badge>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <BillingFact label="Price" value={snapshot.price} />
        <BillingFact label="Payment mode" value={snapshot.modeLabel} />
        <BillingFact label={snapshot.startedLabel} value={snapshot.startedValue} />
        <BillingFact label={snapshot.periodLabel} value={snapshot.periodValue} />
      </div>

      <div className="mt-2.5" data-billing-renewal>
        <BillingNote label="Renewal" tone={snapshot.renewalConfirmed ? 'neutral' : 'warn'}>
          <p>
            {snapshot.renewalLabel ??
              (renewalState === 'failed'
                ? 'Could not be confirmed with Razorpay just now.'
                : 'Checking this with Razorpay…')}
          </p>
          {snapshot.renewalDetail && (
            <p className="mt-1 text-[12px] font-normal leading-relaxed text-muted-foreground">
              {snapshot.renewalDetail}
            </p>
          )}
        </BillingNote>
      </div>
    </div>
  )
}

export function SettingsView() {
  const { data, refresh } = useApp()
  const { view, settingsTab, setSettingsTab } = useStore()
  const { scrollRef, collapsed } = useScrollCollapse()
  const { denied, setDenied, handleLoad, handleAction } = useAccessDenied()
  // The page is `settings.view`; every write on it — saving the restaurant,
  // the Danger Zone, billing — is `settings.manage`. Reviews are the orders
  // module's data: `orders.view` to read them, `orders.manage` to answer.
  const canManageSettings = hasPermission(data?.permissions, 'settings.manage')
  const canViewReviews = hasPermission(data?.permissions, 'orders.view')
  const canManageReviews = hasPermission(data?.permissions, 'orders.manage')
  // The router renders this view for `billing` as well as `settings` (the
  // trial banner opens it), so the billing tab is the one to land on.
  const [activeTab, setActiveTab] = useState(view === 'billing' ? 'billing' : (settingsTab || 'profile'))

  // sync with store whenever settingsTab changes (e.g. from header dropdown),
  // and whenever the view moves between `settings` and `billing` — the router
  // renders this same component for both, so React keeps it mounted and the
  // tab has to be moved by hand. Arriving at `billing` wins, so the trial
  // banner's "See plans" lands on the plan rather than on Profile.
  useEffect(() => {
    if (view === 'billing') setActiveTab('billing')
    else if (settingsTab) setActiveTab(settingsTab)
  }, [view, settingsTab])

  // Tenant form state
  const [savingProfile, setSavingProfile] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  const [tenantForm, setTenantForm] = useState({
    name: '',
    tagline: '',
    email: '',
    phone: '',
    address: '',
    currency: 'INR',
    currencySymbol: '₹',
    logo: '',
    gstin: '',
    fssai: '',
    instagram: '',
    facebook: '',
    youtube: '',
    /** The customer menu's theme. The owner's app theme is a different thing. */
    menuTheme: 'light' as MenuTheme,
  })

  // Operations form state
  const [taxRate, setTaxRate] = useState(0)
  const [serviceCharge, setServiceCharge] = useState(0)
  const [openingHours, setOpeningHours] = useState('')
  const [timezone, setTimezone] = useState('UTC')
  const [opToggles, setOpToggles] = useState<Record<string, boolean>>({})

  // Danger zone
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')

  // Profile (current user) state
  const [profileForm, setProfileForm] = useState({ name: '', email: '', phone: '', avatar: '' })
  const [pwdForm, setPwdForm] = useState({ current: '', next: '', confirm: '' })

  // Preferences state
  const [prefs, setPrefs] = useState({
    theme: 'dark',
    language: 'en',
    emailAlerts: true,
    pushAlerts: true,
    soundAlerts: false,
    dailyDigest: true,
    defaultOrderType: 'DINE_IN',
    compactMode: false,
  })

  // expanded section (for Profile/Preferences cards)
  const [openSection, setOpenSection] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)

  // Internal reviews state. Diners rate their visit when their table session
  // ends; the reviews land in our own customer_reviews table and the owner
  // reads and replies to them here. There is nothing to connect or sync.
  const [reviews, setReviews] = useState<any[]>([])
  const [reviewStats, setReviewStats] = useState<{
    averageRating: number
    totalReviews: number
    distribution: { stars: number; count: number }[]
    feedbackCount: number
  }>({ averageRating: 0, totalReviews: 0, distribution: [], feedbackCount: 0 })
  const [reviewsEnabled, setReviewsEnabled] = useState(true)
  const [reviewsEnabledSaving, setReviewsEnabledSaving] = useState(false)
  const [reviewsLoading, setReviewsLoading] = useState(false)

  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')

  // Billing state
  const [plans, setPlans] = useState<Array<{
    id: string
    name: string
    description: string | null
    priceMonthly: number
    priceYearly: number | null
    currency: string
    trialDays: number
    features: string[]
    limits: { locations: number | null; staff: number | null; menuItems: number | null }
    popular: boolean
    razorpayPlanId: string | null
    billingMode?: 'onetime' | 'recurring'
  }>>([])
  /** Which interval the pricing cards are showing. Starts on the interval the
   * subscription is actually on, or the one a landing-page CTA carried here. */
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly')
  const [payments, setPayments] = useState<BillingPayment[]>([])
  const [receiptFor, setReceiptFor] = useState<(typeof payments)[number] | null>(null)
  const [restaurant, setRestaurant] = useState<{ name: string | null; email: string | null }>({ name: null, email: null })
  const [razorpayConfigured, setRazorpayConfigured] = useState(true)
  const [billingLoading, setBillingLoading] = useState(true)
  const [payState, setPayState] = useState<'idle' | 'starting' | 'paying' | 'verifying' | 'success' | 'failed'>('idle')
  const [payingPlan, setPayingPlan] = useState<string | null>(null)
  const [invoiceBusy, setInvoiceBusy] = useState<string | null>(null)
  const [payError, setPayError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  // Every plan, retired included — the source of honest historical labels.
  const [billingDirectory, setBillingDirectory] = useState<PlanDirectory>({})
  const [billingTotals, setBillingTotals] = useState<BillingTotals | null>(null)
  // The plan as /subscriptions/state resolved it, fresh with the payments.
  // The bootstrap copy in `data.subscription` was fetched when the shell
  // mounted and can be minutes old; it is the fallback, not the source.
  const [statePlan, setStatePlan] = useState<BillingPlanFacts | null>(null)
  // Counted server-side — never a hardcoded 1.
  const [locationCount, setLocationCount] = useState<number | null>(null)
  // The Manage Billing view and its verified payload.
  const [managing, setManaging] = useState(false)
  const [manageData, setManageData] = useState<ManagePayload | null>(null)
  const [manageLoading, setManageLoading] = useState(false)
  const [manageError, setManageError] = useState<string | null>(null)
  // The secure cancellation flow: which dialog is open, and against what.
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
  const [cancelScheduledFor, setCancelScheduledFor] = useState<ScheduledChange | null>(null)
  const [cancellingScheduled, setCancellingScheduled] = useState(false)

  // Initialize from data
  useEffect(() => {
    if (!data) return
    const t = data.tenant
    setTenantForm({
      name: t.name || '',
      tagline: t.tagline || '',
      email: t.email || '',
      phone: t.phone || '',
      address: t.address || '',
      currency: t.currency || 'INR',
      currencySymbol: t.currencySymbol || '$',
      logo: t.logo || '',
      gstin: data.settings.gstin || '',
      fssai: data.settings.fssai || '',
      instagram: data.settings.instagram || '',
      facebook: data.settings.facebook || '',
      youtube: data.settings.youtube || '',
      menuTheme: normaliseMenuTheme(data.settings.menu_theme),
    })
    setTaxRate(t.taxRate ?? 0)
    setServiceCharge(t.serviceCharge ?? 0)
    setOpeningHours(data.settings.opening_hours || 'Mon–Fri 9:00 AM – 10:00 PM')
    setTimezone(data.settings.timezone || 'Asia/Kolkata')
    const toggles: Record<string, boolean> = {}
    for (const t of OPS_TOGGLES) {
      toggles[t.key] = data.settings[t.key] === 'true'
    }
    setOpToggles(toggles)
    // Review collection is on unless the owner has explicitly turned it off.
    setReviewsEnabled(data.settings.reviews_enabled !== 'false')
    // profile
    const u = data.currentUser
    setProfileForm({ name: u.name || '', email: u.email || '', phone: u.phone || '', avatar: u.avatar || '' })
    // prefs
    setPrefs({
      theme: data.settings.pref_theme || 'dark',
      language: data.settings.pref_language || 'en',
      emailAlerts: data.settings.pref_email_alerts !== 'false',
      pushAlerts: data.settings.pref_push_alerts !== 'false',
      soundAlerts: data.settings.pref_sound_alerts === 'true',
      dailyDigest: data.settings.pref_daily_digest !== 'false',
      defaultOrderType: data.settings.pref_default_order_type || 'DINE_IN',
      compactMode: data.settings.pref_compact_mode === 'true',
    })
  }, [data])

  const headers = useMemo(() => ({
    'x-tenant-id': data?.tenant.id ?? '',
    'content-type': 'application/json',
  }), [data?.tenant.id])

  // Dirty detection
  const dirty = useMemo(() => {
    if (!data) return false
    const t = data.tenant
    if (tenantForm.name !== (t.name || '')) return true
    if (tenantForm.tagline !== (t.tagline || '')) return true
    if (tenantForm.email !== (t.email || '')) return true
    if (tenantForm.phone !== (t.phone || '')) return true
    if (tenantForm.address !== (t.address || '')) return true
    if (tenantForm.currency !== (t.currency || 'INR')) return true
    if (tenantForm.currencySymbol !== (t.currencySymbol || '$')) return true
    if (tenantForm.logo !== (t.logo || '')) return true
    if (tenantForm.gstin !== (data.settings.gstin || '')) return true
    if (tenantForm.fssai !== (data.settings.fssai || '')) return true
    if (tenantForm.instagram !== (data.settings.instagram || '')) return true
    if (tenantForm.facebook !== (data.settings.facebook || '')) return true
    if (tenantForm.youtube !== (data.settings.youtube || '')) return true
    if (taxRate !== (t.taxRate ?? 0)) return true
    if (serviceCharge !== (t.serviceCharge ?? 0)) return true
    if (openingHours !== (data.settings.opening_hours || 'Mon–Fri 9:00 AM – 10:00 PM')) return true
    if (timezone !== (data.settings.timezone || 'Asia/Kolkata')) return true
    for (const t of OPS_TOGGLES) {
      if (opToggles[t.key] !== (data.settings[t.key] === 'true')) return true
    }
    // Preferences are part of the same save, so they must be able to raise it.
    // Each comparison mirrors the default used when loading them above.
    if (prefs.theme !== (data.settings.pref_theme || 'dark')) return true
    if (prefs.language !== (data.settings.pref_language || 'en')) return true
    if (prefs.emailAlerts !== (data.settings.pref_email_alerts !== 'false')) return true
    if (prefs.pushAlerts !== (data.settings.pref_push_alerts !== 'false')) return true
    if (prefs.soundAlerts !== (data.settings.pref_sound_alerts === 'true')) return true
    if (prefs.dailyDigest !== (data.settings.pref_daily_digest !== 'false')) return true
    if (prefs.defaultOrderType !== (data.settings.pref_default_order_type || 'DINE_IN')) return true
    if (prefs.compactMode !== (data.settings.pref_compact_mode === 'true')) return true
    return false
  }, [data, tenantForm, taxRate, serviceCharge, openingHours, timezone, opToggles, prefs])

  const tenantId = data?.tenant?.id ?? ''

  const save = async () => {
    // One save at a time: the buttons disable themselves, but a form submit by
    // keyboard or a fast double-click should not start a second request.
    if (saving || !dirty || !data?.tenant) return
    setSaving(true)
    try {
      const t = data.tenant
      const body: any = {
        tenant: {
          name: tenantForm.name,
          tagline: tenantForm.tagline,
          email: tenantForm.email,
          phone: tenantForm.phone,
          address: tenantForm.address,
          currency: tenantForm.currency,
          currencySymbol: tenantForm.currencySymbol,
          logo: tenantForm.logo,
          taxRate,
          serviceCharge,
        },
        settings: {
          opening_hours: openingHours,
          timezone,
          gstin: tenantForm.gstin,
          fssai: tenantForm.fssai,
          instagram: tenantForm.instagram,
          facebook: tenantForm.facebook,
          youtube: tenantForm.youtube,
          // The customer menu's theme. It is not the owner's app theme.
          menu_theme: tenantForm.menuTheme,
          // These were read on load but never written, so every preference
          // reset to its default on reload no matter what was chosen.
          pref_theme: prefs.theme,
          pref_language: prefs.language,
          pref_email_alerts: String(prefs.emailAlerts),
          pref_push_alerts: String(prefs.pushAlerts),
          pref_sound_alerts: String(prefs.soundAlerts),
          pref_daily_digest: String(prefs.dailyDigest),
          pref_default_order_type: prefs.defaultOrderType,
          pref_compact_mode: String(prefs.compactMode),
          ...Object.fromEntries(Object.entries(opToggles).map(([k, v]) => [k, String(v)])),
        },
      }
      const res = await edgeFetch('/api/settings', {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await writeFailure(res, 'your settings')
      const payload = await res.json().catch(() => null)
      if (payload?.error) throw new Error(payload.error)
      toast.success('Settings saved')
      // Re-read them, so the form matches what the database now holds and the
      // Save button stops offering a save that has already happened.
      await refresh()
    } catch (err) {
      handleAction(err, 'your settings')
    } finally {
      // The flag used to be cleared nowhere on either path — the reviews-tab
      // rewrite dropped it. The button then read "Saving…" for ever and stayed
      // disabled, so Settings could not be saved again without a reload.
      setSaving(false)
    }
  }

  const load = async () => {
    if (!tenantId) return
    setReviewsLoading(true)
    try {
      const res = await edgeFetch('/api/reviews', { headers: { 'x-tenant-id': tenantId } })
      await failIfNotOk(res, 'reviews')
      const data = await res.json()
      setReviews(data.reviews || [])
      setReviewStats(data.stats || { averageRating: 0, totalReviews: 0, distribution: [], feedbackCount: 0 })
    } catch (err) {
      handleLoad(err, 'reviews')
    } finally {
      setReviewsLoading(false)
    }
  }

  // Reviews load with the page — there is no connection step to wait for.
  // They are the orders module's data, so a role that may not read orders
  // never asks for them: the 403 would take the whole Settings page.
  useEffect(() => {
    if (tenantId && canViewReviews) {
      load()
    }
  }, [tenantId, canViewReviews])

  // Billing load
  const loadBilling = useCallback(async () => {
    setBillingLoading(true)
    try {
      const res = await edgeFetch('/api/subscriptions', { headers: { 'x-tenant-id': tenantId } })
      await failIfNotOk(res, 'your billing details')
      const body = await res.json()
      setPlans(body.plans ?? [])
      setPayments(body.payments ?? [])
      setRestaurant(body.restaurant ?? { name: null, email: null })
      setRazorpayConfigured(body.razorpayConfigured !== false)
      setBillingDirectory(body.planDirectory ?? {})
      setBillingTotals(body.totals ?? null)
      setLocationCount(typeof body.locationCount === 'number' ? body.locationCount : null)
      setStatePlan(body.plan ?? null)
    } catch (err) {
      handleLoad(err, 'your billing details')
    } finally {
      setBillingLoading(false)
    }
  }, [tenantId, handleLoad])

  // The Manage Billing payload — every mandate and scheduled change on it is
  // verified live against Razorpay by the server before it reaches here.
  const loadManage = useCallback(async () => {
    setManageLoading(true)
    setManageError(null)
    try {
      const res = await edgeFetch('/api/subscriptions/manage', { headers: { 'x-tenant-id': tenantId } })
      await failIfNotOk(res, 'your subscription details')
      const body = await res.json().catch(() => null)
      setManageData(body)
    } catch (err) {
      const failure = describeFailure(err, 'your subscription details')
      // A refusal is the page's answer, not a line inside the manage card —
      // and the guard's bare `Forbidden` is not a sentence for a person. Any
      // other failure keeps the card's own error line, where the retry lives.
      if (isPermissionFailure(failure) || isAuthFailure(failure)) {
        handleLoad(err, 'your subscription details')
      } else {
        setManageError(failure.message)
      }
    } finally {
      setManageLoading(false)
    }
  }, [tenantId, handleLoad])

  // Manage loads with the billing tab (not only when the view opens): the
  // plan card's RENEWAL fact prefers its verified answer over the local guess.
  // Both loads are `settings.manage`, so a role that may not manage billing
  // never asks for them.
  useEffect(() => {
    if (tenantId && canManageSettings) loadManage()
  }, [tenantId, canManageSettings, loadManage])

  useEffect(() => {
    if (canManageSettings) loadBilling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadBilling, canManageSettings])

  // A landing-page CTA remembers the plan and interval the visitor chose; this
  // is the one place that reads it, and only once, so an old choice cannot
  // silently change what a returning owner sees.
  useEffect(() => {
    const intent = consumePlanIntent()
    if (!intent) return
    setBillingInterval(intent.interval)
  }, [])

  // Billing helpers — status copy lives in billing-view.ts, shared with the
  // Manage Billing view so the two can never label the same state differently.
  /** The plan's display name. The directory covers retired plans too, so a
      historical payment never falls back to its raw id. */
  function planName(planId: string): string {
    return billingDirectory[planId]?.name ?? plans.find((pl) => pl.id === planId)?.name ?? planId
  }
  function planIsOneTime(planId: string): boolean {
    return billingDirectory[planId]?.billingMode === 'onetime' || plans.find((pl) => pl.id === planId)?.billingMode === 'onetime'
  }

  /** "30 Oct 2026" — the date style the issued documents use. */
  function docDate(iso: string | null | undefined): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }
  /** "INR 999.00" — the amount style on the issued documents. */
  function docMoney(currency: string, amount: number): string {
    return `${currency} ${Number(amount).toFixed(2)}`
  }

  /**
   * The receipt, normalised into the invoice design — the same document the
   * Download button replays as a PDF (supabase/functions/_shared/pdf.ts).
   * When the server has issued the financial document, its number, period,
   * plan description and seller snapshot are shown verbatim; only payments
   * filed before issuance existed fall back to what the payment row knows.
   */
  function receiptModel(p: (typeof payments)[number]) {
    const doc = p.document ?? null
    const refund = p.status === 'refunded' ? p.refundDocument ?? null : null
    const paidIso = doc?.invoice_date ?? p.created_at
    const periodStart = doc?.period_start ?? null
    const periodEnd = doc?.period_end ?? (planIsOneTime(p.plan_id)
      ? new Date(new Date(periodStart ?? p.created_at).getTime() + 30 * 86_400_000).toISOString()
      : null)
    return {
      kind: (refund ? 'refund' : 'invoice') as 'refund' | 'invoice',
      title: refund ? 'REFUND' : 'INVOICE',
      number: refund?.refund_number ?? doc?.invoice_number ?? p.transaction_id ?? p.id.slice(0, 8),
      date: docDate(refund?.refund_date ?? paidIso),
      badge: refund ? 'REFUNDED' : 'PAID',
      sellerName: doc?.seller_name ?? 'The Salad',
      sellerLines: (doc?.seller_address ?? '')
        .split('\n').map((l) => l.trim()).filter(Boolean),
      sellerEmail: doc?.seller_email ?? null,
      sellerPhone: doc?.seller_phone ?? null,
      buyerName: doc?.buyer_name ?? restaurant.name ?? '—',
      buyerEmail: doc?.buyer_email ?? restaurant.email,
      // The issued record snapshots the buyer's address too — the PDF
      // prints it, so the receipt must show the same lines.
      buyerLines: String(doc?.buyer_address ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3),
      planName: doc?.description ?? planName(p.plan_id),
      period: !refund && periodStart && periodEnd
        ? `${docDate(periodStart)} – ${docDate(periodEnd)}`
        : null,
      totalLabel: refund ? 'Total refunded' : 'Total paid',
      money: docMoney(p.currency, Number(p.amount)),
      originalInvoice: refund
        ? ([
            ['Invoice number', refund.original_invoice_number],
            ['Invoice date', refund.original_invoice_date ? docDate(refund.original_invoice_date) : null],
          ] as Array<[string, string | null]>).filter((row): row is [string, string] => Boolean(row[1]))
        : null,
      detailTitle: refund ? 'REFUND DETAILS' : 'PAYMENT DETAILS',
      detailRows: ([
        ...(refund ? [['Razorpay refund ID', refund.razorpay_refund_id] as [string, string | null]] : []),
        ['Razorpay payment ID', p.razorpay_payment_id ?? p.transaction_id],
        ['Razorpay order ID', p.razorpay_order_id],
        ...(refund ? [] : [['Method', p.payment_method] as [string, string | null]]),
        [refund ? 'Refunded on' : 'Paid on', docDate(refund?.refund_date ?? paidIso)],
        ['Status', refund ? 'Refunded' : 'Succeeded'],
      ] as Array<[string, string | null]>).filter((row): row is [string, string] => Boolean(row[1])),
      notes: refund
        ? [
            'This document records a refund of the payment on the original invoice referenced above.',
            'Both documents together are the complete record of the transaction.',
          ]
        : [
            'This is a computer-generated invoice for a payment made through Razorpay.',
            'The amounts and reference numbers above are recorded exactly as the payment was settled.',
          ],
    }
  }

  /**
   * Print the receipt in the invoice design — the same layout, palette and
   * typography as the issued PDF, so what the owner prints is the same
   * document the Download button produces.
   */
  function printReceipt(p: (typeof payments)[number]) {
    const m = receiptModel(p)
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    const sellerLines = [
      ...m.sellerLines,
      ...(m.sellerEmail ? [m.sellerEmail] : []),
      ...(m.sellerPhone ? [m.sellerPhone] : []),
    ]
    const detailBox = (title: string, rows: Array<[string, string]>) => `
    <div class="pd">
      <div class="pd-title">${esc(title)}</div>
      ${rows.map(([k, v]) => `<div class="pd-row"><span class="pd-k">${esc(k)}</span><span class="pd-v">${esc(v)}</span></div>`).join('')}
    </div>`
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${m.title === 'REFUND' ? 'Refund' : 'Invoice'} — ${esc(m.number)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f3f4f6;
    color: #1b202c;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { position: relative; width: 210mm; min-height: 297mm; margin: 24px auto; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .band { display: flex; justify-content: space-between; align-items: flex-start; background: #1f2937; padding: 10mm 17.6mm 9mm; }
  .brand { font-size: 29px; font-weight: 700; color: #fff; letter-spacing: -0.01em; line-height: 1.1; }
  .tagline { margin-top: 4px; font-size: 11px; color: #c7cfd9; }
  .band-right { text-align: right; }
  .doctitle { font-size: 20px; font-weight: 700; color: #fff; letter-spacing: .02em; }
  .docnum, .docdate { margin-top: 3px; font-size: 12px; color: #c7cfd9; }
  .accent { height: 4px; background: #f97316; }
  .body { padding: 0 17.6mm; }
  .parties { display: grid; grid-template-columns: 1fr 1fr auto; gap: 24px; margin-top: 14mm; }
  .label { font-size: 10px; font-weight: 700; letter-spacing: .08em; color: #6b7280; }
  .party-name { margin-top: 6px; font-size: 15px; font-weight: 700; }
  .party-line { margin-top: 2px; font-size: 12px; color: #1b202c; }
  .badge { align-self: start; background: ${m.kind === 'refund' ? '#475569' : '#16a34a'}; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .06em; padding: 5px 18px; border-radius: 2px; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 16mm; border-top: 1px solid #d9dbe3; }
  table.items thead tr { background: #f3f4f6; }
  table.items th { padding: 8px 12px; font-size: 10px; font-weight: 700; letter-spacing: .08em; color: #6b7280; text-align: left; border-bottom: 1px solid #d9dbe3; }
  table.items th.r, table.items td.r { text-align: right; }
  table.items td { padding: 12px; font-size: 12px; border-bottom: 1px solid #d9dbe3; vertical-align: top; }
  table.items td.desc { font-size: 13px; font-weight: 700; }
  .total-block { margin: 10mm 0 0 auto; width: 62mm; border-top: 2px solid #f97316; padding-top: 5mm; }
  .total-row { display: flex; justify-content: space-between; font-size: 15px; font-weight: 700; }
  .pd { background: #f3f4f6; padding: 14px 16px 16px; margin-top: 14mm; }
  .pd-title { font-size: 10px; font-weight: 700; letter-spacing: .08em; color: #6b7280; margin-bottom: 10px; }
  .pd-row { display: grid; grid-template-columns: 46mm 1fr; padding: 3.5px 0; font-size: 12px; }
  .pd-k { color: #6b7280; }
  .docfoot { position: absolute; left: 17.6mm; right: 17.6mm; bottom: 14mm; border-top: 1px solid #d9dbe3; padding-top: 8px; }
  .docfoot p { margin: 2px 0; font-size: 10px; color: #6b7280; }
  .foot-brand { margin-top: 10px !important; text-align: center; }
  @page { size: A4; margin: 0; }
  @media print {
    body { background: #fff; }
    .sheet { margin: 0; box-shadow: none; }
  }
</style></head><body>
  <div class="sheet">
    <div class="band">
      <div>
        <div class="brand">The Salad</div>
        <div class="tagline">Restaurant management platform</div>
      </div>
      <div class="band-right">
        <div class="doctitle">${esc(m.title)}</div>
        <div class="docnum">No. ${esc(m.number)}</div>
        <div class="docdate">${esc(m.date)}</div>
      </div>
    </div>
    <div class="accent"></div>
    <div class="body">
      <div class="parties">
        <div>
          <div class="label">FROM</div>
          <div class="party-name">${esc(m.sellerName)}</div>
          ${sellerLines.map((l) => `<div class="party-line">${esc(l)}</div>`).join('')}
        </div>
        <div>
          <div class="label">BILLED TO</div>
          <div class="party-name">${esc(m.buyerName)}</div>
          ${m.buyerEmail ? `<div class="party-line">${esc(m.buyerEmail)}</div>` : ''}
          ${m.buyerLines.map((l) => `<div class="party-line">${esc(l)}</div>`).join('')}
        </div>
        <div class="badge">${esc(m.badge)}</div>
      </div>

      <table class="items">
        <thead>
          <tr><th>DESCRIPTION</th><th>BILLING PERIOD</th><th class="r">AMOUNT</th></tr>
        </thead>
        <tbody>
          <tr>
            <td class="desc">${esc(m.planName)}</td>
            <td>${m.period ? esc(m.period) : ''}</td>
            <td class="r">${esc(m.money)}</td>
          </tr>
        </tbody>
      </table>

      <div class="total-block">
        <div class="total-row"><span>${esc(m.totalLabel)}</span><span>${esc(m.money)}</span></div>
      </div>

      ${m.originalInvoice && m.originalInvoice.length > 0 ? detailBox('ORIGINAL INVOICE', m.originalInvoice) : ''}
      ${detailBox(m.detailTitle, m.detailRows)}
    </div>

    <div class="docfoot">
      ${m.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
      <p class="foot-brand">The Salad &nbsp;·&nbsp; www.thesalad.in</p>
    </div>
  </div>
  <script>window.onload=function(){window.print()}<\/script>
</body></html>`
    const w = window.open('', '_blank', 'width=900,height=1000')
    if (!w) {
      toast.error('The browser blocked the receipt window — allow pop-ups and try again')
      return
    }
    w.document.open()
    w.document.write(html)
    w.document.close()
    w.focus()
    // The window stays open after printing: closing it can tear down the
    // print dialog before the browser has finished with it.
    setTimeout(() => { w.print() }, 350)
  }

  /**
   * Download a billing document for a payment. The server issues it
   * once — eagerly when the payment or refund is confirmed — stores the
   * PDF, and replays the same immutable document on every later
   * request. `kind` selects the invoice or its linked refund document.
   */
  async function downloadInvoice(p: (typeof payments)[number], kind: 'invoice' | 'refund' = 'invoice') {
    setInvoiceBusy(`${kind}:${p.id}`)
    const subject = kind === 'refund' ? 'the refund document' : 'the invoice'
    try {
      const res = await edgeFetch(`/api/subscriptions/invoice?paymentId=${p.id}&kind=${kind}&download=1`, { headers })
      await failIfNotOk(res, subject)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // The server names the file after the issued document
      // (Invoice-INV-2026-27-00001.pdf / Refund-RFND-….pdf) — the very
      // number the receipt shows. Trust the Content-Disposition header so
      // the download can never drift from the canonical document; fall
      // back to the document number from state, then the transaction id.
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const serverName = /filename="?([^";]+)"?/.exec(disposition)?.[1]?.trim()
      const docNumber = kind === 'refund'
        ? p.refundDocument?.refund_number
        : p.document?.invoice_number
      a.download = serverName
        ?? `${kind === 'refund' ? 'Refund' : 'Invoice'}-${docNumber ?? p.transaction_id ?? p.id.slice(0, 8)}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(describeFailure(err, subject).message)
    } finally {
      setInvoiceBusy(null)
    }
  }

  // ---- derived billing state ----
  const latestPayment = payments[0] ?? null
  // Billing dates are business days: they are read in the timezone the
  // restaurant works in (Settings → Profile), never in the browser's, so the
  // owner's phone, the tablet on the counter and this build all agree.
  const billingTimeZone = data?.settings?.timezone || DEFAULT_BILLING_TIME_ZONE
  // ONE plan object feeds this whole tab AND the Manage Billing view. The
  // verified Manage payload wins (it is fetched with the tab and carries the
  // server's own Razorpay checks); then the fresh /subscriptions/state answer;
  // the bootstrap copy — fetched when the shell mounted, and possibly minutes
  // old — is only a placeholder until one of them lands.
  const billingPlan: BillingPlanFacts | null = manageData?.plan ?? statePlan ?? data?.subscription ?? null
  // Every remaining read of the plan goes through the canonical object, so
  // the plans grid, the usage limits and the cancel dialog cannot disagree
  // with the summary at the top of the page.
  const sub = billingPlan
  // ONE derivation of every value both pages print.
  const billingSnapshot = buildBillingSnapshot({
    plan: billingPlan,
    manage: manageData,
    timeZone: billingTimeZone,
  })
  // A legacy one-time purchase is history, not a subscription: it cannot be
  // renewed at its old price because that plan is retired. The next thing such
  // a customer buys is a monthly or annual subscription from the plans below,
  // and until they do they keep the access they already paid for.
  // A pay-once year does not renew itself, so the owner needs a Renew button
  // in the run-up to the end — the same grace the reminder banner gives.
  const payOnceExpiringSoon = Boolean(
    sub?.isPaid &&
      sub.paymentMode === 'pay_once' &&
      sub.currentPeriodEnd &&
      new Date(sub.currentPeriodEnd).getTime() - Date.now() < 30 * 86_400_000,
  )
  const renewTarget = sub?.billingMode === 'onetime'
    ? null
    : payOnceExpiringSoon && sub?.subscriptionPlan
      ? sub.subscriptionPlan
      : sub?.isRestricted && sub.subscriptionPlan
        ? sub.subscriptionPlan
        : sub?.status === 'past_due' && sub.subscriptionPlan
          ? sub.subscriptionPlan
        : null
  const subStatusLabel = billingSnapshot.hasPlan ? billingSnapshot.statusLabel : null

  /**
   * Load Razorpay's checkout script once.
   *
   * Two ways this used to hang forever: a tag that had already failed to
   * load never fires load or error again, and a slow connection left the
   * button waiting with no way out. So: a tag that failed before is removed
   * and started over, and everything settles within a deadline.
   */
  function loadRazorpay(): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = window as any
      if (w.Razorpay) return resolve()

      let settled = false
      let deadline: ReturnType<typeof setTimeout>
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        fn()
      }
      deadline = setTimeout(
        () => settle(() => reject(new Error('The payment window took too long to load. Check your connection and try again.'))),
        15_000,
      )

      const existing = document.querySelector('script[data-razorpay]')
      if (existing && existing.getAttribute('data-state') !== 'error') {
        existing.addEventListener('load', () => settle(resolve))
        existing.addEventListener('error', () =>
          settle(() => reject(new Error('Could not load the payment window.'))),
        )
        return
      }
      // A tag that failed before will never fire again — start over.
      if (existing) existing.remove()

      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.async = true
      script.dataset.razorpay = 'true'
      script.onload = () => {
        script.dataset.state = 'loaded'
        settle(resolve)
      }
      script.onerror = () => {
        script.dataset.state = 'error'
        settle(() => reject(new Error('Could not load the payment window.')))
      }
      document.body.appendChild(script)
    })
  }

  /** Start a purchase. */
  const startPurchase = async (planId: string, interval: BillingInterval = billingInterval) => {
    setPayingPlan(planId)
    setPayError(null)
    setPayState('starting')

    try {
      const res = await edgeFetch('/api/subscriptions/upgrade', {
        method: 'POST',
        headers,
        // Monthly is a mandate; a year is a single payment. The server decides
        // from the interval, so nothing here can ask for an annual mandate.
        body: JSON.stringify({ planId, interval, paymentMode: interval === 'annual' ? 'pay_once' : 'autopay' }),
      })
      if (!res.ok) {
        const failure = await apiError(res, 'your subscription', { action: 'save' })
        // The guard's 403 names the permission it wanted and carries a bare
        // `Forbidden`; that one is a toast, not a line in the payment card.
        // The owner check's sentence ("Only the restaurant owner can manage
        // billing.") and every other failure keep the card's own error line.
        if (isPermissionFailure(failure) && (failure.required?.length || failure.serverMessage === 'Forbidden')) {
          setPayState('idle')
          handleAction(failure, 'your subscription')
          return
        }
        setPayError(failure.serverMessage || failure.message)
        setPayState('failed')
        return
      }
      const body = await res.json()

      // A plan change on a live subscription is applied by Razorpay at the
      // next renewal — nothing is charged now, so there is no checkout to
      // open. The entitlement switches when the new plan's money is
      // collected.
      if (body.scheduled && !body.razorpaySubscriptionId) {
        const when = body.effectiveAt ? new Date(body.effectiveAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'your next renewal'
        toast.success(`${body.planName ?? 'The new plan'} starts at your next renewal (${when}).`)
        setPayState('success')
        await refresh()
        await loadBilling()
        return
      }

      // A subscription bought while paid time is still on the clock starts
      // at the end of that time: the Razorpay checkout only authorises the
      // mandate, nothing is charged today, and there is no payment to
      // verify afterwards.
      if (body.scheduled && body.razorpaySubscriptionId) {
        await loadRazorpay()
        setPayState('paying')
        const starts = body.startsAt ? new Date(body.startsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'when your paid time ends'
        const rzpSched = new (window as any).Razorpay({
          key: body.keyId,
          subscription_id: body.razorpaySubscriptionId,
          name: 'The Salad',
          description: `${body.planName} plan — ${interval === 'annual' ? 'annual' : 'monthly'}, starting ${starts}`,
          prefill: {
            name: restaurant.name ?? undefined,
            email: restaurant.email ?? undefined,
          },
          notes: { planId: body.planId },
          theme: { color: '#f97316' },
          modal: {
            ondismiss: () => {
              setPayState('idle')
              setPayingPlan(null)
            },
          },
          handler: async () => {
            // No verify call: there is no payment yet. The first charge
            // lands at the start date and the webhook activates it.
            setPayState('success')
            toast.success(`Mandate authorised — ${body.planName} starts on ${starts}.`)
            await refresh()
            await loadBilling()
          },
        })
        rzpSched.open()
        return
      }

      if (body.upgraded) {
        toast.success(`You are now on ${planId === 'pro' ? 'Pro' : 'Starter'}`)
        setPayState('success')
        await refresh()
        await loadBilling()
        return
      }

      await loadRazorpay()
      setPayState('paying')

      const rzp = new (window as any).Razorpay({
        key: body.keyId,
        // A one-time plan has no subscription; passing subscription_id at all
        // would put checkout into subscription mode.
        ...(body.razorpaySubscriptionId ? { subscription_id: body.razorpaySubscriptionId } : {}),
        order_id: body.razorpayOrderId,
        amount: Math.round(body.amount * 100),
        currency: body.currency,
        name: 'The Salad',
        description: `${body.planName} plan — ${interval === 'annual' ? 'annual' : 'monthly'}`,
        prefill: {
          name: restaurant.name ?? undefined,
          email: restaurant.email ?? undefined,
        },
        notes: { planId: body.planId },
        theme: { color: '#f97316' },
        modal: {
          ondismiss: () => {
            setPayState('idle')
            setPayingPlan(null)
          },
        },
        handler: async (response: any) => {
          setPayState('verifying')
          const verify = await edgeFetch('/api/subscriptions/verify', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              // Subscription payments may come back without the order id, and
              // one-time payments without the subscription id — forward what
              // Razorpay gave, falling back to what the checkout started with.
              razorpayOrderId: response.razorpay_order_id ?? body.razorpayOrderId,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
              razorpaySubscriptionId: response.razorpay_subscription_id ?? body.razorpaySubscriptionId ?? undefined,
            }),
          })
          if (!verify.ok) {
            const failure = await apiError(verify, 'your payment', { action: 'save' })
            // Same split as the upgrade call: a permission refusal is a
            // toast, everything else is the payment card's own error line.
            if (isPermissionFailure(failure) && (failure.required?.length || failure.serverMessage === 'Forbidden')) {
              setPayState('idle')
              handleAction(failure, 'your payment')
              return
            }
            setPayError(failure.serverMessage || failure.message)
            setPayState('failed')
            return
          }
          setPayState('success')
          toast.success('Payment received — your plan is active.')
          await refresh()
          await loadBilling()
        },
      })
      rzp.open()
    } catch (e: any) {
      setPayError(describeFailure(e, 'your payment', { action: 'save' }).message)
      setPayState('failed')
    } finally {
      setPayingPlan(null)
    }
  }

  // Cancellation runs only from the confirmation dialog, which has already
  // shown the exact date access ends. Nothing is cancelled by one stray tap.
  const cancel = async () => {
    setCancelling(true)
    try {
      const res = await edgeFetch('/api/subscriptions/cancel', { method: 'POST', headers })
      await failIfNotOk(res, 'the subscription', { action: 'save' })
      setCancelDialogOpen(false)
      toast.success(`Cancelled. You keep access until ${fmtDate(sub?.currentPeriodEnd, billingTimeZone)} — no further debits.`)
      await refresh()
      await loadBilling()
      await loadManage()
    } catch (err) {
      handleAction(err, 'the subscription')
    } finally {
      setCancelling(false)
    }
  }

  /**
   * Cancel a scheduled change that has not started. Only ever offered for
   * mandates the server verified as authorised-but-never-charged, so this
   * can never remove access that has been paid for.
   */
  const cancelScheduled = async () => {
    const change = cancelScheduledFor
    if (!change) return
    setCancellingScheduled(true)
    try {
      const res = await edgeFetch('/api/subscriptions/cancel-scheduled', {
        method: 'POST',
        headers,
        body: JSON.stringify({ checkoutId: change.checkoutId }),
      })
      await failIfNotOk(res, 'the scheduled change', { action: 'save' })
      setCancelScheduledFor(null)
      toast.success(`${change.planName} will not start. Your current plan is unchanged.`)
      await refresh()
      await loadBilling()
      await loadManage()
    } catch (err) {
      handleAction(err, 'the scheduled change')
    } finally {
      setCancellingScheduled(false)
    }
  }

  // The one review setting that exists: whether the session-end page asks
  // the diner for a rating at all. Saved to the tenant's settings and
  // enforced server-side when a review is submitted.
  const toggleReviewsEnabled = async (v: boolean) => {
    setReviewsEnabled(v)
    setReviewsEnabledSaving(true)
    try {
      const res = await edgeFetch('/api/settings', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ settings: { reviews_enabled: String(v) } }),
      })
      if (!res.ok) throw await writeFailure(res, 'review collection')
      const data = await res.json().catch(() => null)
      if (data?.error) throw new Error(data.error)
      toast.success(v ? 'Review collection turned on' : 'Review collection turned off')
    } catch (err) {
      setReviewsEnabled(!v)
      handleAction(err, 'review collection')
    } finally {
      setReviewsEnabledSaving(false)
    }
  }

  const handleReply = async (reviewId: string) => {
    if (!replyText.trim()) return
    setReplyingTo(reviewId)
    try {
      const res = await edgeFetch('/api/reviews/respond', {
        method: 'POST',
        headers,
        body: JSON.stringify({ reviewId, reply: replyText.trim() }),
      })
      await failIfNotOk(res, 'the reply', { action: 'save' })
      toast.success('Reply posted')
      setReplyText('')
      await load()
    } catch (err) {
      handleAction(err, 'the reply')
    } finally {
      setReplyingTo(null)
    }
  }



  // The rating overview is the server's own aggregate over every review the
  // restaurant has, not just the newest page of them.
  const avgRating = reviewStats.totalReviews > 0 ? reviewStats.averageRating.toFixed(1) : '—'
  const ratingDist = reviewStats.distribution.length
    ? reviewStats.distribution
    : [5, 4, 3, 2, 1].map(n => ({ stars: n, count: 0 }))

  if (!data) return null

  // A refused load is the whole answer: an empty form would read as "the
  // restaurant has no settings" rather than "you may not look". The retry
  // re-runs every load this role was allowed to make.
  if (denied) {
    return (
      <AccessDenied
        failure={denied}
        view="settings"
        onRetry={() => {
          setDenied(null)
          if (canViewReviews) void load()
          if (canManageSettings) {
            void loadBilling()
            void loadManage()
          }
        }}
      />
    )
  }

  // Discard changes
  const discard = () => {
    if (!data) return
    const t = data.tenant
    setTenantForm({
      name: t.name || '',
      tagline: t.tagline || '',
      email: t.email || '',
      phone: t.phone || '',
      address: t.address || '',
      currency: t.currency || 'INR',
      currencySymbol: t.currencySymbol || '$',
      logo: t.logo || '',
      gstin: data.settings.gstin || '',
      fssai: data.settings.fssai || '',
      instagram: data.settings.instagram || '',
      facebook: data.settings.facebook || '',
      youtube: data.settings.youtube || '',
      menuTheme: normaliseMenuTheme(data.settings.menu_theme),
    })
    setTaxRate(t.taxRate ?? 0)
    setServiceCharge(t.serviceCharge ?? 0)
    setOpeningHours(data.settings.opening_hours || 'Mon–Fri 9:00 AM – 10:00 PM')
    setTimezone(data.settings.timezone || 'Asia/Kolkata')
    const toggles: Record<string, boolean> = {}
    for (const t of OPS_TOGGLES) {
      toggles[t.key] = data.settings[t.key] === 'true'
    }
    setOpToggles(toggles)
    const u = data.currentUser
    setProfileForm({ name: u.name || '', email: u.email || '', phone: u.phone || '', avatar: u.avatar || '' })
    setPrefs({
      theme: data.settings.pref_theme || 'dark',
      language: data.settings.pref_language || 'en',
      emailAlerts: data.settings.pref_email_alerts !== 'false',
      pushAlerts: data.settings.pref_push_alerts !== 'false',
      soundAlerts: data.settings.pref_sound_alerts === 'true',
      dailyDigest: data.settings.pref_daily_digest !== 'false',
      defaultOrderType: data.settings.pref_default_order_type || 'DINE_IN',
      compactMode: data.settings.pref_compact_mode === 'true',
    })
  }

  const onCurrencyChange = (code: string) => {
    const c = CURRENCIES.find(x => x.code === code)
    setTenantForm(f => ({ ...f, currency: code, currencySymbol: c?.symbol || code }))
  }

  // Profile save
  const saveProfile = async () => {
    if (!data?.tenant) return
    setSavingProfile(true)
    try {
      // The owner's own record — name, phone, avatar. This used to PUT to
      // /api/settings, which writes the *restaurant*: saving your name
      // renamed the business and overwrote its contact email.
      const res = await edgeFetch('/api/auth/profile', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          name: profileForm.name,
          phone: profileForm.phone,
          avatar: profileForm.avatar,
        }),
      })
      if (!res.ok) throw await writeFailure(res, 'your profile')
      toast.success('Profile updated')
      await refresh()
    } catch (err) {
      handleAction(err, 'your profile')
    } finally {
      setSavingProfile(false)
    }
  }

  // Password change
  const changePassword = async () => {
    if (pwdForm.next !== pwdForm.confirm) {
      toast.error('Passwords do not match')
      return
    }
    setChangingPassword(true)
    try {
      const res = await edgeFetch('/api/auth/password', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ current: pwdForm.current, next: pwdForm.next }),
      })
      if (!res.ok) throw await writeFailure(res, 'your password')
      toast.success('Password updated')
      setPwdForm({ current: '', next: '', confirm: '' })
    } catch (err) {
      handleAction(err, 'your password')
    } finally {
      setChangingPassword(false)
    }
  }

  // Delete restaurant
  const confirmDelete = async () => {
    if (!data?.tenant) return
    try {
      const res = await edgeFetch('/api/settings', {
        method: 'DELETE',
        headers,
      })
      await failIfNotOk(res, 'the restaurant', { action: 'save' })
      toast.success('Restaurant deleted')
      setDeleteOpen(false)
      setDeleteConfirm('')
    } catch (err) {
      handleAction(err, 'the restaurant')
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className={cn(
        'px-3.5 md:px-6 flex items-center justify-between gap-3 flex-wrap transition-all duration-200 ease-out',
      )}>
        <div>
          <h2 className={cn(
            'font-bold tracking-tight flex items-center gap-2 transition-all duration-200 ease-out',
          )}>
            <Settings className={cn('text-primary transition-all duration-200 ease-out', 'h-5 w-5 md:h-6 md:w-6')} />
            Settings
          </h2>
          <div className={cn(
            'overflow-hidden transition-all duration-200 ease-out',
          )}>
            <p className="text-sm text-muted-foreground mt-0.5">Configure your restaurant profile & operations</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-2">
          {dirty && (
            <Button variant="ghost" onClick={discard} disabled={saving}>
              Discard
            </Button>
          )}
          <Button
            onClick={save}
            disabled={!dirty || saving || !canManageSettings}
            title={!canManageSettings ? 'You do not have permission to change settings' : undefined}
            className="bg-primary hover:bg-primary/90"
          >
            {saving ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving…</> : <><Save className="h-4 w-4" /> Save Changes</>}
          </Button>
        </div>
      </div>

      {/* Tabs — the wrapper is the scroll container; TabsList sticks to the top */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3.5 md:px-6 pb-3 md:pb-6 min-h-0">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
          <TabsList className="flex w-full md:w-auto overflow-x-auto scrollbar-thin justify-start gap-1 h-11 sm:h-9 bg-background/95 backdrop-blur-sm border border-border self-start sticky top-0 z-10">
            <TabsTrigger value="profile" className="flex-none whitespace-nowrap px-3"><User className="h-3.5 w-3.5" /> Profile</TabsTrigger>
            <TabsTrigger value="preferences" className="flex-none whitespace-nowrap px-3"><Palette className="h-3.5 w-3.5" /> Preferences</TabsTrigger>
            <TabsTrigger value="restaurant" className="flex-none whitespace-nowrap px-3"><Store className="h-3.5 w-3.5" /> Restaurant</TabsTrigger>
            <TabsTrigger value="operations" className="flex-none whitespace-nowrap px-3"><SlidersHorizontal className="h-3.5 w-3.5" /> Operations</TabsTrigger>
            {canManageSettings && (
              <TabsTrigger value="billing" className="flex-none whitespace-nowrap px-3"><CreditCard className="h-3.5 w-3.5" /> Billing</TabsTrigger>
            )}
            {canViewReviews && (
              <TabsTrigger value="reviews" className="flex-none whitespace-nowrap px-3"><Star className="h-3.5 w-3.5" /> Customer Reviews</TabsTrigger>
            )}
            {canManageSettings && (
              <TabsTrigger value="danger" className="flex-none whitespace-nowrap px-3 data-[state=active]:text-destructive"><AlertTriangle className="h-3.5 w-3.5" /> Danger Zone</TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="profile" className="flex-1 mt-3 min-h-0">
            <div className="max-w-3xl space-y-4">
              {/* User summary card */}
              <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xl font-bold shrink-0">
                    {profileForm.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-lg truncate">{profileForm.name || 'User'}</h3>
                    <p className="text-sm text-muted-foreground truncate">{profileForm.email}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <Badge variant="secondary" className="bg-primary/15 text-primary">{data.currentUser.role}</Badge>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Expandable sections — Profile buttons that open details */}
              <ExpandCard
                icon={<User className="h-5 w-5 text-primary" />}
                title="Personal Information"
                desc="Update your name, email, and contact details"
                open={openSection === 'personal'}
                onToggle={() => setOpenSection(openSection === 'personal' ? null : 'personal')}
              >
                <div className="grid sm:grid-cols-2 gap-4 pt-2">
                  <Field label="Full Name" icon={<User className="h-3.5 w-3.5" />}>
                    <Input value={profileForm.name} onChange={(e) => setProfileForm(f => ({ ...f, name: e.target.value }))} className="bg-secondary/50 border-border" />
                  </Field>
                  {/* The sign-in address is proved by Supabase Auth and is not
                      replaced by typing over it here — a changed copy would
                      show a different address from the one that actually
                      signs in. Business contact email lives on the Restaurant
                      tab and stays editable. */}
                  <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
                    <div className="flex items-center gap-2">
                      <div
                        aria-readonly="true"
                        className="flex h-9 min-w-0 flex-1 items-center truncate rounded-md border border-border bg-secondary/30 px-3 text-sm text-muted-foreground"
                        title={profileForm.email}
                      >
                        <span className="truncate">{profileForm.email}</span>
                      </div>
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600"
                        title="This address is your verified sign-in identity"
                      >
                        <ShieldCheck className="h-3 w-3" />
                        Verified · Read only
                      </span>
                    </div>
                  </Field>
                  <Field label="Phone" icon={<Phone className="h-3.5 w-3.5" />}>
                    <PhoneInput
                      value={profileForm.phone}
                      onChange={(v) => setProfileForm(f => ({ ...f, phone: v }))}
                      placeholder="98765 43210"
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <ImageUpload
                      value={profileForm.avatar}
                      onChange={(v) => setProfileForm(f => ({ ...f, avatar: v }))}
                      label="Profile Avatar"
                      shape="circle"
                      size={72}
                      fallback={profileForm.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || '👤'}
                    />
                  </div>
                </div>
                <div className="flex justify-end mt-4">
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90"
                    disabled={savingProfile}
                    onClick={saveProfile}
                  >
                    {savingProfile ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save Profile
                  </Button>
                </div>
              </ExpandCard>

              <ExpandCard
                icon={<KeyRound className="h-5 w-5 text-primary" />}
                title="Change Password"
                desc="Update your account password"
                open={openSection === 'password'}
                onToggle={() => setOpenSection(openSection === 'password' ? null : 'password')}
              >
                <div className="grid sm:grid-cols-2 gap-4 pt-2">
                  <div className="sm:col-span-2">
                    <Field label="Current Password" icon={<Lock className="h-3.5 w-3.5" />}>
                      <Input type="password" value={pwdForm.current} onChange={(e) => setPwdForm(f => ({ ...f, current: e.target.value }))} placeholder="••••••••" className="bg-secondary/50 border-border" />
                    </Field>
                  </div>
                  <Field label="New Password" icon={<Lock className="h-3.5 w-3.5" />}>
                    <Input type="password" value={pwdForm.next} onChange={(e) => setPwdForm(f => ({ ...f, next: e.target.value }))} placeholder="••••••••" className="bg-secondary/50 border-border" />
                  </Field>
                  <Field label="Confirm Password" icon={<Lock className="h-3.5 w-3.5" />}>
                    <Input type="password" value={pwdForm.confirm} onChange={(e) => setPwdForm(f => ({ ...f, confirm: e.target.value }))} placeholder="••••••••" className="bg-secondary/50 border-border" />
                  </Field>
                </div>
                <div className="flex justify-end mt-4">
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90"
                    disabled={changingPassword}
                    onClick={changePassword}
                  >
                    {changingPassword ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    Update Password
                  </Button>
                </div>
              </ExpandCard>

            </div>
          </TabsContent>

          <TabsContent value="preferences" className="flex-1 mt-3 min-h-0">
            <div className="max-w-3xl space-y-4">
              <ExpandCard
                icon={<Palette className="h-5 w-5 text-primary" />}
                title="Appearance"
                desc="Customize how the app looks"
                open={openSection === 'appearance'}
                onToggle={() => setOpenSection(openSection === 'appearance' ? null : 'appearance')}
              >
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/30 p-4">
                    <div className="flex items-center gap-3 min-w-0">
                      {prefs.theme === 'dark' ? <Moon className="h-4 w-4 text-primary shrink-0" /> : <Sun className="h-4 w-4 text-primary shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Theme</p>
                        <p className="text-xs text-muted-foreground">Dark mode is recommended for POS screens</p>
                      </div>
                    </div>
                    <Select value={prefs.theme} disabled={!canManageSettings} onValueChange={(v) => {
                      setPrefs(p => ({ ...p, theme: v }))
                      applyTheme(v as 'dark' | 'light' | 'system')
                      // Saved here, not left to the Save button: this control
                      // applies the moment it is chosen, so it must persist the
                      // moment it is chosen. Otherwise the theme changes under
                      // your hand and is still the old one in the account — which
                      // is what "it reverted" looks like after a reload, or on
                      // the next device. Only this key is sent, so no half-finished
                      // edit elsewhere is saved along with it.
                      void edgeFetch('/api/settings', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ settings: { pref_theme: v } }),
                      })
                        .then((res) => {
                          if (!res.ok) toast.error('Theme applied here, but could not be saved to your account')
                        })
                        .catch(() => toast.error('Theme applied here, but could not be saved to your account'))
                      toast.success(`Theme changed to ${v}`, { description: 'Applied and saved' })
                    }}>
                      <SelectTrigger className="bg-secondary/50 border-border w-32 shrink-0" title={!canManageSettings ? 'You do not have permission to change settings' : undefined}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">🌙 Dark</SelectItem>
                        <SelectItem value="light">☀️ Light</SelectItem>
                        <SelectItem value="system">💻 System</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/30 p-4">
                    <div className="flex items-center gap-3">
                      <Languages className="h-4 w-4 text-primary shrink-0" />
                      <div>
                        <p className="text-sm font-medium">Language</p>
                        <p className="text-xs text-muted-foreground">Display language for the interface</p>
                      </div>
                    </div>
                    <Select value={prefs.language} onValueChange={(v) => setPrefs(p => ({ ...p, language: v }))}>
                      <SelectTrigger className="bg-secondary/50 border-border w-32 shrink-0"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {LANGUAGES.map((l) => (
                          <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/30 p-4">
                    <div className="flex items-center gap-3">
                      <Smartphone className="h-4 w-4 text-primary shrink-0" />
                      <div>
                        <p className="text-sm font-medium">Compact Mode</p>
                        <p className="text-xs text-muted-foreground">Denser layout to fit more on screen</p>
                      </div>
                    </div>
                    <Switch checked={prefs.compactMode} onCheckedChange={(v) => setPrefs(p => ({ ...p, compactMode: v }))} />
                  </div>
                </div>
              </ExpandCard>

              <ExpandCard
                icon={<Bell className="h-5 w-5 text-primary" />}
                title="Notifications"
                desc="Manage how you receive alerts"
                open={openSection === 'notifications'}
                onToggle={() => setOpenSection(openSection === 'notifications' ? null : 'notifications')}
              >
                <div className="space-y-2 pt-2">
                  {[
                    { key: 'emailAlerts' as const, label: 'Email Alerts', desc: 'New orders & reservations via email', icon: Mail },
                    { key: 'pushAlerts' as const, label: 'Push Notifications', desc: 'Real-time browser push alerts', icon: Bell },
                    { key: 'soundAlerts' as const, label: 'Sound Alerts', desc: 'Play sound when new order arrives', icon: Bell },
                    { key: 'dailyDigest' as const, label: 'Daily Digest', desc: 'Daily summary email at 9 AM', icon: Mail },
                  ].map((n) => {
                    const Icon = n.icon
                    return (
                      <div key={n.key} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/30 p-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{n.label}</p>
                            <p className="text-xs text-muted-foreground">{n.desc}</p>
                          </div>
                        </div>
                        <Switch checked={prefs[n.key]} onCheckedChange={(v) => setPrefs(p => ({ ...p, [n.key]: v }))} />
                      </div>
                    )
                  })}
                </div>
              </ExpandCard>

              <ExpandCard
                icon={<SlidersHorizontal className="h-5 w-5 text-primary" />}
                title="POS Preferences"
                desc="Default behavior for the point of sale"
                open={openSection === 'pos'}
                onToggle={() => setOpenSection(openSection === 'pos' ? null : 'pos')}
              >
                <div className="space-y-3 pt-2">
                  <Field label="Default Order Type" icon={<CreditCard className="h-3.5 w-3.5" />}>
                    <Select value={prefs.defaultOrderType} onValueChange={(v) => setPrefs(p => ({ ...p, defaultOrderType: v }))}>
                      <SelectTrigger className="bg-secondary/50 border-border w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DINE_IN">🍽️ Dine In</SelectItem>
                        <SelectItem value="TAKEAWAY">🥡 Takeaway</SelectItem>
                        <SelectItem value="DELIVERY">🛵 Delivery</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
              </ExpandCard>

              {/* No second save button here. Preferences are saved by the
                  same "Save Changes" action as everything else on this page;
                  this used to be a separate button that only showed a toast
                  and wrote nothing. */}
            </div>
          </TabsContent>

          <TabsContent value="restaurant" className="flex-1 mt-3 min-h-0">
              <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6 max-w-3xl">
                <div className="flex items-center gap-2 mb-5">
                  <Building2 className="h-5 w-5 text-primary" />
                  <h3 className="font-semibold">Restaurant Profile</h3>
                </div>

                {/* Logo upload */}
                <div className="mb-6">
                  <ImageUpload
                    value={tenantForm.logo}
                    onChange={(v) => setTenantForm((f) => ({ ...f, logo: v }))}
                    label="Restaurant Logo"
                    shape="circle"
                    size={80}
                    fallback={<Store className="h-8 w-8 text-muted-foreground" />}
                  />
                  <p className="text-xs text-muted-foreground mt-1.5 ml-1">Square images work best. Upload a PNG, JPG, or WebP file.</p>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Restaurant Name" icon={<Building2 className="h-3.5 w-3.5" />}>
                    <Input
                      value={tenantForm.name}
                      onChange={(e) => setTenantForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="Jaegar Resto"
                      className="bg-secondary/50 border-border"
                    />
                  </Field>
                  <Field label="Tagline" icon={<Sparkles className="h-3.5 w-3.5" />}>
                    <Input
                      value={tenantForm.tagline}
                      onChange={(e) => setTenantForm((f) => ({ ...f, tagline: e.target.value }))}
                      placeholder="Best sushi in town"
                      className="bg-secondary/50 border-border"
                    />
                  </Field>
                  <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
                    <Input
                      type="email"
                      value={tenantForm.email}
                      onChange={(e) => setTenantForm((f) => ({ ...f, email: e.target.value }))}
                      placeholder="hello@jaegar.resto"
                      className="bg-secondary/50 border-border"
                    />
                  </Field>
                  <Field label="Phone" icon={<Phone className="h-3.5 w-3.5" />}>
                    <PhoneInput
                      value={tenantForm.phone}
                      onChange={(v) => setTenantForm((f) => ({ ...f, phone: v }))}
                      placeholder="98765 43210"
                    />
                  </Field>
                  <Field
                    label="Menu Theme"
                    icon={<Palette className="h-3.5 w-3.5" />}
                    hint="what your customers see"
                  >
                    <Select
                      value={tenantForm.menuTheme}
                      onValueChange={(v) =>
                        setTenantForm((f) => ({ ...f, menuTheme: normaliseMenuTheme(v) }))
                      }
                    >
                      <SelectTrigger className="bg-secondary/50 border-border w-full">
                        <SelectValue placeholder="Select a theme" />
                      </SelectTrigger>
                      <SelectContent>
                        {MENU_THEMES.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Currency" icon={<CreditCard className="h-3.5 w-3.5" />}>
                    <Select value={tenantForm.currency} onValueChange={onCurrencyChange}>
                      <SelectTrigger className="bg-secondary/50 border-border w-full">
                        <SelectValue placeholder="Select currency" />
                      </SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.code} ({c.symbol})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Currency Symbol" icon={<CreditCard className="h-3.5 w-3.5" />}>
                    <Input
                      value={tenantForm.currencySymbol}
                      onChange={(e) => setTenantForm((f) => ({ ...f, currencySymbol: e.target.value }))}
                      maxLength={3}
                      className="bg-secondary/50 border-border"
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Address" icon={<MapPin className="h-3.5 w-3.5" />}>
                      <Textarea
                        value={tenantForm.address}
                        onChange={(e) => setTenantForm((f) => ({ ...f, address: e.target.value }))}
                        rows={2}
                        placeholder="123 Main Street, Suite 100, New York, NY 10001"
                        className="bg-secondary/50 border-border resize-none"
                      />
                    </Field>
                  </div>
                </div>

                {/* Compliance & Tax IDs */}
                <div className="mt-6 pt-5 border-t border-border">
                  <div className="flex items-center gap-2 mb-4">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-semibold">Compliance &amp; Tax IDs</h4>
                    <span className="text-[11px] text-muted-foreground">— appears on invoices &amp; receipts</span>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="GST Number (GSTIN)" icon={<FileText className="h-3.5 w-3.5" />}>
                      <Input
                        value={tenantForm.gstin}
                        onChange={(e) => setTenantForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                        placeholder="22AAAAA0000A1Z5"
                        maxLength={15}
                        className="bg-secondary/50 border-border uppercase font-mono"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">15-digit GSTIN. Used for tax invoices.</p>
                    </Field>
                    <Field label="FSSAI License No." icon={<FileText className="h-3.5 w-3.5" />}>
                      <Input
                        value={tenantForm.fssai}
                        onChange={(e) => setTenantForm((f) => ({ ...f, fssai: e.target.value }))}
                        placeholder="10020065000123"
                        maxLength={14}
                        className="bg-secondary/50 border-border font-mono"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">14-digit FSSAI food license number.</p>
                    </Field>
                  </div>
                </div>

                {/* Social Media Links */}
                <div className="mt-6 pt-5 border-t border-border">
                  <div className="flex items-center gap-2 mb-4">
                    <Instagram className="h-4 w-4 text-primary" />
                    <h4 className="text-sm font-semibold">Social Media</h4>
                    <span className="text-[11px] text-muted-foreground">— shown on the customer menu page</span>
                  </div>
                  <div className="grid sm:grid-cols-3 gap-4">
                    <Field label="Instagram" icon={<Instagram className="h-3.5 w-3.5" />}>
                      <Input
                        value={tenantForm.instagram}
                        onChange={(e) => setTenantForm((f) => ({ ...f, instagram: e.target.value }))}
                        placeholder="https://instagram.com/yourrestaurant"
                        className="bg-secondary/50 border-border"
                      />
                    </Field>
                    <Field label="Facebook" icon={<Facebook className="h-3.5 w-3.5" />}>
                      <Input
                        value={tenantForm.facebook}
                        onChange={(e) => setTenantForm((f) => ({ ...f, facebook: e.target.value }))}
                        placeholder="https://facebook.com/yourrestaurant"
                        className="bg-secondary/50 border-border"
                      />
                    </Field>
                    <Field label="YouTube" icon={<Youtube className="h-3.5 w-3.5" />}>
                      <Input
                        value={tenantForm.youtube}
                        onChange={(e) => setTenantForm((f) => ({ ...f, youtube: e.target.value }))}
                        placeholder="https://youtube.com/@yourrestaurant"
                        className="bg-secondary/50 border-border"
                      />
                    </Field>
                  </div>
                </div>
              </Card>
          </TabsContent>

          <TabsContent value="operations" className="flex-1 mt-3 min-h-0">
              <div className="max-w-3xl space-y-4">
                <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <SlidersHorizontal className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">Operations &amp; Finance</h3>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Tax Rate (%)" icon={<CreditCard className="h-3.5 w-3.5" />}>
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={taxRate}
                        onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
                        className="bg-secondary/50 border-border"
                      />
                    </Field>
                    <Field label="Service Charge (%)" icon={<CreditCard className="h-3.5 w-3.5" />}>
                      <Input
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={serviceCharge}
                        onChange={(e) => setServiceCharge(parseFloat(e.target.value) || 0)}
                        className="bg-secondary/50 border-border"
                      />
                    </Field>
                    <Field label="Opening Hours" icon={<Clock className="h-3.5 w-3.5" />}>
                      <Input
                        value={openingHours}
                        onChange={(e) => setOpeningHours(e.target.value)}
                        placeholder="Mon–Fri 9:00 AM – 10:00 PM"
                        className="bg-secondary/50 border-border"
                      />
                    </Field>
                    <Field label="Timezone" icon={<Globe className="h-3.5 w-3.5" />}>
                      <Select value={timezone} onValueChange={setTimezone}>
                        <SelectTrigger className="bg-secondary/50 border-border w-full">
                          <SelectValue placeholder="Select timezone" />
                        </SelectTrigger>
                        <SelectContent>
                          {TIMEZONES.map((tz) => (
                            <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </Card>

                <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <SlidersHorizontal className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">Feature Toggles</h3>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {OPS_TOGGLES.map((t) => (
                      <div
                        key={t.key}
                        className="flex items-start justify-between gap-3 rounded-xl border border-border bg-secondary/30 p-3"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{t.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{t.desc}</p>
                        </div>
                        <Switch
                          checked={!!opToggles[t.key]}
                          onCheckedChange={(v) => setOpToggles((prev) => ({ ...prev, [t.key]: v }))}
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
          </TabsContent>

          {canManageSettings && (
          <TabsContent value="billing" className="flex-1 mt-3 min-h-0">
            {managing && (
              <ManageBillingView
                snapshot={billingSnapshot}
                plan={billingPlan}
                payments={payments}
                restaurant={restaurant}
                timeZone={billingTimeZone}
                directory={billingDirectory}
                manage={manageData}
                loading={manageLoading}
                error={manageError}
                onRetry={loadManage}
                onBack={() => setManaging(false)}
                onCancelSubscription={() => setCancelDialogOpen(true)}
                cancelling={cancelling}
                onCancelScheduled={(change) => setCancelScheduledFor(change)}
                onBrowsePlans={() => setManaging(false)}
                onDownload={downloadInvoice}
                onReceipt={setReceiptFor}
                invoiceBusy={invoiceBusy}
              />
            )}
            <div className={cn('max-w-4xl space-y-4 md:space-y-6', managing && 'hidden')}>
              {/* ---- loading ---- */}
              {billingLoading && !data?.subscription && (
                <div className="space-y-4">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-40 rounded-2xl bg-secondary/30 animate-pulse" />
                  ))}
                </div>
              )}

              {/* ---- the plan in force ---- */}
              <BillingCard>
                <BillingSummary
                  snapshot={billingSnapshot}
                  plan={billingPlan}
                  heading="Your plan"
                  icon={<CreditCard className="size-4" />}
                  renewalState={manageData ? 'verified' : manageError ? 'failed' : 'loading'}
                  actions={
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setManaging(true)}
                      >
                        <Wallet className="h-3.5 w-3.5 mr-1.5" />
                        Manage Billing
                      </Button>
                      {renewTarget && (
                        <Button
                          size="sm"
                          className="bg-primary hover:bg-primary/90"
                          onClick={() => startPurchase(renewTarget)}
                          disabled={payState !== 'idle'}
                        >
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                          {billingPlan?.isRestricted ? 'Subscribe again' : billingPlan?.status === 'past_due' ? 'Pay now' : 'Renew'}
                        </Button>
                      )}
                      {/* Nothing to cancel without a mandate: a pay-once year has no
                          subscription behind it and simply ends on its date. */}
                      {billingPlan?.isPaid && billingPlan.billingMode !== 'onetime' && billingPlan.paymentMode !== 'pay_once' && !billingPlan.cancelAtPeriodEnd && billingPlan.status !== 'past_due' && (
                        <Button variant="outline" size="sm" onClick={() => setCancelDialogOpen(true)} disabled={cancelling}>
                          {cancelling ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                          Cancel subscription
                        </Button>
                      )}
                    </>
                  }
                />

                {/* The trial */}
                {billingSnapshot.trial && (
                  <div className="mt-4 rounded-xl border border-blue-200/70 bg-blue-50/60 p-3.5 dark:border-blue-500/25 dark:bg-blue-500/10">
                    <div className="flex items-start gap-2.5">
                      <ClockIcon className="mt-0.5 size-4 shrink-0 text-blue-600" />
                      <div className="text-[13px] leading-relaxed text-blue-900 dark:text-blue-200">
                        <p className="font-semibold">
                          {billingSnapshot.trial.daysLeft ?? 0} day
                          {billingSnapshot.trial.daysLeft === 1 ? '' : 's'} left in your free trial
                        </p>
                        <p className="mt-0.5 text-blue-800/90">
                          Started {billingSnapshot.trial.started} ·{' '}
                          ends {billingSnapshot.trial.ends}.
                          You keep everything you have built. When the trial ends, the paid features stop until you
                          subscribe.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* The trial has run out */}
                {sub?.isRestricted && (
                  <div className="mt-4 rounded-xl border border-amber-200/70 bg-amber-50/70 p-3.5 dark:border-amber-500/25 dark:bg-amber-500/10">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                      <div className="text-[13px] leading-relaxed text-amber-900 dark:text-amber-200">
                        <p className="font-semibold">
                          {sub.subscriptionPlan ? 'Your plan has ended' : 'Your free trial has ended'}
                        </p>
                        <p className="mt-0.5 text-amber-800/90 dark:text-amber-300/80">
                          Nothing has been deleted — your menu, orders and settings are all still here. The paid
                          features are switched off until you pick a plan below.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </BillingCard>

              {/* ---- the payment in progress ---- */}
              {payState !== 'idle' && (
                <Card
                  className={cn(
                    'rounded-2xl border p-4 md:p-5',
                    payState === 'success'
                      ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/25 dark:bg-emerald-500/10'
                      : payState === 'failed'
                        ? 'border-destructive/30 bg-destructive/5'
                        : 'border-border bg-card',
                  )}
                >
                  <div className="flex items-start gap-3">
                    {payState === 'success' ? (
                      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
                    ) : payState === 'failed' ? (
                      <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
                    ) : (
                      <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">
                        {payState === 'starting' && 'Starting the payment…'}
                        {payState === 'paying' && 'Waiting for Razorpay…'}
                        {payState === 'verifying' && 'Confirming your payment…'}
                        {payState === 'success' && 'Your plan is active'}
                        {payState === 'failed' && 'The payment did not go through'}
                      </p>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                        {payState === 'verifying' &&
                          'Checking the payment signature with the server. Nothing is activated until it matches.'}
                        {payState === 'success' &&
                          'The payment was verified and your plan is active. Your next payment is due in a month.'}
                        {payState === 'failed' && (payError ?? 'The payment could not be confirmed.')}
                      </p>
                      {payState === 'failed' && payingPlan && (
                        <Button
                          size="sm"
                          className="mt-2.5 bg-primary hover:bg-primary/90"
                          onClick={() => startPurchase(payingPlan)}
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {/* ---- the last payment ---- */}
              {!billingLoading && latestPayment && (
                <BillingCard>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <BillingSectionHead
                      icon={<Receipt className="size-4" />}
                      title="Last payment"
                      extra={
                        <StatusPill
                          tone={latestPayment.status === 'succeeded' ? 'success' : latestPayment.status === 'refunded' ? 'warn' : 'danger'}
                          label={latestPayment.status}
                        />
                      }
                    />
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                    <BillingFact
                      label="Amount"
                      value={<span className="font-semibold">{money(latestPayment.currency, Number(latestPayment.amount))}</span>}
                    />
                    <BillingFact label="Date" value={fmtDate(latestPayment.created_at, billingTimeZone)} />
                    <BillingFact label="Method" value={methodLabel(latestPayment.payment_method)} />
                    <BillingFact
                      label="Transaction ID"
                      value={<span className="truncate font-mono text-[12.5px]">{latestPayment.transaction_id ?? latestPayment.razorpay_payment_id ?? '—'}</span>}
                      title={latestPayment.transaction_id ?? latestPayment.razorpay_payment_id ?? ''}
                    />
                  </div>
                  {latestPayment.status === 'failed' && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200/70 bg-red-50/60 px-3 py-2.5 dark:border-red-500/25 dark:bg-red-500/10">
                      <p className="text-[12.5px] text-red-900 dark:text-red-200">
                        {latestPayment.failure_reason ?? 'The payment was declined.'} — no money was taken.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-300 text-red-800 hover:bg-red-100 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/10"
                        onClick={() => startPurchase(latestPayment.plan_id)}
                        disabled={payState !== 'idle'}
                      >
                        <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                        Retry payment
                      </Button>
                    </div>
                  )}
                  {(latestPayment.status === 'succeeded' || latestPayment.status === 'refunded') && (
                    <div className="mt-3 flex justify-end">
                      <Button size="sm" variant="outline" onClick={() => setReceiptFor(latestPayment)}>
                        <Printer className="h-3.5 w-3.5 mr-1.5" />
                        Receipt
                      </Button>
                    </div>
                  )}
                </BillingCard>
              )}

              {/* ---- the plans ---- */}
              <div>
                <h3 className="mb-2.5 text-sm font-semibold">
                  {sub?.isRestricted ? 'Choose a plan' : 'Plans'}
                </h3>

                {/* Monthly / Annually. Same choice as the landing page, and it
                    decides the price shown and the interval sent to Razorpay. */}
                <div className="mb-3 flex flex-wrap items-center gap-2.5">
                  <div
                    role="tablist"
                    aria-label="Billing period"
                    className="inline-flex rounded-xl border border-border bg-secondary/40 p-1"
                  >
                    {(['monthly', 'annual'] as const).map((key) => (
                      <button
                        key={key}
                        role="tab"
                        aria-selected={billingInterval === key}
                        onClick={() => setBillingInterval(key)}
                        className={cn(
                          'rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                          billingInterval === key
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {key === 'monthly' ? 'Monthly' : 'Annually'}
                      </button>
                    ))}
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-2.5 py-1 text-[11px] font-medium',
                      billingInterval === 'annual'
                        ? 'bg-emerald-500/15 text-emerald-600'
                        : 'bg-secondary text-muted-foreground',
                    )}
                  >
                    {billingInterval === 'annual' ? 'Saving 16.7% with annual billing' : 'Save 16.7% annually'}
                  </span>
                </div>

                {/* A year is bought in one payment: no mandate, nothing that
                    can debit again. Said plainly, once, instead of a choice
                    that does not exist. */}
                {billingInterval === 'annual' && (
                  <p className="mb-3 rounded-xl border border-border bg-secondary/30 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">Pay once for the year.</span>{' '}
                    No auto-debit and no mandate — you are charged once and renew manually when the
                    year ends.
                  </p>
                )}
                {billingInterval === 'monthly' && (
                  <p className="mb-3 rounded-xl border border-border bg-secondary/30 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">AutoPay.</span>{' '}
                    You authorise a monthly debit by card or UPI AutoPay. Cancel any time and keep
                    access until the month you paid for ends.
                  </p>
                )}

                <div className="grid gap-3 md:grid-cols-2">
                  {plans.filter((plan) => plan.billingMode !== 'onetime').map((plan) => {
                    const isCurrent = sub?.planId === plan.id
                    const isTrialPlan = sub?.isTrial && plan.id === 'pro'
                    const amount = priceFor(plan, billingInterval)
                    const savings = annualSavings(plan)
                    const ctaLabel = !sub?.isPaid
                      ? `Choose ${plan.name}`
                      : amount > (billingInterval === 'annual' ? (sub.priceYearly ?? sub.priceMonthly * 12) : sub.priceMonthly)
                        ? `Upgrade to ${plan.name}`
                        : `Switch to ${plan.name}`
                    return (
                      <Card
                        key={plan.id}
                        className={cn(
                          'rounded-2xl border p-5 flex flex-col transition-shadow',
                          isCurrent
                            ? 'border-primary/60 bg-primary/5 shadow-[0_0_0_1px_theme(colors.primary/30)]'
                            : 'border-border bg-card hover:border-primary/25',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="text-lg font-bold tracking-tight">{plan.name}</h4>
                              {isCurrent && (
                                <Badge className="bg-primary/15 text-[10px] text-primary">Current</Badge>
                              )}
                              {plan.popular && !isCurrent && (
                                <Badge className="bg-amber-500/15 text-[10px] text-amber-600">Popular</Badge>
                              )}
                              {plan.billingMode === 'onetime' && (
                                <Badge variant="secondary" className="bg-primary/10 text-[10px] text-primary">
                                  One-time
                                </Badge>
                              )}
                            </div>
                            {plan.description && (
                              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{plan.description}</p>
                            )}
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-2xl font-bold leading-none tracking-tight">{money(plan.currency, amount)}</p>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {billingInterval === 'annual' ? 'per year' : 'per month'}
                            </p>
                            {billingInterval === 'annual' && savings && (
                              <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                                save {money(plan.currency, savings.amount)}
                              </p>
                            )}
                          </div>
                        </div>

                        <ul className="mt-4 space-y-2 flex-1">
                          {plan.features.map((f) => (
                            <li key={f} className="flex items-start gap-2 text-[13px] leading-relaxed">
                              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
                                <Check className="size-2.5" />
                              </span>
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>

                        <div className="mt-5">
                          {isCurrent ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={isTrialPlan}
                            >
                              {isTrialPlan ? 'Included in your trial' : 'Your current plan'}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="w-full bg-primary hover:bg-primary/90"
                              disabled={
                                payState === 'paying' ||
                                payState === 'verifying' ||
                                payState === 'starting' ||
                                // A renewal retry is in flight — charging for a
                                // new plan now could collect twice.
                                sub?.status === 'pending'
                              }
                              onClick={() => startPurchase(plan.id, billingInterval)}
                            >
                              {payState === 'starting' && payingPlan === plan.id ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              {ctaLabel}
                            </Button>
                          )}
                          {sub?.status === 'pending' && !isCurrent && (
                            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                              A renewal payment is being retried — plan changes resume when it settles.
                            </p>
                          )}
                          {sub?.isPaid && sub.status !== 'pending' && !isCurrent && plan.billingMode !== 'onetime' && (
                            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                              Applies at your next renewal — nothing is charged today.
                            </p>
                          )}
                        </div>
                      </Card>
                    )
                  })}
                </div>

                {!razorpayConfigured && (
                  <p className="mt-3 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-900">
                    Payments are not set up on the server yet. The platform owner has to add the Razorpay keys
                    before anyone can subscribe.
                  </p>
                )}

              </div>

              {/* ---- the payment history ---- */}
              <BillingCard>
                <BillingSectionHead
                  icon={<Receipt className="size-4" />}
                  title="Payment history"
                  count={payments.length}
                  extra={
                    billingTotals && billingTotals.paymentCount > 0 ? (
                      <span className="ml-auto text-[12px] text-muted-foreground">
                        Total spent{' '}
                        <span className="font-semibold text-foreground">{money(billingTotals.currency, billingTotals.netSpent)}</span>
                        {billingTotals.totalRefunded > 0 && (
                          <> · refunded {money(billingTotals.currency, billingTotals.totalRefunded)}</>
                        )}
                      </span>
                    ) : undefined
                  }
                />
                {payments.length === 0 ? (
                  <BillingEmpty
                    icon={<Receipt className="size-4" />}
                    title="No payments yet"
                    hint="When you pay for a plan, the receipt appears here."
                  />
                ) : (
                  <PaymentHistoryRows
                    payments={payments}
                    directory={billingDirectory}
                    timeZone={billingTimeZone}
                    invoiceBusy={invoiceBusy}
                    onDownload={downloadInvoice}
                    onReceipt={setReceiptFor}
                  />
                )}
              </BillingCard>

              {/* ---- usage against the plan's limits ---- */}
              <BillingCard>
                <BillingSectionHead icon={<SlidersHorizontal className="size-4" />} title="Usage limits" />
                <div className="grid gap-4 sm:grid-cols-3">
                  <UsageStat
                    label="Staff members"
                    value={data.users.length}
                    limit={sub?.limits?.staff ?? null}
                  />
                  <UsageStat
                    label="Menu items"
                    value={data.menuItems.length}
                    limit={sub?.limits?.menuItems ?? null}
                  />
                  <UsageStat
                    label="Restaurant locations"
                    // Counted from the database by the server, not assumed.
                    value={locationCount ?? manageData?.locationCount ?? 1}
                    limit={sub?.limits?.locations ?? null}
                  />
                </div>
              </BillingCard>

              <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                <CreditCard className="mt-0.5 size-3.5 shrink-0" />
                Payments are handled by Razorpay on their own secure checkout. This page never sees your card
                details, and a plan is only activated after the server has checked the payment signature.
              </p>

              {/* ---- the receipt: the invoice design — the same document the
                    Download button replays as a PDF, from the issued record ---- */}
              <Dialog open={receiptFor !== null} onOpenChange={(open) => !open && setReceiptFor(null)}>
                <DialogContent className="max-w-lg bg-white text-[#1b202c] p-0 overflow-hidden">
                  <DialogTitle className="sr-only">Payment receipt</DialogTitle>
                  {receiptFor && (() => {
                    const m = receiptModel(receiptFor)
                    const sellerLines = [
                      ...m.sellerLines,
                      ...(m.sellerEmail ? [m.sellerEmail] : []),
                      ...(m.sellerPhone ? [m.sellerPhone] : []),
                    ]
                    return (
                      <div className="max-h-[85vh] overflow-y-auto">
                        {/* Navy band + orange accent — the invoice header */}
                        <div className="flex items-start justify-between bg-[#1f2937] px-6 pb-5 pt-6">
                          <div>
                            <p className="text-[22px] font-bold leading-tight text-white">The Salad</p>
                            <p className="mt-1 text-[10px] text-[#c7cfd9]">Restaurant management platform</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[16px] font-bold tracking-wide text-white">{m.title}</p>
                            <p className="mt-1 text-[10.5px] text-[#c7cfd9]">No. {m.number}</p>
                            <p className="text-[10.5px] text-[#c7cfd9]">{m.date}</p>
                          </div>
                        </div>
                        <div className="h-[3px] bg-[#f97316]" />

                        <div className="px-6 py-5">
                          {/* Seller / buyer / status */}
                          <div className="grid grid-cols-[1fr_1fr_auto] gap-4">
                            <div>
                              <p className="text-[9px] font-bold tracking-widest text-gray-500">FROM</p>
                              <p className="mt-1 text-[13px] font-bold">{m.sellerName}</p>
                              {sellerLines.map((l) => <p key={l} className="mt-0.5 text-[11px] break-all">{l}</p>)}
                            </div>
                            <div>
                              <p className="text-[9px] font-bold tracking-widest text-gray-500">BILLED TO</p>
                              <p className="mt-1 text-[13px] font-bold">{m.buyerName}</p>
                              {m.buyerEmail && <p className="mt-0.5 text-[11px] break-all">{m.buyerEmail}</p>}
                              {m.buyerLines.map((l) => <p key={l} className="mt-0.5 text-[11px]">{l}</p>)}
                            </div>
                            <span className={cn('self-start rounded-sm px-3 py-1 text-[10px] font-bold tracking-wider text-white',
                              m.kind === 'refund' ? 'bg-slate-600' : 'bg-green-600')}>
                              {m.badge}
                            </span>
                          </div>

                          {/* The subscription as the single line item */}
                          <table className="mt-6 w-full border-t border-gray-200 text-[11px]">
                            <thead>
                              <tr className="border-b border-gray-200 bg-gray-100 text-[9px] font-bold tracking-widest text-gray-500">
                                <th className="px-2.5 py-1.5 text-left">DESCRIPTION</th>
                                <th className="px-2.5 py-1.5 text-left">BILLING PERIOD</th>
                                <th className="px-2.5 py-1.5 text-right">AMOUNT</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="border-b border-gray-200">
                                <td className="px-2.5 py-2.5 text-[12px] font-bold">{m.planName}</td>
                                <td className="px-2.5 py-2.5">{m.period ?? ''}</td>
                                <td className="px-2.5 py-2.5 text-right whitespace-nowrap">{m.money}</td>
                              </tr>
                            </tbody>
                          </table>

                          {/* Total */}
                          <div className="ml-auto mt-4 w-56 border-t-2 border-[#f97316] pt-2.5">
                            <div className="flex justify-between text-[13px] font-bold">
                              <span>{m.totalLabel}</span><span>{m.money}</span>
                            </div>
                          </div>

                          {/* Reference details */}
                          {m.originalInvoice && m.originalInvoice.length > 0 && (
                            <div className="mt-5 bg-gray-100 px-3.5 py-3">
                              <p className="mb-2 text-[9px] font-bold tracking-widest text-gray-500">ORIGINAL INVOICE</p>
                              {m.originalInvoice.map(([k, v]) => (
                                <div key={k} className="grid grid-cols-[150px_1fr] py-0.5 text-[11px]">
                                  <span className="text-gray-500">{k}</span><span className="break-all">{v}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="mt-5 bg-gray-100 px-3.5 py-3">
                            <p className="mb-2 text-[9px] font-bold tracking-widest text-gray-500">{m.detailTitle}</p>
                            {m.detailRows.map(([k, v]) => (
                              <div key={k} className="grid grid-cols-[150px_1fr] py-0.5 text-[11px]">
                                <span className="text-gray-500">{k}</span><span className="break-all">{v}</span>
                              </div>
                            ))}
                          </div>

                          {/* Notes */}
                          <div className="mt-6 border-t border-gray-200 pt-2.5">
                            {m.notes.map((n) => <p key={n} className="text-[9.5px] leading-relaxed text-gray-500">{n}</p>)}
                            <p className="mt-2.5 text-center text-[9.5px] text-gray-500">The Salad &nbsp;·&nbsp; www.thesalad.in</p>
                          </div>

                          <Button
                            className="mt-4 h-10 w-full gap-2 rounded-lg bg-[#f97316] text-sm font-semibold text-white hover:bg-[#ea580c]"
                            onClick={() => printReceipt(receiptFor)}
                          >
                            <Printer className="h-4 w-4" />
                            Print / save as PDF
                          </Button>
                        </div>
                      </div>
                    )
                  })()}
                </DialogContent>
              </Dialog>

              {/* Cancel the linked subscription — confirmation with the exact
                  date access ends, never a bare native confirm(). */}
              <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel your subscription?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2 text-[13px] leading-relaxed">
                        <p>
                          The AutoPay mandate is cancelled with Razorpay today, so{' '}
                          <span className="font-semibold text-foreground">no further debits</span> happen.
                        </p>
                        <p>
                          You keep full access to {sub?.planName ?? 'your plan'} until{' '}
                          <span className="font-semibold text-foreground">{fmtDate(sub?.currentPeriodEnd, billingTimeZone)}</span>{' '}
                          — the period you have already paid for. Nothing is cut off early.
                        </p>
                        <p className="text-muted-foreground">
                          Razorpay cannot resume a cancelled mandate. To come back later, subscribe
                          again from the plans on the Billing tab — your data stays untouched either way.
                        </p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={cancelling}>Keep subscription</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault()
                        cancel()
                      }}
                      disabled={cancelling}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {cancelling ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                      Cancel on {fmtDate(sub?.currentPeriodEnd, billingTimeZone)}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              {/* Cancel a scheduled change — a mandate that has never charged,
                  so nothing paid for can be lost. */}
              <AlertDialog open={cancelScheduledFor !== null} onOpenChange={(open) => !open && setCancelScheduledFor(null)}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel this scheduled change?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2 text-[13px] leading-relaxed">
                        {cancelScheduledFor && (
                          <p>
                            <span className="font-semibold text-foreground">
                              {cancelScheduledFor.planName} ({intervalModeLabel(cancelScheduledFor.interval, cancelScheduledFor.paymentMode)})
                            </span>{' '}
                            is scheduled to start on {fmtDate(cancelScheduledFor.scheduledStartAt, billingTimeZone)}. Cancelling
                            revokes the authorised mandate with Razorpay — it will never debit.
                          </p>
                        )}
                        <p>
                          Your current plan is unchanged and keeps running normally. Nothing you have
                          already paid for is affected.
                        </p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={cancellingScheduled}>Keep it scheduled</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault()
                        cancelScheduled()
                      }}
                      disabled={cancellingScheduled}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      {cancellingScheduled ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                      Cancel scheduled change
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </TabsContent>
          )}

          {canViewReviews && (
          <TabsContent value="reviews" className="flex-1 mt-3 min-h-0">
            <div className="max-w-4xl space-y-4">
              {/* Header card — reviews come from our own diners, nothing to connect */}
              <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-amber-400/10 flex items-center justify-center shrink-0">
                      <Star className="w-6 h-6 fill-amber-400 text-amber-400" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold">Customer Reviews</h3>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        Diners rate their visit when their table session ends — the reviews land here.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 rounded-xl border border-border bg-secondary/30 px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {reviewsEnabled ? 'Collecting' : 'Paused'}
                    </span>
                    <Switch
                      checked={reviewsEnabled}
                      disabled={reviewsEnabledSaving || !canManageReviews}
                      title={!canManageReviews ? 'You do not have permission to manage orders' : undefined}
                      onCheckedChange={toggleReviewsEnabled}
                    />
                  </div>
                </div>
                {!reviewsEnabled && (
                  <p className="text-xs text-muted-foreground mt-3">
                    While paused, the session-end page shows no review form and new reviews are declined.
                  </p>
                )}
              </Card>

              {/* Rating overview */}
              <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-4">
                    <div className="text-center">
                      <p className="text-4xl font-bold text-gradient-primary">{avgRating}</p>
                      <div className="flex items-center gap-0.5 mt-1 justify-center">
                        {[1, 2, 3, 4, 5].map(n => (
                          <Star key={n} className={cn('h-3.5 w-3.5', n <= Math.round(parseFloat(avgRating)) ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30')} />
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{reviewStats.totalReviews} reviews</p>
                    </div>
                    <Separator orientation="vertical" className="h-20" />
                    <div className="flex-1 min-w-[180px] space-y-1">
                      {ratingDist.map(r => (
                        <div key={r.stars} className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground w-8">{r.stars}★</span>
                          <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                            <div className="h-full bg-amber-400 rounded-full" style={{ width: `${reviewStats.totalReviews ? (r.count / reviewStats.totalReviews) * 100 : 0}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground w-6 text-right">{r.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Reviews list */}
              <Card className="rounded-2xl bg-card border-border p-4 md:p-4 md:p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold">Recent Reviews</h3>
                    <Badge variant="secondary">{reviews.length}</Badge>
                  </div>
                </div>
                <div className="space-y-3 max-h-[500px] overflow-y-auto scrollbar-thin">
                  {reviewsLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="h-24 rounded-xl bg-secondary/30 animate-pulse" />
                      ))}
                    </div>
                  ) : reviews.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No reviews yet. When a diner rates their visit at the end of a table session, the review appears here.
                    </p>
                  ) : reviews.map((r) => (
                    <div key={r.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold shrink-0">
                            {r.authorName?.[0] || '?'}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {r.authorName || 'Anonymous'}
                              {r.tableName && (
                                <span className="font-normal text-muted-foreground"> · {r.tableName}{r.tableArea ? ` (${r.tableArea})` : ''}</span>
                              )}
                            </p>
                            <div className="flex items-center gap-1">
                              {[1, 2, 3, 4, 5].map(n => (
                                <Star key={n} className={cn('h-3 w-3', n <= r.rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30')} />
                              ))}
                              <span className="text-[10px] text-muted-foreground ml-1">
                                {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                      {r.comment && <p className="text-sm text-foreground/80 mb-2">{r.comment}</p>}
                      {r.tags && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {String(r.tags).split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string) => (
                            <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[10.5px] text-muted-foreground">{t}</span>
                          ))}
                        </div>
                      )}
                      {r.reply && (
                        <div className="rounded-lg bg-primary/5 border border-primary/10 p-2.5 mt-2">
                          <p className="text-[10px] font-semibold text-primary mb-0.5">OWNER REPLY</p>
                          {replyingTo === r.id ? (
                            <div className="space-y-2">
                              <Textarea
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value)}
                                placeholder="Edit your reply…"
                                rows={2}
                                className="bg-background/60 border-border text-sm resize-none"
                              />
                              <div className="flex justify-end gap-2">
                                <Button variant="ghost" size="sm" onClick={() => { setReplyingTo(null); setReplyText('') }}>Cancel</Button>
                                <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => handleReply(r.id)} disabled={!replyText.trim() || !canManageReviews} title={!canManageReviews ? 'You do not have permission to manage orders' : undefined}>
                                  <Send className="h-3 w-3 mr-1" /> Update Reply
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-xs text-foreground/80 whitespace-pre-wrap">{r.reply}</p>
                              {canManageReviews && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 mt-1 text-[11.5px] text-primary"
                                  onClick={() => { setReplyingTo(r.id); setReplyText(r.reply || '') }}
                                >
                                  Edit reply
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                      {!r.reply && (
                        <div className="mt-2">
                          {replyingTo === r.id ? (
                            <div className="space-y-2">
                              <Textarea
                                value={replyText}
                                onChange={(e) => setReplyText(e.target.value)}
                                placeholder="Write a reply…"
                                rows={2}
                                className="bg-secondary/50 border-border text-sm resize-none"
                              />
                              <div className="flex justify-end gap-2">
                                <Button variant="ghost" size="sm" onClick={() => { setReplyingTo(null); setReplyText('') }}>Cancel</Button>
                                <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => handleReply(r.id)} disabled={!replyText.trim() || !canManageReviews} title={!canManageReviews ? 'You do not have permission to manage orders' : undefined}>
                                  <Send className="h-3 w-3 mr-1" /> Post Reply
                                </Button>
                              </div>
                            </div>
                          ) : (
                            canManageReviews && (
                            <Button variant="outline" size="sm" onClick={() => { setReplyingTo(r.id); setReplyText('') }}>
                              <MessageSquare className="h-3.5 w-3.5 mr-1" /> Reply
                            </Button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </TabsContent>
          )}

          {canManageSettings && (
          <TabsContent value="danger" className="flex-1 mt-3 min-h-0">
              <div className="max-w-3xl space-y-4">
                <Card className="rounded-2xl bg-card border-destructive/40 p-4 md:p-4 md:p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <AlertTriangle className="h-5 w-5 text-destructive" />
                    <h3 className="font-semibold text-destructive">Danger Zone</h3>
                  </div>
                  <p className="text-sm text-muted-foreground mb-4">
                    These actions are permanent. Proceed with extreme caution.
                  </p>

                  <div className="space-y-3">
                    {/* Delete */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Trash2 className="h-4 w-4 text-destructive" />
                          <p className="text-sm font-medium">Delete Restaurant</p>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Permanently remove <strong className="text-foreground">{tenantForm.name || 'this restaurant'}</strong> and all related data. This cannot be undone.
                        </p>
                      </div>
                      <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} className="w-full sm:w-auto">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  </div>
                </Card>
              </div>
          </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Mobile sticky save bar */}
      <div className="md:hidden shrink-0 sticky bottom-0 z-10 border-t border-border bg-background/95 backdrop-blur p-3 flex items-center gap-2">
        {dirty && (
          <Button variant="ghost" onClick={discard} disabled={saving} className="flex-1">
            Discard
          </Button>
        )}
        <Button
          onClick={save}
          disabled={!dirty || saving || !canManageSettings}
          title={!canManageSettings ? 'You do not have permission to change settings' : undefined}
          className="bg-primary hover:bg-primary/90 flex-1"
        >
          {saving ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving…</> : <><Save className="h-4 w-4" /> Save Changes</>}
        </Button>
      </div>

      {/* Delete dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="bg-card border-destructive/40 max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete {tenantForm.name || 'restaurant'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all data including orders, menu items, reservations, and staff accounts. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              Type <span className="font-mono text-foreground">{tenantForm.name}</span> to confirm
            </Label>
            <Input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={tenantForm.name}
              className="bg-secondary/50 border-border"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirm('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleteConfirm !== tenantForm.name}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete Restaurant
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Field({
  label,
  icon,
  hint,
  children,
}: {
  label: string
  icon?: React.ReactNode
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
        {icon}
        {label}
        {hint && <span className="text-muted-foreground/70 font-normal">· {hint}</span>}
      </Label>
      {children}
    </div>
  )
}

function UsageStat({ label, value, limit }: { label: string; value: number; limit: number | null }) {
  // A null limit means the plan does not cap this — Pro has unlimited staff
  // and unlimited menu items — and dividing by it would be nonsense.
  const unlimited = limit === null || limit === undefined
  const pct = unlimited ? 0 : Math.min(100, Math.round((value / limit) * 100))
  const over = !unlimited && value >= limit
  return (
    <div className="rounded-xl border border-border bg-secondary/20 p-3.5">
      <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">
        {value}
        <span className="text-sm font-normal text-muted-foreground">
          {unlimited ? ' · unlimited' : ` / ${limit}`}
        </span>
      </p>
      {!unlimited && (
        <>
          <div className="mt-2.5 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn('h-full rounded-full', over ? 'bg-destructive' : 'bg-primary')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className={cn('text-xs mt-1.5', over ? 'text-destructive' : 'text-muted-foreground')}>
            {over ? 'Limit reached — upgrade plan' : `${pct}% used`}
          </p>
        </>
      )}
    </div>
  )
}

function ExpandCard({ icon, title, desc, open, onToggle, children }: {
  icon: React.ReactNode
  title: string
  desc: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <Card className={cn('rounded-2xl bg-card border-border overflow-hidden transition-all', open && 'border-primary/30')}>
      <button
        onClick={onToggle}
        className="flex items-center gap-3 w-full p-4 md:p-5 text-left hover:bg-secondary/30 transition-colors"
        aria-expanded={open}
      >
        <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/15 shrink-0">
          {icon}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold truncate">{title}</span>
          <span className="block text-xs text-muted-foreground truncate mt-0.5">{desc}</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      <div className={cn('overflow-hidden transition-all duration-200', open ? 'max-h-200 opacity-100' : 'max-h-0 opacity-0')}>
        <div className="px-4 md:px-5 pb-4 md:pb-5 pt-0 border-t border-border">
          {children}
        </div>
      </div>
    </Card>
  )
}

/**
 * The Manage Billing view.
 *
 * Everything on it comes from GET /api/subscriptions/manage, where the
 * server has verified every mandate and scheduled change against Razorpay
 * before answering. If that payload has not loaded, the view shows a
 * skeleton or an error with a retry — it never fills the gap with guesses,
 * because an unverified "upcoming debit" is worse than no answer.
 *
 * The subscription summary at the top is the *same component* the Billing tab
 * renders, from the same snapshot: plan, price, payment mode, start date, the
 * date the period ends and the renewal answer are the same values on both
 * pages by construction, not by two implementations agreeing today.
 */
function ManageBillingView(props: {
  snapshot: BillingSnapshot
  plan: BillingPlanFacts | null
  payments: BillingPayment[]
  restaurant: { name: string | null; email: string | null }
  timeZone: string
  directory: PlanDirectory
  manage: ManagePayload | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onBack: () => void
  onCancelSubscription: () => void
  cancelling: boolean
  onCancelScheduled: (change: ScheduledChange) => void
  onBrowsePlans: () => void
  onDownload: (p: BillingPayment, kind?: 'invoice' | 'refund') => void
  onReceipt: (p: BillingPayment) => void
  invoiceBusy: string | null
}) {
  const {
    snapshot, plan, payments, restaurant, timeZone, directory, manage, loading, error,
    onRetry, onBack, onCancelSubscription, cancelling, onCancelScheduled,
    onBrowsePlans, onDownload, onReceipt, invoiceBusy,
  } = props

  const d = (iso: string | null | undefined) => fmtDate(iso, timeZone)

  return (
    <div className="max-w-4xl space-y-4 md:space-y-6">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Billing
        </button>
        <Button variant="outline" size="sm" onClick={onRetry} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Refresh
        </Button>
      </div>
      <div>
        <h2 className="text-lg font-bold tracking-tight">Manage Billing</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your subscription, mandates, scheduled changes and invoices. Mandate and schedule details
          are verified with Razorpay when this page loads.
        </p>
      </div>

      {/* load error — retryable, and nothing made-up is shown instead */}
      {error && !loading && (
        <Card className="rounded-2xl border-destructive/30 bg-destructive/5 p-4 md:p-6">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Could not load your subscription details</p>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{error}</p>
              <Button size="sm" variant="outline" className="mt-2.5" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* first load */}
      {loading && !manage && !error && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 rounded-2xl bg-secondary/30 animate-pulse" />
          ))}
        </div>
      )}

      {/* The summary is shown even when the verified payload failed: the plan
          in force is known from /subscriptions/state, and hiding the whole
          page because one call failed is how an owner ends up with no idea
          what they are paying for. The renewal line says it is unconfirmed. */}
      {!manage && !loading && (
        <BillingCard>
          <BillingSummary
            snapshot={snapshot}
            plan={plan}
            heading="Current subscription"
            icon={<CreditCard className="size-4" />}
            renewalState="failed"
          />
        </BillingCard>
      )}

      {manage && (
        <div className="space-y-4 md:space-y-6">
          {/* anything Razorpay could not confirm is said out loud, not hidden */}
          {manage.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-200/70 bg-amber-50/70 p-3.5 dark:border-amber-500/25 dark:bg-amber-500/10">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div className="text-[13px] leading-relaxed text-amber-900 dark:text-amber-200">
                  <p className="font-semibold">Some records could not be confirmed with Razorpay</p>
                  <p className="mt-0.5 text-amber-800/90 dark:text-amber-300/80">
                    Only verified information is shown below.
                  </p>
                  <ul className="mt-1.5 list-disc pl-4 text-[12px] text-amber-800/90 dark:text-amber-300/80">
                    {manage.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* ---- current subscription — the Billing tab's own summary ---- */}
          <BillingCard>
            <BillingSummary
              snapshot={snapshot}
              plan={plan}
              heading="Current subscription"
              icon={<CreditCard className="size-4" />}
              actions={
                <>
                  {plan?.isPaid && plan.billingMode !== 'onetime' && plan.paymentMode !== 'pay_once' && !plan.cancelAtPeriodEnd && plan.status !== 'past_due' && (
                    <Button variant="outline" size="sm" onClick={onCancelSubscription} disabled={cancelling}>
                      {cancelling ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                      Cancel subscription
                    </Button>
                  )}
                  {plan?.isRestricted && (
                    <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={onBrowsePlans}>
                      Subscribe again
                    </Button>
                  )}
                </>
              }
            />
            {plan?.cancelAtPeriodEnd && (
              <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                Cancellation takes effect on {d(plan.currentPeriodEnd)}. Razorpay cannot resume a
                cancelled mandate — you can subscribe again from the Billing tab any time.
              </p>
            )}
          </BillingCard>

          {/* ---- upcoming billing ---- */}
          <BillingCard>
            <BillingSectionHead icon={<CalendarClock className="size-4" />} title="Upcoming billing" />
            {manage.upcoming.length === 0 ? (
              <BillingEmpty
                icon={<CalendarClock className="size-4" />}
                title="Nothing is scheduled"
                hint="No upcoming debits, starts or renewals."
              />
            ) : (
              <div className="space-y-2">
                {manage.upcoming.map((item, i) => {
                  const tone =
                    item.kind === 'debit' ? 'warn' : item.kind === 'end' ? 'danger' : item.kind === 'renewal-due' ? 'info' : 'neutral'
                  return (
                    <BillingRow
                      key={i}
                      tone={tone}
                      icon={
                        item.kind === 'debit' ? <Wallet className="size-4" /> :
                        item.kind === 'end' ? <ClockIcon className="size-4" /> :
                        item.kind === 'renewal-due' ? <RotateCcw className="size-4" /> :
                        <CalendarClock className="size-4" />
                      }
                      title={item.label}
                      meta={item.date ? d(item.date) : 'Date to be confirmed'}
                      trailing={
                        item.amount !== null ? (
                          <p className="text-[13px] font-semibold">{money(item.currency, item.amount)}</p>
                        ) : item.kind === 'end' ? (
                          <StatusPill tone="warn" label="access ends" />
                        ) : undefined
                      }
                    />
                  )
                })}
              </div>
            )}
          </BillingCard>

          {/* ---- the live AutoPay mandate ---- */}
          {manage.mandate && (
            <BillingCard>
              <BillingSectionHead
                icon={<ShieldCheck className="size-4" />}
                title="AutoPay mandate"
                extra={
                  <span className="ml-auto">
                    <StatusPill tone={mandateTone(manage.mandate)} label={mandateStateLabel(manage.mandate)} />
                  </span>
                }
              />
              <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <BillingFact label="Authorisation" value={manage.mandate.status} title={`Razorpay status: ${manage.mandate.status}`} />
                <BillingFact label="Next debit" value={d(manage.mandate.currentPeriodEnd)} />
                <BillingFact
                  label="Charges made"
                  value={
                    manage.mandate.chargesMade !== null && manage.mandate.totalCycles !== null
                      ? `${manage.mandate.chargesMade} of ${manage.mandate.totalCycles}`
                      : '—'
                  }
                />
                <BillingFact label="Mandate ends" value={d(manage.mandate.endAt)} />
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Razorpay subscription <span className="font-mono">{manage.mandate.subscriptionId}</span> · verified
                live with Razorpay when this page loaded.
              </p>
            </BillingCard>
          )}

          {/* ---- scheduled changes (verified) ---- */}
          {manage.scheduledChanges.length > 0 && (
            <BillingCard>
              <BillingSectionHead
                icon={<CalendarClock className="size-4" />}
                title="Scheduled changes"
                extra={<Badge variant="secondary" className="text-[10px]">{manage.scheduledChanges.length}</Badge>}
              />
              <div className="space-y-2">
                {manage.scheduledChanges.map((change) => (
                  <BillingRow
                    key={change.checkoutId}
                    tone="info"
                    icon={<CalendarClock className="size-4" />}
                    title={`${change.planName} · ${intervalModeLabel(change.interval, change.paymentMode)}`}
                    meta={
                      <>
                        Starts {d(change.scheduledStartAt)} · first debit {money(change.currency, change.amount)} on that
                        date — nothing before it
                        {change.mandateId && (
                          <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted-foreground/80">
                            {change.mandateId}
                          </span>
                        )}
                      </>
                    }
                    trailing={
                      <>
                        <StatusPill tone={mandateTone(change)} label={mandateStateLabel(change)} />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-[12px]"
                          onClick={() => onCancelScheduled(change)}
                        >
                          Cancel
                        </Button>
                      </>
                    }
                  />
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                A scheduled change is an authorised mandate, not a payment: it activates only when its
                first charge succeeds on the start date, and the plan switches at that moment — never before.
              </p>
            </BillingCard>
          )}

          {/* ---- plan history ---- */}
          <BillingCard>
            <BillingSectionHead icon={<History className="size-4" />} title="Plan history" />
            {manage.history.length === 0 ? (
              <BillingEmpty icon={<History className="size-4" />} title="No plan changes yet" />
            ) : (
              <div className="space-y-2">
                {manage.history.map((h) => (
                  <BillingRow
                    key={h.id}
                    icon={<History className="size-4" />}
                    title={
                      <>
                        {changeLabel(h.changeType)}
                        {h.newPlanName ? ` · ${h.newPlanName}` : ''}
                      </>
                    }
                    meta={
                      <>
                        {d(h.createdAt)}
                        {h.oldPlanName && h.newPlanName && h.oldPlanName !== h.newPlanName
                          ? ` · ${h.oldPlanName} → ${h.newPlanName}`
                          : ''}
                      </>
                    }
                    trailing={
                      h.amountPaid !== null ? (
                        <p className="text-[13px] font-semibold">{money(manage.totals.currency, h.amountPaid)}</p>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </BillingCard>

          {/* ---- total spending ---- */}
          <BillingCard>
            <BillingSectionHead
              icon={<Wallet className="size-4" />}
              title="Total spending"
              extra={
                <span className="ml-auto text-[12px] text-muted-foreground">
                  across {manage.totals.paymentCount} payment{manage.totals.paymentCount === 1 ? '' : 's'}
                </span>
              }
            />
            <div className="grid grid-cols-3 gap-2.5">
              <BillingFact label="Total spent" value={money(manage.totals.currency, manage.totals.netSpent)} />
              <BillingFact label="Charged" value={money(manage.totals.currency, manage.totals.totalCharged)} />
              <BillingFact label="Refunded" value={money(manage.totals.currency, manage.totals.totalRefunded)} />
            </div>
          </BillingCard>

          {/* ---- payment history & invoices ---- */}
          <BillingCard>
            <BillingSectionHead
              icon={<Receipt className="size-4" />}
              title="Payment history & invoices"
              extra={
                payments.length > 0 ? <Badge variant="secondary" className="text-[10px]">{payments.length}</Badge> : undefined
              }
            />
            {payments.length === 0 ? (
              <BillingEmpty
                icon={<Receipt className="size-4" />}
                title="No payments yet"
                hint="When you pay for a plan, the receipt appears here."
              />
            ) : (
              <PaymentHistoryRows
                payments={payments}
                directory={directory}
                timeZone={timeZone}
                invoiceBusy={invoiceBusy}
                onDownload={onDownload}
                onReceipt={onReceipt}
              />
            )}
          </BillingCard>

          {/* ---- how billing behaves ---- */}
          <BillingCard>
            <BillingSectionHead icon={<ShieldCheck className="size-4" />} title="How billing works" />
            <ul className="list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-muted-foreground">
              <li>A plan activates only after a payment is verified — an authorised mandate is never a payment.</li>
              <li>Scheduled changes start on their date, never before; cancelling one never touches the current plan.</li>
              <li>Cancelling a subscription stops future debits; access continues until the paid period ends.</li>
              <li>AutoPay is shown only when Razorpay confirms a live mandate on this subscription.</li>
              <li>Invoices are issued when a payment is verified and can be re-downloaded any time — they never change.</li>
            </ul>
          </BillingCard>

          <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
            <CreditCard className="mt-0.5 size-3.5 shrink-0" />
            Payments are handled by Razorpay on their own secure checkout for {restaurant.name ?? 'your restaurant'}.
            This page never sees your card details, and a plan is only activated after the server has checked the
            payment signature.
          </p>
        </div>
      )}
    </div>
  )
}
