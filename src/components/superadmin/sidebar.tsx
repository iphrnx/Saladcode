'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Activity,
  Building2,
  CreditCard,
  FileBarChart,
  Funnel,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MessageSquareWarning,
  ScrollText,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { superAdminLogout } from '@/lib/superadmin'

type NavItem = { name: string; href: string; icon: typeof LayoutDashboard; hint?: string }

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Overview',
    items: [
      { name: 'Business Overview', href: '/superadmin', icon: LayoutDashboard },
      { name: 'Conversion', href: '/superadmin/conversion', icon: Funnel, hint: 'Funnel' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { name: 'Restaurant CRM', href: '/superadmin/crm', icon: Building2 },
      { name: 'Retention', href: '/superadmin/retention', icon: LifeBuoy },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { name: 'Payments', href: '/superadmin/payments', icon: CreditCard },
      { name: 'Email Delivery', href: '/superadmin/emails', icon: Mail },
      { name: 'Usage', href: '/superadmin/usage', icon: Activity },
    ],
  },
  {
    label: 'System',
    items: [
      { name: 'Reports', href: '/superadmin/reports', icon: FileBarChart },
      { name: 'Support Issues', href: '/superadmin/issues', icon: MessageSquareWarning },
      { name: 'Audit Log', href: '/superadmin/audit', icon: ScrollText },
      { name: 'Settings', href: '/superadmin/settings', icon: Settings },
    ],
  },
]

export function Sidebar({
  navOpen,
  onClose,
  identity,
}: {
  navOpen: boolean
  onClose: () => void
  identity: { email: string; label: string }
}) {
  const pathname = usePathname()
  const router = useRouter()

  const signOut = async () => {
    await superAdminLogout()
    router.push('/superadmin/login')
    router.refresh()
  }

  const isActive = (href: string) =>
    href === '/superadmin' ? pathname === '/superadmin' : pathname.startsWith(href)

  const nav = (
    <div className="flex h-full flex-col bg-admin-rail text-admin-rail-fg">
      <div className="flex items-center justify-between gap-3 px-5 pb-5 pt-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-admin-accent to-admin-accent-hover text-white shadow-lg shadow-[rgba(234,88,12,0.30)]">
            <ShieldCheck className="size-4.5" />
          </span>
          <div className="leading-tight">
            <p className="text-[15px] font-semibold tracking-tight text-white">The Salad Admin</p>
            <p className="text-[11px] text-admin-rail-fg">Global control panel</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-admin-rail-fg transition hover:bg-admin-rail-active hover:text-white lg:hidden"
          aria-label="Close navigation"
        >
          <X className="size-4" />
        </button>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="px-3 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-admin-rail-fg">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item.href)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition',
                        active
                          ? 'bg-admin-rail-active text-white'
                          : 'text-admin-rail-fg hover:bg-admin-rail-hover hover:text-white',
                      )}
                    >
                      {active && (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-admin-accent" />
                      )}
                      <item.icon
                        className={cn(
                          'size-4 shrink-0 transition',
                          active ? 'text-admin-accent' : 'text-admin-rail-fg group-hover:text-white',
                        )}
                      />
                      <span className="truncate">{item.name}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-admin-rail-border px-5 py-4">
        <p className="truncate text-[12.5px] font-medium text-admin-faint-3">{identity.label}</p>
        <p className="truncate text-[11.5px] text-admin-rail-fg">{identity.email}</p>
        <button
          onClick={signOut}
          className="mt-3 w-full rounded-lg border border-admin-rail-border px-3 py-1.5 text-[12.5px] font-medium text-admin-rail-fg transition hover:border-[rgba(255,255,255,0.16)] hover:bg-admin-rail-hover hover:text-white"
        >
          Sign out
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="sticky top-0 h-[100dvh]">{nav}</div>
      </aside>

      {/* Mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <aside className="relative h-full w-[280px] max-w-[85vw] shadow-2xl">{nav}</aside>
        </div>
      )}
    </>
  )
}
