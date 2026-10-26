import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentsModel } from '../agents/model'

export type Project = { id: string; name: string; path: string }
export type DiscoveryFilter = { scope: 'all' | 'roots'; query: string; candidateIds?: string[] }
export type Discovery = {
  id: string; origin: { kind: 'ui' | 'chat' | 'vox'; id: string }; root: string; requestedRoot: string;
  sourceTurnId?: string | null; sourceCallId?: string | null;
  mode: 'preview' | 'add'; includeNested: boolean; exclude: string[]; defaultExclusions: string[];
  state: 'queued' | 'scanning' | 'registering' | 'completed' | 'partial' | 'cancelled' | 'interrupted' | 'failed';
  scanComplete: boolean; revision: number; createdAt: number; updatedAt: number; url: string | null;
  stats: { directories?: number; candidates?: number; nested?: number; excluded?: number; warnings?: number };
  warnings: { path: string; code: string; message: string }[]; reasons: string[]; error?: string | null;
  resultFilter?: DiscoveryFilter;
  filtered?: { matched: number; total: number; preview: Pick<DiscoveryCandidate, 'id' | 'path' | 'suggestedName' | 'classification'>[] };
  registration: { selected: number; added: number; existing: number; unavailable: number; capacity: number; projectIds: string[] } | null;
}
export type DiscoveryCandidate = {
  id: string; path: string; suggestedName: string; signals: string[]; classification: 'root' | 'nested';
  parentCandidateId: string | null; recommended: boolean; existingProjectIds: string[]; unavailable?: boolean;
}
export type DiscoveryResults = { candidates: DiscoveryCandidate[]; total: number; nextOffset: number | null }
export const discoveryActive = (job: Discovery) => ['queued', 'scanning', 'registering'].includes(job.state)
export function discoveryFilterActive(job: Discovery) {
  const value = job.resultFilter
  return !!value && (value.scope === 'roots' || !!value.query || value.candidateIds !== undefined)
}
export function discoveryFilterSummary(job: Discovery) {
  if (!discoveryFilterActive(job) || !job.filtered) return null
  const { matched, total } = job.filtered
  const noun = job.resultFilter?.scope === 'roots' ? 'project root' : 'project'
  const query = job.resultFilter?.query
  return `Showing ${matched} ${noun}${matched === 1 ? '' : 's'}${query ? ` matching “${query}”` : ''} · ${total - matched} hidden`
}
export function discoverySummary(job: Discovery) {
  if (job.registration && !job.error) {
    const value = job.registration
    return `Added ${value.added} ${value.added === 1 ? 'project' : 'projects'} · ${value.existing} already registered${value.unavailable ? ` · ${value.unavailable} unavailable` : ''}`
  }
  return `${job.stats.candidates ?? 0} candidates · ${job.stats.directories ?? 0} directories inspected${job.stats.nested ? ` · ${job.stats.nested} nested` : ''}`
}

export function useProjects(agents: AgentsModel) {
  const api = useRef(agents)
  api.current = agents
  const [projects, setProjects] = useState<Project[]>([])
  const [discoveries, setDiscoveries] = useState<Discovery[]>([])
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refreshSequence = useRef(0)
  const remember = useCallback((jobs: Discovery[]) => {
    setDiscoveries((previous) => {
      const rows = new Map(previous.map((job) => [job.id, job]))
      for (const job of jobs) if (!rows.has(job.id) || rows.get(job.id)!.revision < job.revision) rows.set(job.id, job)
      return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt)
    })
  }, [])

  async function refresh() {
    const current = generation.current
    const sequence = ++refreshSequence.current
    const rows = await api.current.request<Project[]>('project-list')
    if (current === generation.current && sequence === refreshSequence.current) {
      setProjects(rows)
      setError('')
    }
  }
  async function refreshDiscoveries() {
    const current = generation.current
    let offset: number | null = 0
    let count = 0
    while (offset !== null && count < 100) {
      const page: { jobs: Discovery[]; nextOffset: number | null } = await api.current.request(
        'project-discovery-list', { offset, limit: Math.min(20, 100 - count) })
      if (current !== generation.current || !Array.isArray(page.jobs)) return
      remember(page.jobs)
      count += page.jobs.length
      if (!page.jobs.length || page.nextOffset === null || typeof page.nextOffset !== 'number' || page.nextOffset <= offset) return
      offset = page.nextOffset
    }
  }
  useEffect(() => api.current.subscribe((value) => {
    const message = value as { type: string; discovery?: Discovery }
    if (message.type === 'project-discovery-updated' && message.discovery) remember([message.discovery])
    if (message.type === 'projects-changed')
      void refresh().catch((cause: Error) => setError(cause.message))
  }), [remember])
  useEffect(() => {
    generation.current += 1
    if (agents.status === 'connected') {
      void refresh().catch((cause: Error) => setError(cause.message))
      void refreshDiscoveries()
        .catch(() => { /* Project listing remains usable if job history is unavailable. */ })
    }
  }, [agents.status, remember])

  async function create(name: string, path: string) {
    const project = await api.current.request<Project>('project-create', { name, path })
    setProjects((previous) => [...previous.filter((row) => row.id !== project.id), project].sort((a, b) => a.name.localeCompare(b.name)))
    return project
  }
  async function jobRequest(op: string, args: object) {
    const job = await api.current.request<Discovery>(op, args)
    remember([job])
    return job
  }
  return { projects, discoveries, error, create, remember,
    startDiscovery: (args: { key: string; root: string; mode: 'preview' | 'add'; includeNested: boolean; exclude: string[] }) => jobRequest('project-discovery-start', args),
    getDiscovery: (jobId: string) => jobRequest('project-discovery-get', { jobId }),
    cancelDiscovery: (jobId: string) => jobRequest('project-discovery-cancel', { jobId }),
    filterDiscovery: (key: string, jobId: string, filter: DiscoveryFilter) => jobRequest('project-discovery-filter', { key, jobId, ...filter }),
    importDiscovery: (key: string, jobId: string, selection: 'recommended' | 'all' | 'filtered' | string[]) => jobRequest('project-import', { key, jobId, selection }),
    discoveryResults: (jobId: string, offset = 0) => api.current.request<DiscoveryResults>('project-discovery-results', { jobId, offset, limit: 100 }),
  }
}
export type ProjectsModel = ReturnType<typeof useProjects>
