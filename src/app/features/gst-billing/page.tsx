import type { Metadata } from 'next'
import { BrowserFrame } from '@/components/landing/landing-page'
import { MarketingShell, Points, Section, Steps } from '@/components/marketing/marketing-shell'

const TITLE = 'GST Billing Software for Restaurants'
const DESCRIPTION =
  'Restaurant billing that carries your GSTIN, FSSAI number, tax rate and service charge on every bill. Set them once in settings; every bill in the app is calculated from those values.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/features/gst-billing' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

export default function GstBillingPage() {
  return (
    <MarketingShell
      eyebrow="Features"
      title="GST billing for Indian restaurants"
      intro="Your tax rate, service charge, GSTIN and FSSAI number are set once, in settings. Every bill the app produces is calculated from them — at the counter, from a QR order, or wherever the order was rung up."
      crumbs={[
        { label: 'Home', href: '/' },
        { label: 'Features', href: '/features/gst-billing' },
        { label: 'GST billing', href: '/features/gst-billing' },
      ]}
      related={[
        { href: '/features/pos-billing', label: 'POS & billing', description: 'Where the bill is produced, and what feeds it.' },
        { href: '/features/qr-ordering', label: 'QR ordering', description: 'Table orders totalled with the same tax and service charge.' },
        { href: '/features/analytics', label: 'Analytics', description: 'Revenue and average order value, counted from those settled bills.' },
      ]}
    >
      <BrowserFrame
        src="/screenshots/dashboard.webp"
        alt="The Salad POS showing a cart totalled with tax and service charge before the bill is produced"
      />

      <Section title="Set once, applied everywhere">
        <Steps
          steps={[
            { title: 'Enter your details', body: 'Tax rate, service charge, GSTIN and FSSAI in settings. These are your numbers, not defaults we assume.' },
            { title: 'Every bill uses them', body: 'A bill rung at the counter and a total shown to a guest on a phone are calculated from the same settings on the server.' },
            { title: 'Change a rate, it applies', body: 'When a rate or a charge changes, you change it in settings and the next bill is calculated with the new value.' },
          ]}
        />
      </Section>

      <Section title="What the bill carries">
        <Points
          items={[
            'The line items — what was ordered, how many, at what price.',
            'Tax calculated at your rate, on the amount the bill is for.',
            'Service charge, if you apply one, as its own line rather than folded into the prices.',
            'Your GSTIN and FSSAI number as part of your business details.',
            'The total the guest pays, calculated server-side rather than derived from whatever the device sent.',
          ]}
        />
      </Section>

      <Section title="Why server-side totals matter">
        <p>
          A QR menu puts the menu on a device you do not control. If the price, the tax or the total were trusted
          from that device, a tampered request could change what a guest pays. In The Salad the cart is a list of
          what was ordered; the money is worked out on your server against your settings. The number a guest sees
          and the number on the bill are the same number, and neither of them came from the phone.
        </p>
      </Section>

      <Section title="For the counter and for the CA">
        <p>
          Because every order is stored with its own line items, tax and total, the day\u2019s takings are already
          counted — you are not reconstructing a night from a bundle of bills. Analytics reads the same orders,
          so revenue, average order value and top sellers are the numbers the bills produced.
        </p>
        <Points
          items={[
            'Orders recorded individually, with their timestamps.',
            'Revenue totals that match what was billed, because they are the same records.',
            'Per-restaurant data separation — one outlet\u2019s orders are not visible to another.',
          ]}
        />
      </Section>

      <Section title="Please check your own rates">
        <p>
          Tax treatment for restaurants depends on your turnover, your state, and whether the bill is dine-in,
          takeaway or delivery. The Salad applies the rate you set; it does not decide what that rate should be.
          Confirm your applicable rates with your accountant, then set them once.
        </p>
      </Section>
    </MarketingShell>
  )
}
