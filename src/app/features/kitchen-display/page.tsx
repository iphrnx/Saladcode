import type { Metadata } from 'next'
import { BrowserFrame } from '@/components/landing/landing-page'
import { MarketingShell, Points, Section, Steps } from '@/components/marketing/marketing-shell'

const TITLE = 'Kitchen Display System for Restaurants'
const DESCRIPTION =
  'A live kitchen order board: every ticket from pending to served, moving the moment the kitchen moves it. No paper slips, no orders called across the room, no ticket lost between the floor and the pass.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/features/kitchen-display' },
  openGraph: { title: `${TITLE} · The Salad`, description: DESCRIPTION, type: 'article' },
}

export default function KitchenDisplayPage() {
  return (
    <MarketingShell
      eyebrow="Features"
      title="Kitchen display system for restaurants"
      intro="A screen in the kitchen that shows every live ticket, in the order it was sent. Nothing is read off a slip, nothing is shouted across the pass, and nothing goes missing between the table and the stove."
      crumbs={[
        { label: 'Home', href: '/' },
        { label: 'Features', href: '/features/kitchen-display' },
        { label: 'Kitchen display', href: '/features/kitchen-display' },
      ]}
      related={[
        { href: '/features/qr-ordering', label: 'QR ordering', description: 'Where most of those tickets start, when a table orders from its phone.' },
        { href: '/features/pos-billing', label: 'POS & billing', description: 'Counter orders into the same board, and the bill at the end.' },
        { href: '/features/analytics', label: 'Analytics', description: 'What the tickets add up to across a day, week and month.' },
      ]}
    >
      <BrowserFrame
        src="/screenshots/orders.webp"
        alt="The Salad kitchen display board with tickets grouped by pending, preparing and completed"
      />

      <Section title="How a ticket moves">
        <Steps
          steps={[
            { title: 'It arrives', body: 'An order is sent from a table\u2019s QR menu or the counter POS and appears on the board immediately, with the table and the time it was placed.' },
            { title: 'It is picked up', body: 'The kitchen moves it to preparing. The floor can see that, without walking to the pass to ask.' },
            { title: 'It is served', body: 'Marked served when it leaves the counter, and closed when the bill is settled — so the board never shows a ticket nobody is working on.' },
          ]}
        />
      </Section>

      <Section title="What the board shows">
        <Points
          items={[
            'Live tickets grouped by state — pending, preparing, ready, served — so the next job is always at the top.',
            'The table number and the time on every ticket, so age is visible at a glance.',
            'Allergies and spice level on the ticket itself, carried through from the order.',
            'Order type shown — dine-in, takeaway or delivery — so what leaves the kitchen is obvious.',
            'A search for a dish name or a table when the board is long.',
          ]}
        />
      </Section>

      <Section title="Why it matters on a Saturday">
        <p>
          The failure most restaurants have is not a slow cook — it is a ticket that never reached the kitchen,
          or reached it twice, or arrived without the note that said no chilli. A board that every order passes
          through removes the handoff where those mistakes happen, and it gives the person expediting one place
          to look instead of a rail of paper.
        </p>
        <Points
          items={[
            'No slip to lose, misplace, or hand to the wrong station.',
            'No calling an order across a loud room and hoping it was heard.',
            'No wondering whether a table\u2019s food is being made.',
            'A record afterwards: which order, which table, what time it was sent and closed.',
          ]}
        />
      </Section>

      <Section title="The same board, on the floor and at the counter">
        <p>
          The kitchen board is not a separate product or a second app. It reads the same orders the POS takes
          and the QR menu collects, and it is what the analytics count. One order, one record, seen from three
          places.
        </p>
      </Section>

      <Section title="A screen, not a stack of slips">
        <p>
          The board runs in a browser, so a spare tablet or the screen already behind the pass is enough — nothing
          to install per station and no dedicated terminal to buy. An order is in the kitchen the moment it is
          sent, whether the guest ordered from a phone or the counter typed it in.
        </p>
      </Section>
    </MarketingShell>
  )
}
