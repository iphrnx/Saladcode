'use client'

import { ShieldAlert, ShieldX, LogIn, RefreshCw, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useT } from '@/lib/i18n'
import { useApp } from '@/components/app/data-context'
import { describeRequired, type ApiFailure } from '@/lib/api-error'
import { canView, VIEW_PERMISSIONS, firstAllowedView } from '@/lib/permissions'
import type { ViewKey } from '@/lib/store'

/**
 * The screen for "you may not", as opposed to "it broke".
 *
 * Three different failures used to share one sentence, and none of them was
 * true. A role without `qr.manage` was told "Failed to load QR codes" and shown
 * an empty list, which reads as a restaurant with no tables rather than a
 * permission they do not hold. An expired session was told the same thing, so
 * the owner retried instead of signing in.
 *
 * The three are now separate, and each says what to do about it:
 *
 *   * **403** — Access Denied. Names the permission, and offers a way back to
 *     something the role can actually use.
 *   * **401** — the session is gone. Offers a sign-in.
 *   * **5xx / network** — not the role's fault. Offers a retry.
 *
 * The permission is named rather than the role, because the role name is not
 * what decides access — and because "ask for `menu.manage`" is something an
 * owner can act on.
 */

interface AccessDeniedProps {
  /** The failure, as classified by `apiError` / `describeFailure`. */
  failure: ApiFailure
  /** What was being opened, for the fallback sentence — "the menu". */
  subject?: string
  /** Retry, for the failures that are worth retrying. */
  onRetry?: () => void
  /** The view that was refused, so a way back can be offered. */
  view?: ViewKey
}

export function AccessDenied({ failure, subject, onRetry, view }: AccessDeniedProps) {
  const t = useT()
  const { data } = useApp()

  const isForbidden = failure.kind === 'forbidden'
  const isUnauthorized = failure.kind === 'unauthorized'
  const needs = describeRequired(failure.required)

  // Where to send someone who is allowed to be here but not on this screen.
  // `firstAllowedView` falls back to the dashboard, which every role that can
  // sign in at all can open.
  const landing = firstAllowedView(data?.permissions)
  const canLandSomewhere = landing && landing !== view

  const Icon = isForbidden ? ShieldX : ShieldAlert
  const title = isUnauthorized
    ? t('access.signInAgain')
    : isForbidden
      ? t('access.title')
      : t('access.failedTitle')

  const body = isUnauthorized
    ? t('access.expired')
    : isForbidden
      ? needs
        ? `${t('access.body')} ${t('access.needs')}: ${needs}.`
        : t('access.body')
      : failure.message ||
        `Something went wrong while loading ${subject ?? 'this page'}. Please try again.`

  const signIn = () => {
    // A staff member whose session expired must be sent to their own door,
    // not the owner sign-in — the owner login page is not for them, and
    // telling them to sign in there is how staff used to get stranded.
    window.location.href = data?.currentStaff ? '/?view=staff-login' : '/?view=login'
  }

  return (
    <div className="h-full flex items-center justify-center p-4 md:p-6">
      <Card className="max-w-md w-full p-5 md:p-6 text-center rounded-2xl border-border bg-card">
        <Icon
          className={`h-12 w-12 mx-auto mb-3 ${isForbidden ? 'text-amber-500' : 'text-muted-foreground'}`}
        />
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground mt-1">{body}</p>

        {isForbidden && (
          <p className="text-xs text-muted-foreground mt-2">{t('access.hint')}</p>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
          {isUnauthorized && (
            <Button size="sm" onClick={signIn}>
              <LogIn className="h-3.5 w-3.5" />
              {t('access.signInAgain')}
            </Button>
          )}
          {!isUnauthorized && onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('access.retry')}
            </Button>
          )}
          {isForbidden && canLandSomewhere && (
            <Button size="sm" variant="outline" onClick={() => window.location.assign(`/?view=${landing}`)}>
              {t('access.goTo')} {t(`nav.${landing}`)}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}

/**
 * The same screen, decided from the permission list rather than from a failed
 * request — for a view that is about to render and must not.
 *
 * Used by the view router, so a typed-in URL is refused before the view mounts
 * and before it fires the requests that would have produced the misleading
 * "failed to load" in the first place.
 */
export function AccessDeniedForView({ view }: { view: ViewKey }) {
  const { data } = useApp()
  const permission = VIEW_PERMISSIONS[view]
  return (
    <AccessDenied
      view={view}
      failure={{
        kind: 'forbidden',
        status: 403,
        required: permission && permission.length > 0 ? permission : undefined,
        message: '',
      }}
    />
  )
}

/** Whether this role may open this view at all. */
export function mayOpenView(permissions: string[] | undefined, view: ViewKey): boolean {
  return canView(permissions, view)
}
