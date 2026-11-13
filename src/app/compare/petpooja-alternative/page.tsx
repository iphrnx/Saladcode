import type { Metadata } from 'next'
import Link from 'next/link'
import { BrowserFrame } from '@/components/landing/landing-page'
import { MarketingShell, Points, Section } from '@/components/marketing/marketing-shell'

const TITLE = 'A Petpooja Alternative for Indian Restaurants'
const DESCRIPTION =
  'Weighing The Salad against Petpooja? Here is what to compare before you commit — pricing model, hardware, QR ordering, GST billing and analytics — and where The Salad genuinely differs.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/compare/petpooja-alternative' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

export default function PetpoojaAlternativePage() {
  return (
    <MarketingShell
      eyebrow="Compare"
      title="Looking at a Petpooja alternative?"
      intro="Petpooja is the best-known restaurant software in India, and for plenty of restaurants it is the right answer. This page is for the ones weighing it against something else — what actually decides it, and where The Salad differs."
      crumbs={[
        { label: 'Home', href: '/' },
        { label: 'Compare', href: '/compare/petpooja-alternative' },
        { label: 'Petpooja alternative', href: '/compare/petpooja-alternative' },
      ]}
      related={[
        { href: '/features/qr-ordering', label: 'QR ordering', description: 'Table ordering from a phone, into your kitchen board.' },
        { href: '/features/gst-billing', label: 'GST billing', description: 'Tax, service charge and GSTIN on every bill.' },
        { href: '/features/kitchen-display', label: 'Kitchen display', description: 'The board your kitchen runs service from.' },
      ]}
    >
      <BrowserFrame
        src="/screenshots/dashboard.webp"
        alt="The Salad running in a browser: menu grid, live tables and today's totals on one screen"
      />

      <Section title="The five things that actually decide it">
        <p>
          Most restaurant software does the same core job: take an order, get it to the kitchen, bill it, and
          report on it. What separates products is not the feature list — it is how each of these five is
          answered for <em>your</em> restaurant.
        </p>
        <Points
          items={[
            'What you pay for: per outlet, per user, per order, or a licence plus hardware.',
            'What you must buy: a terminal, a printer, a router, or nothing at all.',
            'How a table orders: staff only, or the guest from a QR code on the table.',
            'What the bill carries: your GSTIN, FSSAI number, tax rate and service charge, set once.',
            'What you can see afterwards: a report you export, or numbers that are already there.',
          ]}
        />
      </Section>

      <Section title="Where The Salad genuinely differs">
        <p>
          These are statements about The Salad. We do not make claims about Petpooja\u2019s pricing or feature set
          on this page — their details change, and you should read them on their own site and ask them directly.
          What we can tell you is what we do:
        </p>
        <Points
          items={[
            'Priced per restaurant, per month, in rupees — ₹999 for one outlet on Starter, ₹2,499 for Pro. No per-user pricing.',
            'No hardware to buy. It runs in a browser on a laptop, desktop or tablet you already own.',
            'QR table ordering is part of the product, not an add-on: every table gets a code, and orders land on the same board as counter orders.',
            'Bills are calculated server-side against your own tax and service charge — set once in settings.',
            'Free to try, no card required, so the comparison can be against your own menu and your own rush.',
          ]}
        />
      </Section>

      <Section title="Where Petpooja may genuinely suit you better">
        <p>
          Being straight about it: a product with a long history in the market tends to have breadth we do not
          yet match — deeper integrations with delivery aggregators, a large support network, and features built
          for formats we have not covered. If aggregator integration is the deciding requirement for your
          restaurant, ask both vendors specifically about it rather than reading it off a comparison page.
        </p>
      </Section>

      <Section title="How to run the comparison properly">
        <Points
          items={[
            'Put your own menu in both. A demo against someone else\u2019s menu hides the awkward parts of yours — the modifiers, the portions, the half-plates.',
            'Run one service, not one hour. A quiet Tuesday afternoon will not tell you what the board looks like at 9pm.',
            'Ask what the bill needs. If GSTIN, FSSAI and service charge are not on it the way your accountant wants, that is the whole decision.',
            'Ask what happens when the internet drops, and what you have to buy to keep going.',
            'Ask what a second outlet costs, and whether its data stays separate from the first.',
          ]}
        />
      </Section>

      <Section title="Try the thing itself">
        <p>
          The fastest way past a comparison table is to open The Salad and put your own menu in it. The AI menu
          scanner will read a photo of your printed menu and pull the items and prices out, so setup is minutes
          rather than an evening of typing. If it does not fit how your floor works, you will know in an hour —
          and you will not have paid to find out.
        </p>
        <p>
          <Link href="/?view=login&mode=register" className="font-semibold text-primary hover:underline">
            Create your restaurant
          </Link>{' '}
          — free to try, no card required.
        </p>
      </Section>
    </MarketingShell>
  )
}
