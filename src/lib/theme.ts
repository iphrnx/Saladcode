'use client'
import { readStored, writeStored } from './storage-keys'

/**
 * Theme management utility.
 * Stores the user's theme preference in localStorage and applies it to the
 * document root element by toggling the `dark` class.
 */

export type Theme = 'dark' | 'light' | 'system'

/**
 * Apply the theme to the document. Call this on the client side.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  if (isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }

  writeStored('theme', theme)
}

/**
 * Get the stored theme (or default 'dark').
 */
export function getStoredTheme(): Theme {
  try {
    const stored = readStored('theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    /* ignore */
  }
  return 'dark'
}

/**
 * Initialize the theme from localStorage. Called on app mount.
 */
export function initTheme() {
  applyTheme(getStoredTheme())

  // Listen for system theme changes if in "system" mode
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => {
      if (getStoredTheme() === 'system') {
        applyTheme('system')
      }
    })
  }
}
