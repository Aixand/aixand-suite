import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Icon, SearchField, Select, Textarea, TextField } from 'bbb-design'
import { useContentFieldVariant } from '../../branding/ContentTheme'
import type { Workspace } from '../model'
import type { SavedWorkflow } from '../../workflows/library'
import type { useTerminalOverview } from './useTerminalOverview'
import { useWorkflowRun } from '../../workflows/builder/useWorkflowRun'
import { compileCanvas } from '../../workflows/builder/compileCanvas'
import { permissionModes } from '../../agents/permissions'
import { HomeSheet } from './HomeDetails'

export function HomeTerminalLauncher({ terminals, navigate, onClose }: {
  terminals: ReturnType<typeof useTerminalOverview>; navigate: (route: string) => void; onClose: () => void
}) {
  const fieldVariant = useContentFieldVariant()
  const [name, setName] = useState('Workspace terminal')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const valid = /^[\w .-]{1,80}$/.test(name.trim())
  async function create() {
    if (!valid || inFlight.current || terminals.status !== 'connected') return
    inFlight.current = true; setBusy(true); setError('')
    try { const session = await terminals.create(name.trim()); navigate(`terminals/${encodeURIComponent(session.id)}`) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The terminal could not be started.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <HomeSheet title="Open a terminal" description="Start a shell in your workspace." onClose={() => { if (!busy) onClose() }}>
    <form className="home-launcher-form" onSubmit={event => { event.preventDefault(); void create() }}>
      <TextField label="Terminal name" variant={fieldVariant} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)}
        hint="Letters, numbers, spaces, periods, hyphens, and underscores." />
      {terminals.status !== 'connected' && <div className="home-panel-notice"><p>Connect to Terminals to start a shell.</p>
        <Button variant="secondary" onPress={terminals.reconnect}>Reconnect terminals</Button></div>}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={!valid || busy || terminals.status !== 'connected'} loading={busy}><Icon name="square-terminal" />Open terminal</Button>
      <Button variant="ghost" onPress={() => navigate('terminals')}>Browse existing terminals<Icon name="arrow-right" /></Button>
    </form>
  </HomeSheet>
}

