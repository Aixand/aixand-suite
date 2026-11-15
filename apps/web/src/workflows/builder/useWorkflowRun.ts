import { createContext, useEffect, useRef, useState } from 'react'
import { useConnectionRecovery } from '../../auth/useConnectionRecovery'
import { compileCanvas, stableOperationId } from './compileCanvas'
import type { GraphWorkflow } from './compileCanvas'
import type { Workflow } from '../ir'
import type { Workspace } from '../../workspace/model'
import type { RunNodeDetails } from './RunNodeContext'
import { useNativeWorkflowRun } from './useNativeWorkflowRun'
import type { CompiledCanvas } from './compile'
import { createCanvasId } from './model'
import type { CanvasDraft } from './model'
import { JobError, JobsConnection } from './jobs'
import type { JobEvents, JobResult, JobState, RunPlan, Continuation } from './jobs'
import { nodeTerminals } from './terminals'
import type { AgentSession } from './terminals'
import { runStorageKey } from './runStorage'
import { permissionLabel } from '../../agents/permissions'
import { profileSelectionLabel } from '../../agents/profileSelection'
import { openMainInbox } from '../../carrier/navigation'
import { usesToolApprovals } from '../capabilities'
export { RUN_KEY } from './runStorage'

export type StepStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'uncertain' | 'available' | 'closed'
export const RunStatusContext = createContext<Record<string, StepStatus>>({})
export type Snapshot = CompiledCanvas<Workflow | GraphWorkflow> & {
  completions?: Record<string, string>; optionalTools?: string[]; needsProject?: boolean;
  create?: { key: string; profile: string | null; mode: 'work'; projectId: string };
  policyPrepared?: boolean
  key: string
  jobId?: string
  labels: Record<string, string>
  inputs?: Record<string, import('../ir').Json>
  authoring?: CanvasDraft
}
export type ExistingRun = { id: string; key: string; namespace: string; workflow: GraphWorkflow; canvas: CanvasDraft }
function existingSnapshot(run: ExistingRun): Snapshot {
  const compiled = compileCanvas(run.canvas, run.namespace, run.workflow.version, run.workflow.identities)
  return { ...compiled, workflow: run.workflow, authoring: run.canvas, jobId: run.id, key: run.key,
    labels: Object.fromEntries(run.canvas.nodes.map((node) => [node.id, node.data.label])) }
}
function savedRun(storageKey: string): Snapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (
      value &&
      typeof value.key === 'string' &&
      (value.workflow?.body?.kind === 'sequence' && Array.isArray(value.workflow.body.steps) ||
        value.workflow?.format === 'aixand.workflow-graph' && value.workflow.workflow?.body?.kind === 'sequence') &&
      value.invocations &&
      value.labels &&
      Array.isArray(value.order) &&
      value.order.every((id: unknown) => typeof id === 'string') &&
      Object.values(value.labels).every((label) => typeof label === 'string')
    )
      return value
  } catch {
    /* A missing or corrupt monitoring record does not affect the draft. */
  }
  return null
}
const active = (state: JobState) => state === 'queued' || state === 'running'

