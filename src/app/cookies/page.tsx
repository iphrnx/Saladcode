import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalDetail, LegalList, LegalSection, LegalShell } from '@/components/landing/legal-shell'
import { BUSINESS, legalRobots } from '@/lib/legal-details'

export const metadata: Metadata = {
  title: 'Cookie Policy',
  description:
    `The cookies and browser storage ${BUSINESS.productName} uses, what each one is for, how long it lasts, and how to control them. Essential cookies only — no advertising or tracking cookies.`,
  alternates: { canonical: '/cookies' },
  robots: legalRobots,
}

/** One row of the cookie or storage table. */
function Row({ name, purpose, life }: { name: string; purpose: string; life: string }) {
  return (
    <div className="grid gap-1.5 border-t border-white/[0.06] py-3.5 sm:grid-cols-[1.1fr_2fr_0.8fr] sm:gap-4">
      <code className="break-all text-[12.5px] text-foreground">{name}</code>
      <span className="text-[13px] leading-relaxed sm:text-sm">{purpose}</span>
      <span className="text-[12.5px] sm:text-right">{life}</span>
    </div>
  )
}

function TableHeader({ first, second, third }: { first: string; second: string; third: string }) {
  return (
    <div className="hidden gap-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground sm:grid sm:grid-cols-[1.1fr_2fr_0.8fr]">
      <span>{first}</span>
      <span>{second}</span>
      <span className="text-right">{third}</span>
    </div>
  )
}

