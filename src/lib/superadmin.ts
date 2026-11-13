'use client'

/**
 * Client for the Super Admin API.
 *
 * Every call goes to this app's own origin, at /api/superadmin/*. The server
 * there holds the session cookie, checks the allowlist and forwards to the
 * edge function. The browser never sees a token and never talks to the edge
 * function directly.
 *
 * Unlike the old pages, this reports what actually went wrong. The previous
 * version threw `Error 401: Unauthorized or not found` for every non-OK
 * response, which is how a missing session ended up looking like a missing
 * restaurant.
 */

export type SuperAdminResult<T = unknown> = {
  ok: boolean
  status: number
  data: T | null
  error: string | null
}

/**
 * How long a call may take before it is given up on.
 *
 * The edge function behind this panel hangs when it is broken — it accepts the
 * request and never answers. Without a deadline the awaited fetch never
 * settles, the caller's `setLoading(false)` never runs, and the page is a
 * skeleton for ever. A deadline turns that into a message the page can show.
 */
const TIMEOUT_MS = 30_000

export async function superAdminFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS,
): Promise<SuperAdminResult<T>> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // A caller may cancel too — the search box does, so a slow answer for an old
  // query cannot land on top of a newer one.
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    let res: Response
    try {
      res = await fetch(`/api/superadmin/${path.replace(/^\/+/, '')}`, {
        ...init,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch {
      if (init.signal?.aborted) {
        // Cancelled by the caller, not a failure: the caller has already moved on.
        return { ok: false, status: 0, data: null, error: 'Cancelled' }
      }
      return controller.signal.aborted
        ? { ok: false, status: 0, data: null, error: 'The server took too long to respond. Please try again.' }
        : { ok: false, status: 0, data: null, error: 'Could not reach the server' }
    }

    // Reading the body is bounded by the same deadline as the request: a
    // server that sends headers and then stops is still a hang.
    const text = await res.text()
    let data: T | null = null
    let error: string | null = null

    try {
      const parsed = text ? JSON.parse(text) : null
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        error = String((parsed as { error: unknown }).error)
      }
      data = parsed as T
    } catch {
      // Not JSON — a CSV export, or an error page.
      data = text as unknown as T
      if (!res.ok) error = text || `Request failed (${res.status})`
    }

    if (!res.ok && !error) error = `Request failed (${res.status})`

    return { ok: res.ok, status: res.status, data, error }
  } catch {
    return controller.signal.aborted
      ? { ok: false, status: 0, data: null, error: 'The server took too long to respond. Please try again.' }
      : { ok: false, status: 0, data: null, error: 'Could not read the server response' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sign out of the admin panel.
 *
 * Only ends the server session and clears the cookie. The caller navigates,
 * so it can use the router rather than a full page load.
 */
export async function superAdminLogout(): Promise<void> {
  try {
    await fetch('/api/superadmin/logout', { method: 'POST', credentials: 'same-origin' })
  } catch {
    // Even if the request failed, the caller still leaves the panel.
  }
}
