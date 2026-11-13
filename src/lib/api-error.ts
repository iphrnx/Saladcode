/**
 * What actually went wrong with a request, said out loud.
 *
 * Every call site used to collapse every failure into one sentence. A 403, a
 * 500 and a dead network all became "Failed to load QR codes", and the list was
 * then emptied — which reads as "you have no QR codes". A role without
 * `qr.manage` was told their tables had failed to load rather than that they may
 * not see them, and an expired session was told the same thing, so nobody knew
 * whether to retry, sign in, or ask for access.
 *
 * These are the three failures that need different words:
 *
 *   * **401** — we do not know who you are. Sign in again.
 *   * **403** — we know who you are, and you may not do this. Ask for access.
 *   * **5xx / network** — nothing to do with you. Try again.
 *
 * `guard()` on the edge functions answers 401 `{error:"Unauthorized"}` and 403
 * `{error:"Forbidden", required:"<permission>"}`, so the required key is
 * available to name in the message when the server sends it.
 */

export type ApiFailureKind =
  /** 401 — no session, or the session has expired. */
  | 'unauthorized'
  /** 403 — signed in, but this is not allowed. */
  | 'forbidden'
  /** 404 — not there. */
  | 'notfound'
  /** 409 — the server refused because of the current state (a conflict). */
  | 'conflict'
  /** 429 — too many requests. */
  | 'ratelimit'
  /** 5xx — the server broke. */
  | 'server'
  /** The request never reached the server. */
  | 'network'
  /** The request was given up on. */
  | 'timeout'
  | 'unknown'

export interface ApiFailure {
  kind: ApiFailureKind
  /** The HTTP status, or null when the request never got one. */
  status: number | null
  /** The permission the server said was required, when it says. */
  required?: string[]
  /** Whatever the server said, when it said something. */
  serverMessage?: string
  /** A sentence to show a person. */
  message: string
}

/** A failed request, carrying enough to say what went wrong. */
export class ApiError extends Error implements ApiFailure {
  kind: ApiFailureKind
  status: number | null
  required?: string[]
  serverMessage?: string

  constructor(failure: ApiFailure) {
    super(failure.message)
    this.name = 'ApiError'
    this.kind = failure.kind
    this.status = failure.status
    this.required = failure.required
    this.serverMessage = failure.serverMessage
  }
}

/** Whether this failure is "you may not", rather than "it went wrong". */
export function isPermissionFailure(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'forbidden'
}

/** Whether this failure is "we do not know who you are". */
export function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'unauthorized'
}

/**
 * The same failure, said about a change rather than a read.
 *
 * A write and a read can produce the identical status, but they are not the same
 * news: "we could not load the menu" and "your change to the menu was not saved"
 * send the user to different places. Re-deriving the sentence here means a call
 * site does not have to remember to ask for the write wording when it first
 * builds the error.
 */
export function asActionFailure(error: unknown, subject = 'this'): ApiError {
  const failure = describeFailure(error, subject)
  return new ApiError({
    kind: failure.kind,
    status: failure.status,
    required: failure.required,
    serverMessage: failure.serverMessage,
    message: messageFor(failure.kind, subject, failure.required, failure.serverMessage, 'save'),
  })
}

/**
 * A permission key as something a person can read.
 *
 * Two forms, because the same key lands in two different sentences: the Access
 * Denied screen says "Needs: menu management", and a toast says "You do not have
 * permission to manage the menu". `verb` is the bare infinitive so it can follow
 * "to" — the gerund form would give "to managing the menu".
 */
const PERMISSION_LABELS: Record<string, { noun: string; verb: string }> = {
  'dashboard.view': { noun: 'dashboard access', verb: 'open the dashboard' },
  'orders.view': { noun: 'order viewing', verb: 'view orders' },
  'orders.manage': { noun: 'order management', verb: 'manage orders' },
  'menu.view': { noun: 'menu viewing', verb: 'view the menu' },
  'menu.manage': { noun: 'menu management', verb: 'manage the menu' },
  'tables.view': { noun: 'table viewing', verb: 'view tables' },
  'tables.manage': { noun: 'table management', verb: 'manage tables' },
  'promos.view': { noun: 'promo viewing', verb: 'view promo codes' },
  'promos.manage': { noun: 'promo management', verb: 'manage promo codes' },
  'analytics.view': { noun: 'analytics', verb: 'view analytics' },
  'qr.manage': { noun: 'QR code management', verb: 'manage QR codes' },
  'settings.view': { noun: 'settings access', verb: 'view settings' },
  'settings.manage': { noun: 'settings management', verb: 'change settings' },
  'security.view': { noun: 'security access', verb: 'view security' },
  'security.manage': { noun: 'security management', verb: 'change security settings' },
  'roles.view': { noun: 'role viewing', verb: 'view roles' },
  'roles.manage': { noun: 'role management', verb: 'manage roles' },
  'staff.view': { noun: 'staff viewing', verb: 'view staff' },
  'staff.manage': { noun: 'staff management', verb: 'manage staff accounts' },
}

/** The noun form — `qr.manage` -> "QR code management". */
export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission]?.noun ?? permission
}

