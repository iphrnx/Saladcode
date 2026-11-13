'use client'

import { ReactNode, useState } from 'react'
import { Sidebar } from './sidebar'
import { Header } from './header'

/**
 * The admin shell.
 *
 * Holds the mobile navigation state so the header's menu button and the
 * sidebar's drawer are the same piece of state, which is what a responsive
 * layout needs and what the previous version did not have at all.
 */
export function AdminShell({
  identity,
  children,
}: {
  identity: { email: string; label: string }
  children: ReactNode
}) {
  const [navOpen, setNavOpen] = useState(false)

  return (
    // 100dvh, not 100vh: on a phone the browser chrome takes the top and
    // bottom of the screen, and a 100vh rail runs off under it.
    <div className="flex min-h-[100dvh] bg-admin-bg text-admin-fg">
      <Sidebar navOpen={navOpen} onClose={() => setNavOpen(false)} identity={identity} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenNav={() => setNavOpen(true)} identity={identity} />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </main>
      </div>
    </div>
  )
}
