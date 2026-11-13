'use client'

import { readStored, removeStored, writeStored } from './storage-keys'
import { notifyAccessDenied } from './permission-toast'

/**
 * Client for the Supabase Edge Functions that now serve the API.
 *
 * The paths are deliberately kept identical to the old Next.js routes —
 * `edgeFetch('/api/orders')` calls `/functions/v1/orders`, and
 * `edgeFetch('/api/orders/123/items')` calls `/functions/v1/orders/123/items`.
 * That keeps the migration a mechanical swap at every call site instead of a
 * rewrite of 46 of them.
 *
 * Auth: owners send their Supabase access token as a bearer. Staff carry an
 * HttpOnly cookie set by the staff function, sent automatically by
 * `credentials: 'include'` — nothing staff-related is readable from JavaScript.
 */

/**
 * Where the edge functions live.
 *
 * Normally the Supabase project itself. `NEXT_PUBLIC_EDGE_BASE` points the
 * browser at the local Deno harness instead, so a browser suite can exercise
 * changed function code before it is deployed — sign-in still goes to the real
 * Supabase, only the `/functions/v1` calls move. Unset in every real build, so
 * this is a test affordance and nothing else.
 */
const EDGE_BASE = `${
  process.env.NEXT_PUBLIC_EDGE_BASE ?? process.env.NEXT_PUBLIC_SUPABASE_URL
}/functions/v1`
/** `/api/orders/123?x=1` -> `${EDGE_BASE}/orders/123?x=1` */
function toEdgeUrl(path: string): string {
  const trimmed = path.replace(/^\/api/, '')
  return `${EDGE_BASE}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
}

/**
 * The URL of an edge function, exposed for `navigator.sendBeacon`, which
 * cannot go through `edgeFetch` (a beacon is fire-and-forget: no headers, no
 * response). Only public, token-in-body routes may be called this way.
 */
export function edgeUrl(path: string): string {
  return toEdgeUrl(path)
}

/**
 * How long a request may take before it is given up on.
 *
 * A request that never settles is worse than one that fails: the caller has no
 * error to show, so its button spins for ever. A deployed edge function that
 * hangs (see the Super Admin outage) put an owner in front of exactly that —
 * a "Saving…" pill with nothing behind it. The slow AI calls pass a longer
 * deadline of their own.
 */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long resolving the caller's identity may take before the call goes out
 * without a bearer. A missing token fails fast and visibly; a stall here would
 * freeze the button, because it happens before the request is even sent.
 */
const IDENTITY_TIMEOUT_MS = 5_000

export async function edgeFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init.headers)

  headers.set('apikey', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '')
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  // Owner JWT. Imported lazily so this module stays importable on the server.
  // Skipped entirely on a staff page, so the staff cookie is what authorises
  // the request rather than an owner session that happens to be in the browser.
  if (!staffSession) {
    // Finding out who the caller is can itself stall: reading a session that
    // decides to refresh its token goes to the network first. That happens
    // before the fetch, so the fetch deadline cannot cover it — give it its
    // own. If it runs out, send no bearer and let the call fail with a 401 the
    // page can show, which is still better than a button that never finishes.
    const bearer = await Promise.race([
      (async () => {
        try {
          const { createClient } = await import('./supabase/client')
          const {
            data: { session },
          } = await createClient().auth.getSession()
          return session?.access_token ?? null
        } catch {
          /* no browser session — fall through to the staff token */
          return null
        }
      })(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), IDENTITY_TIMEOUT_MS)),
    ])
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
  } else {
    // A staff page: the staff token identifies the caller. Needed wherever the
    // cookie could not be stored, which is the whole point of the header.
    const token = currentStaffToken()
    if (token) headers.set('x-staff-session', token)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (init.signal) {
    if (init.signal.aborted) controller.abort()
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const res = await fetch(toEdgeUrl(path), {
      ...init,
      headers,
      credentials: 'include',
      signal: controller.signal,
    })
    noteForbidden(res, init.method ?? 'GET')
    return res
  } catch (err: any) {
    // An aborted fetch throws a DOMException reading "The operation was
    // aborted", which means nothing to a restaurant owner and is what the
    // callers toast. Say what actually happened instead — but only when the
    // deadline is what fired: a caller that cancelled its own request already
    // knows why, and must not be told the server was slow.
    if (init.signal?.aborted) throw err
    if (controller.signal.aborted) {
      throw new Error('The server took too long to respond. Please try again.')
    }
    const msg = String(err?.message || '')
    if (/load failed|failed to fetch|network\s?error/i.test(msg)) {
      throw new Error('Unable to reach the server. Please check your internet connection or try again.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether this page is a staff session.
 *
 * The owner's Supabase session and a staff session can both exist in the same
 * browser — an owner testing their own staff login does exactly that. When they
 * do, `guard()` resolves the owner first, so a request carrying the owner's
 * bearer is authorised as the owner no matter which staff member is signed in.
 * That is how a role without orders.manage was able to delete orders: the
 * request was never the staff member's at all.
 *
 * The staff app turns this on while it is mounted, so its requests carry only
 * the staff cookie and are authorised as the staff member.
 */
let staffSession = false

/**
 * The staff session token, kept so it can be sent as a header as well as a
 * cookie.
 *
 * The cookie alone is not enough. It is issued by supabase.co while the app runs
 * on its own origin, which makes it a third-party cookie, and browsers that
 * block those never store it — the sign-in succeeds and then every request
 * arrives unauthenticated. Chrome now partitions such cookies, which covers
 * desktop, but Safari has no equivalent and staff on an iPhone still could not
 * sign in.
 *
 * `guard()` has accepted an `x-staff-session` header all along; this is the
 * client half of that. sessionStorage rather than localStorage: it is cleared
 * when the tab closes and is not shared between tabs, so the token's exposure is
 * limited to the session that is actually using it.
 */

let staffToken: string | null = null

export function rememberStaffToken(token: string): void {
  staffToken = token
  try {
    writeStored('staffToken', token)
  } catch {
    /* storage blocked — the cookie path still works where it is allowed */
  }
}

export function forgetStaffToken(): void {
  staffToken = null
  try {
    removeStored('staffToken')
  } catch {
    /* nothing to clear */
  }
}

function currentStaffToken(): string | null {
  if (staffToken) return staffToken
  if (typeof window === 'undefined') return null
  try {
    staffToken = readStored('staffToken')
  } catch {
    staffToken = null
  }
  return staffToken
}

export function setStaffSession(active: boolean): void {
  staffSession = active
}

/**
 * Told whenever the server answers 403.
 *
 * `guard()` re-derives the caller's permissions on every request, so a role
 * changed mid-session takes effect on the server immediately — but this page
 * still holds the permission list it loaded with. The sidebar and the view gate
 * then disagree with the server: a module is still offered, or a screen is still
 * rendered, that every request now refuses. Re-reading the list is what closes
 * that gap, and a 403 is the moment we know it is worth re-reading.
 *
 * A listener must never be able to break a request, so each is called inside a
 * try and the response is returned either way.
 */
type ForbiddenListener = () => void
const forbiddenListeners = new Set<ForbiddenListener>()

export function onForbidden(listener: ForbiddenListener): () => void {
  forbiddenListeners.add(listener)
  return () => {
    forbiddenListeners.delete(listener)
  }
}

function noteForbidden(res: Response, method: string): void {
  if (res.status !== 403) return
  // A refused *action* (anything but GET) raises one toast here — deduplicated
  // per method+path — so no view code has to remember to; a refused *load*
  // keeps its full AccessDenied screen instead. See permission-toast.ts.
  if (method !== 'GET' && typeof window !== 'undefined') {
    try {
      const url = new URL(res.url)
      notifyAccessDenied(method, url.pathname)
    } catch {
      /* a toast must never break the request it is observing */
    }
  }
  if (forbiddenListeners.size === 0) return
  for (const listener of [...forbiddenListeners]) {
    try {
      listener()
    } catch {
      /* a listener must not be able to fail the request it is observing */
    }
  }
}

/**
 * Staff-scoped request. Deliberately does NOT attach the owner's bearer token.
 *
 * Two reasons:
 *
 *  - The staff session lives in an HttpOnly cookie set by the staff function,
 *    so it is never readable from JavaScript and cannot be lifted by an XSS.
 *    `credentials: 'include'` is what sends it.
 *  - `edgeFetch` prefers the owner's bearer token when one exists, and the
 *    server's `guard()` resolves an owner session before a staff one. So on a
 *    browser where an owner is also signed in — the normal case when an owner
 *    tests their own staff login — a staff call carrying that bearer would be
 *    authenticated as the owner, and the staff endpoints require a staff
 *    session. Opting out of the bearer is therefore required, not just tidy.
 */
export async function staffFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('apikey', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '')
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  // Carry the token as well as the cookie — see rememberStaffToken.
  const token = currentStaffToken()
  if (token) headers.set('x-staff-session', token)
  const res = await fetch(toEdgeUrl(path), { ...init, headers, credentials: 'include' })
  noteForbidden(res, init.method ?? 'GET')
  return res
}

