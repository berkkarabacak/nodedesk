import type { Settings, Theme } from './api'

/** Resolve the effective theme. Light is the product default for new
 * installs; an explicit stored preference always wins (SPEC §05). */
export function resolveTheme(settings: Pick<Settings, 'theme'>): Theme {
  return settings.theme === 'dark' ? 'dark' : 'light'
}

/** Apply a theme to every app-owned surface via the shared tokens. */
export function applyTheme(theme: Theme) {
  if (theme === 'dark') {
    document.documentElement.dataset.theme = 'dark'
  } else {
    delete document.documentElement.dataset.theme
  }
}
