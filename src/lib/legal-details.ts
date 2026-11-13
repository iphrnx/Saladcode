/**
 * The business details the legal pages are required to state.
 *
 * Every value in square brackets is a **placeholder** — it has deliberately not
 * been filled in, because inventing a registered entity name, address or
 * grievance officer would be worse than leaving a gap. Replace the bracketed
 * values with your real details and the pages are complete; nothing else needs
 * editing.
 *
 * While any value is still a placeholder the legal pages ask search engines not
 * to index them (see `legalIndexable` below) so an unfinished policy cannot be
 * served as if it were final.
 */
export const BUSINESS = {
  /** The product, as it is branded on the site. */
  productName: 'The Salad',
  /** The registered business or company that operates it. */
  legalName: '[Registered business name]',
  entityType: '[Business type — e.g. Private Limited Company, LLP, sole proprietorship]',
  registeredAddress: '[Registered address, India]',
  /** Where legal notices should be sent. */
  legalEmail: '[legal email address]',
  supportEmail: '[support email address]',
  phone: '[support phone number]',
  /** Required by the IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021. */
  grievanceOfficerName: '[Grievance Officer name]',
  grievanceOfficerEmail: '[grievance officer email address]',
  /** The courts that have jurisdiction over disputes. */
  jurisdiction: '[City], India',
  /** Shown on each policy as the date it took effect. */
  effectiveDate: '[effective date — e.g. 24 October 2026]',
} as const

/** The site the pages describe. */
export const SITE_URL = 'https://www.thesalad.in'

/**
 * Whether the details above have been filled in.
 *
 * Nothing here is a legal judgement — it only stops a policy that still says
 * "[Registered business name]" from being indexed as though it were finished.
 */
export const legalDetailsFilled = !Object.values(BUSINESS).some(
  (value) => typeof value === 'string' && value.trim().startsWith('['),
)

/** Robots metadata for the legal pages: indexable once the details are real. */
export const legalRobots = legalDetailsFilled
  ? undefined
  : { index: false as const, follow: true as const }
