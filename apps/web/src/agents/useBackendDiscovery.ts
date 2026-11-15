import { useEffect, useRef, useState } from 'react'
import { AgentError, type BackendDiscovery, type Provider } from './client'
import type { AgentsModel } from './model'
import type { ResourceRequest } from './ResourcePicker'
import { requestId } from '../terminals/connection'

type Selection = { provider: Provider; profile: string | null; backend: string; projectId?: string; draftId?: string; model?: string; resources?: ResourceRequest }
type Cache = { selections: Map<string, BackendDiscovery>; latest: Map<string, BackendDiscovery>; pending: Map<string, Promise<BackendDiscovery>>;
  checked: Map<string, number>; errors: Map<string, Error> }
const caches = new WeakMap<AgentsModel['request'], Cache>()
const cacheLifetime = 5 * 60_000

export function useBackendDiscovery(agents: AgentsModel, selection?: Selection) {
  const api = useRef(agents); api.current = agents
  // Status notifications also arrive for allowance checks and running sessions.
  // Only a change to the selected profile's configuration invalidates its list.
  const identity = selection ? agents.catalog?.profiles.filter(row => row.provider === selection.provider &&
    (selection.profile === null || row.profile === selection.profile)).map(row =>
    [row.id, row.revision, row.auth, row.model, row.sdk_credential?.id, row.sdk_authentication, row.claude_account?.id]).sort() : undefined
  const key = selection ? JSON.stringify({ ...selection, identity }) : ''
  const catalogScope = selection ? JSON.stringify({ ...selection, model: undefined, identity }) : ''
  const previousCatalog = useRef<{ scope: string; snapshot: BackendDiscovery } | undefined>(undefined)
  let cache = caches.get(agents.request)
  if (!cache) { cache = { selections: new Map(), latest: new Map(), pending: new Map(), checked: new Map(), errors: new Map() }; caches.set(agents.request, cache) }
  const shared = cache
  const live = useRef(key); live.current = key
  const [result, setResult] = useState<{ key: string; snapshot?: BackendDiscovery; error?: Error }>()
  const latest = useRef(shared.latest)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState('')
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
      const previous = latest.current.get(event.discovery.id)
      if (previous?.epoch === event.discovery.epoch && previous.sequence > event.discovery.sequence) return
      const snapshot = merge(event.discovery)
      if (snapshot.state === 'ready') for (const [selectionKey, saved] of shared.selections) if (saved.id === snapshot.id) {
        shared.errors.delete(selectionKey); shared.checked.set(selectionKey, Date.now())
      }
      if (shared.selections.get(live.current)?.id === snapshot.id) setResult({ key: live.current, snapshot })
      if (snapshot.state === 'stale' && !snapshot.error && shared.selections.get(live.current)?.id === snapshot.id) {
        shared.checked.delete(live.current)
        setRevision(value => value + 1)
      }
    }
    if (['resources-changed', 'skills-changed', 'mcps-changed', 'prompts-changed'].includes(event.type ?? '')) {
      shared.checked.clear()
      setRevision(value => value + 1)
    }
  }), [])

  useEffect(() => {
    if (agents.status !== 'connected') {
      shared.pending.clear()
      setPending('')
    }
  }, [agents.status])

  useEffect(() => {
    if (!key || agents.status !== 'connected') return
    let alive = true
    const refreshKey = forced.current; forced.current = undefined
    const saved = shared.selections.get(key)
    if (!refreshKey && (saved && (saved.state !== 'stale' || saved.error) || shared.errors.has(key)) &&
        Date.now() - (shared.checked.get(key) ?? 0) < cacheLifetime) {
      setPending('')
      setResult({ key, snapshot: saved, error: shared.errors.get(key) })
      return
    }
    setPending(key)
    const requestKey = refreshKey ? `${key}:${refreshKey}` : key
    let task = shared.pending.get(requestKey)
    if (!task) {
      const { identity: _identity, ...args } = JSON.parse(key)
      task = api.current.request<BackendDiscovery>(refreshKey ? 'backend-discovery-refresh' : 'backend-discovery-get', {
        ...args, ...(refreshKey ? { key: refreshKey } : {}),
      }).finally(() => { if (shared.pending.get(requestKey) === task) shared.pending.delete(requestKey) })
      shared.pending.set(requestKey, task)
    }
    void task.then(snapshot => {
      if (snapshot && typeof snapshot.id === 'string') {
        const next = merge(snapshot)
        shared.selections.set(key, next)
        shared.errors.delete(key)
        shared.checked.set(key, Date.now())
        if (shared.selections.size > 32) {
          const oldest = shared.selections.keys().next().value!
          shared.selections.delete(oldest); shared.checked.delete(oldest); shared.errors.delete(oldest)
        }
        if (alive && live.current === key) setResult({ key, snapshot: next })
      }
    }).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error('Discovery failed.')
      shared.errors.set(key, error); shared.checked.set(key, Date.now())
      if (alive && live.current === key) setResult({ key, snapshot: shared.selections.get(key), error })
    }).finally(() => { if (alive) setPending('') })
    return () => { alive = false }
  }, [key, agents.status, revision])

  const snapshot = shared.selections.get(key) ?? (result?.key === key ? result.snapshot : undefined)
  useEffect(() => {
    if (snapshot?.state === 'ready') previousCatalog.current = { scope: catalogScope, snapshot }
  }, [catalogScope, snapshot])
  // A model can change the available settings. Keep the loaded choices visible
  // during that check, without reusing readiness or choices from another context.
  const catalog: Pick<BackendDiscovery, 'models' | 'settings' | 'commands'> | undefined =
    snapshot?.state === 'ready' || previousCatalog.current?.scope !== catalogScope ? snapshot : previousCatalog.current.snapshot
  const failure = shared.errors.get(key) ?? (snapshot?.error ? new AgentError(snapshot.error,
    snapshot.errorCode, undefined, false, undefined, snapshot.setup ?? undefined, snapshot.diagnosticId, snapshot.retryable) : undefined)
  const setup = failure instanceof AgentError && failure.setup ? failure.setup : snapshot?.setup
  return { snapshot, catalog, loading: Boolean(key && agents.status === 'connected' && (pending === key ||
      !failure && !setup && (!snapshot || ['running', 'stale'].includes(snapshot.state)))),
    error: setup ? '' : failure?.message ?? '', cause: setup ? undefined : failure, setup,
    check: () => setRevision(value => value + 1),
    refresh: () => { forced.current = requestId(); setRevision(value => value + 1) },
  }
}
