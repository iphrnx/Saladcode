'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Cookie, Check, X } from 'lucide-react'
import {
  CONSENT_KEY,
  OPEN_CONSENT_EVENT,
  openConsentSettings,
  readConsent,
  writeConsent,
  type ConsentChoice,
} from '@/lib/cookie-consent'

/**
 * Whether this is the diner's menu, reached by scanning the code on a table.
 *
 * Read from the address rather than through Next's router hooks on purpose: this
 * component sits in the root layout, and `useSearchParams` there would push the
 * whole app into client-side rendering to answer one question about a banner.
 */
function isDinerMenu(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    return params.has('table') || params.get('view') === 'public-menu'
  } catch {
    return false
  }
}

/**
 * The cookie banner.
 *
 * It matches the rest of the product: the dark surface, the hairline border,
 * the single accent colour, the same rounded corners and the same two button
 * weights as the landing page's calls to action.
 *
 * Two deliberate choices:
 *
 * - It renders only after mounting, and only when no choice is on record. The
 *   first avoids a hydration mismatch (the server cannot see local storage);
 *   the second is what makes a choice stick — once someone has answered, this
 *   never appears again on its own.
 * - Both answers are recorded. "Essential only" is not a dismissal; it is a
 *   decision, and it is what keeps an optional cookie from ever being set.
 */
export function CookieConsentBanner() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    // Not on the diner's menu. Someone who has just scanned the code on their
    // table opened a page they did not choose, to order food, and the banner
    // lands over the dishes at the bottom of the screen — the one place on the
    // site where it interrupts something. Nothing there asks for it back, so it
    // simply never appears on that page.
    if (isDinerMenu()) return

    // On a first visit there is no record and the banner appears. After a
    // choice has been made it stays hidden, which is the whole point.
    if (!readConsent()) setOpen(true)

    const reopen = () => setOpen(true)
    window.addEventListener(OPEN_CONSENT_EVENT, reopen)
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, reopen)
  }, [])

  const decide = (choice: ConsentChoice) => {
    writeConsent(choice)
    setOpen(false)
  }

  if (!open) return null

  return (
    <div
      role="region"
      aria-label="Cookie choices"
      className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3 sm:px-8 sm:pb-6"
    >
      <div className="mx-auto max-w-3xl rounded-2xl border border-white/[0.08] bg-card/95 p-4 shadow-2xl backdrop-blur-xl sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <span className="hidden size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary sm:flex">
            <Cookie className="size-4.5" />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">Cookies</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Essential cookies keep you signed in and remember your preferences — the product
              cannot run without them, so they are always on. Nothing else is set: no advertising,
              no analytics, no third-party tracking. Either answer is fine, and whichever you pick
              is remembered and applied to anything optional added later. Read the{' '}
              <Link href="/cookies" className="text-primary hover:underline">
                Cookie Policy
              </Link>
              .
            </p>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <button
                type="button"
                onClick={() => decide('all')}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-5 text-[13px] font-semibold text-primary-foreground transition-premium hover:bg-[#ea580c] hover:-translate-y-px"
              >
                <Check className="size-3.5" />
                Accept All
              </button>
              <button
                type="button"
                onClick={() => decide('essential')}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/12 bg-transparent px-5 text-[13px] font-semibold text-foreground transition-premium hover:bg-white/5"
              >
                <X className="size-3.5" />
                Reject All
              </button>
              <span className="text-[11.5px] text-muted-foreground sm:ml-1">
                Essential cookies are used either way.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A way back to the banner, for anyone who wants to change their mind.
 *
 * It is a button, not a link: it opens the banner on the page you are already
 * on, and the choice itself is the Cookie Policy page's subject, which the
 * footer links to separately.
 */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openConsentSettings}
      className={
        className ??
        'transition-colors hover:text-foreground'
      }
    >
      Cookie settings
    </button>
  )
}

export { CONSENT_KEY }
