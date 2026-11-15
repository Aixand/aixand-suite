import { useEffect, useMemo, useRef, useState } from 'react'
import type { Workspace } from '../../workspace/model'
import { permissionLabel } from '../../agents/permissions'
import { workflowLabels } from '../../chats/WorkflowCards'
import { createCanvasId } from './model'
import type { CanvasDraft } from './model'
import { compileNativeCanvas } from './nativeGraph'
import type { NativePlan } from './nativeGraph'
import type { RunNodeDetails } from './RunNodeContext'
import { openMainInbox } from '../../carrier/navigation'

type Attempt = {
  key: string; chatId: string; projectId: string; title: string;
  create?: { key: string; profile: string | null; mode: 'work'; projectId: string };
  steps?: NativePlan['steps']; deliveryStep?: string;
  resourceCapture?: 'stage' | 'workflow';
  architectureInstruction?: string; securityInstruction?: string; planningInstruction?: string;
}
const terminal = ['completed', 'failed', 'cancelled', 'blocked']
function savedAttempt(key: string): Attempt | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Attempt | null
    if (value && ['key', 'chatId', 'projectId', 'title'].every((name) => typeof value[name as keyof Attempt] === 'string') &&
      (Array.isArray(value.steps) && typeof value.deliveryStep === 'string' ||
        ['architectureInstruction', 'securityInstruction', 'planningInstruction'].every((name) => typeof value[name as keyof Attempt] === 'string'))) return value
  } catch { /* An invalid attempt never launches a job. */ }
  return null
}
function submittedPlan(attempt: Attempt): NativePlan {
  return attempt.steps ? { steps: attempt.steps, deliveryStep: attempt.deliveryStep!, ...(attempt.resourceCapture ? { resourceCapture: attempt.resourceCapture } : {}) } : {
    steps: [
      { id: 'architecture', title: 'Architecture audit', instruction: attempt.architectureInstruction!.trim(), dependsOn: [] },
      { id: 'security', title: 'Security audit', instruction: attempt.securityInstruction!.trim(), dependsOn: [] },
      { id: 'tasks', title: 'Task planning', instruction: attempt.planningInstruction!.trim(), dependsOn: ['architecture', 'security'] },
    ], deliveryStep: 'tasks',
  }
}

