/** Read pre-rebrand settings without overwriting newer data or deleting backups. */
export function readStorage(key: string): string | null {
  const current = localStorage.getItem(key)
  if (current !== null) return current
  const legacy = localStorage.getItem(key.replace(/^aixand\./, 'intessio.'))
  if (legacy !== null) {
    try {
      localStorage.setItem(key, legacy)
    } catch {
      // Existing settings remain readable even when storage is full.
    }
  }
  return legacy
}
