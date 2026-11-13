import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getSuperAdminIdentity } from '@/lib/superadmin-server'
import { AdminShell } from '@/components/superadmin/shell'

/**
 * The guarded Super Admin panel.
 *
 * The check runs on the server, before anything is rendered, so an
 * unauthorised visitor never receives the shell — not the navigation, not a
 * spinner, nothing. The API behind the panel checks the same allowlist
 * again on every request; this is the outer wall, that is the inner one.
 *
 * The login page deliberately sits outside this layout (in the `(auth)`
 * route group), so signing in is not a redirect loop.
 */
export default async function SuperAdminPanelLayout({
  children,
}: {
  children: ReactNode
}) {
  const check = await getSuperAdminIdentity()

  if (!check.ok) {
    if (check.status === 403) {
      redirect('/superadmin/login?error=not-authorised')
    }
    redirect('/superadmin/login')
  }

  return (
    <AdminShell
      identity={{ email: check.identity.email, label: check.identity.label }}
    >
      {children}
    </AdminShell>
  )
}
