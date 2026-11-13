'use client'

import { useEffect } from 'react'

/**
 * Sends a sign-in link to the page that can act on it.
 *
 * Supabase delivers a magic link in the shape `?code=…` (PKCE) or
 * `#access_token=…&refresh_token=…` (implicit). The query shape arrives in
 * the server-rendered page, so the root page can route it. The fragment
 * shape never reaches the server at all — the browser keeps it — so it has to
 * be read here and passed on.
 *
 * Which page it should be is decided by the link's own `type`:
 *
 *   type=recovery   a password reset, which the root page already handles
 *   type=signup     an email confirmation, which the confirm view handles
 *   type=magiclink  a sign-in link, which the admin panel handles
 *
 * The project is configured with a Site URL of `thesalad.in` — a bare host
 * with no scheme — so Supabase builds the link with a path instead of an
 * address and the browser lands on the Supabase domain with "requested path
 * is invalid" rather than here. Naming the destination in the request fixes
 * that where the allow list permits it; this covers the case where Supabase
 * falls back to the Site URL, so the link works either way.
 */
export function MagicLinkForwarder() {
  useEffect(() => {
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : ''
    if (!hash) return

    const params = new URLSearchParams(hash)
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')
    if (!accessToken || !refreshToken) return

    const type = params.get('type')
    if (type === 'recovery') {
      // A password reset — the root page's reset view reads the fragment.
      window.history.replaceState({}, '', '/?view=reset-password' + window.location.hash)
      window.location.reload()
      return
    }
    if (type === 'signup') {
      // An email confirmation — the owner's first sign-in, not the admin
      // panel's. Same reload pattern as recovery so the confirm view gets a
      // clean URL with the fragment still in it.
      window.history.replaceState({}, '', '/?view=confirm-email' + window.location.hash)
      window.location.reload()
      return
    }

    // A sign-in link. The admin panel is the only place that exchanges one.
    window.location.replace('/superadmin/login' + window.location.hash)
  }, [])

  return null
}
