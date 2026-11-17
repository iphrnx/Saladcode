'use client'
import { readStored, writeStored } from './storage-keys'

/**
 * Theme management utility.
 * Stores the user's theme preference in localStorage and applies it to the
 * document root element by toggling the `dark` and `light` classes and `data-theme` attribute.
 */

export type Theme = 'dark' | 'light' | 'system'

let systemListenerAttached = false
let storageListenerAttached = false

/**
 * Apply the theme to the document. Call this on the client side.
 */
export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  if (isDark) {
    root.classList.add('dark')
    root.classList.remove('light')
    root.setAttribute('data-theme', 'dark')
  } else {
    root.classList.remove('dark')
    root.classList.add('light')
    root.setAttribute('data-theme', 'light')
  }

  writeStored('theme', theme)

  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme, isDark } }))
    } catch {}
  }
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
 * Initialize the theme from localStorage or an optional server fallback. Called on app mount.
 */
export function initTheme(fallback?: Theme) {
  const chosen = fallback || getStoredTheme()
  applyTheme(chosen)

  if (typeof window !== 'undefined') {
    // Listen for system theme changes if in "system" mode
    if (!systemListenerAttached) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onMediaChange = () => {
        if (getStoredTheme() === 'system') {
          applyTheme('system')
        }
      }
      mq.addEventListener('change', onMediaChange)
      systemListenerAttached = true
    }

    // Listen for storage changes across tabs
    if (!storageListenerAttached) {
      window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key === 'the-salad-theme' && e.newValue) {
          if (e.newValue === 'light' || e.newValue === 'dark' || e.newValue === 'system') {
            applyTheme(e.newValue as Theme)
          }
        }
      })
      storageListenerAttached = true
    }
  }
}
