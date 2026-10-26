import { useLayoutEffect, useRef, useState } from 'react'
import { Button, EmptyState, Icon, PageHeader, SearchField, TextField, useThemeAttributes } from 'bbb-design'
import type { SavedWorkflow, WorkflowTemplate } from '../workflows/library'
import { NewWorkflow } from '../workflows/NewWorkflow'
import '../workflows/library.css'
import type { ChatWorkflow } from '../chats/model'
import { workflowLabels } from '../chats/WorkflowCards'
import type { AgentsModel } from '../agents/model'
import { CommandWorkflow } from '../workflows/CommandWorkflow'
import { ContentDisclosure } from '../components/ContentDisclosure'

const attentionStates = new Set(['waiting', 'failed', 'uncertain', 'blocked', 'offline', 'failure-delivered'])
const finishedStates = new Set(['completed', 'cancelled', 'delivered'])

export function Workflows({
  workflows,
  onOpen,
  create,
  notice,
  runs, onOpenRun, runError, runLoading, nextOffset, loadRuns,
  agents,
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
}) {
  const soft = useThemeAttributes()['data-bbb-mode'] === 'dark'
  const [query, setQuery] = useState('')
  const runSection = useRef<HTMLElement>(null)
  const focusedRun = useRef<{ key: string; action: string } | null>(null)
  const filtered = workflows.filter(
    (w) => `${w.draft.name} ${w.draft.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const filteredRuns = runs.filter((run) => `${run.title} ${run.project} ${run.id ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const attention = filteredRuns.filter(run => attentionStates.has(run.state))
  const ongoing = filteredRuns.filter(run => !attentionStates.has(run.state) && !finishedStates.has(run.state))
  const finished = filteredRuns.filter(run => finishedStates.has(run.state))

  // A live state change may move a focused run to another group or into history.
  useLayoutEffect(() => {
    const focused = focusedRun.current
    if (!focused || document.activeElement !== document.body) return
    const target = [...runSection.current?.querySelectorAll<HTMLButtonElement>('[data-workflow-run]') ?? []]
      .find(button => button.dataset.workflowRun === focused.key && button.dataset.runAction === focused.action)
    const disclosure = target?.closest('details')
    if (disclosure) disclosure.open = true
    target?.focus({ preventScroll: true })
  }, [runs, query, soft])

  function runList(items: ChatWorkflow[], label: string) {
    return <ul className="workflow-list" aria-label={label}>
      {items.map(run => <li key={run.key}>
        <span className="workflow-symbol"><Icon name="layers" /></span>
        <div className="workflow-copy">
          <Button className="workflow-link" variant="ghost" data-workflow-run={run.key} data-run-action="title"
            onFocus={() => { focusedRun.current = { key: run.key, action: 'title' } }}
            onBlur={event => { if (event.relatedTarget) focusedRun.current = null }}
            onPress={() => onOpenRun(run.key)}>{run.title}</Button>
          <p>{run.project} · <span className="workflow-run-state" data-attention={soft && attentionStates.has(run.state) || undefined}>{soft && run.state === 'uncertain' ? 'Check run status' : workflowLabels[run.state] ?? run.state}</span>{run.delivery && ' · Main inbox delivery confirmed'}</p>
        </div>
        <Button className="workflow-row-action" variant="ghost" size="sm" iconOnly={soft} data-workflow-run={run.key} data-run-action="view"
          onFocus={() => { focusedRun.current = { key: run.key, action: 'view' } }}
          onBlur={event => { if (event.relatedTarget) focusedRun.current = null }}
          onPress={() => onOpenRun(run.key)} aria-label={`View workflow ${run.title}`}>
          {soft ? <Icon name="chevron-right" /> : 'View workflow'}
        </Button>
      </li>)}
    </ul>
  }
  return (
    <div className="page-stack workflow-library">
      <PageHeader
        title="Workflows"
        className="ws-heading"
        description="Follow running workflows, open a saved workflow, or create a new one."
        actions={
          <NewWorkflow create={create} onCreated={onOpen}
            trigger={<Button><Icon name="plus" /> New workflow</Button>} />
        }
      />
      {notice && <p role="status">{notice}</p>}
      <div className="list-tools">
        {soft ? <SearchField label="Search workflows" placeholder="Search workflows…" value={query} onChange={setQuery} /> : <TextField
          label="Search workflows"
          hideLabel
          placeholder="Search workflows…"
          leadingIcon={<Icon name="search" />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />}
      </div>
      <div className="results-summary">
        <p role={soft ? 'status' : undefined}>
          {filtered.length} {filtered.length === 1 ? 'saved workflow' : 'saved workflows'}
          {query.trim() ? ` of ${workflows.length}` : ''}
          {soft && <> · {filteredRuns.length} loaded {filteredRuns.length === 1 ? 'run' : 'runs'}</>}
        </p>
        {query && !soft && (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setQuery('')}
          >
            <Icon name="x" /> Clear search
          </Button>
        )}
      </div>
      <section ref={runSection} className="workflow-runs" aria-label="Workflow runs">
        <h2>Runs</h2>
        {runError && <p role="alert">{runError}</p>}
        {runLoading && <p role="status">Loading workflow runs…</p>}
        {filteredRuns.length > 0 ? soft ? <>
          {attention.length > 0 && <div className="workflow-run-group"><h3>Needs attention <span>{attention.length}</span></h3>{runList(attention, 'Workflows needing attention')}</div>}
          {ongoing.length > 0 && <div className="workflow-run-group"><h3>In progress <span>{ongoing.length}</span></h3>{runList(ongoing, 'Workflows in progress')}</div>}
          {!attention.length && !ongoing.length && <p className="workflow-run-empty">No runs need attention or are in progress.</p>}
          {finished.length > 0 && <ContentDisclosure title={`Finished runs (${finished.length})`} defaultOpen={Boolean(query.trim())}>
            {runList(finished, 'Finished workflow runs')}
          </ContentDisclosure>}
        </> : runList(filteredRuns, 'Workflow runs list') : <p>{query.trim() ? 'No matching runs loaded.' : 'Chat-created workflows appear here automatically.'}</p>}
        {runError && <Button variant="ghost" disabled={runLoading} onPress={() => { void loadRuns() }}>Retry loading runs</Button>}
        {nextOffset !== null && <Button variant="ghost" disabled={runLoading} onPress={() => { void loadRuns(nextOffset) }}>Load more runs</Button>}
      </section>
      <h2>Saved workflows</h2>
      {filtered.length ? (
        <ul className="workflow-list" aria-label="Saved workflows">
          {filtered.map((workflow) => (
            <li key={workflow.id}>
              <span className="workflow-symbol"><Icon name="layers" /></span>
              <div className="workflow-copy">
                <Button className="workflow-link" variant="ghost" onPress={() => onOpen(workflow.id)}>
                  {workflow.draft.name || 'Untitled workflow'}
                </Button>
                <p>{workflow.draft.nodes.length} {workflow.draft.nodes.length === 1 ? 'step' : 'steps'}
                  {workflow.draft.description && <> <span aria-hidden="true">·</span> {workflow.draft.description}</>}
                </p>
              </div>
              <time className="workflow-date" dateTime={workflow.updatedAt}
                title={`Updated ${new Date(workflow.updatedAt).toLocaleString()}`}>
                {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(workflow.updatedAt))}
              </time>
              {agents && <CommandWorkflow key={`${workflow.id}:${workflow.updatedAt}`} workflow={workflow} agents={agents}
                onOpen={soft ? () => onOpen(workflow.id) : undefined} />}
              {(!soft || !agents) && <Button className="workflow-row-action" variant="ghost" iconOnly size="sm" aria-label={`Open ${workflow.draft.name || 'Untitled workflow'}`}
                onPress={() => onOpen(workflow.id)}><Icon name="chevron-right" /></Button>}
            </li>
          ))}
        </ul>
      ) : <EmptyState icon="search" title={query.trim() ? 'No saved workflows found' : 'No saved workflows'}
        description={query.trim() ? 'Try another name or clear your search.' : 'Create a workflow to start adding steps.'} />}
    </div>
  )
}
