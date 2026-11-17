/**
 * Order relative date and time formatting in the restaurant's timezone.
 *
 * Formats:
 * - Today: "Today, 02:23 PM"
 * - Yesterday: "Yesterday, 02:23 PM"
 * - Older: "13 Nov 2026, 02:23 PM"
 */

export const DEFAULT_RESTAURANT_TIMEZONE = 'Asia/Kolkata'

/**
 * Validate and sanitize timezone string with fallback to default restaurant timezone.
 */
export function safeTimeZone(tz?: string | null): string {
  if (!tz || typeof tz !== 'string') return DEFAULT_RESTAURANT_TIMEZONE
  const trimmed = tz.trim()
  if (!trimmed) return DEFAULT_RESTAURANT_TIMEZONE
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed })
    return trimmed
  } catch {
    return DEFAULT_RESTAURANT_TIMEZONE
  }
}

/**
 * Calculate milliseconds until the next midnight in the specified timezone.
 * Used to automatically trigger relative date re-renders right at midnight without page reload.
 */
export function msUntilMidnight(timeZone: string, nowMs = Date.now()): number {
  const tz = safeTimeZone(timeZone)
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    }).formatToParts(new Date(nowMs))

    const map: Record<string, number> = {}
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10)
    }
    const hour = map.hour === 24 ? 0 : (map.hour ?? 0)
    const minute = map.minute ?? 0
    const second = map.second ?? 0

    const msPassedToday = ((hour * 60 + minute) * 60 + second) * 1000
    const remaining = 86_400_000 - msPassedToday
    return Math.max(1000, remaining + 500) // 500ms jitter after midnight
  } catch {
    return 60_000
  }
}

/**
 * Format order timestamp relative to restaurant timezone:
 * - Today: "Today, 02:23 PM"
 * - Yesterday: "Yesterday, 02:23 PM"
 * - Older: "13 Nov 2026, 02:23 PM"
 */
export function formatOrderRelativeTime(
  iso?: string | null,
  timeZone = DEFAULT_RESTAURANT_TIMEZONE,
  now = Date.now(),
): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'

  const tz = safeTimeZone(timeZone)

  // Day key in target timezone: "YYYY-MM-DD"
  const dayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })

  const orderDayKey = dayFormatter.format(d)
  const nowDayKey = dayFormatter.format(new Date(now))

  // Time in target timezone: "02:23 PM"
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
  const timeStr = timeFormatter.format(d)

  if (orderDayKey === nowDayKey) {
    return `Today, ${timeStr}`
  }

  // Parse YYYY-MM-DD into UTC epoch days to determine calendar day difference
  const [oy, om, od] = orderDayKey.split('-').map(Number)
  const [ny, nm, nd] = nowDayKey.split('-').map(Number)
  const orderEpochDays = Math.floor(Date.UTC(oy, om - 1, od) / 86_400_000)
  const nowEpochDays = Math.floor(Date.UTC(ny, nm - 1, nd) / 86_400_000)
  const diffDays = nowEpochDays - orderEpochDays

  if (diffDays === 1) {
    return `Yesterday, ${timeStr}`
  }

  // Older: "13 Nov 2026, 02:23 PM"
  const dateFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  const dateStr = dateFormatter.format(d)

  return `${dateStr}, ${timeStr}`
}

