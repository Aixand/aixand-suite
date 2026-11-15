import { useLayoutEffect, useRef, useState, type FocusEvent } from 'react'
import { Badge, Button, EmptyState, Icon, PageHeader, Popover, SearchField, Select } from 'bbb-design'
import type { SavedWorkflow, WorkflowTemplate } from '../workflows/library'
import { NewWorkflow } from '../workflows/NewWorkflow'
import '../workflows/library.css'
import type { ChatWorkflow } from '../chats/model'
import type { AgentsModel } from '../agents/model'
import type { Project } from '../projects/model'
import { CommandWorkflow } from '../workflows/CommandWorkflow'
import { useContentFieldVariant } from '../branding/ContentTheme'

type StatusGroup = 'saved' | 'active' | 'attention' | 'finished' | 'failed'
type WorkflowStatus = { label: string; group: StatusGroup; tone: 'neutral' | 'accent' | 'success' | 'warning' }
const runStatuses: Record<string, WorkflowStatus> = {
  pending: { label: 'Pending', group: 'active', tone: 'neutral' },
  prepared: { label: 'Preparing', group: 'active', tone: 'neutral' },
  creating: { label: 'Starting', group: 'active', tone: 'neutral' },
  created: { label: 'Starting', group: 'active', tone: 'neutral' },
  starting: { label: 'Starting', group: 'active', tone: 'neutral' },
  submitting: { label: 'Starting', group: 'active', tone: 'neutral' },
  queued: { label: 'Queued', group: 'active', tone: 'neutral' },
  running: { label: 'Running', group: 'active', tone: 'accent' },
  waiting: { label: 'Needs you', group: 'attention', tone: 'warning' },
  blocked: { label: 'Blocked', group: 'attention', tone: 'warning' },
  uncertain: { label: 'Check status', group: 'attention', tone: 'warning' },
  offline: { label: 'Check status', group: 'attention', tone: 'warning' },
  'waiting-for-reports': { label: 'Waiting', group: 'active', tone: 'neutral' },
  report_pending: { label: 'Report pending', group: 'active', tone: 'neutral' },
  'pending-delivery': { label: 'Report pending', group: 'active', tone: 'neutral' },
  completed: { label: 'Completed', group: 'finished', tone: 'success' },
  delivered: { label: 'Completed', group: 'finished', tone: 'success' },
  cancelled: { label: 'Cancelled', group: 'finished', tone: 'neutral' },
  failed: { label: 'Failed', group: 'failed', tone: 'warning' },
  'failure-delivered': { label: 'Failed', group: 'failed', tone: 'warning' },
}
const priority: Record<StatusGroup, number> = { attention: 0, failed: 0, active: 1, saved: 2, finished: 2 }
const dateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })

type WorkflowRow = {
  key: string; title: string; description: string; projectId: string; updatedAt: number; status: WorkflowStatus
} & ({ kind: 'saved'; workflow: SavedWorkflow } | { kind: 'run'; run: ChatWorkflow })

function runStatus(run: ChatWorkflow): WorkflowStatus {
  const status = runStatuses[run.state] ?? { label: 'Check status', group: 'attention', tone: 'warning' }
  return run.held && status.group === 'active' ? { label: 'On hold', group: 'attention', tone: 'warning' } : status
}

