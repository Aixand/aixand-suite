import { useEffect, useSyncExternalStore } from 'react'
import type { Model, ModelSnapshot } from './client'
import type { AgentsModel } from './model'

type Selection = { id: string; provider: string; profile: string | null; auth?: string | null; revision?: string; cwd: string }
type Catalog = { models: Model[]; loading: boolean; error: string; checkedAt: number }
type Entry = { catalog: Catalog; listeners: Set<() => void>; pending?: Promise<void> }
const empty: Catalog = { models: [], loading: false, error: '', checkedAt: 0 }
const caches = new WeakMap<AgentsModel['request'], Map<string, Entry>>()
const cacheLifetime = 5 * 60_000

function update(entry: Entry, catalog: Catalog) {
  entry.catalog = catalog
  for (const listener of entry.listeners) listener()
}

function load(entry: Entry, request: AgentsModel['request'], key: string, force = false) {
  if (entry.pending || !force && entry.catalog.checkedAt && Date.now() - entry.catalog.checkedAt < cacheLifetime) return
  const { provider, profile, cwd } = JSON.parse(key) as Selection
  update(entry, { ...entry.catalog, loading: true, error: '' })
  entry.pending = request<ModelSnapshot>('models', { provider, profile, cwd, ...(force ? { refresh: true } : {}) })
    .then(snapshot => {
      if (snapshot?.schema !== 'agent-manager/models-1' || !Array.isArray(snapshot.models))
        throw new Error('The model list is unavailable.')
      update(entry, { models: snapshot.models, loading: false,
        error: snapshot.error?.message || (snapshot.status === 'ok' ? '' : 'The model list is unavailable.'), checkedAt: Date.now() })
    })
    .catch((cause: unknown) => update(entry, { ...entry.catalog, loading: false, checkedAt: Date.now(),
      error: cause instanceof Error ? cause.message : 'Model list could not be loaded.' }))
    .finally(() => { entry.pending = undefined })
}

export function useProfileModels(agents: AgentsModel, selection?: Selection) {
  const key = selection ? JSON.stringify(selection) : ''
  let cache = caches.get(agents.request)
  if (!cache) { cache = new Map(); caches.set(agents.request, cache) }
  let entry = key ? cache.get(key) : undefined
  if (key && !entry) {
    entry = { catalog: empty, listeners: new Set() }
    cache.set(key, entry)
    if (cache.size > 64) for (const [oldKey, old] of cache) {
      if (oldKey !== key && !old.listeners.size && !old.pending) { cache.delete(oldKey); break }
    }
  }
  const current = entry
  const catalog = useSyncExternalStore(listener => {
    current?.listeners.add(listener)
    return () => { current?.listeners.delete(listener) }
  }, () => current?.catalog ?? empty)
  useEffect(() => {
    if (current && agents.status === 'connected') load(current, agents.request, key)
  }, [current, key, agents.status, agents.request])
  return {
    models: catalog.models,
    loading: Boolean(current && agents.status === 'connected' && (catalog.loading || !catalog.checkedAt)),
    error: agents.status === 'connected' ? catalog.error : '',
    refresh: () => { if (current && agents.status === 'connected') load(current, agents.request, key, true) },
  }
}
