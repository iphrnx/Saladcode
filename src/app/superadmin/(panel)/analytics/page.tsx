import { redirect } from 'next/navigation'

/**
 * The old "Analytics" page became "Usage". This redirect keeps any link that
 * still points at the old address working.
 */
export default function SuperAdminAnalytics() {
  redirect('/superadmin/usage')
}
