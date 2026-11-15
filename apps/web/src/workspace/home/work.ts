import type { Chat, ChatSnapshot, ChatWorkflow } from '../../chats/model'
import type { CarrierMessage } from '../../carrier/client'
import type { SavedWorkflow } from '../../workflows/library'
import type { Session } from '../../terminals/connection'
import { isMyTerminal, sessionKind, sessionTitle } from '../../terminals/context'
import type { WorkVisits } from './history'

export type HomeWork = {
  key: string
  kind: 'chat' | 'terminal' | 'workflow' | 'message'
  title: string
  context: string
  reason: string
  status: string
  action: string
  route: string
  at: number
  recentAt: number
  needs: boolean
  running: boolean
  recent: boolean
  priority: number
  tone: 'attention' | 'danger' | 'neutral'
  result: boolean
  messageId?: string
}
const day = 24 * 60 * 60 * 1000
const workflowRunning = new Set(['pending', 'prepared', 'preparing', 'creating', 'created', 'starting', 'queued', 'submitting', 'running', 'waiting-for-reports', 'pending-delivery'])
const finished = new Set(['completed', 'delivered'])
const ended = new Set([...finished, 'done', 'finished', 'failed', 'failure-delivered', 'cancelled', 'canceled', 'interrupted', 'stopped', 'exited', 'terminated', 'killed'])
const text = (value: string | null | undefined, fallback: string) => value?.trim().replace(/\s+/g, ' ').slice(0, 180) || fallback

function chatRequest(snapshot?: ChatSnapshot) {
  const request = snapshot?.requests[0]
  const question = request?.params.questions?.[0]
  if (question) return { reason: question.isSecret ? 'A private answer is requested.' : text(question.question, 'Waiting for your answer.'), action: 'Answer question', status: 'Reply needed' }
  if (request && /approval|permission/.test(`${request.method} ${request.params.kind}`))
    return { reason: 'Permission is needed to continue.', action: 'Review request', status: 'Approval' }
  return { reason: text(request?.params.message, 'Waiting for your response.'), action: 'Respond', status: 'Needs input' }
}

