import { useCapabilities } from '../capabilities'
import { useEffect, useState } from 'react'
import { CommandSearch, Icon, type CommandItem } from 'bbb-design'
import { agentSections } from '../agents/routes'
import type { NavigationDestination } from '../components/NavigationRail'
import { NewProject } from '../projects/NewProject'
import type { Project } from '../projects/model'
import { settingsSections } from '../settings/SettingsPage'
import type { SavedWorkflow } from '../workflows/library'
import type { Workspace } from './model'
import { HomeSheet } from './home/HomeDetails'
import { HomeTerminalLauncher, HomeWorkflowLauncher, HomeWorkflowPicker } from './home/HomeLaunchers'
import { useWorkVisits } from './home/history'
import { usePendingMessages } from './home/usePendingMessages'
import { useTerminalOverview } from './home/useTerminalOverview'
import { homeWork } from './home/work'

type Panel = { kind: 'terminal' | 'workflows' | 'project' } | { kind: 'workflow'; workflow: SavedWorkflow }
type Props = {
  workspace: Workspace
  workflows: SavedWorkflow[]
  destinations: NavigationDestination[]
  route: string
  navigate: (route: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorkspaceSearch(props: Props) {
  const [panel, setPanel] = useState<Panel | null>(null)
  const { route, onOpenChange } = props
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
      // Capture before editors and terminals consume the key or send it to a shell.
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      setPanel(null)
      onOpenChange(true)
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  }, [onOpenChange])
  useEffect(() => { onOpenChange(false); setPanel(null) }, [route, onOpenChange])

  return props.open || panel ? <SearchContents {...props} panel={panel} onPanelChange={setPanel} /> : null
}

function SearchContents({ workspace: w, workflows, destinations, navigate, open, onOpenChange, panel, onPanelChange }: Props & {
  panel: Panel | null
  onPanelChange: (panel: Panel | null) => void
}) {
  const { voice } = useCapabilities()
  const [query, setQuery] = useState('')
  const terminals = useTerminalOverview()
  const pending = usePendingMessages(w.carrier)
  const visits = useWorkVisits()
  const work = homeWork({ chats: w.chats.chats, snapshots: w.chats.snapshots, workflows: w.chats.workflowRuns,
    drafts: workflows, terminals: terminals.sessions, messages: pending.messages, visits, deletedIds: w.chats.deletedIds })
  const items: CommandItem[] = [
    ...destinations.map(destination => ({ id: `page:${destination.id}`, label: destination.label, group: 'Pages',
      leading: <Icon name={destination.icon} />, keywords: ['go', 'open', 'page'] })),
    { id: 'page:settings', label: 'Settings', group: 'Pages', keywords: ['preferences', 'configuration'] },
    ...agentSections.map(section => ({ id: `page:agents/${section.id}`, label: section.label, group: 'Agents', keywords: ['agents', section.id] })),
    ...settingsSections(voice).map(section => ({ id: `page:settings?section=${section.id}`, label: section.label, group: 'Settings', keywords: ['settings', section.id] })),
    { id: 'new-chat', label: 'New chat', group: 'Actions', description: 'Start a conversation', keywords: ['ask', 'agent'] },
    { id: 'run-workflow', label: 'Run a workflow', group: 'Actions', description: 'Choose a saved workflow' },
    { id: 'new-terminal', label: 'Open a terminal', group: 'Actions', description: 'Start a shell' },
    { id: 'inbox', label: 'Open inbox', group: 'Actions', description: 'Review pending messages' },
    { id: 'new-project', label: 'New project', group: 'Actions', description: 'Add a project directory' },
    ...w.projects.projects.map(project => ({ id: `project:${project.id}`, label: project.name, description: project.path, group: 'Projects' })),
    ...workflows.map(workflow => ({ id: `saved:${workflow.id}`, label: workflow.draft.name, description: workflow.draft.description, group: 'Saved workflows' })),
    ...work.items.map(row => ({ id: `work:${row.key}`, label: row.title, description: `${row.context} · ${row.reason}`,
      group: row.needs ? 'Needs you' : row.running ? 'Live work' : 'Continue working' })),
  ]

  function close() { onOpenChange(false); onPanelChange(null) }
  function go(route: string) { close(); navigate(route) }
  function openInbox(id?: string) {
    w.setActiveMessage(id ?? '')
    w.carrier.setMailbox('user'); w.carrier.setView('Pending'); w.carrier.setSearch(''); w.carrier.setOffset(0)
    go('carrier')
  }
  function projectChat(project: Project) {
    const composer = w.chatComposers.getDraft()
    composer.draft.set({ ...composer.draft.getSnapshot(), project: project.name })
    go('chat')
  }
  function command(id: string) {
    onOpenChange(false)
    if (id.startsWith('page:')) go(id.slice('page:'.length))
    else if (id === 'new-chat') go('chat')
    else if (id === 'run-workflow') onPanelChange({ kind: 'workflows' })
    else if (id === 'new-terminal') onPanelChange({ kind: 'terminal' })
    else if (id === 'inbox') openInbox()
    else if (id === 'new-project') onPanelChange({ kind: 'project' })
    else if (id.startsWith('project:')) {
      const project = w.projects.projects.find(project => `project:${project.id}` === id)
      if (project) projectChat(project)
    } else if (id.startsWith('saved:')) {
      const workflow = workflows.find(workflow => `saved:${workflow.id}` === id)
      if (workflow) onPanelChange({ kind: 'workflow', workflow })
    } else {
      const row = work.items.find(row => `work:${row.key}` === id)
      if (row?.kind === 'message') openInbox(row.messageId)
      else if (row) go(row.route)
    }
  }

  return <>
    {open && <HomeSheet title="Search workspace" centered closeLabel="Close search" onClose={close}>
      <div onKeyDownCapture={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() }
      }}>
        <CommandSearch label="Search workspace" autoFocus query={query} onQueryChange={setQuery}
          placeholder="Find a page, work, project, or action…" items={items} onAction={command} />
      </div>
    </HomeSheet>}
    {panel?.kind === 'terminal' && <HomeTerminalLauncher terminals={terminals} navigate={go} onClose={close} />}
    {panel?.kind === 'workflows' && <HomeWorkflowPicker workflows={workflows} navigate={go} onClose={close}
      onSelect={workflow => onPanelChange({ kind: 'workflow', workflow })} />}
    {panel?.kind === 'workflow' && <HomeWorkflowLauncher key={panel.workflow.id} workflow={panel.workflow} workspace={w} navigate={go} onClose={close}
      projectId={w.projects.projects.find(project => project.name === w.chatComposers.getDraft().draft.getProject())?.id} />}
    <NewProject open={panel?.kind === 'project'} onOpenChange={value => { if (!value) close() }} disabled={w.agents.status !== 'connected'}
      create={w.projects.create} onCreated={projectChat} />
  </>
}
