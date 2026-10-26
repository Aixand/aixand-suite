import { useEffect, useRef, useState } from 'react'
import type { Model } from './client'
import type { AgentsModel } from './model'

type Selection = { id: string; provider: string; profile: string | null; auth?: string | null; cwd: string }
type Catalog = { key: string; models: Model[]; loading: boolean; error: string }

export function useProfileModels(agents: AgentsModel, selection?: Selection) {
  const api = useRef(agents)
  api.current = agents
  const key = selection ? JSON.stringify(selection) : ''
  const [catalog, setCatalog] = useState<Catalog>({ key: '', models: [], loading: false, error: '' })
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!key || agents.status !== 'connected') return
    let alive = true
    const { provider, profile, cwd } = JSON.parse(key) as Selection
    setCatalog({ key, models: [], loading: true, error: '' })
    void api.current.request<Model[]>('models', { provider, profile, cwd })
      .then((models) => { if (alive) setCatalog({ key, models, loading: false, error: '' }) })
      .catch((cause: unknown) => {
        if (alive) setCatalog({ key, models: [], loading: false,
          error: cause instanceof Error ? cause.message : 'Model list could not be loaded.' })
      })
    return () => { alive = false }
  }, [key, agents.status, revision])

  return {
    models: catalog.key === key ? catalog.models : [],
    loading: Boolean(key && agents.status === 'connected' && (catalog.key !== key || catalog.loading)),
    error: catalog.key === key && agents.status === 'connected' ? catalog.error : '',
    refresh: () => setRevision((previous) => previous + 1),
  }
}
