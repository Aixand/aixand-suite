import { useEffect, useRef, useState } from 'react'
import type { BackendDiscovery, Provider } from './client'
import type { AgentsModel } from './model'
import type { ResourceRequest } from './ResourcePicker'
import { requestId } from '../terminals/connection'

type Selection = { provider: Provider; profile: string | null; backend: string; projectId?: string; draftId?: string; model?: string; resources?: ResourceRequest }
type Cache = { selections: Map<string, BackendDiscovery>; latest: Map<string, BackendDiscovery> }
const caches = new WeakMap<AgentsModel['request'], Cache>()

export function useBackendDiscovery(agents: AgentsModel, selection?: Selection) {
  const api = useRef(agents); api.current = agents
  const key = selection ? JSON.stringify(selection) : ''
  let cache = caches.get(agents.request)
  if (!cache) { cache = { selections: new Map(), latest: new Map() }; caches.set(agents.request, cache) }
  const shared = cache
  const live = useRef(key); live.current = key
  const [result, setResult] = useState<{ key: string; snapshot?: BackendDiscovery; error?: string }>()
  const latest = useRef(shared.latest)
  const [revision, setRevision] = useState(0)
  const forced = useRef<string | undefined>(undefined)

  function merge(snapshot: BackendDiscovery) {
    const previous = latest.current.get(snapshot.id)
    const next = previous?.epoch === snapshot.epoch && previous.sequence > snapshot.sequence ? previous : snapshot
    latest.current.set(snapshot.id, next)
    for (const [selectionKey, saved] of shared.selections) if (saved.id === next.id) shared.selections.set(selectionKey, next)
    if (latest.current.size > 64) latest.current.delete(latest.current.keys().next().value!)
    return next
  }

  useEffect(() => api.current.subscribe(message => {
    const event = message as { type?: string; discovery?: BackendDiscovery }
    if (event.type === 'backend-discovery-updated' && event.discovery) {
      const snapshot = merge(event.discovery)
      setResult(previous => previous?.key === live.current && previous.snapshot?.id === snapshot.id ? { key: previous.key, snapshot } : previous)
      if (snapshot.state === 'stale' && snapshot.error) setRevision(value => value + 1)
    }
    if (['profiles-changed', 'resources-changed', 'skills-changed', 'mcps-changed', 'prompts-changed'].includes(event.type ?? '')) {
      if (event.type === 'profiles-changed') { shared.selections.clear(); latest.current.clear(); setResult(undefined) }
      setRevision(value => value + 1)
    }
  }), [])

  useEffect(() => {
    if (!key || agents.status !== 'connected') return
    let alive = true
    const refreshKey = forced.current; forced.current = undefined
    void api.current.request<BackendDiscovery>(refreshKey ? 'backend-discovery-refresh' : 'backend-discovery-get', {
      ...JSON.parse(key), ...(refreshKey ? { key: refreshKey } : {}),
    }).then(snapshot => {
      if (alive && live.current === key && snapshot && typeof snapshot.id === 'string') {
        const next = merge(snapshot)
        shared.selections.set(key, next)
        if (shared.selections.size > 32) shared.selections.delete(shared.selections.keys().next().value!)
        setResult({ key, snapshot: next })
      }
    }).catch((cause: unknown) => {
      if (alive && live.current === key) setResult(previous => ({ key, snapshot: previous?.key === key ? previous.snapshot : undefined,
        error: cause instanceof Error ? cause.message : 'Discovery failed.' }))
    })
    return () => { alive = false }
  }, [key, agents.status, revision])

  const snapshot = result?.key === key ? result.snapshot : shared.selections.get(key)
  return { snapshot, loading: Boolean(key && !(result?.key === key && result.error) && (!snapshot || ['running', 'stale'].includes(snapshot.state))),
    error: result?.key === key ? result.error || snapshot?.error || '' : '',
    check: () => setRevision(value => value + 1),
    refresh: () => { forced.current = requestId(); setRevision(value => value + 1) },
  }
}
