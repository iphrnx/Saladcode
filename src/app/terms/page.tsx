import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalDetail, LegalList, LegalSection, LegalShell } from '@/components/landing/legal-shell'
import { BUSINESS, legalRobots } from '@/lib/legal-details'

export const metadata: Metadata = {
  title: 'Terms & Conditions',
  description:
    `The terms on which ${BUSINESS.productName} is provided to restaurants — accounts, the free trial and subscriptions, acceptable use, data responsibilities, liability and governing law in India.`,
  alternates: { canonical: '/terms' },
  robots: legalRobots,
}

export default function TermsPage() {
  return (
    <LegalShell
      eyebrow="Legal"
      title="Terms & Conditions"
      intro={`These terms govern the use of ${BUSINESS.productName}, the restaurant software operated by ${BUSINESS.legalName}. By creating an account or using the service, the restaurant and the person accepting these terms agree to them.`}
    >
      <LegalSection title="1. The agreement">
        <p>
          These terms are a legal agreement between {BUSINESS.legalName} ({BUSINESS.entityType},
          &ldquo;we&rdquo;, &ldquo;us&rdquo;) and the restaurant or business that uses{' '}
          {BUSINESS.productName} (&ldquo;you&rdquo;, &ldquo;the restaurant&rdquo;). The person
          who creates the account confirms that they are authorised to accept these terms for the
          restaurant.
        </p>
        <p>
          If you do not agree with these terms, do not use the service. Our{' '}
          <Link href="/privacy" className="text-primary hover:underline">
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link href="/cookies" className="text-primary hover:underline">
            Cookie Policy
          </Link>{' '}
          form part of this agreement.
        </p>
      </LegalSection>

      <LegalSection title="2. The service">
        <p>
          {BUSINESS.productName} is software for running a restaurant: point of sale, table QR
          ordering, order and kitchen flow, staff roles and permissions, menu and portion
          management, promotions, reservations, customer reviews, GST-compliant billing and
          analytics. The service is delivered over the internet; nothing is installed at the
          restaurant beyond a browser.
        </p>
        <p>
          You need your own compatible device, a current browser and an internet connection.
          Restaurant staff may sign in with a PIN on shared devices; you are responsible for
          keeping those devices and PINs under your control.
        </p>
      </LegalSection>

      <LegalSection title="3. Accounts">
        <LegalList
          items={[
            'You must provide accurate details for your restaurant and keep them up to date.',
            'You are responsible for everything done through your account and your staff accounts, and for giving each staff member only the access they need.',
            'Keep your login credentials and staff PINs confidential, and tell us promptly if you believe an account has been used without authorisation.',
            'You must be at least 18 years old and entitled to carry on the business you register.',
            'We may suspend an account that is being used unlawfully, that is endangering the platform or other users, or that is being used to send spam or abusive content — see clause 7.',
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Free trial, subscriptions and payment">
        <LegalList
          items={[
            'New restaurants start on a free trial of the period shown when the account is created. The trial is a full-featured trial, not a reduced version of the product.',
            'When the trial ends without a subscription, the account is not deleted — your menu, orders and settings stay — but the paid features are switched off until you choose a plan.',
            'Current plans and prices are shown on the pricing section of our website. Prices are in Indian Rupees and exclusive of applicable taxes unless stated otherwise.',
            'Payments are collected by our payment gateway. We never see or store card, UPI or bank details.',
            'Subscriptions renew for a further period unless cancelled before the end of the current period. Cancelling takes effect at the end of the period you have already paid for; access continues until then.',
            'If a renewal payment fails, we may hold the account open for a short grace period and then restrict the paid features.',
            'Fees already paid are non-refundable except where required by applicable law. [If you offer refunds in specific circumstances, state them here.]',
            'We may change plan prices. A change will not apply to a period you have already paid for, and we will give notice before it takes effect.',
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Your content and your data">
        <p>
          Your menu, prices, photographs, restaurant details, orders and customer data belong to
          you. You grant us permission to host, process, copy and display that content only as
          needed to run the service for you — for example, to show your menu to a diner who scans
          your table QR code.
        </p>
        <p>
          You are responsible for the content you upload and for the way you use customer data.
          In particular:
        </p>
        <LegalList
          items={[
            'You must have the right to use every image, logo and text you upload, and your menu must not be misleading or unlawful.',
            'You are the data fiduciary for the personal data of your diners that the service collects, and we process it on your instructions. You are responsible for collecting it lawfully and for responding to your customers’ requests about their data.',
            'You must not use the platform to send unsolicited messages to diners, or to collect personal data you do not need.',
          ]}
        />
      </LegalSection>

      <LegalSection title="6. Our intellectual property">
        <p>
          The platform, its source code, design, documentation and the {BUSINESS.productName}{' '}
          name and marks belong to us or our licensors. These terms give you the right to use the
          service while your account is active; they do not transfer ownership of anything.
          You may not copy, resell, reverse-engineer or attempt to extract the source code of the
          service, or use it to build a competing product.
        </p>
      </LegalSection>

      <LegalSection title="7. Acceptable use">
        <p>You must not:</p>
        <LegalList
          items={[
            'use the service in a way that breaks any law, including tax, food-safety and consumer-protection law that applies to your restaurant;',
            'attempt to gain access to another restaurant’s data, probe or bypass the platform’s permission checks, or interfere with its operation;',
            'upload malicious code, or content that is unlawful, defamatory, obscene or infringing;',
            'resell or provide the service to third parties as your own, or exceed the limits of your plan by technical workaround;',
            'use the platform to harass, or to send spam or unsolicited communications.',
          ]}
        />
      </LegalSection>

      <LegalSection title="8. Third-party services">
        <p>
          Some parts of the service rely on third parties — cloud hosting and database,
          authentication, the payment gateway, and the AI provider used for menu scanning and
          dish images. Their availability and their own terms apply to those parts. We choose
          them carefully, but we do not control them.
        </p>
      </LegalSection>

      <LegalSection title="9. Availability and support">
        <p>
          We work to keep the service available at all times, but it may be interrupted for
          maintenance, updates, or reasons outside our control. We may change, add or remove
          features; if we remove a feature your plan is sold with, we will tell you in advance
          where we reasonably can.
        </p>
        <p>
          Support is available using the details on our{' '}
          <Link href="/contact" className="text-primary hover:underline">
            Contact page
          </Link>
          . Response times are not guaranteed unless a separate agreement says otherwise.
        </p>
      </LegalSection>

      <LegalSection title="10. Disclaimers">
        <p>
          The service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis.
          To the extent permitted by law, we do not warrant that the service will be
          uninterrupted or error-free, or that it will meet every requirement of your business.
          You remain responsible for your restaurant&apos;s operations, its prices and taxes, its
          compliance with food-safety and licensing law, and for checking the bills and reports
          the software produces.
        </p>
      </LegalSection>

      <LegalSection title="11. Limitation of liability">
        <p>
          To the extent permitted by applicable law, we are not liable for indirect or
          consequential loss, loss of profit, loss of revenue, loss of goodwill, or loss of data
          that you failed to keep a copy of. Our total liability arising out of or relating to
          the service is limited to the fees you paid us in the twelve months before the event
          giving rise to the claim.
        </p>
        <p>
          Nothing in these terms limits liability that cannot be limited under applicable law.
        </p>
      </LegalSection>

      <LegalSection title="12. Indemnity">
        <p>
          You agree to indemnify us against claims, losses and reasonable costs arising from your
          use of the service, your content, your restaurant&apos;s operations, or your breach of
          these terms or of the law — including claims about the personal data of your diners.
        </p>
      </LegalSection>

      <LegalSection title="13. Suspension and termination">
        <LegalList
          items={[
            'You may stop using the service at any time, and may delete your restaurant from Settings.',
            'We may suspend or end an account that breaches these terms, that is used unlawfully, or where we are required to by law. Where it is reasonable to do so, we will give notice and a chance to fix the problem.',
            'On termination, your right to use the service ends. We will make your data available for a reasonable period on request, and then delete it as described in the Privacy Policy.',
          ]}
        />
      </LegalSection>

      <LegalSection title="14. Changes to these terms">
        <p>
          We may update these terms to reflect changes in the service or the law. The effective
          date at the top will change. Where a change materially affects you, we will notify you
          in the dashboard or by email before it takes effect; continuing to use the service
          after that means you accept the updated terms.
        </p>
      </LegalSection>

      <LegalSection title="15. Governing law and jurisdiction">
        <p>
          These terms are governed by the laws of India. The courts at {BUSINESS.jurisdiction}{' '}
          have exclusive jurisdiction, subject to any right you have to resolve a dispute before
          a consumer forum or other authority that cannot be excluded.
        </p>
      </LegalSection>

      <LegalSection title="16. General">
        <LegalList
          items={[
            'If any part of these terms is found to be unenforceable, the rest continues to apply.',
            'A delay in enforcing a term is not a waiver of it.',
            'These terms, together with the Privacy Policy and Cookie Policy, are the whole agreement between us on this subject.',
            'We may assign this agreement as part of a merger, acquisition or sale of assets; you may not assign it without our written consent.',
          ]}
        />
      </LegalSection>

      <LegalSection title="17. Contact">
        <p>Questions about these terms, notices and legal requests should be sent to:</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <LegalDetail label="Entity">{BUSINESS.legalName}</LegalDetail>
          <LegalDetail label="Registered address">{BUSINESS.registeredAddress}</LegalDetail>
          <LegalDetail label="Legal notices">
            <a href={`mailto:${BUSINESS.legalEmail}`} className="text-primary hover:underline">
              {BUSINESS.legalEmail}
            </a>
          </LegalDetail>
          <LegalDetail label="Support">
            <a href={`mailto:${BUSINESS.supportEmail}`} className="text-primary hover:underline">
              {BUSINESS.supportEmail}
            </a>
          </LegalDetail>
        </div>
      </LegalSection>
    </LegalShell>
  )
}
