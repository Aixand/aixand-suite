import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Icon, Link, LoadingIndicator, PageHeader } from 'bbb-design'
import type { IconName } from 'bbb-design'
import type { Workspace } from '../model'
import type { SavedWorkflow } from '../../workflows/library'
import { homeWork } from './work'
import type { HomeWork } from './work'
import { useWorkVisits } from './history'
import { useTerminalOverview } from './useTerminalOverview'
import { usePendingMessages } from './usePendingMessages'
import './Home.css'
import { monitorLabels } from '../../command/model'
import { supervisionChat, supervisionRoute } from '../../command/supervision'
import type { Project } from '../../projects/model'
import { NewProject } from '../../projects/NewProject'
import { ProjectFilesPane } from '../../projects/ProjectFilesPane'
import { HomeStarter } from './HomeStarter'
import { HomeSearch } from './HomeSearch'
import { HomeWorkspace, type WorkspaceTab } from './HomeWorkspace'
import { HomeDetails, HomeSheet } from './HomeDetails'
import { HomeTerminalLauncher, HomeWorkflowLauncher, HomeWorkflowPicker } from './HomeLaunchers'

type Panel = { kind: 'work'; row: HomeWork } | { kind: 'files'; project: Project } |
  { kind: 'workflows' } | { kind: 'workflow'; workflow: SavedWorkflow } | { kind: 'terminal' }

const icons: Record<HomeWork['kind'], IconName> = {
  chat: 'messages-square', terminal: 'square-terminal', workflow: 'workflow', message: 'mail',
}
const labels = { chat: 'Chat', terminal: 'Terminal', workflow: 'Workflow', message: 'Carrier' }

