'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser Supabase client (anon key).
 *
 * Used for: owner sign-in / sign-up, and Realtime order subscriptions.
 * Every query is subject to RLS — this client can only ever see the tenant
 * the signed-in owner belongs to.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
