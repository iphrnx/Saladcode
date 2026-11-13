/**
 * The record of what a visitor chose about cookies.
 *
 * Two rules shape this file. A choice, once made, is honoured on every later
 * visit without asking again. And nothing optional is ever set unless the
 * choice was "all" — so whatever is added later has one place to check
 * rather than each script deciding for itself.
 *
 * The product today sets only essential cookies and storage, so both choices
 * currently behave the same way in practice; the difference is recorded so it
 * means something the moment an optional cookie exists.
 */

export type ConsentChoice = 'all' | 'essential'

/** Where the choice is kept. Listed in the Cookie Policy. */
export const CONSENT_KEY = 'the-salad-cookie-consent'

/**
 * Bumped when what we ask about changes.
 *
 * A choice is only honoured while it answers the current question: if the
 * policy later covers something new, the visitor is asked again rather than
 * being held to a decision they never made.
 */
export const CONSENT_VERSION = 1

/** Announced so anything on the page can reopen the banner. */
export const OPEN_CONSENT_EVENT = 'the-salad:open-cookie-consent'

export type StoredConsent = {
  choice: ConsentChoice
  version: number
  /** When the choice was made, ISO 8601. */
  at: string
}

function isChoice(value: unknown): value is ConsentChoice {
  return value === 'all' || value === 'essential'
}

/** The choice on record, or null if there is none — or none for this version. */
export function readConsent(): StoredConsent | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredConsent>
    if (!isChoice(parsed?.choice)) return null
    if (parsed.version !== CONSENT_VERSION) return null
    return {
      choice: parsed.choice,
      version: CONSENT_VERSION,
      at: typeof parsed.at === 'string' ? parsed.at : new Date().toISOString(),
    }
  } catch {
    // Storage blocked, or a value somebody edited by hand. Treated as no
    // choice: nothing optional is set, and the banner asks again.
    return null
  }
}

export function writeConsent(choice: ConsentChoice): StoredConsent {
  const record: StoredConsent = {
    choice,
    version: CONSENT_VERSION,
    at: new Date().toISOString(),
  }
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(record))
  } catch {
    /* private mode with storage blocked — the choice holds for this visit */
  }
  return record
}

/** Reopen the banner, for the "Cookie settings" link. */
export function openConsentSettings(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_CONSENT_EVENT))
}
