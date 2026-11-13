"use client"

import { useEffect, useState } from "react"
import { Toaster as Sonner, ToasterProps } from "sonner"

/**
 * The toast host.
 *
 * The theme comes from the document, because that is where this app keeps it:
 * `next-themes` has no provider here, so `useTheme()` always returned its own
 * default and a toast could be drawn in the light palette over a dark app — and
 * the other way round — depending on the machine's preference rather than the
 * app's.
 *
 * A theme change mid-session does not re-render this (nothing tells it), so a
 * toast shown immediately after switching themes can still be in the previous
 * palette until the page reloads. The colours below come from the app's own
 * tokens, so the common toast is right either way.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const [theme, setTheme] = useState<ToasterProps["theme"]>("dark")

  useEffect(() => {
    const read = () =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light")
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return (
    <Sonner
      theme={theme}
      position="top-center"
      richColors
      closeButton
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
