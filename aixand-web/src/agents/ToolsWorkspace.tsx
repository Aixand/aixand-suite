import { useEffect, useRef, useState } from 'react'
import { Button, DescriptionList, DropdownMenu, EmptyState, Icon, SearchField } from 'bbb-design'
import type { AgentsModel } from './model'
import type { WorkspaceRenderer } from './AgentWorkspace'
import type { Project } from '../projects/model'
import { ProjectMcps } from './mcp'
import { ManagedDetail, ManagedList, useManaged } from '../resources/managed'
import { ManagedMcpPreparation } from './ManagedMcpPreparation'
import { ResourceAdd } from '../resources/sources'
import { ManagedMcpImport } from './ManagedMcpImport'
import { providerLabel } from './presentation'
import { McpDefinitionEditor } from './McpDefinitionEditor'
import type { McpDefinition } from './McpDefinitionEditor'
import { ContentDisclosure } from '../components/ContentDisclosure'
import { PageLoading } from '../components/PageLoading'
import '../resources/editor/editor.css'
import './tools.css'

type Tool = McpDefinition & { name: string; installed?: boolean; revision?: string }
export function ToolsWorkspace({ agents: a, projects, workspace, route, navigate }: { agents: AgentsModel; projects: Project[]; workspace: WorkspaceRenderer; route: string; navigate: (route: string) => void }) {
  const api = useRef(a); api.current = a
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [record, setRecord] = useState<Tool | null>(null)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const parameters = new URLSearchParams(route.split('?')[1])
  const selected = parameters.get('server') ?? ''
  const query = parameters.get('q') ?? ''
  const projectId = parameters.get('project') ?? ''
  const projectView = parameters.get('view') === 'projects' || selected === 'projects'
  const managed = useManaged('mcp', a)
  const publisher = parameters.get('publisher') ?? ''
  const resource = parameters.get('resource') ?? ''
  const managedItem = managed.catalog?.items.find(item => item.publisher_id === publisher && item.id === resource)
  const connected = a.status === 'connected'
  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(parameters)
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key) }
    navigate(`agents/tools${next.size ? '?' + next.toString() : ''}`)
  }
  async function refresh() {
    setLoading(true)
    try { const result = await api.current.request<{ servers: Tool[] }>('mcp-catalog', { provider: 'codex' }); setTools(result.servers); setLoaded(true); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load MCP servers.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (connected) void refresh() }, [connected])
  useEffect(() => {
    if (record?.name === selected) return
    setEditing(false); setRecord(null); setError('')
    if (!selected || selected === 'projects' || selected === '@new' || selected === '@managed') return
    let active = true
    if (!connected) return
    void api.current.request<Tool>('mcp-show', { name: selected }).then(value => { if (active) setRecord(value) }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [selected, connected])
  const tool = tools.find(item => item.name === selected)
  const activeProject = projects.find(row => row.id === projectId)
  const initialLoading = !loaded && !error && a.status !== 'offline'
  const current = record ?? tool
  const definition: McpDefinition | undefined = record ? (({ name: _name, installed: _installed, revision: _revision, ...value }) => value)(record) : undefined
  const assignments = a.catalog?.profiles.filter(profile => profile.mcp?.servers.includes(selected)) ?? []
  const managedAssignments = a.catalog?.profiles.filter(profile => profile.resources?.mcp.some(({ target }) => typeof target !== 'string' && target.kind === 'managed' && target.publisher_id === publisher && target.server_id === resource && (!target.store || target.store === managed.catalog?.store))) ?? []
  const launchConfiguration = current && <DescriptionList items={[{ id: 'command', label: 'Command', value: <code>{current.command}</code> },
          { id: 'args', label: 'Arguments', value: current.args?.length ? <code>{JSON.stringify(current.args)}</code> : 'No additional arguments' },
          { id: 'environment', label: 'Environment variables', value: current.env_vars?.join(', ') || 'None referenced' }, { id: 'cwd', label: 'Working directory', value: current.cwd ?? 'Launch context' }]} />
  const libraryCopy = current && <Button variant="secondary" disabled={!record || !connected} onPress={() => {
          const value = Object.fromEntries(Object.entries(record!).filter(([key]) => !['name', 'installed', 'revision'].includes(key)))
          void managed.request<import('../resources/managed').ManagedStatus>('ensure', { publisherId: 'local-legacy', resourceId: current.name, definition: value }).then(async item => {
            update({ publisher: item.publisher_id, resource: item.id, server: '' }); await managed.refresh(); setNotice('Copied into the managed library. Existing profile assignments are preserved.')
          }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not copy this definition'))
        }}>Copy into managed library</Button>
  return workspace({ title: 'Tools (MCP)', description: projectView ? 'Project indexes' : loaded ? `${tools.length + (managed.catalog?.items.length ?? 0)} definitions` : undefined,
    selected: projectView ? Boolean(activeProject) : Boolean(selected) || Boolean(managedItem), onBack: () => update(projectView ? { project: '' } : { server: '', publisher: '', resource: '' }), error: error || managed.error, notice,
    primary: !projectView ? { label: 'Add MCP server', onPress: () => update({ server: '@add', publisher: '', resource: '', view: '', project: '' }), disabled: !connected } : undefined,
    actions: <DropdownMenu label="MCP library actions" trigger={<Button iconOnly size="sm" variant="ghost" aria-label="MCP library actions"><Icon name="ellipsis" /></Button>}
      items={[{ id: 'register', label: 'Register publisher definition', disabled: !connected }, { id: 'refresh', label: 'Refresh MCP servers', disabled: !connected || loading }]}
      onAction={action => { if (action === 'refresh') { void refresh(); void managed.refresh() } else update({ server: '@managed', publisher: '', resource: '', view: '' }) }} />,
    controls: <><div className="mcp-library-views" role="group" aria-label="MCP library view"><Button size="sm" variant="ghost" aria-pressed={!projectView} onPress={() => update({ view: '', server: selected === 'projects' ? '' : selected, project: '', q: '' })}>Servers</Button>
      <Button size="sm" variant="ghost" aria-pressed={projectView} onPress={() => update({ view: 'projects', server: '', publisher: '', resource: '', q: '' })}>Project indexes</Button></div>
      {!initialLoading && <SearchField ref={search} label={projectView ? 'Search projects' : 'Search tools'} value={query} onChange={q => update({ q })} />}</>,
    list: <div className="carrier-message-scroll" aria-busy={loading}>{projectView ? <>
      {projects.filter(project => `${project.name} ${project.path}`.toLowerCase().includes(query.toLowerCase())).map(project => <Button key={project.id} variant="ghost" className="carrier-message-row" aria-pressed={project.id === projectId} onPress={() => update({ project: project.id })}>
        <span className="carrier-row-title">{project.name}</span><span className="carrier-row-preview">{project.path}</span></Button>)}
      {!projects.length && <EmptyState headingLevel={2} title="No registered projects" description="Register a project to prepare its MCP indexes." />}
    </> : initialLoading ? <PageLoading label="Loading MCP servers…" size="panel" /> : <>
      {tools.filter(item => `${item.name} ${item.command}`.toLowerCase().includes(query.toLowerCase())).map(item => <Button key={item.name} variant="ghost" className="carrier-message-row" aria-pressed={selected === item.name} onPress={() => update({ server: item.name, publisher: '', resource: '' })}>
        <span className="carrier-row-title">{item.name}</span><span className="carrier-row-preview">{item.command}</span>{!item.installed && <span className="carrier-row-preview">Executable missing</span>}</Button>)}
      <ManagedList catalog={managed.catalog} query={query} publisher={publisher} resource={resource} onSelect={item => update({ publisher: item.publisher_id, resource: item.id, server: '' })} />
      {!tools.length && !managed.catalog?.items.length && <EmptyState headingLevel={2} icon="layers" title="No MCP servers" description="Add a server to make it available for profile assignments." />}
    </>}</div>,
    reader: selected === '@add' ? <ResourceAdd kind="mcp" catalog={managed.catalog} request={managed.request} onAdded={async item => { update({ publisher: item.publisher_id, resource: item.id, server: '' }); await managed.refresh() }} /> : managedItem && managed.catalog ? <><ManagedDetail key={`${publisher}/${resource}`} kind="mcp" item={managedItem} catalog={managed.catalog} request={managed.request} onChanged={managed.refresh} /><section className="managed-mcp-preparation agent-resource-links"><h3>Attached profiles</h3>
        {managedAssignments.map(profile => <p key={profile.id}><a href={`#/agents/profiles?profile=${encodeURIComponent(profile.id)}`}>{profile.profile} · {providerLabel(profile.provider)}</a></p>)}
        {!managedAssignments.length && <p>No profiles use this managed definition yet.</p>}<p><a href="#/agents/profiles">Configure profile resource defaults</a> or select this server for an individual launch.</p>
      </section><ManagedMcpPreparation key={`prepare/${publisher}/${resource}`} item={managedItem} projects={projects} agents={a} request={managed.request} /></>
      : selected === '@managed' ? <ManagedMcpImport connected={connected} onCancel={() => update({ server: '' })} request={managed.request} onSaved={async item => { update({ publisher: item.publisher_id, resource: item.id, server: '' }); await managed.refresh() }} />
      : projectView ? activeProject ? <div className="resource-reader-body"><ProjectMcps key={activeProject.id} agents={a} projects={projects} initialProject={activeProject.id} fixedProject /></div>
      : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="layers" title="Select a project" description="Review index preparation and source freshness for that project." /></div>
      : selected === '@new' ? <div className="resource-overview"><McpDefinitionEditor key="@new" definition={{ kind: 'stdio', command: '', args: [], env_vars: [] }} connected={connected} onCancel={() => update({ server: '' })} onSave={async (name, value) => {
        await a.request('mcp-configure', { name, definition: value, expectedRevision: null }); await refresh()
      }} onSaved={name => { update({ server: name }); setNotice('MCP server added. Assign it to profiles when ready.') }} /></div>
      : current ? <section className="resource-overview" aria-label="MCP server details"><header className="resource-heading"><div className="resource-heading-copy"><h2 tabIndex={-1}>{current.name}</h2><p>{current.installed ? 'Executable found' : 'Executable missing'} · {current.kind === 'stdio' ? 'Standard input/output' : 'Project tool'}</p></div>
        <Button size="sm" variant="secondary" disabled={!record || !connected} onPress={() => setEditing(true)}>Edit configuration</Button></header>
        <div className="resource-reader-body">
          <section className="agent-resource-links"><h3>Assigned profiles</h3>{assignments.map(profile => <p key={profile.id}><a href={`#/agents/profiles?profile=${encodeURIComponent(profile.id)}`}>{profile.profile} · {providerLabel(profile.provider)}</a></p>)}
            {!assignments.length && <p className="carrier-muted">No profiles use this server yet.</p>}<p className="carrier-muted">Change assignments from a profile. Live connections are shown in their chat or session.</p></section>
          {['sonar', 'lore'].includes(current.kind ?? '') && <Button variant="ghost" onPress={() => update({ view: 'projects', server: '' })}>Open project indexes</Button>}
          <ContentDisclosure enabled title="Library management">{libraryCopy}</ContentDisclosure>
          <ContentDisclosure enabled title="Launch configuration">{launchConfiguration}</ContentDisclosure>
          <details className="resource-metadata"><summary>Configuration details</summary><p>Definition revision: {record?.revision ?? 'Loading…'}</p><p>Editing this definition does not reconnect running sessions.</p></details>
        </div>
        {editing && definition && <McpDefinitionEditor key={selected} name={selected} definition={definition} connected={connected} onCancel={() => setEditing(false)} onSave={async (name, value) => {
          const result = await a.request<Tool>('mcp-configure', { name, definition: value, expectedRevision: record!.revision }); setRecord(result); await refresh()
        }} onSaved={() => { setEditing(false); setNotice('Configuration saved. Existing sessions retain their selected configuration.') }} />}
      </section> : selected && !error ? <PageLoading label="Loading server…" size="panel" /> : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="layers" title={error ? 'Server unavailable' : 'Select an MCP server'} description={error || 'Review its configuration and profile assignments.'} /></div>,
  })
}
