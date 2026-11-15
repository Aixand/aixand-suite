import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentsModel } from './model'
import type { Profile } from './client'
import { resourceKey, resourceLabel, validDefaults } from './ResourcePicker'
import type { Defaults, ResourceCatalog, Target } from './ResourcePicker'

export function useProfileResources(agents: AgentsModel, profile: Profile) {
  const api = useRef(agents); api.current = agents
  const [saved, setSaved] = useState<Defaults | null>(null)
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const token = ++generation.current
    setLoading(true); setError('')
    try {
      const [defaults, choices] = await Promise.all([
        api.current.request<Defaults>('profile-resources-get', { provider: profile.provider, profile: profile.profile }),
        api.current.request<ResourceCatalog>('resource-catalog', { provider: profile.provider }),
      ])
      validDefaults(defaults)
      if (!choices?.choices || !['instructions', 'skills', 'mcp'].every(kind => Array.isArray(choices.choices[kind as keyof ResourceCatalog['choices']])))
        throw new Error('The resource library is unavailable.')
      if (generation.current === token) { setSaved(defaults); setCatalog(choices) }
    } catch (cause) {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : 'Could not load profile setup.')
    } finally { if (generation.current === token) setLoading(false) }
  }, [profile.provider, profile.profile])
  useEffect(() => {
    if (agents.status === 'connected') void refresh()
    else setLoading(false)
    return () => { generation.current++ }
  }, [refresh, agents.status])
  useEffect(() => {
    const update = () => { if (api.current.status === 'connected') void refresh() }
    const unsubscribe = agents.subscribe(event => {
      if (event && typeof event === 'object' && 'type' in event && typeof event.type === 'string'
        && ['resources-changed', 'skills-changed', 'prompts-changed', 'mcps-changed'].includes(event.type)) update()
    })
    window.addEventListener('focus', update)
    return () => { unsubscribe(); window.removeEventListener('focus', update) }
  }, [agents.subscribe, refresh])
  return { saved, catalog, loading, error, refresh, setSaved }
}

export function profileResourceName(catalog: ResourceCatalog | null, kind: keyof ResourceCatalog['choices'], target: Target) {
  return catalog?.choices[kind].find(row => resourceKey(row.target) === resourceKey(target))?.label ?? resourceLabel(target)
}
