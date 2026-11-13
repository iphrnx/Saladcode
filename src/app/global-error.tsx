'use client'

/**
 * Last-resort boundary: catches errors thrown by the root layout itself, so it
 * has to render its own <html> and <body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en" className="dark">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0b0f',
          color: '#f5f5f7',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ maxWidth: 420, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>
            The Salad failed to load
          </h1>
          <p style={{ fontSize: 14, opacity: 0.7, margin: '0 0 24px' }}>
            An unexpected error stopped the app from starting.
          </p>
          {error.digest ? (
            <p style={{ fontFamily: 'monospace', fontSize: 12, opacity: 0.5, margin: '0 0 24px' }}>
              ref: {error.digest}
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              borderRadius: 8,
              border: 'none',
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: 500,
              background: '#ff7e6b',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  )
}
