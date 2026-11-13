'use client'

/**
 * The customer menu's theme.
 *
 * The menu a diner sees is the restaurant's, not the diner's. The owner app
 * has its own theme — light, dark or system — and the two must not fight: a
 * diner at a table in daylight should see the restaurant's menu, not whatever
 * their phone prefers, and the restaurant's choice should not change because
 * the owner has dark mode on in the office.
 *
 * So the menu takes the document over while it is up. The theme goes on
 * `<html>`, not only on the menu's own root, because Radix renders the cart
 * sheet and the item sheet in a portal on the document body — outside the
 * menu's wrapper — and a sheet in the wrong palette would be obvious.
 */

import { readStored, writeStored } from './storage-keys'
import {
  normaliseMenuTheme,
  type MenuTheme,
} from '../../supabase/functions/_shared/menu-theme'

export { normaliseMenuTheme }
export type { MenuTheme }

/**
 * The two themes a restaurant can pick.
 *
 * The old list had four — Dark, Light, Warm and Minimal — but Warm and
 * Minimal were never anything but names. The menu is one palette or the
 * other, and both of those are real.
 */
export const MENU_THEMES: {
  id: MenuTheme
  name: string
  description: string
}[] = [
  {
    id: 'light',
    name: 'Light Mode',
    description: 'Bright and airy. The usual choice for a daytime dining room.',
  },
  {
    id: 'dark',
    name: 'Dark Mode',
    description: 'Easier on the eyes in a dim room, and it looks striking.',
  },
]

/**
 * What a stored value means.
 *
 * The rule itself lives in the shared module, so the edge functions that
 * read and write the theme and the browser that applies it cannot disagree.
 */

/**
 * Put the theme on the document.
 *
 * The owner's stored preference is left alone: it is in localStorage under
 * its own key, and the app shell puts it back when it mounts.
 */
export function applyMenuTheme(theme: MenuTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.classList.remove('light')
}



/**
 * The theme this diner was last shown, for this restaurant.
 *
 * It is applied before the server answers, so a returning diner does not see
 * the menu in the wrong palette while it loads.
 */
export function cachedMenuTheme(tenantId?: string | null): MenuTheme | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = readStored('menuTheme')
    if (!raw) return null
    const map = JSON.parse(raw) as Record<string, string>
    const value = tenantId ? map[tenantId] : map.__last
    return value ? normaliseMenuTheme(value) : null
  } catch {
    return null
  }
}

/** Remember the theme, so the next visit starts in the right palette. */
export function cacheMenuTheme(tenantId: string | null | undefined, theme: MenuTheme) {
  if (typeof window === 'undefined') return
  try {
    const raw = readStored('menuTheme')
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, string>
    map[tenantId || '__last'] = theme
    map.__last = theme
    writeStored('menuTheme', JSON.stringify(map))
  } catch {
    /* private mode — the theme is only a nicety */
  }
}
