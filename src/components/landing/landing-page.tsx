'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, Check, QrCode, BarChart3, Users, Smartphone, Receipt, ScanLine, TrendingUp } from 'lucide-react'
import { edgeFetch } from '@/lib/edge'
import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { cn } from '@/lib/utils'
import { CookieSettingsButton } from '@/components/shared/cookie-consent'
import {
  type BillingInterval,
  annualSavings,
  priceFor,
  rememberPlanIntent,
} from '@/lib/pricing'

function startOnboarding(planId?: string, interval?: BillingInterval) {
  // Carry the choice through sign-in and onboarding: billing reads it once and
  // preselects the plan and interval the visitor actually looked at.
  if (planId && interval) rememberPlanIntent(planId, interval)
  window.location.href = '/?view=login&mode=register'
}

function goToLogin() {
  window.location.href = '/?view=login'
}

/**
 * The businesses The Salad runs: one word at a time, sliding up through the
 * headline in the brand orange.
 *
 * Two things make this safe to animate inside a headline.
 *
 * The words share a single grid cell, so the container is always as wide and
 * as tall as the *longest* word. Nothing reflows as the word changes — the
 * line break above it does not move, and each word carries its own full stop
 * so the punctuation hugs the word instead of floating at a fixed gap.
 *
 * The heading keeps a plain, stable accessible name: the moving words are
 * hidden from assistive tech and the `h1` carries the sentence as text, so a
 * screen reader reads a headline rather than a list of venue types. Under
 * `prefers-reduced-motion` the rotation stops entirely and the first word
 * stays put.
 */
const HERO_WORDS = ['Restaurants.', 'Cafés.', 'Bistros.', 'Bakeries.', 'Hotels.', 'Resorts.', 'Food Courts.', 'Cloud Kitchen.'] as const;
const HERO_WORD_MS = 2000;

