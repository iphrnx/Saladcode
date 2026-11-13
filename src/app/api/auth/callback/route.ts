import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

/**
 * Establish the admin session from a sign-in link.
 *
 * Supabase sends a magic link in one of two shapes, and the browser can only
 * reach one of them:
 *
 *   ?code=…                 PKCE — the code arrives in the query string
 *   #access_token=…&…       implicit — the tokens arrive in the fragment
 *
 * The fragment never reaches the server, so the login page reads it and
 * posts it here. This route then does the part that has to happen on the
 * server: it writes the session into the HttpOnly cookie, and it checks the
 * allowlist before the session is allowed to mean anything.
 *
 * Doing it here rather than in the browser is the point. The browser never
 * holds a token, and a link that is not from the allowlist is signed out
 * again immediately.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      accessToken?: string
      refreshToken?: string
      code?: string
    }

    const supabase = await createClient()
    let userId = ''

    if (body.code) {
      const { data, error } = await supabase.auth.exchangeCodeForSession(body.code)
      if (error) {
        return NextResponse.json(
          { error: 'That sign-in link could not be used. Ask for a new one.' },
          { status: 400 },
        )
      }
      userId = data.user?.id ?? ''
    } else if (body.accessToken && body.refreshToken) {
      const { data, error } = await supabase.auth.setSession({
        access_token: body.accessToken,
        refresh_token: body.refreshToken,
      })
      if (error) {
        return NextResponse.json(
          { error: 'That sign-in link could not be used. Ask for a new one.' },
          { status: 400 },
        )
      }
      userId = data.user?.id ?? ''
    } else {
      return NextResponse.json({ error: 'Nothing to verify' }, { status: 400 })
    }

    if (!userId) {
      return NextResponse.json({ error: 'Verification failed' }, { status: 400 })
    }

    // The allowlist is the authority. A valid session for an account that is
    // not on it is signed out again rather than left lying around.
    const db = supabaseAdmin()
    const { data: userData } = await db.auth.getUser(userId)
    const email = userData?.user?.email ?? ''

    let allowed: {
      id: string
      email: string | null
      label: string | null
      user_id: string | null
    } | null = null

    const { data: byId } = await db
      .from('super_admins')
      .select('id, email, label, user_id')
      .eq('user_id', userId)
      .maybeSingle()
    allowed = byId

    if (!allowed && email) {
      const { data: byEmail } = await db
        .from('super_admins')
        .select('id, email, label, user_id')
        .eq('email', email.toLowerCase())
        .maybeSingle()
      allowed = byEmail
    }

    if (!allowed) {
      await supabase.auth.signOut()
      return NextResponse.json(
        { error: 'This account is not authorised for the admin panel.' },
        { status: 403 },
      )
    }

    if (!allowed.user_id) {
      const { error: bindError } = await db
        .from('super_admins')
        .update({ user_id: userId, last_seen_at: new Date().toISOString() })
        .eq('id', allowed.id)
      if (bindError) console.error('callback: could not bind the allowlist row', bindError)
    } else {
      const { error: seenError } = await db
        .from('super_admins')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', allowed.id)
      if (seenError) console.error('callback: could not record last_seen_at', seenError)
    }

    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('callback error:', e)
    return NextResponse.json(
      { error: e?.message || 'Verification failed' },
      { status: 400 },
    )
  }
}
