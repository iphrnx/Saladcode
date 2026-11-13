'use client'

import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query from a client component.
 *
 * SSR-safe: starts `false` and settles on mount, so the first paint never
 * depends on the window. Used by the calendar popovers to switch between the
 * desktop rail layout and the compact mobile layout.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const update = () => setMatches(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [query])

  return matches
}
