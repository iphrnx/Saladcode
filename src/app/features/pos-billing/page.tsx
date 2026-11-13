import type { Metadata } from 'next'
import { BrowserFrame } from '@/components/landing/landing-page'
import { MarketingShell, Points, Section, Steps } from '@/components/marketing/marketing-shell'

const TITLE = 'Restaurant POS and Billing Software'
const DESCRIPTION =
  'A point of sale built for the counter: a live menu grid, dine-in, takeaway and delivery orders, totals calculated with your own tax and service charge, and bills ready to print. No hardware to buy.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/features/pos-billing' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

export default function PosBillingPage() {
  return (
    <MarketingShell
      eyebrow="Features"
      title="Restaurant POS and billing software"
      intro="The counter screen: your menu in a grid, a cart that adds up correctly, and a bill with your tax, service charge, GSTIN and FSSAI on it. Runs on the same order board your kitchen already works from."
      crumbs={[
        { label: 'Home', href: '/' },
        { label: 'Features', href: '/features/pos-billing' },
        { label: 'POS & billing', href: '/features/pos-billing' },
      ]}
      related={[
        { href: '/features/gst-billing', label: 'GST billing', description: 'How tax, service charge and GSTIN end up on the bill.' },
        { href: '/features/qr-ordering', label: 'QR ordering', description: 'Orders from the table, into the same cart and kitchen board.' },
        { href: '/features/analytics', label: 'Analytics', description: 'What the day\u2019s orders add up to, as they happen.' },
      ]}
    >
      <BrowserFrame
        src="/screenshots/dashboard.webp"
        alt="The Salad point-of-sale screen with the menu grid, active orders and the day's totals"
      />

      <Section title="Taking an order at the counter">
        <p>
          Tap items from the menu grid, choose dine-in, takeaway or delivery, pick the table if there is one, and
          send it. The order goes to the kitchen board immediately — the same board QR orders land on, so a table
          ordering from a phone and a guest ordering at the counter end up on one queue instead of two.
        </p>
        <Points
          items={[
            'Dine-in, takeaway and delivery tracked separately, so the kitchen knows what leaves the building.',
            'A cart you can change before sending — quantity, notes, item removed.',
            'Orders tied to a table, so a bill can be produced for exactly what that table had.',
            'Every order recorded with a timestamp, whether it came from the counter or a QR scan.',
          ]}
        />
      </Section>

      <Section title="What the bill is built from">
        <Steps
          steps={[
            { title: 'Your own tax settings', body: 'Tax rate, service charge, GSTIN and FSSAI are set once in settings. Every bill is calculated from those values.' },
            { title: 'Totals computed server-side', body: 'The amount is calculated on your server against your settings, not on the device that took the order.' },
            { title: 'A bill you can hand over', body: 'The bill carries the line items and the totals, ready to settle and print.' },
          ]}
        />
      </Section>

      <Section title="One screen, the whole floor">
        <p>
          The POS is where the day is visible: which tables are open, how many orders are active, what has been
          taken so far. It is the same data the kitchen board and the analytics read from, so there is no
          reconciliation between three systems at closing time.
        </p>
        <Points
          items={[
            'Open tables and active orders on the same screen as the menu.',
            'Today\u2019s takings counted as orders settle, not at the end of the night.',
            'Menu changes appear on the POS, the QR menu and the kitchen board at the same time.',
          ]}
        />
      </Section>

      <Section title="Staff, roles and the counter">
        <p>
          Waiters, cashiers and kitchen staff each get a role. A role decides which parts of the app someone can
          open, and that is enforced at the API rather than hidden in the interface — a waiter cannot read the
          takings because the server will not send them. Staff sign in on a PIN session, which is what ties an
          order to the person who took it.
        </p>
      </Section>

      <Section title="What it runs on">
        <p>
          A browser. A laptop, a desktop, a tablet. There is no proprietary terminal to buy and no installation
          on each device — sign in, and the menu and the day are there. That is also why a second counter, or a
          manager at home, sees the same thing without a second licence.
        </p>
      </Section>
    </MarketingShell>
  )
}
