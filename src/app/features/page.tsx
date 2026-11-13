import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { LandingFooter, LandingNav } from '@/components/landing/landing-page'

const TITLE = 'Restaurant Software Features'
const DESCRIPTION =
  'QR table ordering, POS and billing, a kitchen display system, GST billing and analytics — what each part of The Salad does, and how they run as one product.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/features' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

const PAGES = [
  {
    href: '/features/qr-ordering',
    title: 'QR code ordering',
    body: 'A QR code on every table. Guests scan, browse and order from their own phone — no app, no signup.',
  },
  {
    href: '/features/pos-billing',
    title: 'POS & billing',
    body: 'A live menu grid, dine-in, takeaway and delivery, and a bill built from your own tax settings.',
  },
  {
    href: '/features/kitchen-display',
    title: 'Kitchen display system',
    body: 'Every ticket from pending to served, moving the moment the kitchen moves it.',
  },
  {
    href: '/features/gst-billing',
    title: 'GST billing',
    body: 'Your GSTIN, FSSAI number, tax rate and service charge on every bill, set once in settings.',
  },
  {
    href: '/features/analytics',
    title: 'Analytics',
    body: 'Revenue, average order value and top sellers, counted from the orders as they happen.',
  },
]

export default function FeaturesIndexPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-32 h-[360px]">
            <div className="absolute left-1/2 h-[360px] w-[640px] -translate-x-1/2 rounded-full bg-primary/[0.10] blur-[120px]" />
          </div>
          <div className="relative mx-auto max-w-6xl px-5 pt-10 pb-12 sm:px-8 sm:pt-14 sm:pb-16">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary">Features</p>
            <h1 className="max-w-3xl text-balance text-[1.9rem] font-semibold leading-[1.12] tracking-tight sm:text-[2.6rem]">
              What The Salad does, part by part
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
              One product, five parts that share the same orders. Each page below explains what that part does
              on its own, and what it hands to the next one.
            </p>
          </div>
        </section>

        <section className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PAGES.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  className="group rounded-xl border border-white/[0.08] bg-white/[0.015] p-5 transition-premium hover:border-white/15 hover:bg-white/[0.03]"
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {page.title}
                    <ArrowRight className="size-3.5 text-primary transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-2 block text-[13px] leading-relaxed text-muted-foreground">
                    {page.body}
                  </span>
                </Link>
              ))}
              <Link
                href="/compare/petpooja-alternative"
                className="group rounded-xl border border-primary/25 bg-primary/[0.04] p-5 transition-premium hover:border-primary/40"
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  Comparing with Petpooja?
                  <ArrowRight className="size-3.5 text-primary transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-2 block text-[13px] leading-relaxed text-muted-foreground">
                  What to compare before you commit, and where we differ honestly.
                </span>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  )
}
