import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { LandingFooter, LandingNav } from './landing-page'
import { BUSINESS } from '@/lib/legal-details'

/**
 * The frame the legal pages are set in.
 *
 * It reuses the landing page's own navigation and footer rather than copying
 * them, so the public site cannot drift apart: whatever the landing page looks
 * like, these pages look like it too.
 */
export function LegalShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string
  title: string
  intro?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main>
        <section>
          <div className="mx-auto max-w-6xl px-5 pt-14 pb-4 sm:px-8 sm:pt-20">
            <div className="max-w-3xl">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                {eyebrow}
              </p>
              <h1 className="text-balance text-[1.75rem] font-semibold leading-[1.15] tracking-tight sm:text-[2.25rem]">
                {title}
              </h1>
              {intro && (
                <p className="mt-5 text-sm leading-relaxed text-muted-foreground">{intro}</p>
              )}
              <p className="mt-4 text-xs text-muted-foreground">
                Effective from {BUSINESS.effectiveDate}
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-white/[0.06]">
          <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
            <div className="max-w-3xl space-y-9">{children}</div>

            <div className="mt-14 max-w-3xl border-t border-white/[0.06] pt-8">
              <Link
                href="/"
                className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
                Back to {BUSINESS.productName}
              </Link>
            </div>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  )
}

/** One numbered clause group. */
export function LegalSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-[15px] font-semibold tracking-tight sm:text-base">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}

/** A bulleted list, styled to match the rest of the public site. */
export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2 pl-5">
      {items.map((item, i) => (
        <li key={i} className="list-disc marker:text-primary/70">
          {item}
        </li>
      ))}
    </ul>
  )
}

/** A labelled block, used for the contact and grievance details. */
export function LegalDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1.5 text-sm text-foreground">{children}</div>
    </div>
  )
}
