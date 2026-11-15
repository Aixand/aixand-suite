import { useEffect, useState } from 'react'

export const DISMISSED_REQUESTS_KEY = 'aixand.home.dismissed.v1'
type Dismissals = Record<string, string>
const changed = 'aixand:dismissed-requests-changed'
let memory: Dismissals = {}
function read(): Dismissals {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISSED_REQUESTS_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([key, version]) =>
      /^(chat|workflow|terminal|message|supervision):.+/.test(key) && typeof version === 'string'))
  } catch { return memory }
}
function write(value: Dismissals) {
  memory = value
  try { localStorage.setItem(DISMISSED_REQUESTS_KEY, JSON.stringify(value)) } catch { /* Keep dismissals for this session. */ }
  window.dispatchEvent(new Event(changed))
}
export function useDismissedRequests() {
  const [dismissed, setDismissed] = useState(read)
  useEffect(() => {
    const sync = () => setDismissed(read())
    window.addEventListener(changed, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(changed, sync); window.removeEventListener('storage', sync) }
  }, [])
  return {
    hidden: (key: string, version: string) => dismissed[key] === version,
    dismiss: (key: string, version: string) => write({ ...read(), [key]: version }),
    restore: (key: string) => {
      const next = { ...read() }
      delete next[key]
      write(next)
    },
  }
}