export function HomeWorkflowPicker({ workflows, onSelect, navigate, onClose }: {
  workflows: SavedWorkflow[]; onSelect: (workflow: SavedWorkflow) => void; navigate: (route: string) => void; onClose: () => void
}) {
  const fieldVariant = useContentFieldVariant()
  const [query, setQuery] = useState('')
  const filtered = workflows.filter(workflow => `${workflow.draft.name} ${workflow.draft.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <HomeSheet title="Run a workflow" description="Choose a saved workflow, then review its setup." onClose={onClose}
    footer={<Button variant="ghost" onPress={() => navigate('workflows')}>Open workflow library<Icon name="arrow-right" /></Button>}>
    <SearchField label="Search saved workflows" variant={fieldVariant} placeholder="Find a workflow…" value={query} onChange={setQuery} />
    <ul className="home-workflow-picker">{filtered.map(workflow => <li key={workflow.id}><Button variant="ghost" onPress={() => onSelect(workflow)}>
      <Icon name="workflow" /><span><strong>{workflow.draft.name}</strong><small>{workflow.draft.description || `${workflow.draft.nodes.length} steps`}</small></span><Icon name="chevron-right" />
    </Button></li>)}</ul>
    {!filtered.length && <p className="home-quiet-empty">{query ? 'No workflows match your search.' : 'Save a workflow in the workflow library to run it here.'}</p>}
  </HomeSheet>
}

export function HomeWorkflowLauncher({ workflow, workspace: w, navigate, onClose, projectId }: {
  workflow: SavedWorkflow; workspace: Workspace; navigate: (route: string) => void; onClose: () => void; projectId?: string
}) {
  const fieldVariant = useContentFieldVariant()
  const [draft, setDraft] = useState(() => ({ ...workflow.draft, native: { ...workflow.draft.native,
    ...(projectId ? { projectId } : {}) } }))
  const run = useWorkflowRun(draft, workflow.id, w, navigate)
  const started = useRef(false)
  const controller = w.chats.chats.find(chat => chat.id === run.settings.controllerChatId)
  const problem = useMemo(() => {
    try { compileCanvas(draft, undefined, undefined, undefined, controller); return '' }
    catch (cause) { return cause instanceof Error ? cause.message : 'Check the workflow before running it.' }
  }, [draft, controller])
  const profiles = w.chatProfiles.filter(profile => profile.provider === 'codex')
  const sdkController = controller?.backend === 'claude-sdk' || controller?.backend === 'antigravity-sdk' || controller?.backend === 'copilot-sdk'
  const availableProfile = profiles.some(profile => (profile.automatic ? '@auto' : profile.name) === run.settings.profile)
  useEffect(() => {
    if (started.current && run.snapshot?.jobId) navigate(run.needsProject ? `workflows/runs/${encodeURIComponent(run.snapshot.jobId)}` : `workflows/${encodeURIComponent(workflow.id)}`)
  }, [run.snapshot?.jobId, run.needsProject, workflow.id, navigate])
  return <HomeSheet title={workflow.draft.name} description="Review the setup before starting this workflow." onClose={onClose}
    footer={<Button variant="ghost" onPress={() => navigate(`workflows/${encodeURIComponent(workflow.id)}`)}>Open workflow<Icon name="arrow-right" /></Button>}>
    <div className="home-launcher-form">
      {draft.description && <p>{draft.description}</p>}
      <ol className="home-launch-steps">{draft.nodes.map((node, index) => <li key={node.id}><span>{index + 1}</span>{node.data.label}</li>)}</ol>
      {run.needsProject && <>
        <Select variant={fieldVariant} label="Workflow project" value={run.settings.projectId} disabled={run.busy}
          options={[{ id: '', label: 'Choose a project' }, ...w.projects.projects.map(project => ({ id: project.id, label: project.name }))]}
          onChange={projectId => setDraft(value => ({ ...value, native: { ...value.native, projectId } }))} />
        <Select variant={fieldVariant} label="Controller conversation" value={run.settings.controllerChatId} disabled={run.busy}
          options={[{ id: '', label: 'Create a workflow conversation' }, ...w.chats.chats.filter(chat => !chat.originChatId && chat.workspaceTools).map(chat => ({ id: chat.id, label: chat.title }))]}
          onChange={controllerChatId => setDraft(value => {
            const selected = w.chats.chats.find(chat => chat.id === controllerChatId)
            const sdk = selected?.backend === 'claude-sdk' || selected?.backend === 'antigravity-sdk' || selected?.backend === 'copilot-sdk'
            return { ...value, native: { ...value.native, controllerChatId, ...(sdk ? { permissionMode: undefined,
              ...(run.settings.profileSelection?.mode === 'auto' ? { profileSelection: { mode: 'controller' as const } } : {}) } : { sdkApprovalPolicy: undefined }) } }
          })} />
        {!run.settings.controllerChatId && <Select variant={fieldVariant} label="Controller profile" value={availableProfile ? run.settings.profile : ''} disabled={run.busy || !profiles.length}
          placeholder="Choose an available profile"
          options={profiles.map(profile => ({ id: profile.automatic ? '@auto' : profile.name, label: profile.label ?? profile.name }))}
          onChange={profile => setDraft(value => ({ ...value, native: { ...value.native, profile } }))} />}
        {sdkController ? <Select variant={fieldVariant} label="Workflow tool approvals" value={run.settings.sdkApprovalPolicy ?? 'inherit'} disabled={run.busy}
          options={[{ id: 'inherit', label: 'Inherit controller policy' }, { id: 'ask', label: 'Ask for approval' }, { id: 'deny', label: 'Deny approval prompts' }]}
          onChange={value => setDraft(previous => ({ ...previous, native: { ...previous.native, permissionMode: undefined, sdkApprovalPolicy: value === 'inherit' ? undefined : value as 'ask' | 'deny' } }))} /> : <Select variant={fieldVariant} label="Workflow access" value={run.settings.permissionMode ?? 'inherit'} disabled={run.busy}
          options={[{ id: 'inherit', label: 'Saved spawn default' }, ...permissionModes]}
          onChange={value => setDraft(previous => ({ ...previous, native: { ...previous.native, permissionMode: value === 'inherit' ? undefined : value as NonNullable<typeof draft.native.permissionMode> } }))} />}
        {!run.settings.controllerChatId && !profiles.length && <p role="status">Set up a Codex profile or choose a controller conversation.</p>}
      </>}
      <details className="home-advanced"><summary>Workflow inputs</summary>
        <Textarea label="Inputs (JSON)" variant={fieldVariant} rows={4} spellCheck={false} value={run.inputText} onChange={event => run.setInputText(event.target.value)} disabled={run.busy} />
      </details>
      {problem && <p role="alert">{problem}</p>}
      {run.error && <p role="alert">{run.error}</p>}
      {run.status !== 'connected' && <p role="status">{run.status === 'connecting' ? 'Connecting to workflows…' : 'The workflow service is unavailable.'}</p>}
      {run.status === 'offline' && <Button variant="secondary" onPress={run.connect}>Retry workflow connection</Button>}
      {run.busy && <p role="status">{run.snapshot?.jobId ? 'A run is already in progress. Open the workflow to follow it.' : run.error ? 'The submission has not been confirmed.' : 'Starting workflow…'}</p>}
      {run.snapshot && !run.snapshot.jobId && run.error && <Button disabled={run.status !== 'connected'} onPress={() => { started.current = true; run.resume() }}>Retry workflow submission</Button>}
      <Button disabled={Boolean(problem) || run.status !== 'connected' || run.busy || run.needsProject && (!run.settings.projectId || (run.settings.controllerChatId ? !controller : !availableProfile))}
        onPress={() => { started.current = true; run.start() }}><Icon name="workflow" />Start workflow</Button>
    </div>
  </HomeSheet>
}
