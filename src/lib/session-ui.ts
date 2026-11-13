import type { Session } from '@/components/app/data-context'

/**
 * What one session row may do, decided by the same rules the server enforces.
 *
 * The badges and the Revoke button must mirror `security/index.ts`'s DELETE
 * route, or the page offers an action the server refuses (or hides one it
 * allows — which is how every owner session came to be labelled "Protected"
 * when the server actually lets the owner end another owner's session):
 *
 *   * the session being used right now is never revocable from this page —
 *     that would be a log-out wearing an admin button, and the server
 *     refuses it for the owner;
 *   * a staff PIN session never ends an owner's session, whatever its
 *     permission set says — the server answers 403;
 *   * anything else (another owner's session, to an owner; any staff
 *     session, to a security manager) is revocable.
 */

export type SessionRight = 'current' | 'protected' | 'revoke' | null

/**
 * Whether `viewerIsOwner` is the account viewing the page.
 *
 * The bootstrap payload sets `currentStaff` only for a staff session, so its
 * absence means the viewer is the owner. (A staff member can hold
 * `security.manage` and view the page; they still may not end owner sessions.)
 */
export function viewerIsOwner(currentStaff: unknown): boolean {
  return !currentStaff
}

/** The label and the action for one session row. */
export function sessionRight(
  canManage: boolean,
  viewerIsOwnerFlag: boolean,
  session: Session,
): SessionRight {
  if (session.current) return 'current'
  if (session.kind === 'owner') {
    // Only the owner ends an owner session — and only on another device.
    return viewerIsOwnerFlag && canManage ? 'revoke' : 'protected'
  }
  return canManage ? 'revoke' : null
}

/**
 * The number of genuine live sessions behind the list.
 *
 * Each row stands for `count` real sessions (the same browser signed in more
 * than once), so the total is the sum of them — not the number of rows,
 * which would understate how many sessions can still be used.
 */
export function activeSessionTotal(sessions: Session[] | undefined): number {
  return (sessions ?? []).reduce((n, s) => n + Number(s.count ?? 1), 0)
}
