import { useEffect, useRef, useState } from 'react'
import { Button, DropdownMenu, EmptyState, Icon, SearchField } from 'bbb-design'
import type { AgentsModel } from './model'
import type { WorkspaceRenderer } from './AgentWorkspace'
import type { Project } from '../projects/model'
import { ProjectMcps } from './mcp'
import { ManagedDetail, ManagedList, useManaged } from '../resources/managed'
import { ManagedMcpPreparation } from './ManagedMcpPreparation'
import { ResourceAdd } from '../resources/sources'
import { ManagedMcpImport } from './ManagedMcpImport'
import { McpDefinitionEditor } from './McpDefinitionEditor'
import type { McpDefinition } from './McpDefinitionEditor'
import { McpServerOverview } from './McpServerOverview'
import { PageLoading } from '../components/PageLoading'
import { ProfileStatus } from './ProfileControls'
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
  const configureButton = useRef<HTMLButtonElement>(null)
  function closeConfiguration() { setEditing(false); requestAnimationFrame(() => configureButton.current?.focus()) }
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
    try { const result = await api.current.request<{ servers: Tool[] }>('mcp-catalog', {}); setTools(result.servers); setLoaded(true); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load MCP servers.') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (connected) void refresh() }, [connected])
  useEffect(() => {
    if (record?.name === selected) return
    setEditing(false); setRecord(null); setError('')
    if (!selected || selected === 'projects' || selected === '@new' || selected === '@managed' || selected === '@add') return
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
  const libraryCopy = current && <Button variant="secondary" disabled={!record || !connected} onPress={() => {
          const value = Object.fromEntries(Object.entries(record!).filter(([key]) => !['name', 'installed', 'revision'].includes(key)))
          void managed.request<import('../resources/managed').ManagedStatus>('ensure', { publisherId: 'local-legacy', resourceId: current.name, definition: value }).then(async item => {
            update({ publisher: item.publisher_id, resource: item.id, server: '' }); await managed.refresh(); setNotice('Copied into the managed library. Existing conversations retain their captured configuration.')
          }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not copy this definition'))
        }}>Copy into managed library</Button>
  return workspace({ title: 'Tools (MCP)', description: projectView ? 'Project indexes' : loaded ? `${tools.length + (managed.catalog?.items.length ?? 0)} ${tools.length + (managed.catalog?.items.length ?? 0) === 1 ? 'definition' : 'definitions'}` : undefined,
    selected: projectView ? Boolean(activeProject) : Boolean(selected) || Boolean(managedItem), onBack: () => update(projectView ? { project: '' } : { server: '', publisher: '', resource: '' }), error: error || managed.error, notice,
    primary: !projectView ? { label: 'Add MCP server', onPress: () => update({ server: '@add', publisher: '', resource: '', view: '', project: '' }), disabled: !connected } : undefined,
    actions: <DropdownMenu label="MCP library actions" trigger={<Button iconOnly size="sm" variant="ghost" aria-label="MCP library actions"><Icon name="ellipsis" /></Button>}
      items={[{ id: 'projects', label: 'Project indexes' }, { id: 'register', label: 'Register publisher definition', disabled: !connected }, { id: 'refresh', label: 'Refresh MCP servers', disabled: !connected || loading }]}
      onAction={action => { if (action === 'projects') update({ view: 'projects', server: '', publisher: '', resource: '', project: '', q: '' }); else if (action === 'refresh') { void refresh(); void managed.refresh() } else update({ server: '@managed', publisher: '', resource: '', view: '' }) }} />,
    controls: <>
      {projectView && <Button variant="ghost" size="sm" onPress={() => update({ view: '', server: '', project: '', q: '' })}><Icon name="chevron-left" />Back to servers</Button>}
      {!initialLoading && <SearchField ref={search} label={projectView ? 'Search projects' : 'Search tools'} placeholder={projectView ? 'Search projects…' : 'Search servers…'} value={query} onChange={q => update({ q })} />}</>,
    list: <div className="carrier-message-scroll" aria-busy={loading}>{projectView ? <>
      {projects.filter(project => `${project.name} ${project.path}`.toLowerCase().includes(query.toLowerCase())).map(project => <Button key={project.id} variant="ghost" className="carrier-message-row" aria-pressed={project.id === projectId} onPress={() => update({ project: project.id })}>
        <span className="carrier-row-title">{project.name}</span><span className="carrier-row-preview">{project.path}</span></Button>)}
      {!projects.length && <EmptyState headingLevel={2} title="No registered projects" description="Register a project to prepare its MCP indexes." />}
    </> : initialLoading ? <PageLoading label="Loading MCP servers…" size="panel" /> : <>
      {tools.filter(item => `${item.name} ${item.command}`.toLowerCase().includes(query.toLowerCase())).map(item => <div key={item.name} className="resource-library-row">
        <Button variant="ghost" className="carrier-message-row" aria-pressed={selected === item.name} onPress={() => update({ server: item.name, publisher: '', resource: '' })}>
          <span className="carrier-row-title">{item.name}</span><span className="carrier-row-preview">{item.kind === 'sonar' || item.kind === 'lore' ? 'Project indexing' : 'Local command'}</span></Button>
        {!item.installed && <ProfileStatus tone="warning" label={`Setup needed for ${item.name}. The server command was not found. Open configuration to choose an installed executable.`} />}
      </div>)}
      <ManagedList compact catalog={managed.catalog} query={query} publisher={publisher} resource={resource} onSelect={item => update({ publisher: item.publisher_id, resource: item.id, server: '' })} />
      {!tools.length && !managed.catalog?.items.length && <EmptyState headingLevel={2} icon="layers" title="No MCP servers" description="Add a server to configure tools for new chats." />}
    </>}</div>,
    reader: selected === '@add' ? <ResourceAdd kind="mcp" catalog={managed.catalog} request={managed.request} onAdded={async item => { update({ publisher: item.publisher_id, resource: item.id, server: '' }); await managed.refresh() }} /> : managedItem && managed.catalog ? <ManagedDetail key={`${publisher}/${resource}`} agents={a} kind="mcp" item={managedItem} catalog={managed.catalog} request={managed.request} onChanged={managed.refresh}
        footer={<div className="managed-mcp-context"><p className="carrier-muted">Select this server when starting a chat. Existing conversations retain their captured configuration.</p>
        <ManagedMcpPreparation key={`prepare/${publisher}/${resource}`} item={managedItem} projects={projects} agents={a} request={managed.request} />
        </div>} />
      : selected === '@managed' ? <ManagedMcpImport connected={connected} onCancel={() => update({ server: '' })} request={managed.request} onSaved={async item => { update({ publisher: item.publisher_id, resource: item.id, server: '' }); await managed.refresh() }} />
      : projectView ? activeProject ? <div className="resource-reader-body"><ProjectMcps key={activeProject.id} agents={a} projects={projects} initialProject={activeProject.id} fixedProject /></div>
      : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="layers" title="Select a project" description="Review index preparation and source freshness for that project." /></div>
      : selected === '@new' ? <div className="resource-overview"><McpDefinitionEditor key="@new" definition={{ kind: 'stdio', command: '', args: [], env_vars: [] }} connected={connected} onCancel={() => update({ server: '' })} onSave={async (name, value) => {
        await a.request('mcp-configure', { name, definition: value, expectedRevision: null }); await refresh()
      }} onSaved={name => { update({ server: name }); setNotice('MCP server added. Select a managed library copy when starting a chat.') }} /></div>
      : current ? <section className="resource-overview" aria-label="MCP server details"><header className="resource-heading"><div className="resource-heading-copy"><div className="agent-resource-title"><h2 tabIndex={-1}>{current.name}</h2>
        <ProfileStatus tone={current.installed ? 'success' : 'warning'} label={current.installed ? 'Server executable found.' : 'Server executable missing. Open configuration to select an installed command.'} /></div><p>{current.kind === 'sonar' || current.kind === 'lore' ? 'Project indexing' : 'Local command'}</p></div>
        <Button ref={configureButton} size="sm" variant="secondary" disabled={!record || !connected} onPress={() => setEditing(true)}>Configure</Button></header>
        <div className="resource-reader-body">
          <McpServerOverview definition={current}>
            <p className="carrier-muted">Copy this definition into the managed library to select it when starting a chat.</p>
            {['sonar', 'lore'].includes(current.kind ?? '') && <Button className="mcp-project-setup" variant="secondary" size="sm" onPress={() => update({ view: 'projects', server: '', project: '' })}>Set up for a project…</Button>}
          </McpServerOverview>
          <details className="resource-detail-disclosure"><summary>Source and updates</summary>{libraryCopy}<dl className="agent-source-details"><dt>Definition revision</dt><dd>{record?.revision ?? 'Loading…'}</dd></dl></details>

        </div>
        {editing && definition && <McpDefinitionEditor key={selected} name={selected} definition={definition} connected={connected} onCancel={closeConfiguration} onSave={async (name, value) => {
          const result = await a.request<Tool>('mcp-configure', { name, definition: value, expectedRevision: record!.revision }); setRecord(result); await refresh()
        }} onSaved={() => { closeConfiguration(); setNotice('Configuration saved. Existing sessions retain their selected configuration.') }} />}
      </section> : selected && !error ? <PageLoading label="Loading server…" size="panel" /> : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="layers" title={error ? 'Server unavailable' : 'Select an MCP server'} description={error || 'Review its configuration and project preparation.'} /></div>,
  })
}
