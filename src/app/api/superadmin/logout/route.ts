import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Sign out of the admin panel.
 *
 * The admin session lives in an HttpOnly cookie, so the browser cannot clear
 * it itself — it asks the server, and the server clears the cookie and ends
 * the session with Supabase.
 */
export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut()
  } catch (e) {
    console.error('superadmin logout failed', e)
  }
  return NextResponse.json({ ok: true })
}
