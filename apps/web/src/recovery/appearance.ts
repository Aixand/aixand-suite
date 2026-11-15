import type { ThemeMode } from 'bbb-design'
import { readStorage } from '../storage'

export function recoveryAppearance(): ThemeMode {
  try {
    const mode = readStorage('aixand.appearance')
    if (mode === 'light' || mode === 'dark') return mode
  } catch { /* Recovery remains available when storage is blocked. */ }
  return 'system'
}
