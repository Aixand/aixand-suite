import { useEffect, useState } from 'react'
import { Button, Dialog, Select } from 'bbb-design'
import type { ManagedStatus } from '../resources/managed'
import type { Project } from '../projects/model'
import type { AgentsModel } from './model'
import { requestId } from '../terminals/connection'

type Inspection = { states: { status: string; generation?: string; error?: string }[]; servers: Record<string, { kind: string }> }
type Job = { id: string; status: string; step: string; error?: string }
export function ManagedMcpPreparation({ item, projects, agents, request }: {
  item: ManagedStatus; projects: Project[]; agents: AgentsModel; request: <T>(op: string, args?: object) => Promise<T>
}) {
  const [projectId, setProjectId] = useState('')
  const [open, setOpen] = useState(false)
  const [supported, setSupported] = useState(false)
  const [inspection, setInspection] = useState<Inspection | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const identity = { publisherId: item.publisher_id, resourceId: item.id, revision: item.revision }
  useEffect(() => {
    let active = true
    void request<{ definition: { kind: string } }>('resolve', identity).then(row => { if (active) setSupported(['sonar', 'lore'].includes(row.definition.kind)) }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [item.revision, request])
  useEffect(() => {
    let active = true
    setInspection(null); setJob(null); setError('')
    if (projectId) void request<Inspection>('inspect', { ...identity, projectId }).then(row => { if (active) setInspection(row) }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [projectId, item.revision, request])
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return
    let active = true
    const timer = setInterval(() => {
      void agents.request<Job>('mcp-job', { jobId: job.id }).then(row => {
        if (!active) return
        setJob(row)
        if (row.status === 'completed') void request<Inspection>('inspect', { ...identity, projectId }).then(value => { if (active) setInspection(value) }).catch((cause: Error) => { if (active) setError(cause.message) })
      }).catch((cause: Error) => { if (active) setError(cause.message) })
    }, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [job?.id, job?.status, projectId, item.revision])
  const state = inspection?.states[0]
  const prepared = state?.status === 'prepared'
  if (!supported) return error ? <p role="alert">{error}</p> : null
  return <Dialog title="Project preparation" description={item.label || item.id} className="resource-compact-dialog" bodyClassName="resource-dialog-fields" open={open} onOpenChange={setOpen}
    trigger={<Button variant="secondary" size="sm">Set up for a project…</Button>} footer={<Button variant="secondary" onPress={() => setOpen(false)}>Close</Button>}>
    <section className="managed-mcp-preparation mcp-project-overview" aria-label="Managed MCP preparation">
    <Select label="Registered project" value={projectId} onChange={setProjectId} options={[{ id: '', label: 'Choose a project' }, ...projects.map(project => ({ id: project.id, label: project.name, description: project.path }))]} />
    {state && <p>{state.status.replaceAll('-', ' ')}{state.generation ? ` · generation ${state.generation}` : ''}</p>}
    {state?.error && <p>{state.error}</p>}
    {state && ['needs-preparation', 'prepared'].includes(state.status) && <Button variant="secondary" size="sm" disabled={busy || Boolean(job && ['queued', 'running'].includes(job.status))} onPress={() => {
      setBusy(true); setError('')
      void request<Job>(prepared ? 'refresh' : 'prepare', { ...identity, projectId, key: requestId() }).then(setJob).catch((cause: Error) => setError(cause.message)).finally(() => setBusy(false))
    }}>{prepared ? 'Refresh project index' : 'Prepare project index'}</Button>}
    {job && <p role="status">{job.status} · {job.step}{job.error ? ` · ${job.error}` : ''}</p>}
    {error && <p role="alert">{error}</p>}
  </section></Dialog>
}
