import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { resolveAdminOrigin } from '@/lib/superadmin-server'
import { NextResponse } from 'next/server'

/**
 * Request a sign-in code for the Super Admin panel.
 *
 * The gate is the `super_admins` allowlist. Without it this endpoint was an
 * open signup: `signInWithOtp` creates the account for any address that asks,
 * so two stray accounts (phrnx@icloud.com and phrnx@gmail.com) were created
 * this way before the allowlist existed. They could not reach any admin data
 * — the guard caught them — but an admin login screen should not be a way to
 * create accounts.
 *
 * Two deliberate choices:
 *
 *   - the response is the same whether or not the address is on the
 *     allowlist, so this endpoint cannot be used to find out who is an
 *     administrator;
 *   - `shouldCreateUser: false`, so even if the allowlist check were bypassed
 *     no account would be created.
 */
export async function POST(req: Request) {
  try {
    const { email } = await req.json()
    const address = String(email ?? '').trim().toLowerCase()

    if (!address) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const { data: allowed, error: allowlistError } = await supabaseAdmin()
      .from('super_admins')
      .select('id')
      .eq('email', address)
      .maybeSingle()

    if (allowlistError) {
      console.error('OTP: allowlist lookup failed', allowlistError)
      return NextResponse.json({ error: 'Could not start sign-in' }, { status: 500 })
    }

    if (!allowed) {
      // Same answer as a success, so the endpoint reveals nothing.
      return NextResponse.json({ success: true })
    }

    const supabase = await createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: {
        shouldCreateUser: false,
        // The link has to come back to this page, and it has to be an
        // absolute URL. Left to the project's Site URL it does not: that is
        // set to a bare host with no scheme, so Supabase builds the link
        // with a path instead of an address and the browser lands on
        // Supabase's own domain with a "requested path is invalid" page
        // instead of here. Naming the destination fixes that, and means the
        // panel does not depend on the Site URL being right.
        emailRedirectTo: `${resolveAdminOrigin(req)}/superadmin/login`,
      },
    })

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e: any) {
    console.error('OTP Error:', e)
    return NextResponse.json(
      { error: e.message || 'Failed to send sign-in code' },
      { status: 400 },
    )
  }
}