export function Workflows({
  workflows, onOpen, create, notice,
  runs, onOpenRun, runError, runLoading, nextOffset, loadRuns,
  agents, projects = [],
}: {
  workflows: SavedWorkflow[]
  onOpen: (id: string) => void
  create: (name: string, template?: WorkflowTemplate) => string
  notice: string
  runs: ChatWorkflow[]
  onOpenRun: (key: string) => void
  runError: string
  runLoading: boolean
  nextOffset: number | null
  loadRuns: (offset?: number) => Promise<void>
  agents?: AgentsModel
  projects?: Pick<Project, 'id' | 'name'>[]
}) {
  const fieldVariant = useContentFieldVariant()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [status, setStatus] = useState('all')
  const [project, setProject] = useState('all')
  const [actionError, setActionError] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const focusedRun = useRef<{ key: string; action: string } | null>(null)
  const activeFilters = Number(kind !== 'all') + Number(status !== 'all') + Number(project !== 'all')
  const includesRuns = kind !== 'saved'
  const projectNames = new Map(projects.map(project => [project.id, project.name]))
  for (const run of runs) if (run.projectId || run.project) projectNames.set(run.projectId || `name:${run.project}`, run.project || projectNames.get(run.projectId) || run.projectId)
  for (const workflow of workflows) if (workflow.draft.native?.projectId && !projectNames.has(workflow.draft.native.projectId))
    projectNames.set(workflow.draft.native.projectId, workflow.draft.native.projectId)
  const rows: WorkflowRow[] = [
    ...workflows.map((workflow): WorkflowRow => ({
      kind: 'saved', workflow, key: `saved:${workflow.id}`, title: workflow.draft.name || 'Untitled workflow',
      description: workflow.draft.description, projectId: workflow.draft.native?.projectId || '',
      updatedAt: Date.parse(workflow.updatedAt), status: { label: 'Saved', group: 'saved', tone: 'neutral' },
    })),
    ...runs.map((run): WorkflowRow => ({
      kind: 'run', run, key: `run:${run.key}`, title: run.title || 'Untitled workflow', description: '',
      projectId: run.projectId || (run.project ? `name:${run.project}` : ''), updatedAt: run.updatedAt, status: runStatus(run),
    })),
  ]
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = rows.filter(row => (kind === 'all' || row.kind === kind) &&
    (status === 'all' || row.status.group === status || status === 'attention' && row.status.group === 'failed') &&
    (project === 'all' || (project === 'none' ? !row.projectId : row.projectId === project)) &&
    `${row.title} ${row.description} ${projectNames.get(row.projectId) ?? ''} ${row.kind === 'run' ? row.run.id ?? '' : ''}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => priority[a.status.group] - priority[b.status.group] || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))

  // Live progress can reorder a row or remove it from the selected status filter.
  useLayoutEffect(() => {
    const focused = focusedRun.current
    if (!focused || document.activeElement !== document.body) return
    const target = [...list.current?.querySelectorAll<HTMLButtonElement>('[data-workflow-run]') ?? []]
      .find(button => button.dataset.workflowRun === focused.key && button.dataset.runAction === focused.action)
    if (target) target.focus({ preventScroll: true })
    else { focusedRun.current = null; search.current?.focus({ preventScroll: true }) }
  }, [runs, query, kind, status, project])

  const resetFilters = () => { setKind('all'); setStatus('all'); setProject('all') }
  const runFocus = (key: string, action: string) => ({
    'data-workflow-run': key, 'data-run-action': action,
    onFocus: () => { focusedRun.current = { key, action } },
    onBlur: (event: FocusEvent) => { if (event.relatedTarget) focusedRun.current = null },
  })

  return <div className="page-stack workflow-library">
    <PageHeader title="Workflows" className="ws-heading" actions={<div className="workflow-library-tools">
      <SearchField ref={search} label="Search workflows" placeholder="Search workflows…" value={query} onChange={setQuery} />
      <Popover title="Filter workflows" className="workflow-filter-popover" trigger={<Button variant="ghost" className="workflow-filter-trigger"
        aria-label={`Filter workflows${activeFilters ? `, ${activeFilters} active ${activeFilters === 1 ? 'filter' : 'filters'}` : ''}`}>
        <svg className="bbb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16l-6 7v7l-4 2v-9z" /></svg>
        {activeFilters > 0 && <span className="workflow-filter-count" aria-hidden="true">{activeFilters}</span>}
      </Button>}>
        <div className="workflow-filter-fields">
          <Select label="Show" variant={fieldVariant} value={kind} onChange={value => { setKind(value); if (value === 'saved') setStatus('all') }} options={[
            { id: 'all', label: 'Everything' }, { id: 'saved', label: 'Saved workflows' }, { id: 'run', label: 'Runs' },
          ]} />
          <Select label="Status" variant={fieldVariant} value={status} onChange={setStatus} disabled={kind === 'saved'} options={[
            { id: 'all', label: 'Any status' }, { id: 'active', label: 'Active' }, { id: 'attention', label: 'Needs attention' },
            { id: 'finished', label: 'Finished' }, { id: 'failed', label: 'Failed' },
          ]} />
          <Select label="Project" variant={fieldVariant} value={project} onChange={setProject} options={[
            { id: 'all', label: 'All projects' }, { id: 'none', label: 'No project' },
            ...[...projectNames].sort((a, b) => a[1].localeCompare(b[1])).map(([id, label]) => ({ id, label })),
          ]} />
          <Button variant="ghost" size="sm" onPress={resetFilters}>Reset filters</Button>
        </div>
      </Popover>
      <NewWorkflow create={create} onCreated={onOpen} trigger={<Button className="workflow-new" aria-label="New workflow"><Icon name="plus" /><span>New<span className="workflow-new-suffix"> workflow</span></span></Button>} />
    </div>} />
    {notice && <p role="status" className="workflow-library-notice">{notice}</p>}
    {actionError && <div className="workflow-library-error">
      <p role="alert">{actionError}</p>
      <Button variant="ghost" size="sm" onPress={() => setActionError('')}>Dismiss</Button>
    </div>}
    {includesRuns && runError && <div className="workflow-library-error">
      <p role="alert">{runError}</p>
      <Button variant="ghost" size="sm" disabled={runLoading} onPress={() => { void loadRuns() }}>Retry loading runs</Button>
    </div>}
    <p className="bbb-visually-hidden" aria-live="polite">{filtered.length} {filtered.length === 1 ? 'workflow' : 'workflows'} shown.{includesRuns && runLoading ? ' Loading workflow runs…' : ''}</p>
    {filtered.length ? <ul ref={list} className="workflow-list workflow-library-list" aria-label="Workflows">
      {filtered.map(row => {
        const open = () => row.kind === 'run' ? onOpenRun(row.run.key) : onOpen(row.workflow.id)
        const steps = row.kind === 'run' ? row.run.steps : row.workflow.draft.nodes
        const progress = row.kind === 'run' ? steps.length > 0 ? `${row.run.steps.filter(step => step.state === 'completed').length}/${steps.length} steps` : '' :
          `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
        const context = [projectNames.get(row.projectId), row.kind === 'run' ? row.run.originChatId ? 'Chat' : 'Run' : '', progress].filter(Boolean).join(' · ')
        return <li key={row.key} className="workflow-library-row" data-kind={row.kind} data-status={row.status.group}>
          <span className="workflow-symbol"><Icon name="layers" /></span>
          <div className="workflow-copy">
            <div className="workflow-row-heading">
              <Button className="workflow-link" variant="ghost" aria-description={row.description || undefined}
                {...(row.kind === 'run' ? runFocus(row.run.key, 'title') : {})} onPress={open}><span title={row.title}>{row.title}</span></Button>
              <Badge tone={row.status.tone} dot={row.kind === 'run'} title={row.status.label}><span className="workflow-status-label">{row.status.label}</span></Badge>
            </div>
            <p className="workflow-row-meta" title={context}>
              <span>{context}</span>
              {row.kind === 'saved' && <><span aria-hidden="true"> · </span><time dateTime={row.workflow.updatedAt}
                title={`Updated ${new Date(row.updatedAt).toLocaleString()}`}>Updated {dateFormat.format(row.updatedAt)}</time></>}
            </p>
          </div>
          <div className="workflow-row-actions">
            {row.kind === 'saved' && agents && <CommandWorkflow key={`${row.workflow.id}:${row.workflow.updatedAt}`} workflow={row.workflow} agents={agents}
              onError={error => setActionError(error ? `${row.title}: ${error}` : '')} />}
            <Button className="workflow-row-action" variant="ghost" size="sm" iconOnly aria-label={row.kind === 'run' ? `View workflow ${row.title}` : `Open ${row.title}`}
              {...(row.kind === 'run' ? runFocus(row.run.key, 'view') : {})} onPress={open}><Icon name="chevron-right" /></Button>
          </div>
        </li>
      })}
    </ul> : !(includesRuns && runLoading) && <EmptyState icon="search" headingLevel={2}
      title={normalizedQuery || activeFilters ? 'No matching workflows' : 'No workflows yet'}
      description={normalizedQuery || activeFilters ? 'Try another search or reset your filters.' : ''}
      action={normalizedQuery || activeFilters ? <Button variant="ghost" onPress={() => { setQuery(''); resetFilters(); search.current?.focus() }}>Clear search and filters</Button> : undefined} />}
    {includesRuns && nextOffset !== null && <Button className="workflow-load-more" variant="ghost" disabled={runLoading} onPress={() => { void loadRuns(nextOffset) }}>Load more runs</Button>}
  </div>
}
