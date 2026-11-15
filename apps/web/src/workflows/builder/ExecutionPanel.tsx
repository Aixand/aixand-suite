import { permissionModes } from '../../agents/permissions'
import type { PermissionMode } from '../../agents/permissions'
import { ProfilePicker } from '../../agents/profileSelection'
import { Button, Icon, Select, Textarea, useThemeAttributes } from 'bbb-design'
import type { CanvasDraft } from './model'
import type { Workspace } from '../../workspace/model'
import type { WorkflowRun } from './useWorkflowRun'
import { ContinuationPanel } from './ContinuationPanel'
import { useState } from 'react'
import { supportsWorkflows, usesToolApprovals } from '../capabilities'
import { ContentDisclosure } from '../../components/ContentDisclosure'

export function ExecutionPanel({
  run,
  problem,
  close,
  resetWorkflow,
  workspace,
  configure,
  editingRun, setEditingRun, saveDefinition, dirty, navigate, restoreAccepted,
}: {
  run: WorkflowRun
  workspace?: Workspace
  configure: (settings: CanvasDraft['native']) => void
  problem: string
  close: () => void
  resetWorkflow: () => void
  editingRun: boolean
  setEditingRun: (value: boolean) => void
  saveDefinition: () => void
  dirty: boolean
  navigate?: (route: string) => void
  restoreAccepted: () => void
}) {
  const soft = useThemeAttributes()['data-bbb-mode'] === 'dark'
  const [showNext, setShowNext] = useState(false)
  const controller = workspace?.chats.chats.find(chat => chat.id === run.settings.controllerChatId)
  const sdkController = usesToolApprovals(controller)
  const label =
    run.state === 'completed'
      ? 'Workflow completed'
      : run.state === 'running'
        ? 'Workflow running'
        : run.state === 'queued'
          ? 'Workflow queued'
          : run.state
            ? `Workflow ${run.state}`
            : 'Run workflow'
  const controllerSettings = <>
          <Select label="Controller conversation" value={run.settings.controllerChatId} disabled={run.busy}
            options={[{ id: '', label: 'Create a workflow conversation' }, ...(workspace?.chats.chats ?? []).filter(supportsWorkflows).map((chat) => ({ id: chat.id, label: chat.title }))]}
            onChange={(controllerChatId) => {
              const selected = workspace?.chats.chats.find(chat => chat.id === controllerChatId)
              const sdk = usesToolApprovals(selected)
              configure({ ...run.settings, controllerChatId,
                ...(sdk ? { permissionMode: undefined } : { sdkApprovalPolicy: undefined }),
                ...(selected?.backend && run.settings.profileSelection?.mode === 'auto' ? { profileSelection: { mode: 'controller' as const } } : {}) })
            }} />
          {!run.settings.controllerChatId && <Select label="Controller profile" value={run.settings.profile} disabled={run.busy}
            options={[{ id: '@auto', label: 'Auto' }, ...(workspace?.profiles ?? []).filter((entry) => entry.provider === 'codex').map((entry) => ({ id: entry.profile, label: entry.profile }))]}
            onChange={(profile) => configure({ ...run.settings, profile })} />}
  </>
  const accessSettings = <>
          {sdkController ? <Select label="Workflow tool approvals" value={run.settings.sdkApprovalPolicy ?? 'inherit'} disabled={run.busy}
            options={[{ id: 'inherit', label: 'Inherit controller policy' }, { id: 'ask', label: 'Ask for approval' }, { id: 'deny', label: 'Deny approval prompts' }]}
            onChange={value => configure({ ...run.settings, permissionMode: undefined, sdkApprovalPolicy: value === 'inherit' ? undefined : value as 'ask' | 'deny' })} /> : <Select label="Workflow access" value={run.settings.permissionMode ?? 'inherit'} disabled={run.busy}
            options={[{ id: 'inherit', label: 'Saved spawn default' }, ...permissionModes]}
            onChange={(mode) => configure({ ...run.settings, permissionMode: mode === 'inherit' ? undefined : mode as PermissionMode })} />}
          <ProfilePicker label="Workflow profile" value={run.settings.profileSelection} disabled={run.busy}
            allowAuto={!controller?.backend} onChange={(profileSelection) => configure({ ...run.settings, profileSelection })} />

  </>
  const resourceSettings = <Select label="Resource versions" value={run.settings.resourceCapture ?? 'stage'} disabled={run.busy}
            options={[{ id: 'stage', label: 'Select when each stage starts' }, { id: 'workflow', label: 'Keep versions selected for this run' }]}
            onChange={(value) => configure({ ...run.settings, resourceCapture: value === 'workflow' ? 'workflow' : undefined })} />
  const setup = run.needsProject && <ContentDisclosure title="Run setup" enabled={soft && !!run.snapshot} defaultOpen={!run.busy}>
    <Select label="Project" value={run.settings.projectId} disabled={run.busy}
            options={[{ id: '', label: 'Choose a saved project' }, ...(workspace?.projects.projects ?? []).map((project) => ({ id: project.id, label: project.name }))]}
            onChange={(projectId) => configure({ ...run.settings, projectId })} />
    {soft ? <>{accessSettings}<ContentDisclosure title="Controller and resource settings">{controllerSettings}{resourceSettings}</ContentDisclosure></>
      : <>{controllerSettings}{accessSettings}{resourceSettings}</>}
  </ContentDisclosure>
  const launch = (!soft || !run.busy) && <>
<Button
          onPress={run.start}
          disabled={!!problem && !run.legacy || run.status !== 'connected' || run.busy || run.needsProject && !run.settings.projectId && !run.legacy}
        >
          Start run
        </Button>
        <ContentDisclosure title="Run inputs">
        {!run.busy && <Textarea label="Workflow inputs (JSON)" value={run.inputText} rows={3}
          onChange={(event) => run.setInputText(event.target.value)} />}
        </ContentDisclosure>
  </>
  const pauseControls = run.mutable && run.plan?.phase === 'open' && <>
    <Button variant="secondary" disabled={run.actionBusy || run.status !== 'connected'}
      onPress={() => { void run.hold(!run.plan?.held) }}>{run.plan.held ? 'Resume upcoming steps' : 'Pause upcoming steps'}</Button>
    {run.plan.held && <p role="status">Upcoming steps are paused. Current tasks continue.</p>}
  </>
  const runIdentifiers = run.snapshot?.jobId && <ContentDisclosure title="Run identifiers"><p className="wb-run-id">Job: {run.snapshot.jobId}</p></ContentDisclosure>
  return (
    <aside
      className="wb-inspector wb-run-panel"
      aria-label="Workflow execution"
    >
      <header className="wb-panel-heading">
        <h2>{label}</h2>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Close execution"
          onPress={close}
        >
          <Icon name="x" />
        </Button>
      </header>
      <div className="wb-inspector-body">
        {run.status !== 'connected' ? (
          <>
            <p role="status" className="wb-muted">{run.error ? 'Reconnecting to Runner…' : 'Connecting to Runner…'}</p>
            {run.status === 'offline' && <Button
              onPress={run.connect}
            >
              Retry connection
            </Button>}
          </>
        ) : (
          <p className="wb-muted">Connected to Runner</p>
        )}
        {(!soft || !run.snapshot) && setup}
        {problem && !run.busy && (
          <div className="wb-run-problem">
            <p>{problem}</p>
            <Button variant="secondary" size="sm" onPress={resetWorkflow}>
              Use Sequential hello
            </Button>
          </div>
        )}
        {(!soft || !run.snapshot) && launch}
        {soft && pauseControls}
        <ContentDisclosure title="Edit run and saved workflow" enabled={soft && !!run.snapshot && (run.mutable || run.supportsMutable && ['queued', 'running'].includes(run.state ?? ''))} defaultOpen={dirty}>
        {run.supportsMutable && !run.mutable && run.snapshot?.jobId && 'format' in run.snapshot.workflow && ['queued', 'running'].includes(run.state ?? '') && <>
          <Button variant="secondary" disabled={run.actionBusy} onPress={() => { void run.enableEdits() }}>Enable editing of this run</Button>
          <p className="wb-muted">Upcoming steps will pause while Runner preserves the existing chats and results. Started SDK sessions keep their original execution path.</p>
        </>}
        {run.mutable && run.snapshot && <>
          <Select label="Edit scope" value={editingRun ? 'run' : 'definition'} options={[
            { id: 'run', label: 'This run' }, { id: 'definition', label: 'Saved workflow for future runs' },
          ]} onChange={(value) => setEditingRun(value === 'run')} />
          {run.plan?.phase === 'open' && <>
            {!soft && pauseControls}
            {editingRun && <>
              <Button disabled={!!problem || !dirty || run.actionBusy || run.status !== 'connected'}
                onPress={() => { void run.amend() }}>Apply changes to this run</Button>
              <Button variant="secondary" disabled={!!problem || !dirty || run.actionBusy || run.status !== 'connected'}
                onPress={() => { void run.amend().then((applied) => { if (applied) saveDefinition() }) }}>Apply and save for future runs</Button>
            </>}
          </>}
          <Button variant="ghost" onPress={saveDefinition}>Save workflow for future runs</Button>
          {dirty && editingRun && <Button variant="ghost" onPress={restoreAccepted}>Reload accepted plan</Button>}
          {run.plan && <p className="wb-muted">Accepted plan version {run.plan.revision} · {run.plan.phase === 'open' ? 'Pending steps can change' : 'Run plan is sealed'}</p>}
        </>}
        </ContentDisclosure>
        {(run.error || run.legacy?.error) && (
          <p role="alert" className="wb-run-error">
            {run.error || run.legacy?.error}
          </p>
        )}
        {run.canReconcile && <Button variant="secondary" disabled={run.status !== 'connected'} onPress={() => { void run.reconcile() }}>Resume existing run</Button>}
        {run.state === 'uncertain' && <p className="wb-run-error">Inspect the existing chats and sessions before starting another run. The unconfirmed work is retained.</p>}
        {run.snapshot && (
          <>
            <p className="wb-muted">
              {('format' in run.snapshot.workflow ? run.snapshot.workflow.workflow : run.snapshot.workflow).name} · Submitted version
            </p>
            {!soft && runIdentifiers}
            <ol className="wb-run-steps" aria-label="Run steps">
              {run.snapshot.order.map((id) => (
                <li key={id} data-status={run.states[id] ?? 'pending'}>
                  <span>{run.snapshot!.labels[id]}</span>
                  <small>{run.states[id] ?? 'pending'}</small>
                </li>
              ))}
            </ol>
            {!!(run.snapshot.optionalTools ?? run.snapshot.agentGraph?.tools)?.length && <>
              <h3>Optional tools</h3>
              <ul className="wb-run-steps" aria-label="Optional tools">
                {(run.snapshot.optionalTools ?? run.snapshot.agentGraph?.tools ?? []).map((id) => <li key={id} data-status={run.states[id] ?? 'pending'}>
                  <span>{run.snapshot!.labels[id]}</span><small>{run.states[id] ?? 'pending'}</small>
                </li>)}
              </ul>
              <p className="wb-muted">Available when the main agent asks. No consultation is required to finish.</p>
            </>}
            {run.busy && (
              <>
                <Button
                  variant="secondary"
                  onPress={() => {
                    void run.cancel()
                  }}
                  disabled={!run.snapshot.jobId || run.status !== 'connected'}
                >
                  Cancel run
                </Button>
                {run.error && run.status === 'connected' && (
                  <Button variant="ghost" onPress={run.resume}>
                    Resume monitoring
                  </Button>
                )}
              </>
            )}
            {soft && runIdentifiers}
          </>
        )}
        {run.legacy?.attempt && <>
          <p className="wb-muted">{run.legacy.attempt.title} · Previously submitted version</p>
          <p role="status">{run.legacy.run?.state ?? 'Submission unconfirmed'}</p>
          <Button variant="secondary" disabled={!run.legacy.connected || run.legacy.busy} onPress={() => { void run.legacy?.action('cancel') }}>Cancel run</Button>
          {!run.legacy.run?.id && <Button variant="secondary" disabled={!run.legacy.connected || run.legacy.busy} onPress={() => { void run.legacy?.start() }}>Retry saved request</Button>}
          <Button variant="ghost" onPress={run.inbox}>Open main inbox</Button>
        </>}
        {run.snapshot && 'format' in run.snapshot.workflow && run.snapshot.workflow.workflow.body.steps.some((step) => step.kind === 'operation' && step.operation.id === 'carrier.human.deliver') && <Button variant="ghost" onPress={run.inbox}>Open main inbox</Button>}
        {typeof run.result?.result?.final_reply_text === 'string' && (
          <div className="wb-final-reply"><h3>Final reply</h3><p>{run.result.result.final_reply_text}</p></div>
        )}
        {run.result?.result && (
          <details>
            <summary>Run outputs</summary>
            <pre aria-label="Workflow run outputs">
              {JSON.stringify(run.result.result, null, 2)}
            </pre>
          </details>
        )}
        {run.state === 'completed' && (
          <p role="status">{run.snapshot?.agentGraph ? 'Main task finished. Agent sessions closed.' : 'All steps finished. Agent sessions closed.'}</p>
        )}
        {run.snapshot?.jobId && run.supportsContinuations && <Button variant="secondary" onPress={() => setShowNext((value) => !value)}>Add follow-up workflow</Button>}
        {showNext && run.snapshot?.jobId && <ContinuationPanel jobId={run.snapshot.jobId} workspace={workspace} navigate={navigate}
          context={'format' in run.snapshot.workflow ? run.snapshot.workflow.context : undefined}
          exports={Object.keys('format' in run.snapshot.workflow ? run.snapshot.workflow.workflow.outputs : run.snapshot.workflow.outputs)
            .sort((a, b) => a === 'result' ? -1 : b === 'result' ? 1 : a.localeCompare(b))
            .map((name) => ({ id: `/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, label: name === 'result' ? 'Workflow result' : name }))} />}
        {soft && run.snapshot && <>{setup}{launch}</>}
        <ContentDisclosure title="How execution works"><p className="wb-inspector-footnote">
          Runner continues when you close the builder. Independent nodes run together; required connections wait for completed outputs. Adviser links make tools available without requiring consultation. Carrier replies are correlated and acknowledged before dependent work starts.
        </p></ContentDisclosure>
      </div>
    </aside>
  )
}
