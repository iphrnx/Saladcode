'use client'

import { AlertTriangle, Clock, X } from 'lucide-react'
import { useState } from 'react'
import { useApp } from './data-context'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { hasPermission } from '@/lib/permissions'

/**
 * The trial, and the plan, said where the owner is standing.
 *
 * The trial running is worth showing — how many days are left is not
 * something an owner should have to go looking for. The trial being over is
 * worth showing too, because the paid features have stopped.
 *
 * It is a banner and not a full screen, because the restaurant still has to
 * be able to take orders while it decides. Nothing here is deleted when a
 * trial ends.
 */
export function TrialBanner() {
  const { data } = useApp()
  const setView = useStore((s) => s.setView)
  const [dismissed, setDismissed] = useState(false)

  // Every button here leads to Billing, which needs `settings.manage`. A role
  // without it was offered "See plans", and the click opened the POS because
  // the router had no billing case; now that it has one, it would open Access
  // Denied. Neither is a thing to offer someone who cannot act on it — but the
  // sentence is still theirs to read. A restaurant whose trial has ended should
  // know why the paid features stopped, whether or not they can fix it.
  const canManageBilling = hasPermission(data?.permissions, 'settings.manage')

  const subscription = data?.subscription
  if (!subscription || dismissed) return null

  if (subscription.isRestricted) {
    return (
      <div className="flex items-center gap-2.5 border-b border-amber-200/70 bg-amber-50 px-3.5 md:px-6 py-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600" />
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-amber-900">
          <span className="font-semibold">Your free trial has ended.</span> Everything you have built
          is still here — pick a plan to switch the paid features back on.
        </p>
        {canManageBilling && (
          <button
            onClick={() => setView('billing')}
            className="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-amber-700"
          >
            See plans
          </button>
        )}
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md p-1 text-amber-700/70 transition hover:bg-amber-100 hover:text-amber-900"
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </button>
      </div>
    )
  }

  // The trial is running. It is only worth a line when the end is close.
  const days = subscription.trialDaysRemaining
  if (!subscription.isTrial || days === null || days > 7) {
    // Not in a trial: the reminder that matters now is a paid period that
    // will not renew itself.
    return <PeriodEndBanner canManageBilling={canManageBilling} />
  }

  return trialBanner(days, setView, () => setDismissed(true), canManageBilling)
}

/**
 * A paid period that ends without renewing itself.
 *
 * A month is a mandate: it renews on its own, so there is nothing to warn
 * about. A year is paid once, so when it runs out nothing charges and the
 * restaurant simply stops being paid — the reminder is the only thing standing
 * between an owner and a surprise. Shown at 30, 7 and 1 day before the period
 * ends; `renewal-reminders` records when each one came due.
 */
function PeriodEndBanner({ canManageBilling }: { canManageBilling: boolean }) {
  const { data } = useApp()
  const setView = useStore((s) => s.setView)
  const [dismissed, setDismissed] = useState(false)

  const subscription = data?.subscription
  if (!subscription || dismissed) return null
  if (!subscription.isPaid || subscription.isTrial) return null
  if (subscription.status !== 'active' || subscription.cancelAtPeriodEnd) return null
  // Monthly renews itself; only a one-off period needs a warning.
  if (subscription.billingInterval !== 'annual' && subscription.billingMode !== 'onetime') return null
  if (!subscription.currentPeriodEnd) return null

  const msLeft = new Date(subscription.currentPeriodEnd).getTime() - Date.now()
  const days = Math.ceil(msLeft / 86_400_000)
  if (days > 30) return null

  return (
    <div className="flex items-center gap-2.5 border-b border-amber-200/70 bg-amber-50 px-3.5 md:px-6 py-2">
      <AlertTriangle className="size-4 shrink-0 text-amber-600" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-amber-900">
        {days > 0 ? (
          <>
            <span className="font-semibold">
              {days} day{days === 1 ? '' : 's'} left
            </span>{' '}
            on your {subscription.planName} plan — it does not renew by itself. Renew to keep
            everything running.
          </>
        ) : (
          <span className="font-semibold">Your paid period has ended.</span>
        )}
      </p>
      {canManageBilling && (
        <button
          onClick={() => setView('billing')}
          className="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-amber-700"
        >
          Renew
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-md p-1 text-amber-700/70 transition hover:bg-amber-100 hover:text-amber-900"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function trialBanner(
  days: number,
  setView: (v: 'billing') => void,
  dismiss: () => void,
  canManageBilling: boolean,
) {

  return (
    <div className="flex items-center gap-2.5 border-b border-blue-200/70 bg-blue-50 px-3.5 md:px-6 py-2">
      <Clock className="size-4 shrink-0 text-blue-600" />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-blue-900">
        <span className="font-semibold">
          {days} day{days === 1 ? '' : 's'} left
        </span>{' '}
        in your free trial.
      </p>
      {canManageBilling && (
        <button
          onClick={() => setView('billing')}
          className={cn(
            'shrink-0 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition',
            'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          Upgrade
        </button>
      )}
      <button
        onClick={dismiss}
        className="shrink-0 rounded-md p-1 text-blue-700/70 transition hover:bg-blue-100 hover:text-blue-900"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
