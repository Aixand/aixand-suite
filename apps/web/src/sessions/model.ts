import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentsModel } from '../agents/model'
import type { SessionLibrary } from '../agents/client'

export type SessionFilters = { home?: string; cwd?: string; query?: string; view?: string; offset?: number }
export function useSessionLibrary(agents: AgentsModel, filters: SessionFilters, enabled = true) {
  const api = useRef(agents); api.current = agents
  const settings = JSON.stringify(filters)
  const [data, setData] = useState<SessionLibrary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refresh = useCallback(async (force = false) => {
    if (!enabled || api.current.status !== 'connected') return
    const token = ++generation.current
    setLoading(true)
    try {
      const result = await api.current.request<SessionLibrary>('session-list', { ...JSON.parse(settings), ...(force ? { refresh: true } : {}) })
      if (generation.current === token) { setData(result); setError('') }
    } catch (cause) {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : 'Session history could not be loaded.')
    } finally { if (generation.current === token) setLoading(false) }
  }, [settings, enabled])
  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    if (agents.status === 'connected') setLoading(true)
    const timer = setTimeout(() => { void refresh() }, 150)
    const interval = setInterval(() => { void refresh() }, 10000)
    return () => { clearTimeout(timer); clearInterval(interval); generation.current += 1 }
  }, [refresh, agents.status, enabled])
  return { data, loading, error, refresh }
}
