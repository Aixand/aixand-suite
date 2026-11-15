import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Icon, Select, TextField } from 'bbb-design'
import type { AgentsModel } from './model'
import type { Provider } from './client'
import type { Project } from '../projects/model'
import { requestId } from '../terminals/connection'
import { PageLoading } from '../components/PageLoading'

export type McpPolicy = { inherit?: boolean; add?: string[]; exclude?: string[] }
export type McpBinding = { schema: number; servers: string[]; revision: string }
export type McpState = { name: string; server_name: string; status: string; project?: string | null; error?: string; generation?: string; freshness?: string }
export type McpSnapshot = { digest: string; project: string | null; states: McpState[]; selection: McpPolicy }
type Definition = { name: string; kind: string; installed: boolean; command: string }
type Job = { id: string; status: string; step: string; project: string; error?: string | null; tools: string[] }

function useDefinitions(agents: AgentsModel, provider: Provider) {
  const api = useRef(agents); api.current = agents
  const [definitions, setDefinitions] = useState<Definition[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    setDefinitions([])
    setError('')
    setLoading(agents.status === 'connected')
    if (agents.status !== 'connected') return
    void api.current.request<{ servers: Definition[] }>('mcp-catalog', { provider })
      .then((value) => { if (active) { setDefinitions(value.servers); setError('') } })
      .catch((cause: Error) => { if (active) setError(cause.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agents.status, provider])
  return { definitions, error, loading }
}

export function McpServerList({ agents, provider = 'codex', value, onChange, disabled }: {
  agents: AgentsModel; provider?: Provider; value: string[]; onChange: (value: string[]) => void; disabled?: boolean
}) {
  const { definitions, error, loading } = useDefinitions(agents, provider)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])
  const search = query.trim().toLowerCase()
  const matches = definitions.filter((item) => item.name.toLowerCase().includes(search))

  return <div className="mcp-server-picker">
    <TextField ref={searchRef} label="Search MCP servers" hideLabel type="search" autoFocus
      placeholder="Search MCP servers…" leadingIcon={<Icon name="search" />}
      value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="mcp-server-list" role="group" aria-label="Available MCP servers" aria-busy={loading}>
      {!loading && !error && matches.map((item) => <Checkbox key={item.name} className="mcp-server-option"
        label={item.name} description={item.installed ? undefined : 'Executable not found'}
        isSelected={value.includes(item.name)}
        disabled={disabled || agents.status !== 'connected' || (!item.installed && !value.includes(item.name))}
        onChange={(checked) => onChange(checked ? [...value, item.name] : value.filter((name) => name !== item.name))} />)}
      {loading && <p className="mcp-server-empty" role="status">Loading MCP servers…</p>}
      {!loading && !error && !matches.length && <p className="mcp-server-empty" role="status">
        {search ? 'No MCP servers match your search.' : 'No MCP servers available.'}
      </p>}
      {error && <p className="mcp-server-empty" role="alert">{error}</p>}
    </div>
  </div>
}

export function McpProfileEditor({ agents, provider, value, onChange, disabled }: {
  agents: AgentsModel; provider: Provider; value: string[]; onChange: (value: string[]) => void; disabled?: boolean
}) {
  const { definitions, error } = useDefinitions(agents, provider)
  return <fieldset className="mcp-settings">
    <legend>MCP attachments</legend>
    <p className="ws-note">Load these tools whenever this profile starts. Sonar and Lore use the selected project’s prepared indexes.</p>
    {definitions.map((item) => <Checkbox key={item.name} label={`${item.name}${item.installed ? '' : ' · executable unavailable'}`}
      isSelected={value.includes(item.name)} disabled={disabled || agents.status !== 'connected'}
      onChange={(checked) => onChange(checked ? [...value, item.name] : value.filter((key) => key !== item.name))} />)}
    {error && <p role="alert">{error}</p>}
  </fieldset>
}

