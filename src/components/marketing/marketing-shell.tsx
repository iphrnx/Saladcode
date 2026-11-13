import Link from 'next/link'
import { ArrowRight, ArrowLeft } from 'lucide-react'
import { LandingFooter, LandingNav } from '@/components/landing/landing-page'

/**
 * The frame every marketing page is set in.
 *
 * It reuses the landing page's own navigation and footer, so the public site
 * cannot drift apart. Deliberately a server component with no client hooks:
 * the whole page — headings, copy, links — is in the HTML a crawler receives,
 * which the single-page marketing view on `/` cannot offer.
 */

const SITE = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

export type Crumb = { label: string; href: string }

export type Related = { href: string; label: string; description: string }

function CrumbList({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {crumbs.map((crumb, i) => (
          <li key={crumb.href} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true">/</span>}
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="text-foreground">
                {crumb.label}
              </span>
            ) : (
              <Link href={crumb.href} className="transition-colors hover:text-foreground">
                {crumb.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function MarketingShell({
  eyebrow,
  title,
  intro,
  crumbs,
  children,
  related,
}: {
  eyebrow: string
  title: string
  intro: string
  crumbs: Crumb[]
  children: React.ReactNode
  related: Related[]
}) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((crumb, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: crumb.label,
          item: `${SITE}${crumb.href === '/' ? '' : crumb.href}`,
        })),
      },
      {
        '@type': 'WebPage',
        name: title,
        description: intro,
        url: `${SITE}${crumbs[crumbs.length - 1].href === '/' ? '' : crumbs[crumbs.length - 1].href}`,
        isPartOf: { '@type': 'WebSite', name: 'The Salad', url: SITE },
      },
    ],
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LandingNav />
      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-32 h-[360px]">
            <div className="absolute left-1/2 h-[360px] w-[640px] -translate-x-1/2 rounded-full bg-primary/[0.10] blur-[120px]" />
          </div>
          <div className="relative mx-auto max-w-6xl px-5 pt-10 pb-12 sm:px-8 sm:pt-14 sm:pb-16">
            <CrumbList crumbs={crumbs} />
            <div className="mt-8 max-w-3xl">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                {eyebrow}
              </p>
              <h1 className="text-balance text-[1.9rem] font-semibold leading-[1.12] tracking-tight sm:text-[2.6rem]">
                {title}
              </h1>
              <p className="mt-5 text-base leading-relaxed text-muted-foreground">{intro}</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/?view=login&mode=register"
                  className="inline-flex h-11 items-center justify-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground transition-premium hover:bg-[#ea580c]"
                >
                  Create your restaurant
                  <ArrowRight className="ml-1.5 size-4" />
                </Link>
                <Link
                  href="/#pricing"
                  className="inline-flex h-11 items-center justify-center rounded-xl border border-white/12 px-6 text-sm font-semibold transition-premium hover:bg-white/5"
                >
                  See pricing
                </Link>
              </div>
            </div>
          </div>
        </section>

        <div className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
            <div className="max-w-3xl space-y-12">{children}</div>
          </div>
        </div>

        <section className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-16">
            <h2 className="text-lg font-semibold tracking-tight">Keep reading</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {related.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group rounded-xl border border-white/[0.08] bg-white/[0.015] p-5 transition-premium hover:border-white/15 hover:bg-white/[0.03]"
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {item.label}
                    <ArrowRight className="size-3.5 text-primary transition-transform group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-2 block text-[13px] leading-relaxed text-muted-foreground">
                    {item.description}
                  </span>
                </Link>
              ))}
            </div>

            <Link
              href="/"
              className="mt-10 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Back to The Salad
            </Link>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  )
}

/** A titled block of page copy. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
        {children}
      </div>
    </section>
  )
}

/** A short list of specifics, with the product's own check mark. */
export function Points({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item} className="flex gap-3">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
}

/** A numbered walk-through of what happens, in order. */
export function Steps({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <ol className="space-y-5">
      {steps.map((step, i) => (
        <li key={step.title} className="flex gap-4">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <span>
            <span className="block text-sm font-semibold text-foreground">{step.title}</span>
            <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
              {step.body}
            </span>
          </span>
        </li>
      ))}
    </ol>
  )
}
