import type { Metadata } from 'next'
import { BrowserFrame } from '@/components/landing/landing-page'
import { MarketingShell, Points, Section, Steps } from '@/components/marketing/marketing-shell'

const TITLE = 'Restaurant Analytics and Sales Reports'
const DESCRIPTION =
  'Revenue, average order value and top sellers counted from the orders your restaurant actually took — as they happen, not rebuilt from notebooks at closing time.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/features/analytics' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

export default function AnalyticsPage() {
  return (
    <MarketingShell
      eyebrow="Features"
      title="Restaurant analytics that count themselves"
      intro="Every order is already a record with its items, its tax and its total. Analytics is what happens when you read those records — so the day's numbers are correct while the day is still going."
      crumbs={[
        { label: 'Home', href: '/' },
        { label: 'Features', href: '/features/analytics' },
        { label: 'Analytics', href: '/features/analytics' },
      ]}
      related={[
        { href: '/features/pos-billing', label: 'POS & billing', description: 'Where those orders are taken and settled.' },
        { href: '/features/kitchen-display', label: 'Kitchen display', description: 'What a ticket is doing while it is still open.' },
        { href: '/features/gst-billing', label: 'GST billing', description: 'The tax and service charge the totals are built from.' },
      ]}
    >
      <BrowserFrame
        src="/screenshots/analytics.webp"
        alt="The Salad analytics dashboard with total revenue, orders, average order value and a revenue trend"
      />

      <Section title="What you can see">
        <Points
          items={[
            'Total revenue for the period, counted from settled orders.',
            'How many orders that revenue came from.',
            'Average order value — the number that tells you whether a menu change moved the ticket.',
            'Top sellers, so you know what is actually carrying the kitchen.',
            'A revenue trend across the period, so a quiet Tuesday is visible as a pattern rather than a feeling.',
          ]}
        />
      </Section>

      <Section title="Where the numbers come from">
        <Steps
          steps={[
            { title: 'An order is taken', body: 'At the counter or from a table\u2019s QR menu — either way it is a record with items, tax and a total.' },
            { title: 'It is served and settled', body: 'The order closes with the bill, which is what makes it revenue rather than an open ticket.' },
            { title: 'Analytics reads it', body: 'The charts are a view over those records, not a separate spreadsheet someone keeps alongside them.' },
          ]}
        />
      </Section>

      <Section title="Why that matters more than a report">
        <p>
          Most restaurants already have numbers. The problem is that they are assembled after the fact, from
          bills, from a notebook, from the day-end slip — and by then the decision they would have informed has
          already been made. When analytics reads the same orders the floor is taking, you can look at the night
          during the night: whether the new dish is selling, whether a table\u2019s spend is drifting down, whether
          the average ticket responds to what you changed.
        </p>
      </Section>

      <Section title="One outlet or three">
        <p>
          Data belongs to a restaurant, and a restaurant\u2019s owner sees that restaurant. On the Pro plan, up to
          three locations run under one account without their orders mixing — each outlet has its own menu, its
          own staff and its own numbers.
        </p>
      </Section>

      <Section title="What analytics is not">
        <p>
          It is not a forecasting engine and it will not tell you what to cook tomorrow. It tells you what
          happened, accurately and on time, and leaves the judgement to the person who knows the room.
        </p>
      </Section>
    </MarketingShell>
  )
}