/** The verb form — `qr.manage` -> "manage QR codes". */
export function permissionAction(permission: string): string {
  return PERMISSION_LABELS[permission]?.verb ?? permission
}

function joinLabels(required: string[] | undefined, label: (p: string) => string): string {
  if (!required?.length) return ''
  const labels = required.map(label)
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`
}

/** "menu management", "menu management or promo management". */
export function describeRequired(required: string[] | undefined): string {
  return joinLabels(required, permissionLabel)
}

/** "manage the menu", "manage the menu or manage promo codes". */
export function describeRequiredActions(required: string[] | undefined): string {
  return joinLabels(required, permissionAction)
}

/** Whether the request was reading something or changing something. */
export type ApiAction = 'load' | 'save'

export interface ApiErrorOptions {
  /** `'save'` for a write, so the sentence is about the change, not the data. */
  action?: ApiAction
}

function kindForStatus(status: number): ApiFailureKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notfound'
  if (status === 409) return 'conflict'
  if (status === 429) return 'ratelimit'
  if (status >= 500) return 'server'
  return 'unknown'
}

/**
 * The sentence for a failure.
 *
 * `subject` names the thing that could not be loaded — "QR codes", "the menu" —
 * so a server failure stays specific while a permission failure stays about
 * permission rather than about the data.
 */
function messageFor(
  kind: ApiFailureKind,
  subject: string,
  required: string[] | undefined,
  serverMessage: string | undefined,
  action: ApiAction,
): string {
  const needs = describeRequiredActions(required)
  const saving = action === 'save'
  switch (kind) {
    case 'unauthorized':
      return 'Your session has expired. Please sign in again.'
    case 'forbidden':
      return needs
        ? `You do not have permission to ${needs}.`
        : saving
          ? 'You do not have permission to do that.'
          : `You do not have permission to view ${subject}.`
    case 'notfound':
      return `${subject} could not be found.`
    case 'conflict':
      return serverMessage || `${subject} changed while you were working. Reload and try again.`
    case 'ratelimit':
      return 'Too many requests just now. Please wait a moment and try again.'
    case 'server':
      return saving
        ? `Something went wrong on our side and your change to ${subject} was not saved. Please try again.`
        : `Something went wrong on our side while loading ${subject}. Please try again.`
    case 'network':
      return 'Could not reach the server. Check your connection and try again.'
    case 'timeout':
      return 'The server took too long to respond. Please try again.'
    default:
      return serverMessage || (saving ? `Could not save ${subject}.` : `Could not load ${subject}.`)
  }
}

/** Read the server's own explanation out of a failed response body. */
async function readBody(res: Response): Promise<{ error?: string; required?: string[] }> {
  try {
    const body = await res.clone().json()
    if (!body || typeof body !== 'object') return {}
    const required = Array.isArray(body.required)
      ? body.required.map(String)
      : typeof body.required === 'string'
        ? [body.required]
        : undefined
    return {
      error: typeof body.error === 'string' ? body.error : undefined,
      required,
    }
  } catch {
    return {}
  }
}

/**
 * Turn a failed response into an `ApiError`.
 *
 * Call it only when `!res.ok`; it reads the body, so the response cannot be
 * read again afterwards.
 */
export async function apiError(
  res: Response,
  subject = 'this',
  options: ApiErrorOptions = {},
): Promise<ApiError> {
  const kind = kindForStatus(res.status)
  const { error, required } = await readBody(res)
  return new ApiError({
    kind,
    status: res.status,
    required,
    serverMessage: error,
    message: messageFor(kind, subject, required, error, options.action ?? 'load'),
  })
}

/**
 * `if (!res.ok) throw await apiError(res, 'QR codes')` — the one-line form.
 *
 * A helper rather than a bare `throw` so the subject is stated once, at the
 * call site that knows what it was fetching.
 */
export async function failIfNotOk(
  res: Response,
  subject = 'this',
  options: ApiErrorOptions = {},
): Promise<void> {
  if (!res.ok) throw await apiError(res, subject, options)
}

/**
 * Classify anything a `catch` can hold.
 *
 * A fetch that never reached the server throws a `TypeError` ("Failed to
 * fetch"); an aborted one throws a `DOMException`. `edgeFetch` already turns its
 * own deadline into a sentence, so that one is recognised by its text.
 */
export function describeFailure(
  error: unknown,
  subject = 'this',
  options: ApiErrorOptions = {},
): ApiError {
  if (error instanceof ApiError) return error

  const raw = error instanceof Error ? error.message : String(error ?? '')
  const action = options.action ?? 'load'

  if (/took too long to respond/i.test(raw)) {
    return new ApiError({
      kind: 'timeout',
      status: null,
      message: messageFor('timeout', subject, undefined, raw, action),
    })
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError({
      kind: 'timeout',
      status: null,
      message: messageFor('timeout', subject, undefined, raw, action),
    })
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return new ApiError({
      kind: 'network',
      status: null,
      message: messageFor('network', subject, undefined, raw, action),
    })
  }
  return new ApiError({
    kind: 'unknown',
    status: null,
    serverMessage: raw || undefined,
    message: messageFor('unknown', subject, undefined, raw || undefined, action),
  })
}