export function McpPicker({ agents, provider = 'codex', profile, projectId, cwd, value, onChange, disabled }: {
  agents: AgentsModel; provider?: Provider; profile?: string; projectId?: string; cwd?: string;
  value?: McpPolicy; onChange: (value: McpPolicy) => void; disabled?: boolean
}) {
  const { definitions, error } = useDefinitions(agents, provider)
  const api = useRef(agents); api.current = agents
  const [preview, setPreview] = useState<McpSnapshot | null>(null)
  const [previewError, setPreviewError] = useState('')
  const selection = value ?? {}
  const key = JSON.stringify({ provider, profile, projectId, cwd, selection })
  const defaults = agents.catalog?.profiles.find((row) => row.provider === provider && row.profile === profile)?.mcp?.servers ?? []
  const effective = new Set([...(selection.inherit === false ? [] : defaults), ...(selection.add ?? [])].filter((name) => !selection.exclude?.includes(name)))
  useEffect(() => {
    let active = true
    setPreview(null)
    if (!profile || agents.status !== 'connected' || (cwd !== undefined && !cwd.trim())) return
    const context = JSON.parse(key)
    void api.current.request<McpSnapshot>('mcp-preview', {
      provider: context.provider, profile: context.profile, selection: context.selection,
      ...(context.projectId ? { projectId: context.projectId } : context.cwd ? { cwd: context.cwd } : {}),
    }).then((result) => { if (active) { setPreview(result); setPreviewError('') } })
      .catch((cause: Error) => { if (active) setPreviewError(cause.message) })
    return () => { active = false }
  }, [key, agents.status, profile, cwd])
  return <fieldset className="mcp-settings">
    <legend>MCP tools for this launch</legend>
    <Checkbox label="Use profile attachments" isSelected={selection.inherit !== false} disabled={disabled}
      onChange={(inherit) => onChange({ ...selection, inherit })} />
    {!profile && <p className="ws-note">Auto inherits the attachments of the profile selected at launch.</p>}
    {definitions.map((item) => {
      const state = preview?.states.find((row) => row.name === item.name)
      if (!profile) return <Select key={item.name} label={item.name} disabled={disabled}
        value={selection.add?.includes(item.name) ? 'add' : selection.exclude?.includes(item.name) ? 'exclude' : 'inherit'}
        options={[{ id: 'inherit', label: 'Use selected profile setting' }, { id: 'add', label: 'Attach' }, { id: 'exclude', label: 'Skip' }]}
        onChange={(choice) => onChange({ ...selection,
          add: [...(selection.add ?? []).filter((name) => name !== item.name), ...(choice === 'add' ? [item.name] : [])],
          exclude: [...(selection.exclude ?? []).filter((name) => name !== item.name), ...(choice === 'exclude' ? [item.name] : [])],
        })} />
      return <div key={item.name}><Checkbox
        label={`${item.name}${state ? ' · ' + state.status.replaceAll('-', ' ') : ''}`}
        isSelected={effective.has(item.name)} disabled={disabled}
        onChange={(checked) => {
          const add = (selection.add ?? []).filter((name) => name !== item.name)
          const exclude = (selection.exclude ?? []).filter((name) => name !== item.name)
          if (checked) add.push(item.name)
          else exclude.push(item.name)
          onChange({ ...selection, add, exclude })
        }} />{state?.error && <p className="ws-note">{state.error}</p>}</div>
    })}
    {(error || previewError) && <p role="alert">{error || previewError}</p>}
  </fieldset>
}

export function McpSummary({ snapshot }: { snapshot?: McpSnapshot | null }) {
  if (!snapshot?.states.length) return null
  return <p className="ws-note">MCP: {snapshot.states.map((row) => `${row.name} (${row.status.replaceAll('-', ' ')})`).join(', ')}</p>
}

type McpConnection = {
  name: string; tools: Record<string, unknown>; runtimeStatus?: string | null;
  authStatus?: string; toolsError?: string | null
}
type SuiteTools = { status: 'current' | 'pending' | 'revoked'; tools: string[]; reconciliation_required?: boolean; update_error?: string;
  resources?: { group: string; reconciliation_required: boolean; sync_error?: { message: string } | null }[] }
type RuntimeCapabilities = { reconnect: boolean; preserve_selection: boolean; reconnect_scopes: string[] }
type RuntimeResult = { servers?: McpConnection[]; suiteTools?: SuiteTools | null; capabilities?: RuntimeCapabilities; selection?: { selection_digest?: string }; inventory?: { servers: McpConnection[] }; status?: string; error?: { message: string }; inventoryError?: string }

const connectionLabels: Record<string, string> = {
  notStarted: 'Not started', starting: 'Connecting', connected: 'Connected',
  authenticationRequired: 'Sign-in required', failed: 'Connection failed', cancelled: 'Cancelled', disabled: 'Disabled',
}