export function homeWork({ chats, snapshots, workflows, drafts, terminals, messages, visits, deletedIds = new Set<string>(), now = Date.now() }: {
  chats: Chat[]
  snapshots: Record<string, ChatSnapshot>
  workflows: ChatWorkflow[]
  drafts: SavedWorkflow[]
  terminals: Session[]
  messages: CarrierMessage[]
  visits: WorkVisits
  deletedIds?: ReadonlySet<string>
  now?: number
}) {
  chats = chats.filter(chat => !deletedIds.has(chat.id) && !chat.automationSupervisor)
  // Runs remain available in Workflows after their source history is removed.
  // Home should not offer them as conversations to continue.
  workflows = workflows.filter(workflow => !workflow.originConversationDeleted && !deletedIds.has(workflow.originChatId))
  const rows = new Map<string, HomeWork>()
  const childWorkflows = new Map<string, string>()
  const chatOwners = new Map<string, string>()
  const chatsById = new Map(chats.map(chat => [chat.id, chat]))
  const failureNeedsReview = (key: string, at: number) => at > 0 && now - at <= day && (visits[key] ?? 0) < at
  const workflowRoute = (id: string) => `workflows/runs/${encodeURIComponent(id)}`
  const chatRoute = (id: string) => `chat/${encodeURIComponent(id)}`

  for (const workflow of workflows) {
    const key = `workflow:${workflow.key}`
    const state = workflow.state
    const steps = workflow.steps ?? []
    // Retain ownership so stale child chats and terminals cannot reappear on their own.
    for (const step of steps) if (step.chat_id) childWorkflows.set(step.chat_id, key)
    if (ended.has(state)) continue
    const stepDeleted = (step: ChatWorkflow['steps'][number]) => step.conversationDeleted || Boolean(step.chat_id && deletedIds.has(step.chat_id))
    const terminal = finished.has(state) || ['failed', 'failure-delivered', 'cancelled'].includes(state)
    const waiting = terminal ? [] : steps.filter(step => !stepDeleted(step) &&
      !ended.has(step.executionState ?? '') && !ended.has(step.state) &&
      !(step.chat_id && (ended.has(chatsById.get(step.chat_id)?.status ?? '') || chatsById.get(step.chat_id)?.statusReason === 'session_ended')) &&
      (step.state === 'waiting' || step.chat_id && chatsById.get(step.chat_id)?.status === 'waiting'))
    const needsInput = waiting.length > 0 || !terminal && state === 'waiting' && !steps.some(step => stepDeleted(step) && step.state === 'waiting')
    const failed = state === 'failed' || state === 'failure-delivered'
    const uncertain = state === 'uncertain'
    const reviewedAt = Math.max(visits[key] ?? 0, visits[`workflow:${workflow.id}`] ?? 0)
    const needs = needsInput || uncertain || failed && failureNeedsReview(key, workflow.updatedAt) && reviewedAt < workflow.updatedAt
    const target = waiting.length === 1 ? waiting[0].chat_id : undefined
    const prompt = target ? chatRequest(snapshots[target]) : null
    const complete = finished.has(state)
    rows.set(key, {
      key, kind: 'workflow', title: workflow.title, context: workflow.project || 'Workflow',
      reason: needsInput ? waiting.length > 1 ? `${waiting.length} steps need your response.` : prompt?.reason ?? 'Waiting for your response.'
        : failed ? text(workflow.error, 'The workflow stopped after a failure.') : uncertain ? 'Check the workflow outcome before continuing.'
          : complete ? 'Completed' : workflow.held ? 'On hold' : state === 'waiting-for-reports' ? 'Waiting for agent reports' : 'Workflow in progress',
      action: needsInput && target ? prompt!.action : failed ? 'Inspect failure' : uncertain ? 'Check outcome' : complete ? 'Read result' : 'Open workflow',
      status: needsInput ? prompt?.status ?? 'Needs input' : failed ? 'Failed' : uncertain ? 'Check outcome' : complete ? 'Done' : workflow.held ? 'On hold' : state === 'waiting-for-reports' ? 'Waiting' : 'Running',
      route: target && needsInput ? chatRoute(target) : workflowRoute(workflow.key),
      at: workflow.updatedAt, recentAt: Math.max(workflow.updatedAt, reviewedAt), needs,
      running: !needs && !workflow.held && workflowRunning.has(state), recent: true,
      priority: needsInput ? 0 : 1, tone: failed || uncertain ? 'danger' : needsInput ? 'attention' : 'neutral',
      result: complete && failureNeedsReview(key, workflow.updatedAt) && reviewedAt < workflow.updatedAt,
    })
  }
  for (const chat of chats) {
    const parent = childWorkflows.get(chat.id)
    if (parent) { chatOwners.set(chat.id, parent); continue }
    const key = `chat:${chat.id}`
    chatOwners.set(chat.id, key)
    if (ended.has(chat.status) || chat.statusReason === 'session_ended') continue
    const waiting = chat.status === 'waiting'
    const failed = chat.status === 'failed'
    const uncertain = chat.status === 'uncertain'
    const needs = waiting || uncertain || failed && failureNeedsReview(key, chat.updatedAt)
    const request = waiting ? chatRequest(snapshots[chat.id]) : null
    const complete = chat.status === 'completed'
    rows.set(key, {
      key, kind: 'chat', title: chat.title || 'Untitled conversation', context: chat.project || chat.profile || 'Chat',
      reason: request?.reason ?? (failed ? text(chat.error, 'The response failed.') : uncertain ? 'Check the previous response before continuing.' : complete ? 'Completed' : chat.status === 'running' ? 'Working on your request' : chat.status === 'offline' ? 'Reconnect to check this conversation' : 'Continue the conversation'),
      action: request?.action ?? (failed ? 'Inspect failure' : uncertain ? 'Check outcome' : complete ? 'Read result' : 'Open chat'),
      status: request?.status ?? (failed ? 'Failed' : uncertain ? 'Check outcome' : complete ? 'Done' : chat.status === 'running' ? 'Working' : chat.status === 'offline' ? 'Offline' : 'Ready'),
      route: chatRoute(chat.id), at: chat.updatedAt, recentAt: Math.max(chat.updatedAt, visits[key] ?? 0), needs,
      running: chat.status === 'running', recent: true, priority: waiting ? 0 : 1,
      tone: failed || uncertain ? 'danger' : waiting ? 'attention' : 'neutral',
      result: complete && failureNeedsReview(key, chat.updatedAt),
    })
  }

  const terminalOwners = new Map<string, string>()
  for (const chat of chats) if (chat.terminal?.sessionId) terminalOwners.set(chat.terminal.sessionId, chatOwners.get(chat.id)!)
  const workflowIds = new Map<string, string>()
  for (const workflow of workflows) {
    workflowIds.set(workflow.key, `workflow:${workflow.key}`)
    if (workflow.id) workflowIds.set(workflow.id, `workflow:${workflow.key}`)
  }
  for (const session of terminals) {
    const key = `terminal:${session.id}`
    const state = session.lifecycle.state
    const live = ['running', 'starting', 'stopping'].includes(state)
    if (!live) continue
    const interaction = session.foreground?.interaction
    const requested = live && interaction?.state === 'requested' && interaction.basis?.disposition === 'affirmative'
    const failed = state === 'failed' || state === 'exited' && session.lifecycle.code != null && session.lifecycle.code !== 0
    const at = session.updated_at_millis ?? session.started_at_millis ?? 0
    const failure = failed && failureNeedsReview(key, at)
    const kind = sessionKind(session.labels)
    const reason = requested ? interaction.modality === 'secret' ? 'Private input is requested in the terminal.'
      : /confirm|approv|permission/.test(interaction.semantic ?? '') ? 'Confirmation is requested in the terminal.' : 'Input is requested in the terminal.'
      : failed ? `Process failed${session.lifecycle.code != null ? ` with exit code ${session.lifecycle.code}` : ''}.`
        : live ? session.foreground?.execution?.state === 'active' ? 'Working in the terminal' : state === 'starting' ? 'Starting' : kind === 'job' ? 'Process is running' : 'Ready for commands' : state === 'exited' ? 'Process finished' : 'Stopped'
    const ownerKey = terminalOwners.get(session.id) ?? workflowIds.get(session.labels?.['workflow.id'] ?? '')
      ?? workflowIds.get(session.labels?.['workflow.run_id'] ?? '')
    const owner = ownerKey ? rows.get(ownerKey) : undefined
    if (ownerKey && !owner) continue
    if (owner) {
      if (requested && (!owner.needs || owner.priority > 0)) rows.set(owner.key, { ...owner, needs: true, running: false,
        reason, status: interaction.modality === 'secret' ? 'Private input' : 'Needs input', action: 'Open terminal', route: `terminals/${encodeURIComponent(session.id)}`, priority: 0, tone: 'attention' })
      else if (failure && !owner.needs) rows.set(owner.key, { ...owner, needs: true, running: false,
        reason, status: 'Failed', action: 'Inspect failure', route: `terminals/${encodeURIComponent(session.id)}`, priority: 1, tone: 'danger' })
      continue
    }
    const active = kind !== 'server' && session.profile !== 'server' && live && (kind === 'job' || session.foreground?.execution?.state === 'active' && session.foreground.execution.basis?.disposition === 'affirmative')
    const relevant = Boolean(visits[key]) || isMyTerminal(session.labels) || kind === 'job' || !kind && !session.labels?.app
    rows.set(key, {
      key, kind: 'terminal', title: sessionTitle(session), context: session.labels?.['project.name'] || session.profile || 'Terminal',
      reason, action: requested ? 'Open terminal' : failed ? 'Inspect failure' : 'Open terminal', route: `terminals/${encodeURIComponent(session.id)}`,
      status: requested ? interaction.modality === 'secret' ? 'Private input' : 'Needs input' : failed ? 'Failed' : state === 'starting' ? 'Starting' : active ? 'Running' : 'Ready',
      at: requested ? interaction.basis?.evidence_observed_at_millis ?? at : at,
      recentAt: Math.max(visits[key] ?? 0, kind === 'job' ? at : session.started_at_millis ?? at), needs: requested || failure,
      running: !requested && active, recent: relevant || requested, priority: requested ? 0 : 1,
      tone: failed ? 'danger' : requested ? 'attention' : 'neutral', result: false,
    })
  }
  for (const draft of drafts) {
    const key = `workflow-draft:${draft.id}`
    if (!visits[key]) continue
    rows.set(key, { key, kind: 'workflow', title: draft.draft.name || 'Untitled workflow', context: 'Saved workflow',
      reason: `${draft.draft.nodes.length} steps · Continue editing`, status: 'Draft', action: 'Continue workflow', route: `workflows/${encodeURIComponent(draft.id)}`,
      at: Date.parse(draft.updatedAt) || 0, recentAt: visits[key], needs: false, running: false, recent: true, priority: 2, tone: 'neutral', result: false })
  }
  for (const message of messages) {
    if (message.direction !== 'incoming' || message.acknowledged_at || message.archived) continue
    const key = `message:${message.id}`
    const at = Date.parse(message.created_at) || 0
    rows.set(key, { key, kind: 'message', title: message.title, context: message.source || 'Main inbox',
      reason: 'A message is awaiting your acknowledgement.', status: 'Review', action: 'Review message', route: 'carrier', messageId: message.id,
      at, recentAt: at, needs: true, running: false, recent: false, priority: 2, tone: 'attention', result: false })
  }
  const all = [...rows.values()]
  const needs = all.filter(row => row.needs).sort((a, b) => a.priority - b.priority || b.at - a.at || a.key.localeCompare(b.key))
  return {
    items: all,
    needs,
    recent: all.filter(row => row.recent && !row.needs && !row.running).sort((a, b) => Number(b.result) - Number(a.result) || b.recentAt - a.recentAt || a.key.localeCompare(b.key)).slice(0, 5),
    running: all.filter(row => row.running && !row.needs).sort((a, b) => b.at - a.at || a.key.localeCompare(b.key)),
  }
}
