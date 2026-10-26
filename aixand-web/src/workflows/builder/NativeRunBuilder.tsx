import { useEffect, useMemo, useState } from 'react'
import { Button, Icon, Select, Textarea, TextField } from 'bbb-design'
import { MarkerType, useReactFlow } from '@xyflow/react'
import type { Edge, EdgeChange, NodeChange, XYPosition } from '@xyflow/react'
import type { ChatWorkflow } from '../../chats/model'
import { ProfilePicker, ProfileResolution, profileSelectionLabel } from '../../agents/profileSelection'
import { permissionLabel } from '../../agents/permissions'
import type { PermissionMode } from '../../agents/permissions'
import { workflowLabels } from '../../chats/WorkflowCards'
import { arrangeNodes } from './model'
import type { WorkflowNode } from './model'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowToolbar } from './WorkflowToolbar'
import { RunNodeContext } from './RunNodeContext'
import type { RunNodeDetails } from './RunNodeContext'
import { BuilderIcon } from './StepNode'
import './native-run.css'
import { createCanvasId } from './model'
import { ContinuationPanel } from './ContinuationPanel'
import type { Workspace } from '../../workspace/model'
import { workflowActionFeedback, workflowGuidance } from '../feedback'

export type NativeRunBuilderProps = {
  mode: 'run'; run: ChatWorkflow; connected: boolean; error: string;
  onBack: () => void; onOpenChat: (id: string) => void; onInbox: () => void; onOpenOrigin?: () => void;
  onAction: (action: 'status' | 'cancel' | 'resume' | 'hold' | 'release') => Promise<unknown>;
  workspace?: Workspace;
  navigate?: (route: string) => void;
}
const terminal = ['completed', 'failed', 'cancelled', 'blocked']
const label = (state: string) => workflowLabels[state] ?? state