export function McpConnections({ agents, chatId, disabled }: { agents: AgentsModel; chatId: string; disabled?: boolean }) {
  const api = useRef(agents); api.current = agents
  const generation = useRef(0)
  const pending = useRef(false)
  const [servers, setServers] = useState<McpConnection[] | null>(null)
  const [suiteTools, setSuiteTools] = useState<SuiteTools | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<'check' | 'reconnect' | null>(null)
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null)
  const [selectionDigest, setSelectionDigest] = useState<string | null>(null)
  const reconnectKey = useRef<string | null>(null)
  async function check(reconnect = false) {
    if (pending.current || api.current.status !== 'connected') return
    const token = generation.current
    pending.current = true
    setBusy(reconnect ? 'reconnect' : 'check'); setError(''); setNotice('')
    try {
      if (reconnect && !reconnectKey.current) reconnectKey.current = requestId()
      const result = await api.current.request<RuntimeResult>(reconnect ? 'mcp-chat-reconnect' : 'mcp-chat-status', {
        chatId, ...(reconnect ? { scope: capabilities?.reconnect_scopes[0], operationId: reconnectKey.current, expectedSelectionDigest: selectionDigest } : {}),
      })
      if (generation.current === token) {
        setServers(result.servers ?? result.inventory?.servers ?? [])
        setSuiteTools(result.suiteTools ?? null)
        if (result.capabilities) setCapabilities(result.capabilities)
        if (result.selection) setSelectionDigest(result.selection.selection_digest ?? null)
        if (result.inventoryError) setError(result.inventoryError)
        if (reconnect) {
          if (result.status === 'completed' || result.status === 'accepted') { setNotice(`MCP reconnect ${result.status}. Inspect observed connection states.`); reconnectKey.current = null }
          else setError(result.error?.message ?? `Reconnect ${result.status}. Inspect the retained operation.`)
        }
      }
    } catch (cause) {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : 'Unable to check MCP connections.')
    } finally {
      if (generation.current === token) { pending.current = false; setBusy(null) }
    }
  }
  useEffect(() => {
    generation.current += 1; pending.current = false
    setServers(null); setSuiteTools(null); setError(''); setNotice(''); setBusy(null); setCapabilities(null); setSelectionDigest(null); reconnectKey.current = null
    if (agents.status === 'connected') void check()
    return () => { generation.current += 1; pending.current = false }
  }, [agents.status, chatId])
  return <div className="mcp-connections" role="group" aria-label="MCP connections" aria-busy={Boolean(busy)}>
    <div className="mcp-connection-actions">
      <Button variant="ghost" size="sm" disabled={Boolean(busy) || agents.status !== 'connected'} onPress={() => { void check() }}>
        Check MCP connections
      </Button>
      <Button variant="secondary" size="sm" disabled={disabled || Boolean(busy) || agents.status !== 'connected' || !capabilities?.reconnect || !capabilities.preserve_selection || !selectionDigest} onPress={() => { void check(true) }}>
        {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect MCPs'}
      </Button>
    </div>
    {busy === 'check' && <p role="status">Checking MCP connections…</p>}
    {suiteTools && <details className="mcp-suite-tools">
      <summary>Suite tools · {suiteTools.reconciliation_required ? 'Publisher review needed' : suiteTools.status === 'revoked' ? 'Inspection and cancellation only' : suiteTools.status === 'current' ? 'Up to date' : 'Update pending'} · {suiteTools.tools.length} tools</summary>
      <p>{suiteTools.tools.join(', ')}</p>
      {suiteTools.update_error && <p role="status">Could not check publisher updates: {suiteTools.update_error}. Using the captured resources.</p>}
      {suiteTools.resources?.filter(row => row.reconciliation_required).map(row => <p key={row.group} role="status">{row.group}: publisher update awaiting reconciliation. The accepted copy remains active. <a href={`#/agents/tools?publisher=aixand-suite&resource=${encodeURIComponent(row.group)}`}>Review publisher update</a></p>)}
    </details>}
    {servers?.map((server) => <div className="mcp-connection" key={server.name}>
      <p><strong>{server.name}</strong>{server.runtimeStatus && ` · ${connectionLabels[server.runtimeStatus] ?? server.runtimeStatus}`}
        {` · ${Object.keys(server.tools).length} discovered tools`}</p>
      {server.authStatus === 'notLoggedIn' && <p className="ws-note">Sign in to this MCP server to use its tools.</p>}
      {server.toolsError && <p role="alert">{server.toolsError}</p>}
    </div>)}
    {servers?.length === 0 && <p>No MCP servers configured for this conversation.</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="ws-note">{capabilities?.reconnect && capabilities.preserve_selection ? `Reconnect scope: ${capabilities.reconnect_scopes.join(', ')}. Selected configuration is retained.` : 'Selection-preserving reconnect is unavailable for this backend. Native reload affects the process and remains unverified.'}</p>
  </div>
}

export function ProjectMcps({ agents, projects, initialProject, fixedProject = false }: { agents: AgentsModel; projects: Project[]; initialProject?: string; fixedProject?: boolean }) {
  const api = useRef(agents); api.current = agents
  const [projectId, setProjectId] = useState(initialProject ?? '')
  const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [installModel, setInstallModel] = useState(false)
  const generation = useRef(0)
  const project = projects.find((row) => row.id === projectId)
  useEffect(() => {
    const token = ++generation.current
    setSnapshot(null); setJobs([])
    if (!projectId || agents.status !== 'connected') return
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const [status, rows] = await Promise.all([
          api.current.request<McpSnapshot>('mcp-project-status', { projectId }),
          api.current.request<Job[]>('mcp-jobs', { projectId }),
        ])
        if (generation.current === token) { setSnapshot(status); setJobs(rows); setError('') }
      } catch (cause) { if (generation.current === token) setError((cause as Error).message) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => { generation.current += 1; clearInterval(timer) }
  }, [agents.status, projectId])
  async function prepare(tool: string, refresh: boolean) {
    const token = generation.current
    setBusy(true); setError('')
    try {
      const row = await api.current.request<Job>('mcp-prepare', { key: requestId(), projectId, tools: [tool], refresh,
        ...(tool === 'lore' && installModel ? { settings: { install_model: true } } : {}) })
      if (generation.current === token) setJobs((previous) => [row, ...previous.filter((job) => job.id !== row.id)])
    } catch (cause) { if (generation.current === token) setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="mcp-project-overview" aria-label="Project MCP preparation">
    <h2 tabIndex={-1}>{fixedProject ? project?.name : 'Project MCP indexes'}</h2>
    {!fixedProject && <Select label="Registered project" value={projectId} onChange={setProjectId} disabled={busy}
      options={[{ id: '', label: 'Choose a project' }, ...projects.map((row) => ({ id: row.id, label: row.name, description: row.path }))]} />}
    {project && <p className="ws-note">{project.path}</p>}
    {project && Boolean(snapshot?.states.length) && <Button variant="ghost" disabled={busy} onPress={() => {
      const token = generation.current
      setBusy(true)
      void api.current.request<McpSnapshot>('mcp-project-status', { projectId, check: true })
        .then((result) => { if (generation.current === token) setSnapshot(result) })
        .catch((cause: Error) => { if (generation.current === token) setError(cause.message) }).finally(() => setBusy(false))
    }}>Check source freshness</Button>}
    {snapshot?.states.some(row => row.name === 'lore') && <details><summary>Preparation options</summary><Checkbox label="Provision Lore model assets during preparation" isSelected={installModel} onChange={setInstallModel} disabled={busy} /></details>}
    {project && !snapshot && !error && <PageLoading label="Loading project indexes…" size="panel" />}
    {snapshot && !snapshot.states.length && <p role="status">No project index servers are configured. Add a project index server in Tools (MCP) to prepare its indexes.</p>}
    {snapshot?.states.map((row) => <div key={row.name} className="mcp-index-row">
      <div><h3>{row.name}</h3><p>{row.status === 'prepared' ? 'Index prepared' : row.status.replaceAll('-', ' ')}{row.freshness ? ' · sources ' + row.freshness : ''}</p></div>
      {row.error && <p className="ws-note">{row.error}</p>}
      <Button variant="secondary" disabled={busy || jobs.some((job) => ['queued', 'running'].includes(job.status) && job.tools.includes(row.name))}
        onPress={() => { void prepare(row.name, row.status === 'prepared') }}>{row.status === 'prepared' ? 'Refresh' : 'Prepare'} {row.name}</Button>
    </div>)}
    {jobs.filter(job => ['queued', 'running'].includes(job.status)).map(job => <div key={job.id} className="mcp-preparation-job"><strong>{job.tools.join(', ')}</strong><p role="status">{job.status} · {job.step}</p></div>)}
    {jobs.find(job => ['failed', 'interrupted'].includes(job.status)) && <Alert title="Preparation needs attention" tone="warning">{jobs.find(job => ['failed', 'interrupted'].includes(job.status))?.error || 'The last index preparation did not complete. Review its history before retrying.'}</Alert>}
    {jobs.some(job => !['queued', 'running'].includes(job.status)) && <details className="mcp-job-history"><summary>Preparation history</summary>
      {jobs.filter(job => !['queued', 'running'].includes(job.status)).map(job => <p key={job.id} role="status">{job.tools.join(', ')} · {job.status} · {job.step}{job.error ? ' · ' + job.error : ''}</p>)}
    </details>}
    {error && <p role="alert">{error}</p>}
    <p className="ws-note">Preparation survives browser disconnects. New launches use refreshed indexes; active sessions retain their selected generation.</p>
  </section>
}