export function useWorkflowRun(
  draft: CanvasDraft,
  workflowId: string,
  workspace?: Workspace,
  navigate?: (route: string) => void,
  existingRun?: ExistingRun,
) {
  const storageKey = existingRun ? `aixand.workflow.run.job.${existingRun.id}` : runStorageKey(workflowId)
  const legacy = useNativeWorkflowRun(draft, workflowId, workspace, navigate)
  const latestWorkspace = useRef(workspace)
  latestWorkspace.current = workspace
  const needsProject = draft.nodes.some((node) => node.data.kind === 'chat')
  const legacyActive = !localStorage.getItem(storageKey) && !!legacy.attempt && !legacy.settled
  const [status, setStatus] = useState<'offline' | 'connecting' | 'connected'>(
    'connecting',
  )
  const [error, setError] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => existingRun ? existingSnapshot(existingRun) : savedRun(storageKey))
  const context = snapshot?.workflow && 'format' in snapshot.workflow ? snapshot.workflow.context : undefined
  useEffect(() => {
    if (snapshot?.jobId && needsProject && workspace?.agents.status === 'connected') {
      void latestWorkspace.current?.chats.openWorkflowRun(snapshot.jobId).catch(() => {})
    }
  }, [snapshot?.jobId, needsProject, workspace?.agents.status])
  const settings = { ...legacy.settings, ...draft.native,
    projectId: draft.native?.projectId || context?.projectId || legacy.settings.projectId,
    controllerChatId: draft.native?.controllerChatId || context?.originChatId || legacy.settings.controllerChatId }
  const [supportsMutable, setSupportsMutable] = useState(false)
  const [supportsContinuations, setSupportsContinuations] = useState(false)
  const [plan, setPlan] = useState<RunPlan | null>(null)
  const [continuations, setContinuations] = useState<Continuation[]>([])
  const [actionBusy, setActionBusy] = useState(false)
  const [inputText, setInputText] = useState('{}')
  const [state, setState] = useState<JobState | null>(null)
  const [states, setStates] = useState<Record<string, StepStatus>>({})
  const [result, setResult] = useState<JobResult | null>(null)
  const [chatIds, setChatIds] = useState<Record<string, string>>({})
  const [chatSelections, setChatSelections] = useState<Record<string, NonNullable<RunNodeDetails['selection']>>>({})
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({})
  const connection = useRef<JobsConnection | null>(null)
  const mutableAvailable = useRef(false)
  const recovery = useConnectionRecovery(connect)
  const snapshotRef = useRef(snapshot)
  const monitorVersion = useRef(0)
  const settled = useRef(false)
  const save = (value: Snapshot | null) => {
    snapshotRef.current = value
    setSnapshot(value)
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value))
      else localStorage.removeItem(storageKey)
    } catch {
      /* Monitoring still works without local persistence. */
    }
  }
  async function monitor(client: JobsConnection, value: Snapshot, submit = false) {
    if (!value.jobId && !submit) {
      setError('Run submission is unconfirmed. Resume monitoring to retry the saved submission.')
      return
    }
    settled.current = false
    const version = ++monitorVersion.current
    const current = () =>
      connection.current === client && version === monitorVersion.current
    let after = 0
    setStates(Object.fromEntries([...value.order, ...(value.optionalTools ?? value.agentGraph?.tools ?? [])].map((id) => [id, 'pending'])))
    setResult(null)
    setSessions({})
    setError('')
    if (!value.jobId) { setChatIds({}); setChatSelections({}) }
    let effectsStarted = false
    try {
      if (!value.jobId) {
        if (value.create && !value.policyPrepared && 'format' in value.workflow && latestWorkspace.current) {
          const graph = value.workflow
          const settings = await latestWorkspace.current.agents.request<{ defaultMode: string }>('spawn-settings-get')
          if (settings.defaultMode === 'manual' && !graph.context.permissionMode) {
            const missing = graph.workflow.body.kind === 'sequence' ? graph.workflow.body.steps.filter((step) =>
              step.kind === 'operation' && step.operation.id === 'aixand.project.chat' && !graph.context.chatPolicies?.[step.id]?.permissionMode) : []
            if (missing.length) throw new Error(`Manual access requires a mode for every stage: ${missing.map((step) => step.id).join(', ')}`)
          }
        }
        if (value.create) {
          if (!latestWorkspace.current) throw new Error('Connect project chats before submitting.')
          effectsStarted = true
          await latestWorkspace.current.chats.create(value.create)
        }
        if (value.needsProject && !value.policyPrepared && 'format' in value.workflow) {
          if (!latestWorkspace.current) throw new Error('Connect project chats before preparing access.')
          value = { ...value, workflow: await latestWorkspace.current.chats.prepareWorkflow({ key: value.key, workflow: value.workflow }), policyPrepared: true }
          save(value)
        }
        effectsStarted = true
        const accepted = await client.request<{
          job: { id: string; state: JobState }
        }>('submit', {
          submission: {
            key: value.key,
            workflow: value.workflow,
            inputs: value.inputs ?? {},
            metadata: { origin: 'aixand.workflow-builder', workflowId,
              ...(value.authoring ? { suite_canvas: value.authoring, suite_namespace: value.namespace } : {}) },
          },
        })
        if (!current()) return
        value = { ...value, jobId: accepted.job.id }
        save(value)
        setState(accepted.job.state)
      }
      while (current()) {
        if (mutableAvailable.current && 'format' in value.workflow && value.workflow.version === 2) {
          const accepted = await client.request<RunPlan>('plan', { id: value.jobId })
          if (!current()) return
          setPlan(accepted)
          if (accepted.authoring) {
            const compiled = compileCanvas(accepted.authoring, value.namespace, 2, accepted.workflow.identities)
            value = { ...value, ...compiled, workflow: accepted.workflow, authoring: accepted.authoring,
              labels: Object.fromEntries(accepted.authoring.nodes.map((node) => [node.id, node.data.label])) }
            if (JSON.stringify(snapshotRef.current?.workflow) !== JSON.stringify(value.workflow)) save(value)
          }
        }
        const page = await client.request<JobEvents>('events', {
          id: value.jobId,
          after,
          limit: 100,
        })
        if (!current()) return
        setState(page.state)
        setChatIds((previous) => ({ ...previous, ...Object.fromEntries(page.events.flatMap((event) =>
          event.kind === 'ir' && event.data.event === 'chat_step' && typeof event.data.chat_id === 'string' && event.data.invocation
            ? [[value.invocations[event.data.invocation], event.data.chat_id]] : [])) }))
        setChatSelections((previous) => ({ ...previous, ...Object.fromEntries(page.events.flatMap((event) => {
          const data = event.data
          return data.event === 'chat_step' && data.invocation ? [[value.invocations[data.invocation], {
            permissionMode: data.permission_mode, permissionSource: data.permission_source,
            sdkApprovalPolicy: data.sdk_approval_policy,
            requested: data.profile_selection, decision: data.profile_decision,
          }]] : []
        })) }))
        setSessions((previous) => {
          const entries = page.events.filter((event) =>
            event.kind === 'ir' && event.data.event === 'agent_session',
          )
          if (!entries.length) return previous
          const updated = { ...previous }
          for (const event of entries) {
            const entry = event.data
            if (entry.event === 'agent_session' &&
              typeof entry.invocation === 'string' &&
              typeof entry.session_id === 'string' && entry.session_id &&
              typeof entry.run_id === 'string' &&
              typeof entry.provider === 'string')
              updated[entry.invocation] = entry
          }
          return updated
        })
        setStates((previous) => {
          const updated = { ...previous }
          for (const event of page.events) {
            if (event.kind !== 'ir') continue
            const entry = event.data
            if (entry.event === 'agent_session') continue
            const nodeId =
              value.invocations[
                entry.invocation ?? entry.failure?.invocation_id ?? ''
              ]
            if (nodeId) {
              if (entry.event === 'started') updated[nodeId] = 'running'
              if (entry.event === 'published') updated[nodeId] = value.optionalTools?.includes(nodeId) ? 'available' :
                !value.completions || value.completions[entry.invocation ?? ''] ? 'completed' : 'running'
              if (entry.event === 'chat_step' && typeof entry.status === 'string' && ['running', 'waiting', 'offline', 'starting', 'failed', 'uncertain'].includes(entry.status)) updated[nodeId] = entry.status as StepStatus
              if (entry.event === 'failed') updated[nodeId] = 'failed'
              if (value.agentGraph && entry.event === 'published') {
                if (value.agentGraph.tools.includes(nodeId)) updated[nodeId] = 'available'
                else if (nodeId === value.agentGraph.result) updated[nodeId] = 'running'
                else if (entry.invocation === 'mailbox_1') updated[nodeId] = 'running'
                else if (nodeId === value.agentGraph.agent)
                  updated[nodeId] = entry.invocation?.startsWith('spawn_') ? 'available' : 'running'
                if (entry.invocation === 'message_1') updated[value.agentGraph.agent] = 'running'
              }
            }
          }
          return updated
        })
        after = page.next_after
        if (page.has_more) continue
        if (!active(page.state)) {
          const final = await client.request<JobResult>('result', {
            id: value.jobId,
          })
          if (!current()) return
          setResult(final)
          settled.current = true
          setState(final.state)
          setStates((previous) =>
            Object.fromEntries(
              [...value.order, ...(value.optionalTools ?? value.agentGraph?.tools ?? [])].map((id) => [
                id,
                (value.optionalTools ?? value.agentGraph?.tools)?.includes(id)
                  ? previous[id] === 'failed' ? 'failed'
                    : ['available', 'running'].includes(previous[id])
                      ? final.state === 'uncertain' ? 'uncertain' : 'closed'
                      : (previous[id] ?? 'pending')
                  : final.state === 'completed'
                  ? 'completed'
                  : ['running', 'available'].includes(previous[id])
                    ? final.state === 'cancelled'
                      ? 'cancelled'
                      : final.state === 'uncertain'
                        ? 'uncertain'
                        : 'failed'
                    : value.completions ? final.state === 'cancelled' ? 'cancelled' : 'blocked' : (previous[id] ?? 'pending'),
              ]),
            ),
          )
          if (final.error)
            setError(`${final.error.code}: ${final.error.message}`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 350))
      }
    } catch (cause) {
      if (!current()) return
      setError(
        cause instanceof Error ? cause.message : 'Run monitoring failed.',
      )
      // Preflight rejections create no job. Transport failures may have committed.
      if (
        !value.jobId &&
        (!effectsStarted || cause instanceof JobError &&
        !['runner_connection', 'runner_timeout', 'connection_lost'].includes(
          cause.code,
        ))
      ) {
        save(null)
        settled.current = true
        setState(null)
      }
    }
  }
  function connect() {
    const previous = connection.current
    connection.current = null
    previous?.close()
    ++monitorVersion.current
    setStatus('connecting')
    const client = new JobsConnection(
      () => {
        if (connection.current !== client) return
        void client
          .request<{ protocol: number; capabilities?: { workflow_graphs?: number[]; workflow_continuations?: number[] } }>('health')
          .then((health) => {
            if (connection.current !== client) return
            recovery.ready()
            setSupportsMutable(health.capabilities?.workflow_graphs?.includes(2) ?? false)
            mutableAvailable.current = health.capabilities?.workflow_graphs?.includes(2) ?? false
            setSupportsContinuations(health.capabilities?.workflow_continuations?.includes(1) ?? false)
            setStatus('connected')
            setError('')
            if (snapshotRef.current) void monitor(client, snapshotRef.current)
          })
          .catch((cause: unknown) => {
            if (connection.current !== client) return
            setError(
              cause instanceof Error ? cause.message : 'Runner unavailable.',
            )
            connection.current = null
            client.close()
            setStatus('offline')
            recovery.failed()
          })
      },
      (message) => {
        if (connection.current !== client) return
        connection.current = null
        ++monitorVersion.current
        setStatus('offline')
        setError(message)
        recovery.failed()
      },
    )
    connection.current = client
  }
  function start() {
    if (legacyActive) { void legacy.start(); return }
    if (
      !connection.current ||
      status !== 'connected' ||
      (snapshotRef.current && !settled.current)
    )
      return
    try {
      const key = createCanvasId()
      const controller = workspace?.chats.chats.find(chat => chat.id === settings.controllerChatId)
      const compiled = compileCanvas(draft, key, supportsMutable ? 2 : 1, {}, controller)
      const supplied = JSON.parse(inputText)
      if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object') throw new Error('Workflow inputs must be a JSON object.')
      let create: Snapshot['create']
      if (compiled.needsProject) {
        if (!settings.projectId) throw new Error('Choose a saved project.')
        if (!workspace || workspace.agents.status !== 'connected') throw new Error('Connect project chats before submitting.')
        const chatId = settings.controllerChatId || createCanvasId()
        compiled.workflow.context = { ...compiled.workflow.context, projectId: settings.projectId, originChatId: chatId }
        if (!settings.controllerChatId) create = { key: chatId, profile: settings.profile === '@auto' ? null : settings.profile, mode: 'work', projectId: settings.projectId }
      }
      const value = {
        ...compiled,
        ...(create ? { create } : {}),
        key: `workflow-builder:${key}`,
        inputs: supplied,
        ...(compiled.workflow.version === 2 ? { authoring: draft } : {}),
        labels: Object.fromEntries(
          draft.nodes.map((node) => [node.id, node.data.label]),
        ),
      }
      save(value) // Persist the idempotency key before sending the request.
      setState('queued')
      void monitor(connection.current, value, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid sequence.')
    }
  }
  async function cancel() {
    if (legacyActive) { await legacy.action('cancel'); return }
    if (!snapshot?.jobId || !connection.current) return
    try {
      await connection.current.request('cancel', { id: snapshot.jobId })
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Cancellation request failed.',
      )
    }
  }
  async function refreshPlan() {
    const value = snapshotRef.current
    if (!connection.current || !value?.jobId) return
    const accepted = await connection.current.request<RunPlan>('plan', { id: value.jobId })
    setPlan(accepted)
    return accepted
  }
  async function hold(held: boolean) {
    if (!connection.current || !snapshotRef.current?.jobId) return
    setActionBusy(true); setError('')
    try { setPlan(await connection.current.request<RunPlan>(held ? 'hold' : 'release', { id: snapshotRef.current.jobId })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change upcoming steps.') }
    finally { setActionBusy(false) }
  }
  async function amend() {
    const value = snapshotRef.current
    if (!connection.current || !value?.jobId || !('format' in value.workflow) || value.workflow.version !== 2) return false
    setActionBusy(true); setError('')
    try {
      const compiled = compileCanvas(draft, value.namespace, 2, value.workflow.identities, value.workflow.context)
      compiled.workflow.context = { ...value.workflow.context, ...compiled.workflow.context,
        chatPolicies: compiled.workflow.context.chatPolicies ?? {},
        projectId: value.workflow.context.projectId, originChatId: value.workflow.context.originChatId }
      const attemptKey = `${storageKey}:amend`
      const previous = JSON.parse(localStorage.getItem(attemptKey) || 'null')
      const accepted = plan ?? await refreshPlan()
      if (!accepted) throw new Error('Reload the accepted plan before applying changes.')
      const request = previous && JSON.stringify(previous.workflow) === JSON.stringify(compiled.workflow)
        ? previous : { id: value.jobId, key: createCanvasId(), expected_revision: accepted.revision, workflow: compiled.workflow, authoring: draft }
      if (compiled.needsProject && !previous) {
        if (!workspace) throw new Error('Connect project chats before applying access changes.')
        request.workflow = await workspace.chats.prepareWorkflow({ key: request.key, workflowId: value.jobId, workflow: request.workflow })
      }
      localStorage.setItem(attemptKey, JSON.stringify(request))
      const result = await connection.current.request<{ plan: RunPlan }>('amend', request)
      localStorage.removeItem(attemptKey)
      setPlan(result.plan)
      const canvas = result.plan.authoring ?? draft
      const current = result.plan.workflow as GraphWorkflow
      const updated = { ...value, ...compileCanvas(canvas, value.namespace, 2, current.identities), workflow: current,
        authoring: canvas, labels: Object.fromEntries(canvas.nodes.map((node) => [node.id, node.data.label])) }
      save(updated)
      void monitor(connection.current, updated)
      return true
    } catch (cause) {
      if (cause instanceof JobError && !['runner_connection', 'runner_timeout', 'connection_lost'].includes(cause.code)) localStorage.removeItem(`${storageKey}:amend`)
      setError(cause instanceof Error ? cause.message : 'Could not apply changes.')
      await refreshPlan().catch(() => undefined)
      return false
    } finally { setActionBusy(false) }
  }
  useEffect(() => {
    if (!supportsContinuations || !snapshot?.jobId || status !== 'connected') return
    let alive = true
    const refresh = async () => {
      try { const result = await connection.current?.request<{ continuations: Continuation[] }>('continuations', { id: snapshot.jobId }); if (alive && result) setContinuations(result.continuations) }
      catch { /* Connection recovery owns transport errors. */ }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 1500)
    return () => { alive = false; clearInterval(timer) }
  }, [supportsContinuations, snapshot?.jobId, status])
  async function enableEdits() {
    const value = snapshotRef.current
    if (!connection.current || !value?.jobId || !('format' in value.workflow) || value.workflow.version !== 1) return
    setActionBusy(true); setError('')
    try {
      const restored = compileCanvas(draft, value.namespace, 1)
      restored.workflow.context = value.workflow.context
      if (JSON.stringify(restored.workflow) !== JSON.stringify(value.workflow)) throw new Error('Restore the submitted draft before enabling edits, or schedule a follow-up workflow.')
      const groups: Record<string, string[]> = {}
      const identities: Record<string, string> = {}
      for (const step of value.workflow.workflow.body.steps) {
        if (step.kind !== 'operation') throw new Error('This run cannot adopt graph editing.')
        const node = value.invocations[step.id]
        if (!node) throw new Error('The submitted node mapping is unavailable.')
        ;(groups[node] ??= []).push(step.id)
        identities[stableOperationId(node, step.operation.id)] = step.id
      }
      const accepted = await connection.current.request<RunPlan>('enable_edits', { id: value.jobId, key: `enable:${value.key}`, groups, identities, authoring: draft })
      setPlan(accepted)
      const compiled = compileCanvas(draft, value.namespace, 2, accepted.workflow.identities)
      const updated = { ...value, ...compiled, workflow: accepted.workflow, authoring: draft }
      save(updated); void monitor(connection.current, updated)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not enable edits.') }
    finally { setActionBusy(false) }
  }
  useEffect(
    () => () => {
      const current = connection.current
      connection.current = null
      ++monitorVersion.current
      current?.close()
    },
    [],
  )
  const details: Record<string, RunNodeDetails> = { ...legacy.details }
  for (const node of draft.nodes.filter((node) => node.data.kind === 'chat')) {
    const graph = plan?.workflow ?? (snapshot?.workflow && 'format' in snapshot.workflow ? snapshot.workflow : undefined)
    const operationId = Object.entries(snapshot?.invocations ?? {}).find(([, nodeId]) => nodeId === node.id)?.[0]
    const policy = operationId ? graph?.context.chatPolicies?.[operationId] : undefined
    const selection = chatSelections[node.id] ?? {
      permissionMode: policy?.permissionMode ?? graph?.context.permissionMode,
      sdkApprovalPolicy: policy?.sdkApprovalPolicy ?? graph?.context.sdkApprovalPolicy ?? settings.sdkApprovalPolicy ?? (usesToolApprovals(workspace?.chats.chats.find(chat => chat.id === settings.controllerChatId)) ? 'ask' : undefined),
      permissionSource: policy?.permissionSource ?? graph?.context.permissionSource,
      requested: policy?.profileSelection ?? graph?.context.profileSelection,
    }
    const chatId = chatIds[node.id]
    const retainedStep = workspace?.chats.workflowRuns.flatMap(run => run.steps).find(step => step.chat_id === chatId)
    const deletedChat = !!chatId && (workspace?.chats.deletedIds.has(chatId) || retainedStep?.conversationDeleted)
    details[node.id] = { state: states[node.id] ?? 'pending', kindLabel: 'Project chat', statusLabel: states[node.id] ?? 'pending',
      detail: retainedStep?.reportState === 'pending' && ['completed', 'failed', 'interrupted', 'cancelled'].includes(retainedStep.executionState ?? '') ? 'Work finished · report delivery pending' : deletedChat ? 'Conversation deleted. Workflow execution remains tracked.' : 'Runner waits for the complete report and Carrier acknowledgment.', selection,
      meta: `${selection.sdkApprovalPolicy ? 'Tool approvals: ' + selection.sdkApprovalPolicy : selection.permissionMode ? permissionLabel(selection.permissionMode) : 'Inherited access'} · ${selection.decision?.profile ?? profileSelectionLabel(selection.requested)}`,
      ...(chatId && !deletedChat ? { open: () => navigate?.(`chat/${chatId}`), actionLabel: 'Open chat' } : {}) }
  }
  function inbox() {
    if (!workspace) return
    const retained = workspace.chats.workflowRuns.find(run => run.id === snapshot?.jobId || run.key === snapshot?.key)
    openMainInbox(workspace, route => navigate?.(route), retained?.delivery?.message_id ?? legacy.run?.delivery?.message_id)
  }
  return {
    supportsMutable, supportsContinuations, plan, continuations, actionBusy, inputText, setInputText,
    mutable: !!snapshot && 'format' in snapshot.workflow && snapshot.workflow.version === 2,
    amend, hold, enableEdits,
    settings, needsProject, details, inbox, legacy: legacyActive ? legacy : undefined,
    status,
    error,
    snapshot,
    state: legacyActive ? legacy.run?.state as JobState | null ?? null : state,
    states,
    result,
    terminals: nodeTerminals(snapshot, sessions, result),
    connect: recovery.reconnect,
    start,
    cancel,
    canReconcile: state === 'uncertain' && !!snapshot?.jobId && 'format' in snapshot.workflow &&
      snapshot.workflow.workflow.body.steps.every((step) => step.kind === 'operation' && ['workflow.value', 'workflow.text', 'aixand.project.chat', 'carrier.human.deliver'].includes(step.operation.id)),
    reconcile: async () => {
      if (!connection.current || !snapshot?.jobId) return
      try { await connection.current.request('resume', { id: snapshot.jobId }); void monitor(connection.current, snapshot) }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Reconciliation failed.') }
    },
    busy: legacyActive ? legacy.busy || !!legacy.run?.id : !!snapshot && !result,
    resume: () => {
      if (legacyActive) { void legacy.start(); return }
      if (connection.current && snapshot)
        void monitor(connection.current, snapshot, true)
    },
  }
}
export type WorkflowRun = ReturnType<typeof useWorkflowRun>
