export interface MenuPortion {
  id: string
  name: string
  price: number
}

const PRESET_NAMES: Record<string, string> = {
  quarter: 'Quarter',
  half: 'Half',
  full: 'Full',
  regular: 'Regular',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
}

export const PORTION_PRESETS = ['Quarter', 'Half', 'Full'] as const

export function canonicalPortionName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .trim()
    .split(' ')
    .filter(Boolean)
    .join(' ')
  if (!cleaned) return ''
  const preset = PRESET_NAMES[cleaned.toLowerCase()]
  return preset ?? cleaned
}

export function portionIdFromName(name: string, rawId?: unknown): string {
  const candidate = String(rawId ?? '').trim().toLowerCase()
  const base = candidate || name.trim().toLowerCase()
  let slug = ''
  for (let i = 0; i < base.length; i++) {
    const ch = base[i]
    const isAlphaNum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
    if (isAlphaNum) {
      slug += ch
    } else if (slug.length > 0 && !slug.endsWith('-')) {
      slug += '-'
    }
  }
  while (slug.endsWith('-')) slug = slug.slice(0, -1)
  return slug || 'portion'
}

/**
 * Normalise and deduplicate portions on a menu item.
 * Ensures every portion has a stable `id`, canonical `name`, and numeric `price`,
 * and that duplicate portion names/IDs are never rendered in the UI.
 */
export function normalizePortions(value: unknown): MenuPortion[] {
  let list: unknown = value
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list) || list.length === 0) return []

  const seenNames = new Set<string>()
  const seenIds = new Set<string>()
  const out: MenuPortion[] = []

  for (let idx = 0; idx < list.length; idx++) {
    const raw = list[idx]
    if (typeof raw !== 'object' || raw === null) continue
    const name = canonicalPortionName((raw as any).name)
    const price = Number((raw as any).price)
    if (!name || !Number.isFinite(price) || price < 0) continue

    const nameKey = name.toLowerCase()
    if (seenNames.has(nameKey)) continue

    let id = portionIdFromName(name, (raw as any).id)
    if (seenIds.has(id)) {
      id = `${id}-${idx + 1}`
    }

    seenNames.add(nameKey)
    seenIds.add(id)
    out.push({
      id,
      name: name.slice(0, 40),
      price: Math.round(price * 100) / 100,
    })
    if (out.length >= 8) break
  }

  return out
}

/**
 * Format the price display for a menu item card in Menu Manager.
 * Never prints duplicated min-max when min === max (e.g. "₹100.00", not "₹100–₹100.00").
 */
export function formatDishPriceLabel(
  basePrice: number,
  rawPortions: unknown,
  currencySymbol: string,
): string {
  const portions = normalizePortions(rawPortions)
  if (portions.length === 0) {
    return `${currencySymbol}${Number(basePrice || 0).toFixed(2)}`
  }
  const prices = portions.map((p) => p.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  if (min === max) {
    return `${currencySymbol}${min.toFixed(2)}`
  }
  return `${currencySymbol}${min.toFixed(2)} – ${currencySymbol}${max.toFixed(2)}`
}

/**
 * Canonical key for matching a portion in cart lines (case-insensitive).
 */
export function normalizePortionKey(portion?: string | null, portionId?: string | null): string {
  const idKey = String(portionId ?? '').trim().toLowerCase()
  if (idKey) return idKey
  const nameKey = canonicalPortionName(portion).toLowerCase()
  return nameKey ? portionIdFromName(nameKey) : ''
}