function RotatingWord() {
  const [active, setActive] = useState(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setStill(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => {
      // A hidden tab does not need to animate; skipping the tick there keeps
      // the rotation in step with what the reader actually sees.
      if (document.visibilityState === 'hidden') return;
      setActive((i) => (i + 1) % HERO_WORDS.length);
    }, HERO_WORD_MS);
    return () => clearInterval(timer);
  }, [still]);

  return (
    // `items-baseline` keeps the box's baseline at the text's, not at the
    // grid row's bottom edge (grid items stretch by default, and a stretched
    // row would float the word up inside the line). That matters even on a
    // line of its own: aligned this way the box's baseline sits where the
    // strut's does, and the line starts exactly where the previous line ends,
    // so this line keeps the heading's rhythm even though it is a touch
    // taller than the two static lines above it.
    //
    // The words run at 1.3× the heading size. Em sizing scales both
    // breakpoints from one place, and the line-height stays at the heading's
    // 1.1 so the glyphs keep comfortable clearance inside the clip window.
    //
    // The box is already as wide as the longest word, so nothing overflows
    // horizontally; `overflow-hidden` only ever clips the word sliding in from
    // below and out above.
    // The words are centred inside the box reserved for the longest one, so a
    // short word like "Cafés" sits symmetrically under "Restaurants" rather
    // than hanging off its left edge. The box itself never changes size, so
    // centring costs nothing in layout stability — only the ink inside moves.
    <span
      data-hero-rotator
      className="relative inline-grid items-baseline justify-items-center overflow-hidden align-baseline text-center text-primary"
      // One line tall: the grid's height is its tallest child, and every child
      // is a single line at the heading's line-height multiplier.
      style={{ lineHeight: 'inherit', fontSize: '1.3em' }}
    >
      {HERO_WORDS.map((word, i) => {
        // Offsets carry the slide: the word below waits at the bottom, the one
        // that left has moved up and out of view.
        const offset = i === active ? '0%' : i < active ? '-100%' : '100%';
        return (
          <span
            key={word}
            aria-hidden="true"
            className={cn(
              'col-start-1 row-start-1 whitespace-nowrap transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none',
              i === active ? 'opacity-100' : 'opacity-0',
            )}
            style={still ? undefined : { transform: `translateY(${offset})` }}
          >
            {word}
          </span>
        );
      })}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Primitives                                                                 */
/* -------------------------------------------------------------------------- */

function PrimaryCta({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <Button
      size="lg"
      onClick={onClick ?? (() => startOnboarding())}
      className={cn(
        'h-11 rounded-xl px-6 text-sm font-semibold',
        'bg-primary text-primary-foreground transition-premium',
        'hover:bg-[#ea580c] hover:-translate-y-px',
        className,
      )}
    >
      {children}
    </Button>
  )
}

function GhostCta({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <Button
      variant="outline"
      size="lg"
      onClick={onClick ?? goToLogin}
      className="h-11 rounded-xl border-white/12 bg-transparent px-6 text-sm font-semibold text-foreground transition-premium hover:bg-white/5"
    >
      {children}
    </Button>
  )
}

/** Small caps label above a section heading. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary">{children}</p>
  )
}

/** A real screenshot in a browser chrome. */
export function BrowserFrame({ src, alt, className, priority }: { src: string; alt: string; className?: string; priority?: boolean }) {
  return (
    <div className={cn('overflow-hidden rounded-xl border border-white/10 bg-[#0d1017] shadow-2xl shadow-black/50', className)}>
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/[0.03] px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
      </div>
      <img src={src} alt={alt} width={1600} height={800} loading={priority ? 'eager' : 'lazy'} className="block w-full" />
    </div>
  )
}

export function PhoneFrame({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-[1.75rem] border border-white/12 bg-[#0d1017] p-1.5 shadow-2xl shadow-black/60', className)}>
      <img src={src} alt={alt} width={780} height={1688} loading="lazy" className="block w-full rounded-[1.35rem]" />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Nav                                                                        */
/* -------------------------------------------------------------------------- */

export function LandingNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            S
          </div>
          <span className="text-[15px] font-semibold tracking-tight">The Salad</span>
        </a>

        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="/features" className="transition-colors hover:text-foreground">Product</a>
          <a href="/#pricing" className="transition-colors hover:text-foreground">Pricing</a>
          <a href="/#faq" className="transition-colors hover:text-foreground">FAQ</a>
        </nav>

        <div className="flex items-center gap-2">
          <button onClick={goToLogin} className="hidden px-3 text-sm text-muted-foreground transition-colors hover:text-foreground sm:block">
            Sign in
          </button>
          <PrimaryCta className="h-9 px-4 text-[13px]">
            Get started
            <ArrowUpRight className="ml-1 size-3.5" />
          </PrimaryCta>
        </div>
      </div>
    </header>
  )
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                       */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-32 h-[420px]">
        <div className="absolute left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-primary/[0.13] blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-6xl px-5 pt-20 pb-20 sm:px-8 sm:pt-28 sm:pb-28">
        <div className="mx-auto max-w-2xl text-center">
          <h1
            className="text-balance text-[2.1rem] font-semibold leading-[1.1] tracking-tight sm:text-[3.25rem]"
            // A stable name for assistive tech: the visible words move, the
            // headline does not.
            aria-label="Powering the Next Generation of Restaurants."
          >
            <span aria-hidden="true" className="block">
              Powering the Next
            </span>
            <span aria-hidden="true" className="block">
              Generation of
            </span>
            <RotatingWord />
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-balance text-base leading-relaxed text-muted-foreground">
            Create a new experience for modern dining and hospitality. Simplify
            operations, delight customers, and grow your business with one
            intelligent platform. 14-Day Free Trial · No Credit Card Required
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <PrimaryCta>
              Create your restaurant
              <ArrowRight className="ml-1.5 size-4" />
            </PrimaryCta>
            <GhostCta>See a demo</GhostCta>
          </div>
        </div>

        <div className="relative mx-auto mt-16 max-w-5xl">
          <BrowserFrame
            src="/screenshots/dashboard.webp"
            alt="The Salad point-of-sale dashboard with a live menu grid and active orders"
            priority
          />
          <PhoneFrame
            src="/screenshots/mobile-menu.webp"
            alt="The diner-facing menu on a phone"
            className="absolute -bottom-10 -left-2 hidden w-[150px] sm:block lg:-left-12 lg:w-[172px]"
          />
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Features                                                                   */
/* -------------------------------------------------------------------------- */

const FEATURES = [
  {
    icon: QrCode,
    title: 'QR table ordering',
    body: 'A QR code menu on every table. Diners scan, browse and order from their own phone — no app to install, no account to make.',
  },
  {
    icon: BarChart3,
    title: 'Live order board',
    body: 'Your kitchen display system: every ticket from prep to served, moving the moment the kitchen does.',
  },
  {
    icon: Receipt,
    title: 'GST-ready billing',
    body: 'Set your tax rate, service charge, GSTIN and FSSAI once. Every bill is calculated and printed from them — no calculator at the counter.',
  },
  {
    icon: ScanLine,
    title: 'AI menu scanning',
    body: 'Photograph your printed menu and The Salad extracts the items and prices for you. The slowest part of setup, gone.',
  },
  {
    icon: TrendingUp,
    title: 'Sales analytics',
    body: 'Revenue, average order value and top sellers, from real orders as they happen — not from end-of-day exports.',
  },
  {
    icon: Users,
    title: 'Staff roles & permissions',
    body: 'Waiters, cashiers and kitchen each see only what their role allows — enforced server-side.',
  },
]

function Features() {
  return (
    <section id="product" className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="max-w-lg">
          <Eyebrow>The product</Eyebrow>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Everything the floor needs, nothing it doesn&apos;t
          </h2>
        </div>

        <div className="mt-14 grid gap-12 sm:grid-cols-3 sm:gap-10">
          {FEATURES.map((f) => (
            <div key={f.title}>
              <f.icon className="size-5 text-primary" strokeWidth={1.75} />
              <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Showcase — two real screens, nothing else                                  */
/* -------------------------------------------------------------------------- */

function Showcase() {
  return (
    <section className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="max-w-lg">
          <Eyebrow>Full house</Eyebrow>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Run the night without standing in it
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Whoever&apos;s on the floor, the orders still reach the kitchen and
            the bills still come out right — and you can see all of it from
            anywhere.
          </p>
        </div>

        <div className="mt-12 grid gap-8 lg:grid-cols-5 lg:gap-10">
          <div className="lg:col-span-3">
            <BrowserFrame src="/screenshots/orders.webp" alt="The Salad kitchen display system showing live order tickets" />
            <p className="mt-4 text-sm text-muted-foreground">
              The kitchen order board — every table, updating as tickets move.
            </p>
          </div>
          <div className="lg:col-span-2">
            <BrowserFrame src="/screenshots/analytics.webp" alt="The Salad restaurant analytics dashboard with revenue and top sellers" />
            <p className="mt-4 text-sm text-muted-foreground">
              Restaurant analytics: revenue, average order value and top sellers, from real orders.
            </p>
          </div>
        </div>

      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  QR ordering — the diner's side                                            */
/* -------------------------------------------------------------------------- */

function QrOrdering() {
  return (
    <section className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <Eyebrow>For your guests</Eyebrow>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              QR code menu ordering for your tables
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Every table gets its own QR code. Guests scan it, your digital menu
              opens in their phone&apos;s browser — no app, no signup — and each
              order reaches your kitchen display system exactly as placed.
              Prices, GST and totals are computed on your server, so every bill
              comes out right.
            </p>
            <ul className="mt-7 space-y-3">
              {[
                'QR menu updates in real time — change a price once, every table sees it',
                'Allergies and spice level travel with the order',
                'A table session ends with the meal — only a fresh scan reopens it',
              ].map((line) => (
                <li key={line} className="flex gap-3 text-sm text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-center gap-6">
            <PhoneFrame src="/screenshots/mobile-menu.webp" alt="The Salad QR code digital menu on a diner's phone" className="w-[160px] sm:w-[190px]" />
            <PhoneFrame src="/screenshots/mobile-cart.webp" alt="Diner's cart on the The Salad QR menu with server-calculated totals" className="mt-12 w-[160px] sm:w-[190px]" />
          </div>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pricing                                                                    */
/* -------------------------------------------------------------------------- */

type MarketingPlan = {
  id: string
  name: string
  description: string | null
  priceMonthly: number
  priceYearly: number | null
  currency: string
  features: string[]
  popular: boolean
}

/**
 * The pricing, if the catalogue cannot be reached.
 *
 * The real list comes from the plan catalogue, which is the only copy — the
 * landing page and the billing tab used to have their own, and they
 * disagreed with each other and with the catalogue. This is only here so a
 * failed request leaves a sensible page rather than an empty one, and it
 * matches the catalogue.
 */
const FALLBACK_PLANS: MarketingPlan[] = [
  {
    id: 'starter',
    name: 'Starter',
    description: 'One location, getting started',
    priceMonthly: 999,
    priceYearly: 9990,
    currency: 'INR',
    features: [
      'AI menu scanning with instant extraction',
      'QR ordering',
      'Kitchen display',
      'Up to 100 menu items',
      '1 restaurant location',
      'Up to 5 staff members with roles',
      'Advanced analytics',
      'Email support',
    ],
    popular: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'Busy restaurants that need everything',
    priceMonthly: 2499,
    priceYearly: 24990,
    currency: 'INR',
    features: [
      'AI menu scanning with instant extraction',
      'QR ordering',
      'Kitchen display',
      'Up to 200 menu items',
      'Up to 3 restaurant locations',
      'Up to 10 staff members with roles',
      'Advanced analytics with multi-location insights and consolidated reporting',
      'Priority support',
    ],
    popular: true,
  },
]

function Pricing() {
  const [plans, setPlans] = useState<MarketingPlan[]>(FALLBACK_PLANS)
  const [interval, setInterval] = useState<BillingInterval>('monthly')

  // The plan catalogue is the only copy of the pricing. The fallback above is
  // only used if the request fails, so the page never renders empty.
  useEffect(() => {
    let cancelled = false
    edgeFetch('/api/plans')
      .then((res) => res.json())
      .then((body: { plans?: MarketingPlan[] }) => {
        if (cancelled) return
        if (Array.isArray(body?.plans) && body.plans.length) {
          setPlans(body.plans)
        }
      })
      .catch(() => {
        /* the fallback is already in place */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section id="pricing" className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="max-w-lg">
          <Eyebrow>Pricing</Eyebrow>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Simple, per-restaurant pricing
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            ₹999 a month, about ₹33 a day. Less than a cup of chai to run the
            whole restaurant.
          </p>
        </div>

        {/* Monthly / Annually. Monthly is the default — the smaller number is
            the honest first impression — and annual shows what it saves. */}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Billing period"
            className="inline-flex rounded-xl border border-white/[0.08] bg-white/[0.02] p-1"
          >
            {(['monthly', 'annual'] as const).map((key) => {
              const active = interval === key
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setInterval(key)}
                  className={cn(
                    'rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {key === 'monthly' ? 'Monthly' : 'Annually'}
                </button>
              )
            })}
          </div>
          {interval === 'annual' ? (
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11.5px] font-medium text-emerald-500">
              You are saving 16.7% with annual billing
            </span>
          ) : (
            <span className="text-[12.5px] text-muted-foreground">
              Save 16.7% with annual billing
            </span>
          )}
        </div>

        <div
          className={cn(
            'mt-12 grid gap-6',
            // Three columns on a wide screen, two when there is room for them,
            // and one on a phone. `sm:grid-cols-2` is what makes the second
            // row a single card that spans the width, rather than a card
            // squeezed into a column.
            plans.length > 2 ? 'lg:grid-cols-3' : 'sm:grid-cols-2',
          )}
        >
          {plans.map((plan) => {
            const amount = priceFor(plan, interval)
            const savings = annualSavings(plan)
            const price = amount
              ? plan.currency === 'INR'
                ? `\u20b9${amount.toLocaleString('en-IN')}`
                : `${plan.currency} ${amount.toLocaleString('en-IN')}`
              : 'Custom'
            const period = amount ? (interval === 'annual' ? '/yr' : '/mo') : ''
            return (
              <div
                key={plan.id}
                className={cn(
                  'flex flex-col rounded-2xl border p-5 sm:p-6 lg:p-7',
                  plan.popular ? 'border-primary/40 bg-primary/[0.04]' : 'border-white/[0.08] bg-white/[0.015]',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{plan.name}</h3>
                  {plan.popular && (
                    <span className="shrink-0 rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-medium text-primary">
                      Most popular
                    </span>
                  )}
                </div>
                <div className="mt-5 flex flex-wrap items-baseline gap-1">
                  <span className="text-3xl font-semibold tracking-tight">{price}</span>
                  {period && <span className="text-sm text-muted-foreground">{period}</span>}
                </div>
                {interval === 'annual' && savings && (
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {plan.currency === 'INR' ? `\u20b9${savings.amount.toLocaleString('en-IN')}` : `${plan.currency} ${savings.amount}`} saved
                    a year · billed annually
                  </p>
                )}
                {interval === 'monthly' && (
                  <p className="mt-1 text-[12px] text-muted-foreground">billed monthly</p>
                )}
                {plan.description && (
                  <p className="mt-2 text-xs text-muted-foreground">{plan.description}</p>
                )}

                <ul className="mt-6 flex-1 space-y-2.5">
                  {plan.features.map((f) => (
                    <li key={f} className="flex gap-2.5 text-sm text-muted-foreground">
                      <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <PrimaryCta
                  className={cn('mt-8 w-full', !plan.popular && 'bg-white/10 text-foreground hover:bg-white/15 hover:text-foreground')}
                  onClick={() => startOnboarding(plan.id, interval)}
                >
                  {price === 'Custom' ? 'Contact us' : 'Start free'}
                </PrimaryCta>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  FAQ                                                                        */
/* -------------------------------------------------------------------------- */

const FAQS = [
  {
    q: 'What is a QR code ordering system?',
    a: 'The menu lives behind a QR code on each table. Diners scan it, browse and order from their own phone, and the order lands on your kitchen board — no app, no printed menus, no waiter running back and forth.',
  },
  {
    q: 'Do my customers need to download an app?',
    a: 'No. They scan the QR code on the table and the menu opens in their phone browser. No app, no account.',
  },
  {
    q: 'What happens when a table session ends?',
    a: 'The session is closed for good. Refreshing, pressing back or reopening a copied link will not bring the menu back — only scanning the table QR code again starts a new one.',
  },
  {
    q: 'Does it handle GST and service charge?',
    a: 'Yes. Set your tax rate, service charge, GSTIN and FSSAI once in settings, and every bill is calculated and printed from them.',
  },
  {
    q: 'How much does restaurant POS software cost in India?',
    a: 'The Salad starts at ₹999 per month per restaurant; busy restaurants that need everything pay ₹2,499. Plans are billed per restaurant, and you can try it free without a card.',
  },
  {
    q: 'Does it work for a small café or a single outlet?',
    a: 'Yes. The Starter plan covers one location with up to 100 menu items and 5 staff members — most cafés and single outlets, end to end.',
  },
  {
    q: 'Can I control what each staff member sees?',
    a: 'Yes. Roles decide which modules a staff member can open, and that is enforced at the API — not just hidden in the interface.',
  },
  {
    q: 'How long does setup take?',
    a: 'Most restaurants are taking orders within a few minutes: add your menu, print the QR codes, done.',
  },
]

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQS.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
}

function Faq() {
  return (
    <section id="faq" className="border-t border-white/[0.06]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
          <div>
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Frequently asked questions</h2>
          </div>
          <Accordion type="single" collapsible className="w-full">
            {FAQS.map((f, i) => (
              <AccordionItem key={f.q} value={`item-${i}`} className="border-white/[0.08]">
                <AccordionTrigger className="text-left text-sm font-medium hover:no-underline">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Final CTA + footer                                                         */
/* -------------------------------------------------------------------------- */

function FinalCta() {
  return (
    <section className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-5 py-24 text-center sm:px-8 sm:py-28">
        <h2 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          Start taking orders today
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
          Free to try. No card required.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PrimaryCta>
            Create your restaurant
            <ArrowRight className="ml-1.5 size-4" />
          </PrimaryCta>
          <GhostCta>Sign in</GhostCta>
        </div>
      </div>
    </section>
  )
}

export function LandingFooter() {
  return (
    <footer className="border-t border-white/[0.06]">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-5 py-9 sm:flex-row sm:px-8">
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
            S
          </div>
          <span className="text-sm text-muted-foreground">The Salad</span>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <Link href="/features/qr-ordering" className="transition-colors hover:text-foreground">QR Ordering</Link>
          <Link href="/features/pos-billing" className="transition-colors hover:text-foreground">POS Billing</Link>
          <Link href="/features/kitchen-display" className="transition-colors hover:text-foreground">Kitchen Display</Link>
          <Link href="/features/gst-billing" className="transition-colors hover:text-foreground">GST Billing</Link>
          <Link href="/features/analytics" className="transition-colors hover:text-foreground">Analytics</Link>
          <Link href="/#pricing" className="transition-colors hover:text-foreground">Pricing</Link>
          <Link href="/#faq" className="transition-colors hover:text-foreground">FAQ</Link>
          <span className="hidden items-center gap-1.5 sm:inline-flex">
            <Smartphone className="size-3.5" />
            No app needed
          </span>
        </div>
      </div>

      {/* The policies and the way to reach us. Kept on their own row so the
          links above stay where they are, and wrapped so a phone can read them
          without a second column. */}
      <div className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 px-5 py-5 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:gap-6 sm:px-8">
          <span className="order-2 text-center sm:order-1 sm:text-left">
            © {new Date().getFullYear()} The Salad · All rights reserved
          </span>
          <nav
            aria-label="Legal"
            className="order-1 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 sm:order-2 sm:justify-end"
          >
            <Link href="/privacy" className="transition-colors hover:text-foreground">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">
              Terms &amp; Conditions
            </Link>
            <Link href="/cookies" className="transition-colors hover:text-foreground">
              Cookie Policy
            </Link>
            <Link href="/contact" className="transition-colors hover:text-foreground">
              Contact Us
            </Link>
            {/* A way back to the banner, for anyone who wants to change the
                choice they made. */}
            <CookieSettingsButton />
          </nav>
        </div>
      </div>
    </footer>
  )
}

/* -------------------------------------------------------------------------- */

export function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main>
        <Hero />
        <Features />
        <Showcase />
        <QrOrdering />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  )
}
