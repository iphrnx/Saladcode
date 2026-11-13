import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

/**
 * Exchange a sign-in code for the admin session.
 *
 * This is the point where control of the email address has been proven, so
 * it is also the point where the allowlist is checked for real: a valid code
 * for an address that is not on the allowlist ends the session immediately
 * and says so plainly. The address is known to be reachable at this point,
 * so naming the reason leaks nothing new.
 */
export async function POST(req: Request) {
  try {
    const { email, code } = await req.json()
    const address = String(email ?? '').trim().toLowerCase()
    const token = String(code ?? '').trim()

    if (!address || !token) {
      return NextResponse.json({ error: 'Email and code are required' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data, error } = await supabase.auth.verifyOtp({
      email: address,
      token,
      type: 'email',
    })

    if (error) throw error
    if (!data.session) throw new Error('Verification failed')
    const user = data.user
    if (!user) throw new Error('Verification failed')

    const db = supabaseAdmin()

    const { data: allowed, error: allowlistError } = await db
      .from('super_admins')
      .select('id, email, user_id, label')
      .eq('email', address)
      .maybeSingle()

    if (allowlistError) {
      console.error('verify-otp: allowlist lookup failed', allowlistError)
      await supabase.auth.signOut()
      return NextResponse.json({ error: 'Could not verify this account' }, { status: 500 })
    }

    if (!allowed) {
      // The session is real, but this account is not an administrator. End it
      // rather than leaving a valid session behind.
      await supabase.auth.signOut()
      return NextResponse.json(
        { error: 'This account is not authorised for the admin panel.' },
        { status: 403 },
      )
    }

    // Bind the allowlist row to the user id on first sign-in.
    if (!allowed.user_id) {
      const { error: bindError } = await db
        .from('super_admins')
        .update({ user_id: user.id, last_seen_at: new Date().toISOString() })
        .eq('id', allowed.id)
      if (bindError) console.error('verify-otp: could not bind the allowlist row', bindError)
    } else {
      const { error: seenError } = await db
        .from('super_admins')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', allowed.id)
      if (seenError) console.error('verify-otp: could not record last_seen_at', seenError)
    }

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 })
  }
}
