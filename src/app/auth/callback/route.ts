import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const requestUrl = new URL(req.url)
  const code = requestUrl.searchParams.get('code')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Successful sign in, redirect to superadmin dashboard
      return NextResponse.redirect(`${requestUrl.origin}/superadmin`)
    }
  }

  // Return user to a page with error message if sign-in fails
  return NextResponse.redirect(`${requestUrl.origin}/superadmin/login?error=callback_error`)
}
