import type { Metadata } from 'next'
import Link from 'next/link'
import { Mail, MessageSquare, Phone, ShieldCheck } from 'lucide-react'
import { LegalList, LegalSection, LegalShell } from '@/components/landing/legal-shell'
import { BUSINESS, legalRobots } from '@/lib/legal-details'

export const metadata: Metadata = {
  title: 'Contact Us',
  description:
    `Get in touch with ${BUSINESS.productName} — support for your restaurant account, sales and demos, billing and subscription queries, and the grievance officer for privacy complaints.`,
  alternates: { canonical: '/contact' },
  robots: legalRobots,
}

/** One contact card. */
function ContactCard({
  icon: Icon,
  title,
  detail,
  href,
  children,
}: {
  icon: typeof Mail
  title: string
  detail: string
  href?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Icon className="size-4" />
        </span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</p>
      {href ? (
        <a
          href={href}
          className="mt-3 inline-block break-all text-sm font-medium text-primary hover:underline"
        >
          {detail}
        </a>
      ) : (
        <p className="mt-3 break-all text-sm font-medium text-foreground">{detail}</p>
      )}
    </div>
  )
}

export default function ContactPage() {
  return (
    <LegalShell
      eyebrow="Contact"
      title="Contact us"
      intro={`We are a small team, and we answer directly. Whether something in the dashboard is not behaving, you want a walkthrough before you sign up, or you have a question about a bill — write to us using the address that fits, and it reaches the right person.`}
    >
      <LegalSection title="Talk to us">
        <div className="grid gap-4 sm:grid-cols-2">
          <ContactCard
            icon={MessageSquare}
            title="Product support"
            detail={BUSINESS.supportEmail}
            href={`mailto:${BUSINESS.supportEmail}`}
          >
            Anything about running your restaurant on {BUSINESS.productName} — orders, the
            kitchen screen, QR codes, printing bills, staff PINs or roles. Tell us which
            restaurant the account belongs to and what you expected to happen, and we can usually
            reproduce it quickly.
          </ContactCard>

          <ContactCard
            icon={Mail}
            title="Sales and demos"
            detail={BUSINESS.supportEmail}
            href={`mailto:${BUSINESS.supportEmail}?subject=Demo%20request`}
          >
            Want a walkthrough before you commit, or thinking about running several outlets?
            Ask for a demo and tell us how many locations and how many covers a day you serve.
          </ContactCard>

          <ContactCard
            icon={Phone}
            title="Phone"
            detail={BUSINESS.phone}
            href={`tel:${BUSINESS.phone.replace(/[^+0-9]/g, '')}`}
          >
            For anything urgent during service hours — the floor stops being patient when the
            kitchen screen does. Calling is faster than writing if a service is down mid-rush.
          </ContactCard>

          <ContactCard
            icon={ShieldCheck}
            title="Privacy and grievances"
            detail={BUSINESS.grievanceOfficerEmail}
            href={`mailto:${BUSINESS.grievanceOfficerEmail}?subject=Privacy%20request`}
          >
            Requests to access, correct or delete personal data, and complaints under the IT
            (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021. See the{' '}
            <Link href="/privacy" className="text-primary hover:underline">
              Privacy Policy
            </Link>{' '}
            for how these are handled.
          </ContactCard>
        </div>
      </LegalSection>

      <LegalSection title="Billing and subscriptions">
        <p>
          For a question about a charge, an upgrade, a plan change or a cancellation, write to{' '}
          <a href={`mailto:${BUSINESS.supportEmail}`} className="text-primary hover:underline">
            {BUSINESS.supportEmail}
          </a>{' '}
          from the email address on the account, and include the payment reference if you have
          one. Payments are processed by our payment gateway; we never hold card, UPI or bank
          details, so we will never ask you for them.
        </p>
        <p>
          You can also change or cancel a plan yourself at any time in{' '}
          <span className="text-foreground">Settings → Billing</span>. Cancelling takes effect at
          the end of the period you have already paid for.
        </p>
      </LegalSection>

      <LegalSection title="Grievance officer">
        <p>
          In accordance with the Information Technology Act, 2000 and the rules made under it, the
          details of the grievance officer are published below. A complaint about this platform,
          including one about personal data, may be sent to them.
        </p>
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Name
              </dt>
              <dd className="mt-1 text-foreground">{BUSINESS.grievanceOfficerName}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Email
              </dt>
              <dd className="mt-1">
                <a
                  href={`mailto:${BUSINESS.grievanceOfficerEmail}`}
                  className="break-all text-primary hover:underline"
                >
                  {BUSINESS.grievanceOfficerEmail}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Address
              </dt>
              <dd className="mt-1 text-foreground">{BUSINESS.registeredAddress}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Response time
              </dt>
              <dd className="mt-1 text-foreground">
                Acknowledged within 24 hours, and resolved within 15 days of receipt.
              </dd>
            </div>
          </dl>
        </div>
      </LegalSection>

      <LegalSection title="Registered details">
        <LegalList
          items={[
            <>
              <span className="text-foreground">Entity</span> — {BUSINESS.legalName},{' '}
              {BUSINESS.entityType}
            </>,
            <>
              <span className="text-foreground">Registered address</span> —{' '}
              {BUSINESS.registeredAddress}
            </>,
            <>
              <span className="text-foreground">Legal notices</span> —{' '}
              <a href={`mailto:${BUSINESS.legalEmail}`} className="text-primary hover:underline">
                {BUSINESS.legalEmail}
              </a>
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Before you write">
        <p>
          A few details let us help you in one reply instead of three: your restaurant name, the
          email address on the account, the device and browser you were using, what you did, and
          what you expected to happen. If a bill printed wrongly, send a photograph of it. Never
          send us passwords or PINs — we will never ask for them.
        </p>
      </LegalSection>
    </LegalShell>
  )
}
