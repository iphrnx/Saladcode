import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalDetail, LegalList, LegalSection, LegalShell } from '@/components/landing/legal-shell'
import { BUSINESS, legalRobots } from '@/lib/legal-details'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description:
    `How ${BUSINESS.productName} collects, uses, shares and protects personal data — for restaurant accounts, their staff and the diners who order from a table, in line with India's Digital Personal Data Protection Act, 2023.`,
  alternates: { canonical: '/privacy' },
  robots: legalRobots,
}

export default function PrivacyPolicyPage() {
  return (
    <LegalShell
      eyebrow="Legal"
      title="Privacy Policy"
      intro={`This policy explains what personal data ${BUSINESS.productName} collects, why, who it is shared with, how long it is kept, and the choices you have. It covers the platform website and the restaurants that use it, together with the diners who scan a table QR code.`}
    >
      <LegalSection title="1. Who this policy is for">
        <p>
          {BUSINESS.productName} is restaurant software operated by {BUSINESS.legalName}{' '}
          ({BUSINESS.entityType}). It is used by two groups, and the policy applies to both:
        </p>
        <LegalList
          items={[
            <>
              <span className="text-foreground">Restaurant accounts</span> — the owner or
              manager who signs up, and the staff they add.
            </>,
            <>
              <span className="text-foreground">Diners</span> — anyone who scans a table QR
              code, places an order, books a table, or leaves a review.
            </>,
          ]}
        />
        <p>
          A restaurant using {BUSINESS.productName} decides what diner data it collects and why,
          and is responsible for it as the data fiduciary under the Digital Personal Data
          Protection Act, 2023. We process that data on the restaurant&apos;s instructions as a
          data processor. For restaurant account data — the logins and business details held in
          the platform itself — we are the data fiduciary.
        </p>
      </LegalSection>

      <LegalSection title="2. What we collect">
        <p>
          <span className="text-foreground">Account and restaurant details.</span> Name, email
          address, phone number and profile picture of the owner and of each staff member added;
          restaurant name, address, contact details, logo, GSTIN and FSSAI numbers; currency,
          tax and service-charge settings; opening hours, timezone and menu theme.
        </p>
        <p>
          <span className="text-foreground">Staff activity.</span> Staff sign in with a PIN
          rather than an email account. We record the name and role attached to a PIN session,
          and the actions taken in the dashboard, so that a restaurant can see who did what.
        </p>
        <p>
          <span className="text-foreground">Orders and table sessions.</span> The table session
          token created when a QR code is scanned, the orders placed against it — dishes,
          quantities, portions, amounts, taxes, discounts and the time — and, for takeaway or
          delivery orders, the diner&apos;s name and phone number if they are entered.
        </p>
        <p>
          <span className="text-foreground">Reviews.</span> The rating, any comment, optional
          name, and the tags a diner selects, linked to the table session they came from. The
          restaurant&apos;s reply is stored alongside.
        </p>
        <p>
          <span className="text-foreground">Subscription and payment references.</span> The plan,
          subscription status, billing period and the identifiers and status returned by our
          payment gateway. <span className="text-foreground">We never receive or store card,
          UPI or bank details</span> — those are entered on the payment gateway&apos;s own
          checkout.
        </p>
        <p>
          <span className="text-foreground">Sign-in and security logs.</span> Sign-in attempts,
          failures, session information, IP address and browser user-agent, kept to keep accounts
          secure and to investigate misuse.
        </p>
        <p>
          <span className="text-foreground">Menu images and AI features.</span> If a restaurant
          uses menu scanning or dish image generation, the images and text it provides are sent to
          our AI provider to produce the result. Do not upload images containing personal data of
          others unless you have the right to share them.
        </p>
      </LegalSection>

      <LegalSection title="3. Why we use it, and our lawful basis">
        <LegalList
          items={[
            'To create and run the account, and to provide the service the restaurant has signed up for — performing our contract with the restaurant.',
            'To take orders, calculate bills and taxes, print bills and pass orders to the kitchen — the core of the service.',
            'To process subscription payments and keep billing records — performing our contract, and to meet tax and accounting obligations.',
            'To keep accounts and the platform secure, prevent fraud and abuse, and audit who changed what — our legitimate business need, and in the interest of every user of the platform.',
            'To answer support requests, and to send service messages about the account, downtime or changes to the service — performing our contract.',
            'To improve the product — using aggregated, non-identifying usage patterns.',
            'To comply with applicable law, including responding to lawful requests from authorities.',
          ]}
        />
        <p>
          Where consent is the basis — for example, an optional marketing email — you can withdraw
          it at any time. Withdrawing consent does not affect processing carried out before the
          withdrawal, and may mean we can no longer provide a feature that depends on it.
        </p>
      </LegalSection>

      <LegalSection title="4. Cookies and local storage">
        <p>
          We use a small number of essential cookies and browser storage to keep people signed in
          and to remember preferences. There are no advertising cookies, and no third-party
          analytics or tracking cookies. The full list is in our{' '}
          <Link href="/cookies" className="text-primary hover:underline">
            Cookie Policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="5. Who we share it with">
        <p>
          We do not sell personal data. We share it only with service providers who process it on
          our instructions, under contract, and only as needed to run the platform:
        </p>
        <LegalList
          items={[
            <>
              <span className="text-foreground">Cloud hosting and database</span> — Supabase,
              which stores the database, authentication, files and server functions, and Vercel,
              which hosts the website.
            </>,
            <>
              <span className="text-foreground">Payments</span> — our payment gateway, for
              subscription billing. Diner payments made directly at the restaurant are outside
              the platform.
            </>,
            <>
              <span className="text-foreground">AI features</span> — our AI provider, only when
              the restaurant uses menu scanning or dish image generation.
            </>,
            <>
              <span className="text-foreground">Professional advisers, and authorities</span> —
              where we are legally required to disclose, or to establish or defend legal claims.
            </>,
          ]}
        />
        <p>
          Diner data belongs to the restaurant that collected it. We do not use it for our own
          purposes, and we do not share it with other restaurants.
        </p>
      </LegalSection>

      <LegalSection title="6. Where data is stored and transferred">
        <p>
          Data is stored on cloud infrastructure in the regions our providers operate. Where data
          is processed outside India, we take steps required by applicable law to ensure it
          continues to receive an appropriate standard of protection.
        </p>
      </LegalSection>

      <LegalSection title="7. How long we keep it">
        <LegalList
          items={[
            'Account and restaurant data — while the account is active, and for a short period afterwards so the account can be restored if it was closed by mistake.',
            'Orders, bills and billing records — for the period required by tax and accounting law.',
            'Staff activity and security logs — for a limited period, to investigate incidents.',
            'Table sessions and diner reviews — while the restaurant needs them for its own records; the restaurant can delete them.',
            'Data in backups — removed on the backup provider’s normal rotation.',
          ]}
        />
        <p>
          When data is no longer needed, we delete it or make it unreadable. Deleting a restaurant
          account deletes the data attached to it, except what we must keep to comply with law.
        </p>
      </LegalSection>

      <LegalSection title="8. Your rights">
        <p>
          Under the Digital Personal Data Protection Act, 2023 you have the right to access a
          summary of the personal data we hold about you and how it is processed, to correct or
          complete it, to have it erased, to withdraw consent, to nominate someone to exercise
          your rights in the event of death or incapacity, and to a readily available grievance
          redressal mechanism. You also have the right to complain to the Data Protection Board
          of India.
        </p>
        <p>
          A restaurant owner can access, correct, export or delete most data directly in the
          dashboard. For anything else, write to the email address below. We will respond within
          the period required by law. A diner who wants their order data or review accessed,
          corrected or removed should contact the restaurant that collected it; we will help the
          restaurant carry out the request.
        </p>
      </LegalSection>

      <LegalSection title="9. Security">
        <p>
          We use access controls and row-level isolation so that each restaurant can reach only
          its own data, encrypted connections, server-side enforcement of every permission, and
          security logging. No system is perfectly secure, but we work to keep unauthorised access
          out and to fix issues quickly when we find them.
        </p>
      </LegalSection>

      <LegalSection title="10. Children">
        <p>
          The service is for restaurant businesses and is not directed at children. We do not
          knowingly collect personal data from anyone under 18 through the platform itself.
        </p>
      </LegalSection>

      <LegalSection title="11. Changes to this policy">
        <p>
          We may update this policy as the product changes or the law does. The effective date at
          the top will change, and material changes will be notified in the dashboard or by email
          before they take effect.
        </p>
      </LegalSection>

      <LegalSection title="12. Contact us">
        <p>
          For any question about this policy or your personal data, contact us. A grievance
          officer is available for complaints under the IT (Intermediary Guidelines and Digital
          Media Ethics Code) Rules, 2021.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <LegalDetail label="Data controller">{BUSINESS.legalName}</LegalDetail>
          <LegalDetail label="Registered address">{BUSINESS.registeredAddress}</LegalDetail>
          <LegalDetail label="Privacy and support">
            <a href={`mailto:${BUSINESS.supportEmail}`} className="text-primary hover:underline">
              {BUSINESS.supportEmail}
            </a>
          </LegalDetail>
          <LegalDetail label="Grievance officer">
            {BUSINESS.grievanceOfficerName}
            <br />
            <a
              href={`mailto:${BUSINESS.grievanceOfficerEmail}`}
              className="text-primary hover:underline"
            >
              {BUSINESS.grievanceOfficerEmail}
            </a>
          </LegalDetail>
        </div>
      </LegalSection>
    </LegalShell>
  )
}
