/**
 * The customer menu's theme.
 *
 * This is the one copy of the rule, and both sides use it: the edge functions
 * that read and write the theme, and the browser that applies it.
 */

export type MenuTheme = 'light' | 'dark'

/**
 * What a stored value means.
 *
 * Anything that is not `dark` is `light`. The old options — Warm and
 * Minimal — never did anything, and a restaurant that had one of them
 * stored gets the light menu rather than a blank one.
 */
export function normaliseMenuTheme(value: unknown): MenuTheme {
  return String(value ?? '').trim().toLowerCase() === 'dark' ? 'dark' : 'light'
}

/** The setting key the theme is stored under. */
export const MENU_THEME_KEY = 'menu_theme'