export function useNativeWorkflowRun(draft: CanvasDraft, workflowId: string, workspace?: Workspace, navigate?: (route: string) => void) {
  // Keep the old attempt key so existing audit runs retain their exact submission.
  const attemptKey = `aixand.project-audit.attempt.${workflowId}`
  const [attempt, setAttempt] = useState(() => savedAttempt(attemptKey))
  const enabled = !!attempt
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef(workspace)
  latest.current = workspace
  const connected = workspace?.agents.status === 'connected'
  const run = attempt ? workspace?.chats.workflowRuns.find((row) => row.key === attempt.key) : undefined
  const settled = !!run && (run.state === 'cancelled' || !!run.id && terminal.includes(run.state))
  const settings = { projectId: draft.native?.projectId ?? attempt?.projectId ?? '',
    controllerChatId: draft.native?.controllerChatId ?? (attempt && !attempt.create ? attempt.chatId : ''),
    profile: draft.native?.profile ?? attempt?.create?.profile ?? '@auto' }
  const compilation = useMemo(() => {
    if (!enabled) return { plan: null, problem: '' }
    try { return { plan: compileNativeCanvas(draft), problem: '' } }
    catch (cause) { return { plan: null, problem: cause instanceof Error ? cause.message : 'Check workflow connections.' } }
  }, [draft, enabled])
  useEffect(() => {
    if (!enabled || !connected || !attempt || busy) return
    let alive = true
    void latest.current!.chats.openWorkflowRun(attempt.key)
      .then(() => { if (alive) setError('') })
      .catch((cause: Error) => { if (alive) setError(cause.message) })
    return () => { alive = false }
  }, [enabled, connected, attempt?.key, busy])

  async function start() {
    if (!workspace || !connected || busy || run?.id && !settled) return
    setBusy(true); setError('')
    try {
      let current = attempt
      if (!current || settled) {
        const plan = compileNativeCanvas(draft)
        if (!settings.projectId) throw new Error('Choose a saved project.')
        const chatId = settings.controllerChatId || createCanvasId()
        current = { key: createCanvasId(), chatId, projectId: settings.projectId, title: draft.name.trim(), ...plan,
          ...(!settings.controllerChatId ? { create: { key: chatId, profile: settings.profile === '@auto' ? null : settings.profile,
            mode: 'work' as const, projectId: settings.projectId } } : {}) }
        localStorage.setItem(attemptKey, JSON.stringify(current))
        setAttempt(current)
      }
      if (current.create) await workspace.chats.create(current.create)
      const { create: _create, ...request } = current
      await workspace.chats.startWorkflow(request)
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Submission is unconfirmed. Reconcile the saved request.') }
    finally { setBusy(false) }
  }
  function inbox() {
    if (!workspace) return
    openMainInbox(workspace, route => navigate?.(route), run?.delivery?.message_id)
  }
  const matchesDraft = !!attempt && !!run?.id && draft.name.trim() === attempt.title && settings.projectId === attempt.projectId &&
    settings.controllerChatId === (attempt.create ? '' : attempt.chatId) &&
    (settings.controllerChatId || settings.profile === (attempt.create?.profile ?? '@auto')) &&
    JSON.stringify(compilation.plan) === JSON.stringify(submittedPlan(attempt))
  const details: Record<string, RunNodeDetails> = {}
  if (matchesDraft && run) {
    for (const node of draft.nodes) {
      if (node.data.kind === 'chat') {
        const step = run.steps.find((entry) => entry.id === node.id)
        if (step) details[node.id] = { state: step.state, statusLabel: workflowLabels[step.state] ?? step.state, kindLabel: permissionLabel(step.permissionMode ?? 'read-only'),
          detail: step.receipt ? `Report received · Message ${step.receipt.messageId}${step.receipt.acknowledged ? ' · Acknowledged' : ''}` : node.data.description,
          ...(step.chat_id && !step.conversationDeleted ? { open: () => navigate?.(`chat/${step.chat_id}`), actionLabel: step.state === 'waiting' ? 'Open chat to respond' : 'Open chat' } : {}) }
      } else if (node.data.kind === 'collector') {
        const dependencies = draft.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)
          .map((id) => run.steps.find((entry) => entry.id === id))
        const received = dependencies.filter((step) => step?.state === 'completed' && step.receipt).length
        const ready = !!dependencies.length && dependencies.every((step) => step?.state === 'completed' && step.receipt?.acknowledged)
        const blocked = dependencies.some((step) => step && ['failed', 'blocked', 'cancelled'].includes(step.state)) || terminal.includes(run.state) && !ready
        details[node.id] = { state: ready ? 'completed' : blocked ? 'blocked' : 'waiting-for-reports', statusLabel: ready ? 'Inputs ready' : blocked ? 'Blocked' : 'Waiting for reports',
          kindLabel: 'Report join', detail: `${received} of ${dependencies.length} successful reports received` }
      } else if (node.data.kind === 'human-inbox') details[node.id] = {
        state: run.delivery ? run.state === 'failed' ? 'failure-delivered' : 'delivered' : 'pending-delivery', statusLabel: run.delivery ? run.state === 'failed' ? 'Failure delivered' : 'Delivered' : 'Awaiting delivery', kindLabel: 'For you',
        detail: run.delivery ? `Delivery confirmed · Message ${run.delivery.message_id}` : 'The final report will be delivered here.', open: inbox, actionLabel: 'Open main inbox',
      }
    }
  }
  return { run, attempt, settled, connected, busy, error, settings, problem: compilation.problem, details, start, inbox,
    canStart: connected && !busy && !(run?.id && !settled) && (attempt && !settled ? true : !compilation.problem && !!settings.projectId),
    action: async (action: 'status' | 'cancel' | 'resume') => {
      if (!workspace || !run) return
      setBusy(true); setError('')
      try { await workspace.chats.workflowAction(run.originChatId, run.id ?? run.key, action) }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Workflow action failed.') }
      finally { setBusy(false) }
    },
  }
}
export type NativeWorkflowRun = ReturnType<typeof useNativeWorkflowRun>
