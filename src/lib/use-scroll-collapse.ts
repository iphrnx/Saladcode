'use client'

import { useRef, useState, useEffect } from 'react'

/**
 * useScrollCollapse — the "header shrinks as you scroll" effect.
 *
 * Attach `scrollRef` to the scrollable content container. Past the collapse
 * threshold the header contracts to give content more room; returning near the
 * top expands it again.
 *
 * Three things this deliberately does *not* do, each because a version of it did
 * and the page felt broken for it:
 *
 *  - **It does not write `scrollTop`.** Two earlier versions tried to hide the
 *    shift the collapse causes by adjusting the scroll position per frame while
 *    the header animated. That fights the reader: while they scroll with a
 *    finger or a trackpad, those writes pin the content back, and the page
 *    visibly judders up and down. Measured on the Role Access page, six frames
 *    in a single downward scroll moved *backwards*, the worst by 55px. The
 *    browser's own scroll anchoring does this job — it keeps the content under
 *    the reader stable when something above it changes size — natively, without
 *    competing with the reader for the scroll position. Nothing here sets
 *    `overflow-anchor: none`, which would disable it.
 *
 *  - **It does not collapse at the same threshold it expands at.** That makes
 *    the state chatter whenever the scroll position sits on the boundary, and
 *    each toggle changes the header's height, which shifts the content, which
 *    re-triggers the check. Collapsing at 48px and expanding only below 12px
 *    leaves a dead zone between them.
 *
 *  - **It does not write state it already holds.** Calling setState on every
 *    animation frame with an identical value makes React bail out of the render
 *    but still queues work on every scroll frame.
 */
export function useScrollCollapse(collapseAt = 48, expandAt = 12) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(false)

  // Latest value, so the scroll handler never needs re-creating.
  const collapsedRef = useRef(false)

  useEffect(() => {
    let frame = 0

    /**
     * One listener at the document, deciding from the event's target.
     *
     * A single ref is not enough: views render both their mobile and desktop
     * layout and hide one with CSS, so two scroll containers exist and the ref
     * can only hold one — often the hidden one, which has no box and cannot
     * scroll. Scroll events do not bubble but can be captured on the way down,
     * so one listener sees them all.
     */
    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement | null
      if (!target || typeof target.scrollTop !== 'number') return

      const rect = target.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return // a hidden duplicate

      // Only a pane that scrolls vertically. A sideways swipe on a filter strip
      // fires scroll events too, and reacting to those collapsed the header
      // mid-swipe.
      if (target.scrollHeight <= target.clientHeight + 4) return

      const top = target.scrollTop
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!collapsedRef.current && top > collapseAt) {
          collapsedRef.current = true
          setCollapsed(true)
        } else if (collapsedRef.current && top < expandAt) {
          collapsedRef.current = false
          setCollapsed(false)
        }
      })
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [collapseAt, expandAt])

  return { scrollRef, collapsed }
}
