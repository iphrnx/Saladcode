import type { Metadata } from 'next'
import { BrowserFrame, PhoneFrame } from '@/components/landing/landing-page'
import { MarketingShell, Points, Section, Steps } from '@/components/marketing/marketing-shell'

const TITLE = 'QR Code Ordering for Restaurants'
const DESCRIPTION =
  'Let diners scan a QR code at the table, browse your menu and order from their own phone — no app, no signup. Orders land on your kitchen board instantly. Built for Indian restaurants.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/features/qr-ordering' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

export default function QrOrderingPage() {
  return (
    <MarketingShell
      eyebrow="Features"
      title="QR code ordering for restaurant tables"
      intro="Every table gets its own QR code. A guest scans it, your menu opens in their browser, and the order reaches the kitchen exactly as they placed it — no app to install, no account to create, no waiter hovering."
      crumbs={[
        { label: 'Home', href: '/' },
        { label: 'Features', href: '/features/qr-ordering' },
        { label: 'QR ordering', href: '/features/qr-ordering' },
      ]}
      related={[
        { href: '/features/kitchen-display', label: 'Kitchen display system', description: 'What happens to the order after the table sends it.' },
        { href: '/features/pos-billing', label: 'POS & billing', description: 'Take the same order at the counter when a guest would rather speak to staff.' },
        { href: '/features/gst-billing', label: 'GST billing', description: 'Tax, service charge and GSTIN on every bill, set once in settings.' },
      ]}
    >
      <BrowserFrame
        src="/screenshots/orders.webp"
        alt="The Salad kitchen display board showing QR orders arriving with their status"
      />

      <Section title="How a table orders">
        <Steps
          steps={[
            { title: 'The guest scans', body: 'Each table has its own printed QR code. Scanning opens your menu in the phone\u2019s browser — nothing to download, nothing to sign up for.' },
            { title: 'They browse and order', body: 'Your live menu, with categories, prices and dish descriptions. Items go into a cart the guest can change before sending.' },
            { title: 'It reaches the kitchen', body: 'The order appears on your order board as a ticket, at the moment it is sent — not when someone walks it over.' },
            { title: 'The bill is already right', body: 'Prices, tax and service charge are calculated on your server, so what the guest is charged never depends on the request the phone made.' },
          ]}
        />
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <PhoneFrame src="/screenshots/mobile-menu.webp" alt="The Salad QR menu open on a diner's phone with dishes and prices" className="mx-auto w-[190px]" />
        <PhoneFrame src="/screenshots/mobile-cart.webp" alt="Diner's cart on The Salad QR menu before sending the order" className="mx-auto w-[190px]" />
      </div>

      <Section title="What your guests get">
        <Points
          items={[
            'A menu that opens in the browser — no app store, no download, no login.',
            'Prices, photos and descriptions of what you actually serve, updated when you change them.',
            'A cart they can edit before sending, so the order is theirs, not the waiter\u2019s reading of it.',
            'Allergies and spice level noted with the order, so the kitchen sees them on the ticket.',
            'A session that ends with the meal — once it closes, only a fresh scan starts a new one.',
          ]}
        />
      </Section>

      <Section title="What you get behind it">
        <Points
          items={[
            'No reprinting menus when a price changes: edit once, every table sees it.',
            'Fewer trips to a table just to take an order, and fewer orders read back wrong across a loud room.',
            'Every order is a real record — timestamped, tied to a table, and visible in your analytics.',
            'Orders are computed server-side against your own tax and service charge, not the guest\u2019s phone.',
            'Room to run staff on a PIN session, so each order is attributed to whoever was serving.',
          ]}
        />
      </Section>

      <Section title="Where QR ordering stops">
        <p>
          A QR menu handles the guest who is happy to order from their phone. It does not replace a waiter for
          recommendations, a celebration, or the table that wants to talk to someone. The Salad runs both: QR
          ordering for the tables that use it, the counter POS for the ones that would rather speak — same
          menu, same kitchen board, same bill.
        </p>
      </Section>

      <Section title="Setting it up">
        <p>
          Add your menu — you can photograph a printed one and let the scanner extract the items and prices — then
          print a QR code per table. Most restaurants are taking orders the same day. There is no hardware to buy
          and nothing to install on a guest\u2019s phone.
        </p>
      </Section>
    </MarketingShell>
  )
}
