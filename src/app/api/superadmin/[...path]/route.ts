import { NextRequest, NextResponse } from 'next/server'
import { getSuperAdminIdentity } from '@/lib/superadmin-server'

/**
 * /api/superadmin/*
 *
 * The secure door between the browser and the admin edge function.
 *
 * The browser holds an HttpOnly session cookie and nothing else. It cannot
 * read a token, cannot write one, and cannot reach the edge function
 * directly with a token of its own — the function lives on another origin,
 * and the browser never talks to it for admin data.
 *
 * This route, on the server:
 *   1. reads the session from the cookie;
 *   2. checks the `super_admins` allowlist;
 *   3. forwards the request to the edge function with the caller's own
 *      access token, so the edge function's own guard authorises it again.
 *
 * The service-role key never leaves the server, and the browser never sees a
 * token. The one thing the browser can do is ask a question, and the answer
 * is "no" unless the allowlist says yes.
 */
export const dynamic = 'force-dynamic'

async function handler(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path } = await ctx.params
  const route = (path ?? []).join('/')

  const check = await getSuperAdminIdentity()
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status })
  }

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!base || !anonKey) {
    return NextResponse.json({ error: 'Server is not configured' }, { status: 500 })
  }

  const headers: Record<string, string> = {
    apikey: anonKey,
    authorization: `Bearer ${check.identity.accessToken}`,
  }

  const method = req.method
  const init: RequestInit = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['content-type'] = 'application/json'
    init.body = await req.text()
  }

  const search = req.nextUrl.search
  const target = `${base}/functions/v1/super-admin/${route}${search}`

  let res: Response
  try {
    res = await fetch(target, init)
  } catch (e) {
    console.error('superadmin proxy: upstream request failed', e)
    return NextResponse.json({ error: 'Could not reach the admin service' }, { status: 502 })
  }

  const contentType = res.headers.get('content-type') ?? 'application/json'
  const payload = await res.text()

  return new NextResponse(payload, {
    status: res.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  })
}

export const GET = handler
export const POST = handler
export const PATCH = handler
export const PUT = handler
export const DELETE = handler