function age(at: number, now: number) {
  if (!at) return ''
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

// Live status updates can change a row's contents without moving its target
// underneath the pointer. New requests append within their priority group.
function useStableRequests(rows: HomeWork[]) {
  const ranks = useRef(new Map<string, number>())
  const sequence = useRef(0)
  const keys = new Set(rows.map(row => row.key))
  for (const key of ranks.current.keys()) if (!keys.has(key)) ranks.current.delete(key)
  for (const row of rows) if (!ranks.current.has(row.key)) ranks.current.set(row.key, sequence.current++)
  return [...rows].sort((a, b) => a.priority - b.priority || ranks.current.get(a.key)! - ranks.current.get(b.key)!)
}

export function Home({ workspace: w, workflows, navigate }: {
  workspace: Workspace
  workflows: SavedWorkflow[]
  navigate: (route: string) => void
}) {
  const terminals = useTerminalOverview()
  const pending = usePendingMessages(w.carrier)
  const visits = useWorkVisits()
  const [now, setNow] = useState(Date.now)
  const [expanded, setExpanded] = useState(false)
  const [showRunning, setShowRunning] = useState(false)
  const [tab, setTab] = useState<WorkspaceTab>('projects')
  const [panel, setPanel] = useState<Panel | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const focusedRequest = useRef<string | null>(null)
  const workflowPages = useRef(new Set<number>())
  const api = useRef(w)
  api.current = w

  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') setNow(Date.now()) }
    const timer = setInterval(update, 60000)
    window.addEventListener('focus', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update) }
  }, [])
  useEffect(() => {
    if (w.agents.status !== 'connected') { workflowPages.current.clear(); return }
    const offset = w.chats.workflowNextOffset
    if (w.chats.workflowLoading || w.chats.workflowError || offset === null || workflowPages.current.has(offset) || workflowPages.current.size >= 256) return
    workflowPages.current.add(offset)
    void api.current.chats.loadWorkflowRuns(offset)
  }, [w.agents.status, w.chats.workflowNextOffset, w.chats.workflowError, w.chats.workflowLoading])

  const work = homeWork({ chats: w.chats.chats, snapshots: w.chats.snapshots,
    workflows: w.chats.workflowRuns, drafts: workflows, terminals: terminals.sessions,
    messages: pending.messages, visits, deletedIds: w.chats.deletedIds, now })
  const requests = useStableRequests(work.needs)
  const visibleRequests = expanded ? requests : requests.slice(0, 5)
  const supervisionUpdates = w.command.monitors.filter(monitor => !monitor.conversationDeleted &&
    !w.chats.deletedIds.has(supervisionChat(monitor) ?? '') && !w.chats.deletedIds.has(monitor.sourceChatId ?? '') &&
    monitor.state === 'needs_input')

  const agentOnline = w.agents.status === 'connected'
  const sources = [
    { id: 'chat', label: 'Chats', checking: !w.chats.listReady && !w.chats.listError && w.agents.status !== 'offline',
      available: agentOnline && w.chats.listReady && !w.chats.listError,
      retry: () => agentOnline ? void w.chats.refresh().catch(() => {}) : w.agents.connect() },
    { id: 'workflow', label: 'Workflows', checking: w.agents.status === 'connecting' || agentOnline && !w.chats.workflowError && (!w.chats.workflowReady || w.chats.workflowLoading),
      available: agentOnline && w.chats.workflowReady && !w.chats.workflowError && w.chats.workflowNextOffset === null,
      retry: () => { workflowPages.current.clear(); if (agentOnline) void w.chats.loadWorkflowRuns(); else w.agents.connect() } },
    { id: 'terminal', label: 'Terminals', checking: terminals.status === 'connecting' || terminals.loading,
      available: terminals.status === 'connected' && !terminals.loading && !terminals.error,
      retry: () => terminals.status === 'connected' ? void terminals.refresh() : terminals.reconnect() },
    { id: 'message', label: 'Carrier', checking: pending.status === 'checking', available: pending.status === 'ready',
      retry: () => {
        if (w.carrier.status !== 'connected') w.carrier.connect()
        else void w.carrier.refresh().then(pending.retry)
      } },
  ]
  const checking = sources.filter(source => source.checking)
  const unavailable = sources.filter(source => !source.available && !source.checking)
  const complete = sources.every(source => source.available)

  useLayoutEffect(() => {
    if (focusedRequest.current && !visibleRequests.some(row => row.key === focusedRequest.current)) {
      if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true })
      focusedRequest.current = null
    }
  }, [visibleRequests])

  function openInbox(id?: string) {
    w.setActiveMessage(id ?? '')
    w.carrier.setMailbox('user')
    w.carrier.setView('Pending')
    w.carrier.setSearch('')
    w.carrier.setOffset(0)
    navigate('carrier')
  }
  function projectChat(project: Project) {
    const composer = w.chatComposers.getDraft()
    composer.draft.set({ ...composer.draft.getSnapshot(), project: project.name })
    navigate('chat')
  }
  function browseProjects() {
    setTab('projects')
    requestAnimationFrame(() => {
      document.getElementById('home-workspace')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      document.getElementById('home-workspace-heading')?.focus({ preventScroll: true })
    })
  }
  const commands = [
    { id: 'new-chat', label: 'New chat', group: 'Actions', description: 'Start a conversation', keywords: ['ask', 'agent'] },
    { id: 'run-workflow', label: 'Run a workflow', group: 'Actions', description: 'Choose a saved workflow' },
    { id: 'new-terminal', label: 'Open a terminal', group: 'Actions', description: 'Start a shell' },
    { id: 'inbox', label: 'Open inbox', group: 'Actions', description: 'Review pending messages' },
    { id: 'new-project', label: 'New project', group: 'Actions', description: 'Add a project directory' },
    ...w.projects.projects.map(project => ({ id: `project:${project.id}`, label: project.name, description: project.path, group: 'Projects' })),
    ...workflows.map(workflow => ({ id: `saved:${workflow.id}`, label: workflow.draft.name, description: workflow.draft.description, group: 'Saved workflows' })),
    ...work.items.map(row => ({ id: `work:${row.key}`, label: row.title, description: `${row.context} · ${row.reason}`, group: row.needs ? 'Needs you' : row.running ? 'Live work' : 'Continue working' })),
  ]
  function command(id: string) {
    if (id === 'new-chat') navigate('chat')
    else if (id === 'run-workflow') setPanel({ kind: 'workflows' })
    else if (id === 'new-terminal') setPanel({ kind: 'terminal' })
    else if (id === 'inbox') openInbox()
    else if (id === 'new-project') setNewProjectOpen(true)
    else if (id.startsWith('project:')) { const project = w.projects.projects.find(project => `project:${project.id}` === id); if (project) projectChat(project) }
    else if (id.startsWith('saved:')) { const workflow = workflows.find(workflow => `saved:${workflow.id}` === id); if (workflow) setPanel({ kind: 'workflow', workflow }) }
    else {
      const row = work.items.find(row => `work:${row.key}` === id)
      if (row?.key.startsWith('workflow-draft:')) navigate(row.route)
      else if (row) setPanel({ kind: 'work', row })
    }
  }
  function rows(items: HomeWork[], section: 'needs' | 'recent' | 'running') {
    return <ul className="home-work-list" aria-label={section === 'needs' ? 'Work needing you' : section === 'recent' ? 'Recent work' : 'Running work'}>
      {items.map(row => {
        const source = row.route.startsWith('terminals/') ? 'terminal' : row.kind
        const stale = !sources.find(item => item.id === source)?.available && !row.key.startsWith('workflow-draft:')
        const timestamp = section === 'recent' ? row.recentAt : row.at
        const workflow = section === 'running' && row.kind === 'workflow' ? w.chats.workflowRuns.find(run => `workflow:${run.key}` === row.key) : undefined
        const steps = workflow?.steps ?? []
        const completed = steps.filter(step => ['completed', 'delivered'].includes(step.executionState ?? step.state)).length
        return <li key={row.key} data-work-key={row.key}>
          <Link variant="quiet" className="home-work-row" href={`#/${row.route}`}
            onFocus={() => { if (section === 'needs') focusedRequest.current = row.key }}
            onClick={event => {
              if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault(); setPanel({ kind: 'work', row })
              }
            }}>
            <span className="home-work-icon" data-tone={section === 'needs' ? row.tone : 'neutral'}><Icon name={icons[row.kind]} /></span>
            <span className="home-work-copy">
              <span className="home-work-title">{row.title}</span>
              <span className="home-work-reason" data-tone={section === 'needs' ? row.tone : undefined}>{row.reason}</span>
              {steps.length > 0 && <span className="home-work-progress"><progress max={steps.length} value={completed} aria-label={`${row.title} progress`} /><span>{completed} of {steps.length} steps</span></span>}
              <span className="home-work-meta">{labels[row.kind]}{row.context !== labels[row.kind] && <> · {row.context}</>}
                {timestamp > 0 && <> · <time dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()}>{age(timestamp, now)}</time></>}
                {stale && <span className="home-stale"> · Last known status</span>}
              </span>
            </span>
            <span className="home-work-action">{row.action}<Icon name="arrow-right" /></span>
          </Link>
        </li>
      })}
    </ul>
  }

  return <div className="ws-page home-page">
    <PageHeader className="ws-heading home-header" title="Home"
      actions={<><HomeSearch items={commands} onAction={command} />
        <Button variant="secondary" className="home-new-chat" aria-label="New chat" onPress={() => navigate('chat')}><Icon name="plus" /><span>New chat</span></Button></>} />

    <HomeStarter workspace={w} workflows={workflows} navigate={navigate} onWorkflow={() => setPanel({ kind: 'workflows' })} onTerminal={() => setPanel({ kind: 'terminal' })}
      onProjects={browseProjects} onInbox={() => openInbox()} inboxCount={pending.messages.filter(message => !message.acknowledged_at && !message.archived).length} />

    <div className="home-activity-grid">
    <section className="home-section home-attention" aria-labelledby="home-needs-heading">
      <div className="home-section-heading">
        <div className="home-section-title"><span className="home-section-symbol"><Icon name="info" /></span>
          <h2 id="home-needs-heading" ref={heading} tabIndex={-1}>Needs you{requests.length + supervisionUpdates.length > 0 && <span className="home-count">{requests.length + supervisionUpdates.length}</span>}</h2></div>
      </div>
      {visibleRequests.length > 0 ? rows(visibleRequests, 'needs') : checking.length > 0
        ? <div className="home-empty"><LoadingIndicator label="Checking what needs you…" /></div>
        : <div className="home-empty"><span className="home-empty-symbol"><Icon name={complete ? 'check' : 'messages-square'} /></span><div>
          <p>{complete ? 'Nothing needs your response right now.' : 'No requests in the available services.'}</p>
        </div></div>}
      {requests.length > 5 && <Button variant="ghost" className="home-show-more" onPress={() => {
        setExpanded(!expanded)
      }}>{expanded ? 'Show fewer' : `View all ${requests.length} requests`}<Icon name={expanded ? 'arrow-up' : 'chevron-down'} /></Button>}

    {supervisionUpdates.length > 0 &&
      <section className="home-supervision" aria-label="Supervision updates"><div className="home-section-heading"><h3>Supervision updates</h3>
        <Button variant="ghost" size="sm" onPress={() => navigate('chat/supervising')}>View supervising chats</Button></div>
        <ul className="home-work-list">{supervisionUpdates.slice(0, 5).map(monitor =>
          <li key={monitor.id}><Link href={`#/${supervisionRoute(monitor)}`} className="home-work-row">
            <span className="home-work-icon"><Icon name="eye" /></span><span className="home-work-copy"><span className="home-work-title">{monitor.title}</span>
              <span className="home-work-reason">{monitor.progress}</span><span className="home-work-meta">{monitorLabels[monitor.state]}</span></span>
            <span className="home-work-action">Open chat<Icon name="arrow-right" /></span></Link></li>)}</ul>
      </section>}

      <div className="home-feed-status" aria-live="polite" aria-atomic="true">
        {checking.length > 0 && visibleRequests.length > 0 && <p>Checking {checking.map(source => source.label).join(', ')}…</p>}
        {unavailable.map(source => <div className="home-source-issue" key={source.id}>
          <span>{source.id === 'message' && w.carrier.retryRequired
            ? w.carrier.error : `${source.label} status unavailable. Saved items may have changed.`}</span>
          <Button variant="ghost" size="sm" onPress={source.retry} aria-label={`Retry ${source.label} status`}>Retry</Button>
        </div>)}
      </div>
      {pending.more && <Link className="home-more-messages" href="#/carrier" variant="quiet" onClick={event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openInbox() }
      }}>View remaining messages in Carrier<Icon name="arrow-right" /></Link>}
    </section>

      <section className="home-section home-running" aria-labelledby="home-running-heading">
        <div className="home-section-heading"><div className="home-section-title"><span className="home-section-symbol home-section-symbol--live"><Icon name="clock" /></span>
          <h2 id="home-running-heading">Live work{work.running.length > 0 && <span className="home-count">{work.running.length}</span>}</h2></div></div>
        {work.running.length ? rows(showRunning ? work.running : work.running.slice(0, 3), 'running') : <div className="home-empty"><span className="home-empty-symbol"><Icon name={checking.length ? 'clock' : unavailable.length ? 'info' : 'check'} /></span><p>{checking.length ? 'Checking running work…' : unavailable.length ? 'Running work status unavailable.' : 'No running work.'}</p></div>}
        {work.running.length > 3 && <Button variant="ghost" className="home-show-more" onPress={() => setShowRunning(!showRunning)}>{showRunning ? 'Show fewer' : `View all ${work.running.length} running`}<Icon name={showRunning ? 'arrow-up' : 'chevron-down'} /></Button>}
      </section>
    </div>

    <HomeWorkspace workspace={w} workflows={workflows} items={work.items} tab={tab} onTabChange={setTab}
      onNewProject={() => setNewProjectOpen(true)} onProjectChat={projectChat} onProjectFiles={project => setPanel({ kind: 'files', project })}
      onRunWorkflow={workflow => setPanel({ kind: 'workflow', workflow })} onOpen={row => setPanel({ kind: 'work', row })} navigate={navigate} />
    <NewProject open={newProjectOpen} onOpenChange={setNewProjectOpen} disabled={!agentOnline} create={w.projects.create}
      onCreated={project => { const composer = w.chatComposers.getDraft(); composer.draft.set({ ...composer.draft.getSnapshot(), project: project.name }); browseProjects() }} />
    {panel?.kind === 'work' && <HomeDetails key={panel.row.key} row={panel.row} workspace={w} terminals={terminals} messages={pending.messages}
      onClose={() => setPanel(null)} onAcknowledged={pending.retry} openInbox={openInbox} />}
    {panel?.kind === 'files' && <HomeSheet title={panel.project.name} description="Project files" onClose={() => setPanel(null)}>
      <div className="home-project-files"><ProjectFilesPane project={panel.project} agents={w.agents} /></div>
    </HomeSheet>}
    {panel?.kind === 'terminal' && <HomeTerminalLauncher terminals={terminals} navigate={navigate} onClose={() => setPanel(null)} />}
    {panel?.kind === 'workflows' && <HomeWorkflowPicker workflows={workflows} navigate={navigate} onClose={() => setPanel(null)} onSelect={workflow => setPanel({ kind: 'workflow', workflow })} />}
    {panel?.kind === 'workflow' && <HomeWorkflowLauncher key={panel.workflow.id} workflow={panel.workflow} workspace={w} navigate={navigate}
      onClose={() => setPanel(null)} projectId={w.projects.projects.find(project => project.name === w.chatComposers.getDraft().draft.getProject())?.id} />}
  </div>
}
