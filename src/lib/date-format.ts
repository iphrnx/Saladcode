/**
 * Date formatting driven by the restaurant's saved pref_date_format setting.
 * Supports:
 *   - 'DD/MM/YYYY' (e.g. 16/11/2026 - Standard UK/India)
 *   - 'MM/DD/YYYY' (e.g. 11/16/2026 - US)
 *   - 'YYYY-MM-DD' (e.g. 2026-11-16 - ISO)
 */

export type DateFormatPattern = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD'

export const DATE_FORMAT_OPTIONS: { value: DateFormatPattern; label: string; sample: string }[] = [
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY', sample: '16/11/2026' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY', sample: '11/16/2026' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD', sample: '2026-11-16' },
]

export function formatDateWithPattern(
  dateInput: string | number | Date | null | undefined,
  pattern: DateFormatPattern = 'DD/MM/YYYY',
  includeTime = false,
  _timeZone?: string,
): string {
  if (!dateInput) return '—'
  const d = new Date(dateInput)
  if (isNaN(d.getTime())) return '—'

  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')

  let dateStr: string
  switch (pattern) {
    case 'MM/DD/YYYY':
      dateStr = `${mm}/${dd}/${yyyy}`
      break
    case 'YYYY-MM-DD':
      dateStr = `${yyyy}-${mm}-${dd}`
      break
    case 'DD/MM/YYYY':
    default:
      dateStr = `${dd}/${mm}/${yyyy}`
      break
  }

  if (includeTime) {
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${dateStr} ${hh}:${min}`
  }

  return dateStr
}

