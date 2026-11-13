import { edgeFetch } from '@/lib/edge'
import { createClient } from '@/lib/supabase/client'

/**
 * Sign out, properly, and leave.
 *
 * There are three places that offer this — the header menu, the rail, and the
 * drawer on a phone — and they had drifted: the drawer's button had no handler
 * at all, so on a phone the only way out was to close the browser. One
 * implementation, so a fix to signing out is a fix everywhere.
 *
 * The order matters. The server session is cleared first, because a browser
 * session that outlives its server session is the state that leaves a page
 * looking signed in while every request is refused. Both steps are best-effort:
 * if the network is down, the browser session is still cleared and the user
 * still leaves, which is what they asked for.
 */
export async function signOutAndLeave(): Promise<void> {
  try {
    await edgeFetch('/api/auth/logout', { method: 'POST' })
  } catch {
    /* best-effort — clear the local session regardless */
  }
  try {
    await createClient().auth.signOut()
  } catch {
    /* ignore */
  }
  window.location.href = '/?view=login'
}
