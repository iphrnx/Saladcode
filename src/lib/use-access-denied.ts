'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  asActionFailure,
  describeFailure,
  isAuthFailure,
  isPermissionFailure,
  type ApiFailure,
} from './api-error'

/**
 * The screen a view shows when the answer was "you may not".
 *
 * Every view used to answer a 403 the same way it answered a 500: a toast
 * saying the data had failed to load, and then an empty list. That is worse
 * than unhelpful — an empty list is a claim about the restaurant. A Cashier
 * who may not see promos was told "No promo codes yet", which is a statement
 * about their promos that happens to be false.
 *
 * So the two are separated here, once, for every view:
 *
 *   * a failed **load** sets `denied`, and the view renders `<AccessDenied>`
 *     instead of its body — no empty state, no false claim that the restaurant
 *     has no data. The screen then says the right thing for the failure it was:
 *     "Access Denied" for a 403, "sign in again" for a 401, "try again" for a
 *     500 or a dead network.
 *   * a failed **write** is only ever a toast. The user is mid-task and the list
 *     behind the dialog is still valid; taking the screen away would be worse
 *     than the failure.
 *
 * `handleLoadQuiet` is for the loads the screen can live without — a poll, a
 * background refresh, a secondary panel. Those must never blank a page that has
 * already loaded, so they only speak up when the failure is about permission or
 * the session, which the user needs to know about.
 */
export function useAccessDenied() {
  const [denied, setDenied] = useState<ApiFailure | null>(null)

  /**
   * Report a failed load the screen depends on. Always takes over the screen —
   * the alternative is rendering the empty state, which claims there is no data.
   * Returns true, so `if (handleLoad(...)) return` reads naturally.
   */
  const handleLoad = useCallback((error: unknown, subject: string): boolean => {
    setDenied(describeFailure(error, subject))
    return true
  }, [])

  /**
   * Report a failed background load. Never takes over the screen; only a
   * permission or session failure is worth interrupting the user for, because
   * those mean the page they are looking at is about to be wrong.
   */
  const handleLoadQuiet = useCallback((error: unknown, subject: string): ApiFailure => {
    const failure = describeFailure(error, subject)
    if (isPermissionFailure(error) || isAuthFailure(error)) toast.error(failure.message)
    return failure
  }, [])

  /** Report a failed write. Always a toast — never takes over the screen. */
  const handleAction = useCallback((error: unknown, subject: string): void => {
    // A refused write is reported once, by the global 403 listener in
    // edge.ts, with the action-specific "Access Denied" toast. Suppress the
    // per-view copy so a single refused click never stacks two toasts.
    if (isPermissionFailure(error)) return
    toast.error(asActionFailure(error, subject).message)
  }, [])

  return { denied, setDenied, handleLoad, handleLoadQuiet, handleAction }
}
