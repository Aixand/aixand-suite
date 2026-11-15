import { useEffect, useState } from 'react'

export type WorkVisits = Record<string, number>
export const WORK_VISITS_KEY = 'aixand.home.visits.v1'
const changed = 'aixand:work-visits-changed'
let memory: WorkVisits = {}

export function readWorkVisits(): WorkVisits {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WORK_VISITS_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value)
      .filter(([key, at]) => /^(chat|terminal|workflow|workflow-draft):.+/.test(key) && typeof at === 'number' && Number.isFinite(at) && at > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 200)) as WorkVisits
  } catch { return memory }
}

export function rememberWork(key: string) {
  memory = Object.fromEntries(Object.entries({ ...readWorkVisits(), [key]: Date.now() })
    .sort((a, b) => b[1] - a[1]).slice(0, 200))
  try { localStorage.setItem(WORK_VISITS_KEY, JSON.stringify(memory)) } catch { /* Recency still works for this visit. */ }
  window.dispatchEvent(new CustomEvent(changed))
}

export function rememberWorkRoute(route: string) {
  if (route.startsWith('chat/')) {
    const chat = /^chat\/([a-f0-9-]{36})(?:\/supervision\/[a-f0-9-]{36})?$/i.exec(route)
    if (chat) rememberWork('chat:' + chat[1])
    return
  }
  const match = /^(chat|terminals|workflows)\/([^?]+)$/.exec(route)
  if (!match) return
  try {
    const kind = match[1] === 'terminals' ? 'terminal' : match[1] === 'workflows'
      ? match[2].startsWith('runs/') ? 'workflow' : 'workflow-draft' : 'chat'
    rememberWork(`${kind}:${decodeURIComponent(kind === 'workflow' ? match[2].slice(5) : match[2])}`)
  } catch { /* Ignore malformed bookmarks. */ }
}

export function useWorkVisits() {
  const [visits, setVisits] = useState(readWorkVisits)
  useEffect(() => {
    const sync = () => setVisits(readWorkVisits())
    sync()
    window.addEventListener(changed, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(changed, sync); window.removeEventListener('storage', sync) }
  }, [])
  return visits
}