function submittedCanvas(run: ChatWorkflow, open: (id: string) => void, inbox: () => void) {
  const nodes: WorkflowNode[] = []
  const edges: Edge[] = []
  const details: Record<string, RunNodeDetails> = {}
  function add(id: string, kind: 'agent' | 'mailbox', title: string, runtime: Omit<RunNodeDetails, 'statusLabel'>, instruction = '') {
    nodes.push({ id, type: 'workflowStep', position: { x: 0, y: 0 },
      data: { kind, label: title, description: runtime.detail, prompt: instruction, agent: id,
        provider: run.definition?.provider ?? 'codex', profile: run.definition?.profile } })
    details[id] = { ...runtime, statusLabel: label(runtime.state) }
  }
  function edge(source: string, target: string, ready: boolean, title: string) {
    edges.push({ id: `${source}:${target}`, source, target, sourceHandle: 'out', targetHandle: 'in', label: title,
      type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      style: { strokeWidth: ready ? 2 : 1.5, strokeDasharray: ready ? undefined : '5 4' } })
  }
  for (const step of run.steps) {
    const definition = run.definition?.steps.find((entry) => entry.id === step.id)
    add(`stage:${step.id}`, 'agent', step.title, { kindLabel: step.sdkApprovalPolicy ? `Tool approvals: ${step.sdkApprovalPolicy}` : permissionLabel(step.permissionMode ?? 'read-only'), state: ['completed', 'failed', 'interrupted', 'cancelled'].includes(step.executionState ?? '') && step.reportState === 'pending' ? 'report_pending' : step.state,
      detail: step.receipt ? `Report received · Message ${step.receipt.messageId}${step.receipt.acknowledged ? ' · Acknowledged' : ' · Awaiting acknowledgment'}` :
        step.dependsOn.length ? 'Starts after every required report is received and acknowledged.' : 'Independent stage',
      meta: `${step.profileDecision?.profile ?? profileSelectionLabel(step.profileSelection)} · ${step.sdkApprovalPolicy ? 'Tool approvals' : `${step.permissionSource ?? 'legacy'} access`}`,
      ...(step.chat_id && !step.conversationDeleted ? { open: () => open(step.chat_id!), actionLabel: step.state === 'waiting' ? 'Open chat to respond' : `Open ${step.title.toLowerCase()}` } : {}),
    }, definition?.instruction)
    if (step.dependsOn.length) {
      const dependencies = step.dependsOn.map((id) => run.steps.find((entry) => entry.id === id))
      const received = dependencies.filter((dependency) => dependency?.state === 'completed' && dependency.receipt).length
      const ready = dependencies.every((dependency) => dependency?.state === 'completed' && dependency.receipt?.acknowledged)
      const blocked = dependencies.some((dependency) => dependency && ['failed', 'blocked', 'cancelled'].includes(dependency.state)) || terminal.includes(run.state) && !ready
      const join = `collector:${step.id}`
      add(join, 'mailbox', 'Collector inbox', { kindLabel: `Inputs for ${step.title}`, state: ready ? 'completed' : blocked ? 'blocked' : 'waiting-for-reports',
        detail: `${received} of ${dependencies.length} successful reports received${received === dependencies.length && !ready ? ' · Awaiting acknowledgment' : ''}` })
      for (const dependency of dependencies) if (dependency)
        edge(`stage:${dependency.id}`, join, !!dependency.receipt, dependency.receipt ? 'Report received' : 'Awaiting report')
      edge(join, `stage:${step.id}`, ready, ready ? 'Inputs ready' : blocked ? 'Blocked' : 'Awaiting all inputs')
    }
  }
  const confirmed = !!run.delivery
  add('human:main', 'mailbox', 'Main inbox', { kindLabel: 'For you',
    state: confirmed ? run.state === 'failed' ? 'failure-delivered' : 'delivered' : run.state === 'cancelled' ? 'cancelled' : 'pending-delivery',
    detail: confirmed ? `Delivery confirmed · Message ${run.delivery!.message_id}` : 'The final report will be delivered here.',
    open: inbox, actionLabel: 'Open main inbox' })
  if (run.state === 'failed' && confirmed) {
    for (const step of run.steps.filter((entry) => entry.state === 'failed')) edge(`stage:${step.id}`, 'human:main', true, 'Failure delivered')
  } else if (run.steps.some((step) => step.id === run.deliveryStep))
    edge(`stage:${run.deliveryStep}`, 'human:main', confirmed, confirmed ? 'Delivered' : 'Awaiting delivery')
  // The editor's layout is shared; taller runtime nodes need more vertical space.
  return { nodes: arrangeNodes(nodes, edges, { mode: 'dag' }).map((node) => ({ ...node, position: { ...node.position, y: node.position.y * 1.5 } })), edges, details }
}

function savedLayout(key: string): Record<string, XYPosition> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, XYPosition] => {
        const point = entry[1] as XYPosition | null
        return !!point && Number.isFinite(point.x) && Number.isFinite(point.y)
      }))
  } catch { /* A bad layout never changes the submitted workflow. */ }
  return {}
}

