import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentsModel } from '../agents/model'

export type InputContract = {
  type: string
  default?: unknown
  enum?: unknown[]
}
export type Prompt = {
  name: string
  description: string
  inputs: Record<string, InputContract>
  instruction_compatible: boolean
}
export type Pack = {
  id: string
  kind: 'draft' | 'release'
  path?: string
  source: string
  source_id: string
  name: string
  version: string | null
  digest: string | null
  description?: string
  reference?: string
  status: string
  error?: string
  prompts: Prompt[]
  editable?: boolean
}
export type ProfileBinding = {
  profile: string
  binding: { reference: string; inputs: Record<string, unknown> } | null
  binding_digest: string | null
  error?: string
}
export type Launch = {
  id: string
  profile?: string
  status: string
  thread_id?: string | null
  reference?: string | null
  release?: { digest: string }
  error?: string
}
export type Consumer = {
  id: string
  label: string
  provider?: string
  local?: boolean
  root?: string
  config?: string
  status: string
  error?: string
  profiles: ProfileBinding[]
  launches: Launch[]
  total?: number
  next_offset?: number | null
}
export type Catalog = {
  applications?: import('./Applications').Application[]
  sourceRegistrations?: import('../skills/Sources').Source[]
  store: string
  checked_at: string
  sources: { id: string; label: string; status: string; error?: string }[]
  consumers: Consumer[]
  packs: Pack[]
}
export type Details = {
  entry: Pack
  release: { digest: string | null }
  manifest: Record<string, unknown>
  files: Record<string, string>
  dependencies: Record<string, unknown>
  inspection_error?: string
}
export type Snapshot = {
  status: string
  thread_id: string | null
  instructions: {
    reference: string
    developer_instructions: string
    delivery_digest: string
    provenance: Record<string, unknown>
  } | null
}

export function usePrompts(agents: AgentsModel) {
  const api = useRef(agents); api.current = agents
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refreshTask = useRef<Promise<void> | null>(null)
  const refreshAgain = useRef(false)
  const refresh = useCallback(async () => {
    if (api.current.status !== 'connected') return
    if (refreshTask.current) { refreshAgain.current = true; return refreshTask.current }
    const token = generation.current
    setLoading(true)
    const task = api.current.request<Catalog>('prompts-catalog').then(value => {
      if (generation.current === token) { setCatalog(value); setError('') }
    }).catch((cause: unknown) => {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : 'Could not refresh prompts.')
    }).finally(() => {
      if (refreshTask.current !== task || generation.current !== token) return
      refreshTask.current = null; setLoading(false)
      if (refreshAgain.current) { refreshAgain.current = false; void refresh() }
    })
    refreshTask.current = task
    return task
  }, [])
  useEffect(() => {
    generation.current++; refreshTask.current = null; refreshAgain.current = false; setLoading(false)
    if (agents.status !== 'connected') return
    void refresh()
    const unsubscribe = api.current.subscribe(message => {
      if ((message as { type: string }).type === 'prompts-changed') void refresh()
    })
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { generation.current++; unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [agents.status, refresh])
  const request = useCallback(<T>(op: string, args: object = {}) => api.current.request<T>(op, args), [])
  return { catalog, connected: agents.status === 'connected', status: agents.status, loading, error, refresh, request, reconnect: agents.connect }
}