export default function CookiePolicyPage() {
  return (
    <LegalShell
      eyebrow="Legal"
      title="Cookie Policy"
      intro={`This page lists every cookie and every piece of browser storage ${BUSINESS.productName} sets, what each one does, and how you can control them. We use only what the product needs to work — there are no advertising cookies and no third-party tracking or analytics cookies.`}
    >
      <LegalSection title="1. What cookies and browser storage are">
        <p>
          A <span className="text-foreground">cookie</span> is a small piece of text a website
          asks your browser to keep and to send back on later requests. It is how a site knows
          that the person asking for a page is already signed in. Some cookies are set by us,
          and are called first-party cookies.
        </p>
        <p>
          <span className="text-foreground">Browser storage</span> (local storage) works
          similarly but stays in your browser and is never sent automatically with requests. We
          use it for preferences and for drafts that do not belong on a server.
        </p>
        <p>
          We do not use cookies to build advertising profiles, we do not sell data, and we do not
          embed third-party advertising or social tracking pixels. Because the product sets only
          essential cookies, that is all there is to consent to today — the banner below records
          your answer, and it is what decides whether anything optional may ever be set.
        </p>
      </LegalSection>

      <LegalSection title="2. Cookies we set">
        <div>
          <TableHeader first="Cookie" second="What it does" third="Lasts" />
          <Row
            name="sb-…-auth-token"
            purpose="Keeps a restaurant owner or staff member signed in after they log in. Without it, every page would ask for credentials again. It is refreshed as you work and includes a code that proves your session to our servers."
            life="Session, renewed while in use"
          />
          <Row
            name="sb-…-auth-token-code-verifier"
            purpose="Holds a one-time value while a sign-in link or password reset is being completed, so the link cannot be replayed by anyone else."
            life="Minutes, then deleted"
          />
          <Row
            name="the-salad-staff-session"
            purpose="The staff PIN session. Set when a staff member signs in with a PIN, and marked HttpOnly so it cannot be read by scripts in the page. It is what lets a shared floor device stay signed in as that staff member. A device that signed in before the rename is still recognised through the cookie's previous name, which is cleared the next time that staff member signs in or out."
            life="Until sign-out or expiry"
          />
        </div>
      </LegalSection>

      <LegalSection title="3. Browser storage we use">
        <div>
          <TableHeader first="Key" second="What it does" third="Lasts" />
          <Row
            name="the-salad-theme"
            purpose="Remembers whether you chose the light or dark interface, so the dashboard does not flash the wrong theme on every visit."
            life="Until cleared"
          />
          <Row
            name="the-salad-menu-theme"
            purpose="A cached copy of the restaurant's customer-menu theme, so the menu a diner opens appears in the right colours immediately."
            life="Until cleared"
          />
          <Row
            name="the-salad-onboarding"
            purpose="A draft of the setup wizard, so a half-finished menu import or restaurant profile is not lost if the page is closed."
            life="Until setup is completed"
          />
          <Row
            name="the-salad-diner-session"
            purpose="The diner's table session token. It keeps the menu open when a diner refreshes the page or their phone wakes up, without asking them to scan the QR code again."
            life="Until the table session ends"
          />
          <Row
            name="the-salad-cart-session-…"
            purpose="The diner's cart for that table session, so items are not lost on a refresh. It is keyed to the session, so a new scan starts a new cart."
            life="Until the table session ends"
          />
          <Row
            name="the-salad-notifications-seen"
            purpose="The last time the owner opened their notifications, so the unread badge does not keep counting things already seen."
            life="Until cleared"
          />
          <Row
            name="the-salad-cookie-consent"
            purpose="The answer you gave in the cookie banner — accept or reject optional cookies — with the date you gave it and which version of the question it answered. It is how the banner knows not to ask again, and how anything optional knows whether it is allowed to run. It holds no identifier and is never sent to us."
            life="Until cleared"
          />
          <Row
            name="the-salad-staff-token"
            purpose="The staff session token, kept for browsers that block the staff cookie. It authorises staff-only requests on that device."
            life="Until sign-out"
          />
        </div>
        <p>
          These names changed with the product. If you visited before the rename you may still see
          an entry under the older name in your browser&apos;s storage viewer — it is read once,
          copied to the name above, and then removed, so your theme, your half-finished setup and a
          diner&apos;s open cart all survive the change. Nothing is signed out by it.
        </p>
        {/* If error monitoring or product analytics are ever switched on, they
            almost certainly set their own storage — add a row here when they do. */}
      </LegalSection>

      <LegalSection title="4. Your choices">
        <p>
          On your first visit a banner asks whether to accept or reject optional cookies. Both
          answers are recorded, and both are honoured: the banner does not appear again on a later
          visit, and nothing optional is set unless you chose <em>Accept All</em>. &ldquo;Reject
          All&rdquo; is a decision, not a dismissal — it is the setting that keeps optional
          cookies off, and the product works exactly the same either way because it needs nothing
          beyond the essential items listed above.
        </p>
        <p>
          You can change your mind at any time using{' '}
          <span className="text-foreground">Cookie settings</span> in the footer of any page, which
          brings the banner back. If a future version of this policy covers something new, we ask
          again rather than holding you to an answer you gave about something else.
        </p>
      </LegalSection>

      <LegalSection title="5. Cookies set by others">
        <p>
          One part of the product runs on someone else&apos;s site: when a restaurant pays for a
          subscription, the payment gateway&apos;s own checkout opens on its own domain and sets
          its cookies there, under its own policy. We never see or store card, UPI or bank
          details.
        </p>
        <p>
          Our hosting and database provider sets only what is needed to deliver and protect the
          service. The AI provider used for menu scanning and dish images receives the images the
          restaurant chooses to send, and sets no cookies in the browser.
        </p>
      </LegalSection>

      <LegalSection title="6. Controlling cookies and storage">
        <LegalList
          items={[
            'Every major browser lets you see, block and delete cookies and site data, and do so for individual sites. Clearing them signs you out of the dashboard and can empty a diner’s cart.',
            'The essential cookies are exactly the ones that keep people signed in. If they are blocked, the service cannot be used — signing in will appear to fail, or every page will ask again.',
            'Private or incognito windows keep this storage only until the window is closed, so nothing is remembered between visits.',
            'You can change your cookie answer whenever you like with the “Cookie settings” control in the footer, and clearing your browser storage resets it to “not yet chosen”, so the banner asks once more.',
          ]}
        />
      </LegalSection>

      <LegalSection title="7. Changes to this policy">
        <p>
          If we add a cookie or a piece of storage that is not listed here, we will update this
          page and the effective date at the top before it is used.
        </p>
      </LegalSection>

      <LegalSection title="8. Contact">
        <p>
          Questions about this policy or about how we handle personal data should go to the
          privacy contact below. Our{' '}
          <Link href="/privacy" className="text-primary hover:underline">
            Privacy Policy
          </Link>{' '}
          explains the rest of how data is handled.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <LegalDetail label="Entity">{BUSINESS.legalName}</LegalDetail>
          <LegalDetail label="Privacy queries">
            <a href={`mailto:${BUSINESS.supportEmail}`} className="text-primary hover:underline">
              {BUSINESS.supportEmail}
            </a>
          </LegalDetail>
        </div>
      </LegalSection>
    </LegalShell>
  )
}