export function NativeRunBuilder({ run, connected, error, onBack, onOpenChat, onInbox, onOpenOrigin, onAction, workspace, navigate }: NativeRunBuilderProps) {
  const [panel, setPanel] = useState<'settings' | 'run' | null>(null)
  const [selection, setSelection] = useState<{ node?: string; edge?: string }>({})
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<keyof typeof workflowActionFeedback | null>(null)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [showNext, setShowNext] = useState(false)
  const nativePlan = run.executionWorkflow?.format === 'aixand.chat-workflow' ? run.executionWorkflow : undefined
  const sdk = !!nativePlan?.backend && nativePlan.backend !== 'native-codex'
  const [proposed, setProposed] = useState<typeof nativePlan>()
  const [baseRevision, setBaseRevision] = useState<number>()
  const mutable = !!nativePlan && nativePlan.version === 2 && run.phase === 'open' && !!workspace
  const displayRun: ChatWorkflow = proposed ? { ...run, deliveryStep: proposed.delivery_step,
    definition: { profile: proposed.profile, model: proposed.model ?? null, provider: proposed.provider, backend: proposed.backend, sdkApprovalPolicy: proposed.sdk_approval_policy, steps: proposed.steps },
    steps: proposed.steps.map((step) => ({ ...(run.steps.find((row) => row.id === step.id) ?? { state: 'pending' }),
      id: step.id, title: step.title, dependsOn: step.depends_on, permissionMode: step.permission_mode ?? proposed.permission_mode, sdkApprovalPolicy: step.sdk_approval_policy ?? proposed.sdk_approval_policy, permissionSource: step.permission_source ?? proposed.permission_source, profileSelection: step.profile_selection ?? proposed.profile_selection })) } : run
  const layoutKey = `aixand.workflow-run.layout.${run.key}`
  const [positions, setPositions] = useState(() => savedLayout(layoutKey))
  const [measurements, setMeasurements] = useState<Record<string, { width: number; height: number }>>({})
  const flow = useReactFlow<WorkflowNode>()
  const canvas = useMemo(() => submittedCanvas(displayRun, onOpenChat, onInbox), [displayRun, onOpenChat, onInbox])
  const nodes = canvas.nodes.map((node) => ({ ...node, measured: measurements[node.id], position: positions[node.id] ?? node.position, selected: node.id === selection.node }))
  const edges = canvas.edges.map((edge) => ({ ...edge, selected: edge.id === selection.edge }))
  const selectedNode = nodes.find((node) => node.id === selection.node)
  const selectedEdge = edges.find((edge) => edge.id === selection.edge)
  const selectedStage = displayRun.steps.find((step) => `stage:${step.id}` === selectedNode?.id)
  const editable = mutable && !!selectedStage && !run.lockedGroups?.includes(selectedStage.id)
  const runtime = selectedNode ? canvas.details[selectedNode.id] : undefined
  useEffect(() => {
    try { localStorage.setItem(layoutKey, JSON.stringify(positions)) }
    catch { setNotice('Layout changes are kept for this visit. Browser storage is unavailable.') }
  }, [layoutKey, positions])
  function nodesChanged(changes: NodeChange<WorkflowNode>[]) {
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) {
        const dimensions = change.dimensions
        setMeasurements((previous) => previous[change.id]?.width === dimensions.width && previous[change.id]?.height === dimensions.height ? previous :
          { ...previous, [change.id]: dimensions })
      }
      if (change.type === 'position' && change.position) {
        const point = change.position
        setPositions((previous) => ({ ...previous, [change.id]: point }))
      }
      if (change.type === 'select' && change.selected) setSelection({ node: change.id })
    }
  }
  function edgesChanged(changes: EdgeChange[]) {
    for (const change of changes) if (change.type === 'select' && change.selected) setSelection({ edge: change.id })
  }
  function arrange() {
    setPositions(Object.fromEntries(canvas.nodes.map((node) => [node.id, node.position])))
    requestAnimationFrame(() => { void flow.fitView({ padding: .16, duration: 200, maxZoom: 1 }) })
  }
  function revise(change: (workflow: NonNullable<typeof nativePlan>) => void) {
    if (!mutable || !nativePlan) return
    const next = JSON.parse(JSON.stringify(proposed ?? nativePlan)) as NonNullable<typeof nativePlan>
    change(next); setProposed(next); setBaseRevision((previous) => previous ?? run.planRevision)
  }
  function addAfter(after: string, insert: boolean) {
    if (insert && (proposed ?? nativePlan)?.steps.some((step) => step.depends_on.includes(after) && run.lockedGroups?.includes(step.id))) {
      setActionError('A dependent step has already started. Add a separate dependent task or schedule a follow-up.'); return
    }
    const id = `step_${createCanvasId().replace(/-/g, '')}`
    revise((workflow) => {
      const source = workflow.steps.find((step) => step.id === after)!
      if (insert) for (const step of workflow.steps) step.depends_on = step.depends_on.map((dependency) => dependency === after ? id : dependency)
      workflow.steps.push({ id, title: 'Next task', instruction: 'Complete the next task using the supplied reports.', depends_on: [after],
        ...(sdk ? { sdk_approval_policy: workflow.sdk_approval_policy ?? source.sdk_approval_policy ?? 'ask' } : { permission_mode: workflow.permission_mode ?? (workflow.require_explicit_access ? undefined : source.permission_mode ?? displayRun.steps.find((step) => step.id === after)?.permissionMode ?? 'read-only') }) })
      if (workflow.delivery_step === after) workflow.delivery_step = id
    })
    setSelection({ node: `stage:${id}` }); setPanel('settings')
  }
  function updateStage(change: Partial<NonNullable<typeof nativePlan>['steps'][number]>) {
    if (!editable || !selectedStage) return
    revise((workflow) => { const step = workflow.steps.find((entry) => entry.id === selectedStage.id)!; Object.assign(step, change) })
  }
  async function apply() {
    if (!proposed || !workspace || !run.id) return
    setBusy(true); setActionError('')
    const storageKey = `aixand.workflow.native-amend.${run.key}`
    try {
      const previous = JSON.parse(localStorage.getItem(storageKey) || 'null')
      const request = previous && JSON.stringify(previous.workflow) === JSON.stringify(proposed) ? previous : {
        chatId: run.originChatId, workflowId: run.id, key: createCanvasId(), expectedRevision: baseRevision ?? run.planRevision, workflow: proposed,
      }
      localStorage.setItem(storageKey, JSON.stringify(request))
      await workspace.chats.amendWorkflow(request)
      localStorage.removeItem(storageKey); setProposed(undefined); setBaseRevision(undefined); setNotice('Changes accepted for this run.')
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not apply changes. Retry to recover the saved request.') }
    finally { setBusy(false) }
  }
  async function enableEdits() {
    if (!workspace || !run.id) return
    setBusy(true); setActionError('')
    const storageKey = `aixand.workflow.enable.${run.key}`
    try {
      const key = localStorage.getItem(storageKey) || createCanvasId()
      localStorage.setItem(storageKey, key)
      await workspace.chats.enableWorkflowEdits({ chatId: run.originChatId, workflowId: run.id, key })
      localStorage.removeItem(storageKey)
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Could not enable edits.') }
    finally { setBusy(false) }
  }
  async function act(action: 'status' | 'cancel' | 'resume' | 'hold' | 'release') {
    if (busy) return
    setBusy(true); setPendingAction(action); setActionError(''); setNotice('')
    try { await onAction(action); setNotice(action === 'cancel' ? 'Cancellation requested. Check progress for confirmation.' : action === 'status' ? 'Workflow status checked.' : action === 'resume' ? 'Resume requested. Check progress for confirmation.' : 'Upcoming step settings updated.') }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Workflow action failed.') }
    finally { setBusy(false); setPendingAction(null) }
  }
  const canReconcile = ['queued', 'running', 'uncertain', 'submitting'].includes(run.state) || !run.id && run.state === 'failed'
  const canCancel = ['queued', 'running', 'uncertain', 'submitting'].includes(run.state)
  return <div className={`wb-builder wb-builder--native-run wb-builder--${panel ?? 'closed'}`}
    onKeyDown={(event) => { if (event.key === 'Escape') { setPanel(null); setSelection({}) } }}>
    <WorkflowToolbar title={run.title} status={`Run · ${label(run.state)}`} onBack={onBack}>
      <Button variant="ghost" size="sm" iconOnly aria-label="Settings" aria-pressed={panel === 'settings'}
        onPress={() => setPanel(panel === 'settings' ? null : 'settings')}><Icon name="panel-left" /></Button>
      <Button variant="ghost" size="sm" iconOnly aria-label="Arrange" onPress={arrange}><Icon name="layout-grid" /></Button>
      <span className="wb-toolbar-divider" />
      <Button size="sm" aria-label="Workflow execution" aria-pressed={panel === 'run'}
        onPress={() => setPanel(panel === 'run' ? null : 'run')}><Icon name="arrow-right" /><span className="wb-action-label">Progress</span></Button>
    </WorkflowToolbar>
    <div className="wb-notice" role={error || actionError ? 'alert' : 'status'}><Icon name="info" />
      <span>{error || actionError || (busy ? pendingAction ? workflowActionFeedback[pendingAction] : 'Updating this workflow…' : notice) || workflowGuidance(run, connected)}</span>
    </div>
    <div className="wb-workspace">
      <div className="wb-canvas" role="region" aria-label="Workflow canvas" tabIndex={0}>
        <RunNodeContext.Provider value={canvas.details}>
          <WorkflowCanvas nodes={nodes} edges={edges} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
            onNodesChange={nodesChanged} onEdgesChange={edgesChanged} minZoom={.15}
            onNodeClick={(_event, node) => { setSelection({ node: node.id }); setPanel('settings') }}
            onEdgeClick={(_event, edge) => { setSelection({ edge: edge.id }); setPanel('settings') }}
            onPaneClick={() => setSelection({})} />
        </RunNodeContext.Provider>
      </div>
      {panel && <aside className={`wb-inspector${panel === 'run' ? ' wb-run-panel' : ''}`} aria-label={panel === 'run' ? 'Workflow execution' : 'Workflow settings'}>
        <header className="wb-panel-heading"><h2>{panel === 'run' ? `Workflow ${run.state}` : selectedNode ? 'Step settings' : selectedEdge ? 'Connection' : 'Workflow settings'}</h2>
          <Button variant="ghost" size="sm" iconOnly aria-label={panel === 'run' ? 'Close execution' : 'Close settings'}
            onPress={() => { setPanel(null); setSelection({}) }}><Icon name="x" /></Button>
        </header>
        <div className="wb-inspector-body">
          {panel === 'run' ? <>
            <p role="status">{label(run.state)}{!connected && ' · Reconnect to refresh progress'}</p>
            <p className="wb-muted">{workflowGuidance(run, connected)}</p>
            <p className="wb-muted">{run.project} · Submitted plan</p>
            <p className="wb-run-id">{run.id ?? 'Awaiting Runner acceptance'}</p>
            <ol className="wb-run-steps" aria-label="Run steps">{run.steps.map((step) => <li key={step.id} data-status={step.state}>
              <span>{step.title}</span><small>{['completed', 'failed', 'interrupted', 'cancelled'].includes(step.executionState ?? '') && step.reportState === 'pending' ? 'Work finished · report delivery pending' : label(step.state)}</small>
              {step.conversationDeleted && <small>Conversation deleted</small>}
              {step.reportError && <small>{step.reportError}</small>}
              {step.chat_id && !step.conversationDeleted && <Button variant="ghost" size="sm" onPress={() => onOpenChat(step.chat_id!)}>{step.state === 'waiting' ? 'Open chat to respond' : 'Open chat'}</Button>}
            </li>)}</ol>
            {run.collector && <p>{run.collector.received} of {run.collector.expected} stage reports received</p>}
            {run.delivery && <p>Delivered to main inbox · Message {run.delivery.message_id}</p>}
            {run.error && <p role="alert" className="wb-run-error">{run.error}</p>}
            <Button variant="secondary" onPress={onInbox}>{run.delivery ? 'Read report in Carrier' : 'Open main inbox'}</Button>
            {onOpenOrigin && <Button variant="ghost" onPress={onOpenOrigin}>Open initiating chat</Button>}
            {canReconcile && <Button variant="ghost" disabled={!connected || busy}
              loading={busy && (pendingAction === 'status' || pendingAction === 'resume')}
              onPress={() => { void act(run.id && run.state === 'uncertain' ? 'resume' : 'status') }}>{run.id && run.state === 'uncertain' ? 'Resume existing run' : 'Check status'}</Button>}
            {canCancel && <Button variant="secondary" disabled={!connected || busy} loading={pendingAction === 'cancel'} onPress={() => { void act('cancel') }}>Cancel workflow</Button>}
            {nativePlan?.version === 1 && canCancel && workspace && <Button variant="secondary" disabled={!connected || busy}
              onPress={() => { void enableEdits() }}>Enable editing of this run</Button>}
            {mutable && <>
              <Button variant="secondary" disabled={!connected || busy} onPress={() => { void act(run.held ? 'release' : 'hold') }}>{run.held ? 'Resume upcoming steps' : 'Pause upcoming steps'}</Button>
              {run.held && <p role="status">Upcoming steps are paused. Current tasks continue.</p>}
              <Button disabled={!proposed || !connected || busy} onPress={() => { void apply() }}>Apply changes to this run</Button>
              {proposed && <Button variant="ghost" onPress={() => { setProposed(undefined); setBaseRevision(undefined) }}>Discard edits</Button>}
              <Button variant="secondary" disabled={busy} onPress={() => addAfter((proposed ?? nativePlan)!.delivery_step, false)}>Append task</Button>
            </>}
            {run.id && <Button variant="secondary" onPress={() => setShowNext((value) => !value)}>Add follow-up workflow</Button>}
            {showNext && run.id && <ContinuationPanel jobId={run.id} workspace={workspace} navigate={navigate}
              context={{ projectId: run.projectId, originChatId: run.originChatId }}
              exports={[{ id: nativePlan?.version === 2 ? '/result' : `/steps/${run.deliveryStep}/result/report`, label: 'Final report' }]} />}
          </> : selectedNode && runtime ? <>
            <div className="wb-inspector-summary"><span className={`wb-step-icon wb-step-icon--${selectedNode.data.kind}`}><BuilderIcon kind={selectedNode.data.kind} /></span>
              <div><strong>{selectedNode.data.label}</strong><span>{runtime.kindLabel}</span></div></div>
            <TextField label="Step name" value={selectedNode.data.label} readOnly={!editable}
              onChange={(event) => updateStage({ title: event.target.value })} />
            <p role="status">{runtime.statusLabel}</p><p>{runtime.detail}</p>
            {selectedStage && <>
              <p>{sdk ? `Tool approvals: ${selectedStage.sdkApprovalPolicy ?? 'ask'}` : `Access: ${permissionLabel(selectedStage.permissionMode ?? 'read-only')} · ${selectedStage.permissionSource ?? 'legacy'}`}</p>
              <ProfileResolution requested={selectedStage.profileSelection} decision={selectedStage.profileDecision} />
              {editable && <ProfilePicker label="Stage profile" inherit allowAuto={!nativePlan?.backend}
                value={(proposed ?? nativePlan)?.steps.find((step) => step.id === selectedStage.id)?.profile_selection}
                onChange={(profile_selection) => updateStage({ profile_selection })} />}
              <p>{selectedStage.dependsOn.length ? `Required reports: ${selectedStage.dependsOn.map((id) => run.steps.find((step) => step.id === id)?.title ?? id).join(', ')}` : 'No prerequisites. This stage starts independently.'}</p>
              {run.definition ? <Textarea label="Role instructions" value={selectedNode.data.prompt} readOnly={!editable} rows={7}
                onChange={(event) => updateStage({ instruction: event.target.value })} /> : <p className="wb-muted">Reconnect to load the submitted instructions.</p>}
              {mutable && <>
                {!editable && <p className="wb-muted">This step has started. Its assigned instructions and inputs are fixed.</p>}
                {editable && <>
                  {sdk ? <Select label="Tool approvals" value={(proposed ?? nativePlan)?.steps.find((step) => step.id === selectedStage.id)?.sdk_approval_policy ?? 'inherit'} options={[{ id: 'inherit', label: 'Inherit workflow' }, { id: 'ask', label: 'Ask when required' }, { id: 'deny', label: 'Deny approval requests' }]} onChange={(value) => updateStage({ sdk_approval_policy: value === 'inherit' ? undefined : value as 'ask' | 'deny' })} /> : <Select label="Access mode" value={(proposed ?? nativePlan)?.steps.find((step) => step.id === selectedStage.id)?.permission_mode ?? 'inherit'} options={[
                    { id: 'inherit', label: 'Inherit workflow' }, ...['read-only', 'workspace-write', 'workspace-auto', 'full-access'].map((mode) => ({ id: mode, label: permissionLabel(mode as PermissionMode) })),
                  ]}
                    onChange={(mode) => updateStage({ permission_mode: mode === 'inherit' ? undefined : mode as PermissionMode, permission_source: mode === 'inherit' ? undefined : 'stage' })} />}
                  <Select label="Add required report" value="" options={[{ id: '', label: 'Choose a prerequisite' },
                    ...displayRun.steps.filter((step) => step.id !== selectedStage.id && !selectedStage.dependsOn.includes(step.id)).map((step) => ({ id: step.id, label: step.title }))]}
                    onChange={(id) => { if (id) updateStage({ depends_on: [...selectedStage.dependsOn, id] }) }} />
                  {selectedStage.dependsOn.map((id) => <Button key={id} variant="ghost" size="sm"
                    onPress={() => updateStage({ depends_on: selectedStage.dependsOn.filter((dependency) => dependency !== id) })}>Remove requirement: {displayRun.steps.find((step) => step.id === id)?.title ?? id}</Button>)}
                  <Button variant="ghost" onPress={() => revise((workflow) => {
                    const removed = workflow.steps.find((step) => step.id === selectedStage.id)!
                    workflow.steps = workflow.steps.filter((step) => step.id !== removed.id)
                    for (const step of workflow.steps) step.depends_on = [...new Set(step.depends_on.flatMap((id) => id === removed.id ? removed.depends_on : [id]))]
                    if (workflow.delivery_step === removed.id) workflow.delivery_step = workflow.steps.at(-1)?.id ?? ''
                    setSelection({})
                  })}>Remove pending step</Button>
                </>}
                <Button variant="secondary" onPress={() => addAfter(selectedStage.id, false)}>Add dependent task</Button>
                <Button variant="secondary" onPress={() => addAfter(selectedStage.id, true)}>Insert next task</Button>
                {proposed && <Button disabled={!connected || busy} onPress={() => { void apply() }}>Apply changes to this run</Button>}
              </>}
              {run.definition && <p className="wb-muted">{run.definition.profile}{run.definition.model && ` · ${run.definition.model}`} · {sdk ? `Tool approvals: ${selectedStage.sdkApprovalPolicy ?? 'ask'}` : permissionLabel(selectedStage.permissionMode ?? 'read-only')}</p>}
              {selectedStage.error && <p role="alert" className="wb-run-error">{selectedStage.error}</p>}
            </>}
            {runtime.open && <Button variant="secondary" onPress={runtime.open}>{runtime.actionLabel}</Button>}
          </> : selectedEdge ? <>
            <TextField label="Connection label" value={String(selectedEdge.label ?? '')} readOnly />
            <p>{nodes.find((node) => node.id === selectedEdge.source)?.data.label} → {nodes.find((node) => node.id === selectedEdge.target)?.data.label}</p>
          </> : <>
            <TextField label="Workflow name" value={run.title} readOnly />
            <p>{run.project} · {label(run.state)}</p>
            <p>{run.steps.length} chat stages · Final delivery: {run.steps.find((step) => step.id === run.deliveryStep)?.title ?? run.deliveryStep}</p>
            {onOpenOrigin && <Button variant="ghost" onPress={onOpenOrigin}>Open initiating chat</Button>}
          </>}
          <p className="wb-inspector-footnote">{mutable ? 'Pending steps can change when you apply edits. Started steps keep their assigned work.' : 'This run uses the submitted plan.'} Moving or arranging nodes changes only your view. Runner continues when you close this panel.</p>
        </div>
      </aside>}
    </div>
    <footer className="wb-statusbar"><span><span className="wb-status-dot" />{nodes.length} nodes <span className="wb-status-separator">·</span> {edges.length} connections <span className="wb-status-separator">·</span> Submitted run</span>
      <span>Select a node to inspect <span className="wb-status-separator">·</span> Solid edges show confirmed handoffs</span></footer>
  </div>
}
