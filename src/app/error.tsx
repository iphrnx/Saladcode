'use client'

import { useEffect } from 'react'

/**
 * Route-level error boundary. Catches render/data errors in the app shell so a
 * single bad response cannot white-screen the whole dashboard.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Surfaces in the browser console and in Vercel's runtime logs.
    console.error('[the-salad] unhandled route error:', error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-2xl border border-border/60 bg-card p-8 text-center shadow-lg">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <span className="text-xl" aria-hidden>
            ⚠
          </span>
        </div>
        <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This screen hit an unexpected error. Your data is safe — try again, and if it keeps
          happening reload the page.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-xs text-muted-foreground/70">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  )
}
