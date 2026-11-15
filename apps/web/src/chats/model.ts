import { randomUUID } from '../uuid'
import type { ResourceReport, ResourceRequest } from '../agents/ResourcePicker'
import type { ProfileSelection, ProfileDecision } from '../agents/profileSelection'
import type { ChatCommand, CommandsState, CommandOutput } from './commands'
import { useEffect, useRef, useState } from 'react'
import type { ProjectRun, Transfer } from '../connect/model'
import type { AgentsModel } from '../agents/model'
import type { Discovery } from '../projects/model'
import type { McpSnapshot } from '../agents/mcp'
import type { PermissionMode } from '../agents/permissions'
import type { ChatSearchArgs, ChatSearchPage } from './ChatSearch'
import { CACHED_CONVERSATIONS, chatSummary, loadedItems, recentSnapshot } from './history'
import { reportRecovery } from '../recovery/events'

export type ChatItem = {
  nativeItemId?: string
  id: string
  type: string
  text: string
  turnId?: string | null
  status?: string | null
  command?: string | null
  exitCode?: number | null
  afterItemId?: string
  supervisionUpdate?: boolean
  source?: { kind: 'chat' | 'vox'; id: string; title: string; url?: string;
    messageType?: 'delegation_result'; delegationId?: string; turnId?: string; outcome?: 'completed' | 'failed' }
}
export type ChatRequest = {
  requestId: string
  autoApprovalError?: string
  method: string
  params: {
    threadId?: string
    choices?: { option_id?: string; optionId?: string; name: string; kind?: string }[]
    kind?: string
    reason?: string
    command?: string
    permissions?: unknown
    networkApprovalContext?: { host?: string; protocol?: string }
    message?: string
    mode?: string
    _meta?: { codex_approval_kind?: string }
    requestedSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] }
    questions?: { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] | null }[]
  }
}
export type ChatTerminal = {
  key: string
  status: 'queued' | 'launching' | 'running' | 'releasing' | 'uncertain' | 'unavailable' | 'exited' | 'failed' | 'released'
  runId: string | null
  sessionId: string | null
  url: string | null
  error?: string | null
  createdAt: number
  updatedAt: number
}
export type BackgroundAgent = {
  id: string; parentId?: string; title: string; preview: string; status: string
  needsInput: boolean; canInspect: boolean; canStop: boolean; source: 'provider'
}
export type BackgroundProcess = {
  id: string; itemId?: string; command: string; cwd: string; status: string; canStop: boolean; source: 'provider'
}
export type BackgroundActivity = {
  agents: BackgroundAgent[]; processes: BackgroundProcess[]
  agentsAvailability: 'ready' | 'unsupported' | 'unavailable'
  processesAvailability: 'ready' | 'limited' | 'unsupported' | 'unavailable'
}
export function terminalIsActive(terminal?: ChatTerminal | null) {
  return Boolean(terminal && ['queued', 'launching', 'running', 'releasing', 'uncertain', 'unavailable'].includes(terminal.status))
}
export type BackendResponse = { outcome: 'selected'; option_id: string } | { outcome: 'cancelled' }
export type DeletionActivity = { remote: boolean; hasWork: boolean; activeChatIds: string[]; workflowIds: string[]; stopToken?: string }
export type ChatDeletionPreview = { chatId: string; childCount: number; previewToken: string; activity?: Record<'conversation' | 'subtree', DeletionActivity> }
export type ChatDeletionChoice = { scope: 'conversation' | 'subtree'; previewToken: string }
export type ChatCreationStatus = {
  requestId: string; state: 'creating' | 'uncertain' | 'failed' | 'created'; sessionConfirmed: boolean
  phase?: string; error?: string | null; code?: string | null
}
export type ChatCreationResult = ChatCreationStatus & { chat: ChatSnapshot | null }

export type Chat = {
  creation?: ChatCreationStatus
  initialConfiguration?: { state: 'pending' | 'ready' | 'failed'; requested: { id: string; value: string | boolean }[] }
  profileId?: string
  authId?: string | null
  homeId?: string
  identityState?: 'resolved' | 'needs_attention'
  connectionState?: 'connected' | 'waiting_for_active_work' | 'ready_to_reconnect' | 'reconnecting' | 'needs_attention'
  authRecovery?: { operationId?: string; phase?: string; blockers?: { kind: string }[] }
  loginGeneration?: number
  availableCommands?: ChatCommand[]
  commandsState?: CommandsState
  commandsError?: string
  commandOutput?: CommandOutput
  tokenUsage?: Record<string, unknown>
  contextCompaction?: { metadata: Record<string, unknown>; source: string; turnId?: string }
  sessionConfig?: { id: string; name: string; category?: string; type: string; currentValue: string | boolean;
    options?: ({ value: string; name: string } | { group: string; name: string; options: { value: string; name: string }[] })[] }[]
  backend?: string
  backendRoute?: 'managed'
  backendCapabilities?: { operations: Record<string, { supported: boolean; reason?: string }> }
  chatCapabilities?: { queue: boolean; steer: boolean; workflows: boolean; background?: boolean; workflowApprovalMode?: 'sandbox' | 'tool-approvals' }
  backendHistoryPending?: boolean
  backendPreviousTurnUnknown?: boolean
  sessionRecovery?: { phase: 'restoring' | 'blocked' | 'failed'; message?: string } | null
  interruptedTurn?: { id: string; reason: 'runtime_ended'; outcomeUnknown?: boolean }
  resourceReport?: ResourceReport | null
  resourceRequest?: ResourceRequest
  applicationPreset?: { id: string; revision: string }
  automationId?: string
  automationSupervisor?: boolean
  resourceSnapshotRef?: string
  labels?: Record<string, string>
  id: string
  provider: 'codex' | 'claude' | 'opencode' | 'antigravity'
  profile: string
  auth: string | null
  model?: string | null
  cwd: string
  project: string
  projectId?: string | null
  remoteProfile?: string | null
  deviceId?: string | null
  device?: string | null
  mode: 'chat' | 'work'
  title: string
  status: string
  statusReason?: 'session_ended' | 'connection_lost' | 'notification_error' | null
  createdAt: number
  updatedAt: number
  revision: number
  turnId?: string | null
  latestCompletedTurnId?: string | null
  lastReadTurnId?: string | null
  error?: string | null
  originChatId?: string | null
  parentChatId?: string | null
  parentTitle?: string | null
  launchId?: string | null
  returnsResult?: boolean
  accessMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  permissionMode?: PermissionMode | null
  permissionSource?: string
  profileSelection?: ProfileSelection
  profileDecision?: ProfileDecision | null
  approvalPolicy?: 'on-request' | 'never' | null
  workspaceTools?: boolean
  mcp?: McpSnapshot | null
  terminal?: ChatTerminal | null
}
export type ChatLaunch = {
  resultDelivery?: { state: 'waiting' | 'pending' | 'queued' | 'paused' | 'accepted' | 'processing' | 'processed' | 'parent_failed' | 'uncertain' | 'cancelled' | 'removed';
    outcome: 'completed' | 'failed' | null; messageId: string; parentTurnId?: string | null; error?: string | null; reportAvailable: boolean }
  permissionMode?: PermissionMode | null
  permissionSource?: string
  profileSelection?: ProfileSelection
  profileDecision?: ProfileDecision | null
  id: string
  originChatId: string
  sourceTurnId?: string | null
  sourceCallId?: string | null
  attached?: boolean
  chatId: string
  projectId: string | null
  project: string
  title: string
  instruction: string
  phase: string
  status: string
  url: string | null
  needsInput: boolean
  resultPreview: string
  error?: string | null
  createdAt: number
  updatedAt: number
  revision: number
}
export type ChatWorkflow = {
  key: string; id: string | null; originChatId: string; projectId: string; project: string; title: string;
  originConversationDeleted?: boolean;
  sourceTurnId?: string | null; sourceCallId?: string | null;
  state: string; revision: number; createdAt: number; updatedAt: number; error?: string | null;
  accepted?: boolean; url?: string; deliveryStep?: string;
  canvas?: import('../workflows/builder/model').CanvasDraft | null;
  namespace?: string; workflowId?: string | null; parentJobId?: string | null;
  planRevision?: number; held?: boolean; phase?: string; lockedGroups?: string[];
  executionWorkflow?: import('../workflows/builder/compileCanvas').GraphWorkflow | {
    format: 'aixand.chat-workflow'; version: number; name: string; project_id: string; origin_chat_id: string; profile: string;
    provider?: string; backend?: string; sdk_approval_policy?: 'ask' | 'deny';
    permission_mode?: PermissionMode; permission_source?: string; require_explicit_access?: boolean;
    profile_selection?: ProfileSelection; profile_requirements?: import('../workflows/ir').Json;
    model?: string | null; delivery_step: string; steps: { id: string; title: string; instruction: string; depends_on: string[];
      permission_mode?: PermissionMode; sdk_approval_policy?: 'ask' | 'deny'; permission_source?: string; profile_selection?: ProfileSelection; profile_requirements?: import('../workflows/ir').Json; input_names?: string[] }[];
  };
  definition?: { profile: string; model: string | null; provider?: string; backend?: string; sdkApprovalPolicy?: 'ask' | 'deny'; steps: { id: string; instruction: string }[] };
  steps: { id: string; title: string; dependsOn: string[]; state: string; chat_id?: string | null; error?: string | null; permissionMode?: PermissionMode; permissionSource?: string; profileSelection?: ProfileSelection; profileDecision?: ProfileDecision | null;
    sdkApprovalPolicy?: 'ask' | 'deny'; provider?: string; backend?: string;
    conversationDeleted?: boolean; executionState?: string; reportState?: string; reportError?: string | null;
    receipt?: { messageId: number; acknowledged: boolean } }[];
  collector?: { address: string | null; received: number; expected: number } | null;
  delivery?: { message_id: number; address: string; inbox: string } | null;
}
export type QueuedMessage = {
  id: string; text: string; status: 'queued' | 'sending' | 'uncertain'; revision: number; createdAt: number; error?: string | null
  source?: ChatItem['source']
}
export type ChatQueue = { paused: boolean; reason?: string | null; messages: QueuedMessage[] }
export type ChatSnapshot = Chat & { items: ChatItem[]; requests: ChatRequest[]; supervisionUpdates?: ChatItem[]; queue?: ChatQueue; launches?: ChatLaunch[]; workflows?: ChatWorkflow[]; discoveries?: Discovery[]; transfers?: Transfer[]; projectRuns?: ProjectRun[]; indexedHistory?: boolean; searchItemId?: string; historyTruncated?: boolean; historyCursor?: string | null; historyAfter?: string | null; historyUnavailable?: boolean; syncing?: boolean }
export type HistoryPage = { items: ChatItem[]; cursor: string | null; after?: string | null; unavailable?: boolean }
type Event =
  | { kind: 'metadata'; chat: Partial<Chat> }
  | { kind: 'item'; item: ChatItem }
  | { kind: 'delta'; itemId: string; itemType: string; text: string; turnId?: string | null }
  | { kind: 'status'; status: string; statusReason?: Chat['statusReason']; turnId?: string; error?: string }
  | { kind: 'request'; request: ChatRequest }
  | { kind: 'requests'; requests: ChatRequest[] }
  | { kind: 'connection'; status: string }
  | { kind: 'relationship'; parentChatId: string | null; parentTitle: string | null }
  | { kind: 'terminal'; terminal: ChatTerminal | null }
  | { kind: 'queue'; queue: ChatQueue }

function apply(snapshot: ChatSnapshot, event: Event): ChatSnapshot {
  if (event.kind === 'metadata') return { ...snapshot, ...event.chat }
  if (event.kind === 'queue') return { ...snapshot, queue: event.queue }
  if (event.kind === 'terminal') return { ...snapshot, terminal: event.terminal }
  if (event.kind === 'relationship') return { ...snapshot, parentChatId: event.parentChatId, parentTitle: event.parentTitle }
  if (event.kind === 'item') {
    const found = snapshot.items.some((item) => item.id === event.item.id)
    return { ...snapshot, items: found ? snapshot.items.map((item) => item.id === event.item.id ? event.item : item) : [...snapshot.items, event.item] }
  }
  if (event.kind === 'delta') {
    const found = snapshot.items.some((item) => item.id === event.itemId)
    return { ...snapshot, items: found ? snapshot.items.map((item) => item.id === event.itemId ? { ...item, text: (item.text + event.text).slice(-65536), turnId: event.turnId ?? item.turnId } : item) :
      [...snapshot.items, { id: event.itemId, type: event.itemType, text: event.text, turnId: event.turnId }] }
  }
  if (event.kind === 'status') return { ...snapshot, status: event.status,
    statusReason: event.statusReason === undefined && event.status === 'offline' ? snapshot.statusReason : event.statusReason,
    turnId: event.turnId ?? snapshot.turnId, error: event.error, requests: ['completed', 'failed', 'interrupted', 'offline'].includes(event.status) ? [] : snapshot.requests }
  if (event.kind === 'request') return { ...snapshot, status: 'waiting', statusReason: null, requests: [...snapshot.requests.filter((request) => request.requestId !== event.request.requestId), event.request] }
  if (event.kind === 'requests') return { ...snapshot, requests: event.requests, status: snapshot.status === 'waiting' && !event.requests.length ? 'running' : snapshot.status }
  return { ...snapshot, status: 'offline', requests: [] }
}

export function useChats(agents: AgentsModel) {
  const api = useRef(agents)
  api.current = agents
  const [chats, setChats] = useState<Chat[]>([])
  const [listReady, setListReady] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const listTask = useRef<Promise<void> | null>(null)
  const [snapshots, setSnapshots] = useState<Record<string, ChatSnapshot>>({})
  const snapshotStore = useRef(snapshots)
  const latestSnapshots = useRef<Record<string, ChatSnapshot>>({})
  const activeId = useRef<string | null>(null)
  const navigationGeneration = useRef(0)
  const recent = useRef<string[]>([])
  const opened = useRef(new Map<string, Promise<ChatSnapshot>>())
  const visited = useRef(new Map<string, number>())
  const visitTasks = useRef(new Map<string, Promise<ChatSnapshot>>())
  const historyTasks = useRef(new Map<string, Promise<HistoryPage>>())
  const [projectRuns, setProjectRuns] = useState<Record<string, ProjectRun[]>>({})
  const [transfers, setTransfers] = useState<Record<string, Transfer[]>>({})
  const [launches, setLaunches] = useState<Record<string, ChatLaunch[]>>({})
  const [workflows, setWorkflows] = useState<Record<string, ChatWorkflow[]>>({})
  const [workflowError, setWorkflowError] = useState('')
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowReady, setWorkflowReady] = useState(false)
  const [workflowNextOffset, setWorkflowNextOffset] = useState<number | null>(null)
  const deleted = useRef(new Set<string>())
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set())
  const deleteAttempts = useRef(new Map<string, string>())
  const answerAttempts = useRef(new Map<string, { key: string; payload: string }>())
  const backgroundStopAttempts = useRef(new Map<string, string>())
  const deletionPreviews = useRef(new Map<string, Promise<ChatDeletionPreview>>())
  const events = useRef(new Map<string, { revision: number; event: Event }[]>())
  const snapshotReads = useRef(new Map<string, number>())
  const discoveryRevision = useRef(0)
  const discoveries = useRef(new Map<string, number>())

  function updateSnapshots(update: (previous: Record<string, ChatSnapshot>) => Record<string, ChatSnapshot>) {
    const next = update(snapshotStore.current)
    if (next === snapshotStore.current) return
    snapshotStore.current = next
    setSnapshots(next)
  }

  function activate(id: string | null) {
    if (id === activeId.current) return
    navigationGeneration.current++
    activeId.current = id
    if (id) recent.current = [id, ...recent.current.filter((key) => key !== id)].slice(0, CACHED_CONVERSATIONS)
    latestSnapshots.current = Object.fromEntries(Object.entries(latestSnapshots.current).filter(([key]) => recent.current.includes(key)))
    updateSnapshots((previous) => Object.fromEntries(Object.entries(previous)
      .filter(([key]) => recent.current.includes(key))
      .map(([key, snapshot]) => [key, key === id ? snapshot : latestSnapshots.current[key] ?? recentSnapshot(snapshot)])))
  }

  async function requestSnapshot(op: string, args: object, creating = false): Promise<ChatSnapshot> {
    const identity = args as { chatId?: string; key?: string }
    const id = identity.chatId ?? identity.key!
    snapshotReads.current.set(id, (snapshotReads.current.get(id) ?? 0) + 1)
    try {
      const snapshot = await api.current.request<ChatSnapshot>(op, args)
      if (op === 'chat-open' && !snapshot.syncing && !snapshot.sessionRecovery && !['offline', 'uncertain'].includes(snapshot.status)) reportRecovery({ kind: 'healthy' })
      if (creating && !activeId.current) activate(snapshot.id)
      return remember(snapshot)
    } finally {
      const count = (snapshotReads.current.get(id) ?? 1) - 1
      if (count) snapshotReads.current.set(id, count)
      else { snapshotReads.current.delete(id); events.current.delete(id) }
    }
  }

  function rememberProjectRun(run: ProjectRun) {
    if (deleted.current.has(run.chatId)) return run
    run = { ...run, childConversationDeleted: run.childConversationDeleted || Boolean(run.childChatId && deleted.current.has(run.childChatId)),
      targets: run.targets?.map(target => ({ ...target, childConversationDeleted: target.childConversationDeleted || Boolean(target.childChatId && deleted.current.has(target.childChatId)) })) }
    setProjectRuns((previous) => {
      const rows = previous[run.chatId] ?? []
      if (rows.some((row) => row.id === run.id && row.revision >= run.revision)) return previous
      return { ...previous, [run.chatId]: [...rows.filter((row) => row.id !== run.id), run].sort((a, b) => a.createdAt - b.createdAt) }
    })
    return run
  }
  async function projectRunAction(chatId: string, runId: string, action: 'cancel' | 'check', targetId?: string) {
    return rememberProjectRun(await api.current.request<ProjectRun>(`connect-project-${action}`, { chatId, runId, ...(targetId ? { targetId } : {}) }))
  }

  function rememberTransfer(transfer: Transfer) {
    if (deleted.current.has(transfer.chatId)) return transfer
    setTransfers((previous) => {
      const rows = previous[transfer.chatId] ?? []
      if (rows.some((row) => row.id === transfer.id && row.revision >= transfer.revision)) return previous
      return { ...previous, [transfer.chatId]: [transfer, ...rows.filter((row) => row.id !== transfer.id)].sort((a, b) => a.createdAt - b.createdAt) }
    })
    return transfer
  }
  async function transferAction(chatId: string, transferId: string, action: 'cancel' | 'check') {
    return rememberTransfer(await api.current.request<Transfer>(`connect-${action}`, { chatId, transferId }))
  }

  function rememberLaunch(launch: ChatLaunch) {
    if (deleted.current.has(launch.chatId) || deleted.current.has(launch.originChatId)) return
    setLaunches((previous) => {
      const rows = previous[launch.originChatId] ?? []
      if (rows.some((row) => row.id === launch.id && row.revision >= launch.revision)) return previous
      return { ...previous, [launch.originChatId]: [launch, ...rows.filter((row) => row.id !== launch.id)].sort((a, b) => a.createdAt - b.createdAt) }
    })
  }

  function rememberWorkflow(workflow: ChatWorkflow) {
    workflow = { ...workflow, originConversationDeleted: workflow.originConversationDeleted || deleted.current.has(workflow.originChatId),
      steps: workflow.steps.map(step => ({ ...step,
      conversationDeleted: step.conversationDeleted || Boolean(step.chat_id && deleted.current.has(step.chat_id)) })) }
    setWorkflows((previous) => {
      const rows = previous[workflow.originChatId] ?? []
      const current = rows.find((row) => row.key === workflow.key)
      if (current && current.revision >= workflow.revision) {
        // Chat deletion does not change the workflow revision. Merge its durable
        // deletion flags even when a cached run is otherwise newer.
        const next = { ...current, definition: current.definition ?? workflow.definition,
          originConversationDeleted: current.originConversationDeleted || workflow.originConversationDeleted,
          steps: current.steps.map(step => ({ ...step, conversationDeleted: step.conversationDeleted ||
            workflow.steps.some(candidate => candidate.chat_id === step.chat_id && candidate.conversationDeleted) })) }
        if (next.definition !== current.definition || next.originConversationDeleted !== current.originConversationDeleted ||
          next.steps.some((step, index) => step.conversationDeleted !== current.steps[index].conversationDeleted))
          return { ...previous, [workflow.originChatId]: rows.map((row) => row.key === workflow.key ? next : row) }
        return previous
      }
      const next = { ...workflow, definition: workflow.definition ?? current?.definition,
        originConversationDeleted: workflow.originConversationDeleted || current?.originConversationDeleted,
        steps: workflow.steps.map(step => ({ ...step, conversationDeleted: step.conversationDeleted ||
          current?.steps.some(candidate => candidate.chat_id === step.chat_id && candidate.conversationDeleted) })) }
      return { ...previous, [workflow.originChatId]: [next, ...rows.filter((row) => row.key !== workflow.key)].sort((a, b) => a.createdAt - b.createdAt) }
    })
    return workflow
  }

  function remember(snapshot: ChatSnapshot) {
    if (deleted.current.has(snapshot.id)) return snapshot
    discoveries.current.set(snapshot.id, ++discoveryRevision.current)
    for (const run of snapshot.projectRuns ?? []) rememberProjectRun(run)
    for (const transfer of snapshot.transfers ?? []) rememberTransfer(transfer)
    for (const launch of snapshot.launches ?? []) rememberLaunch(launch)
    for (const workflow of snapshot.workflows ?? []) rememberWorkflow(workflow)
    // Events can arrive before a snapshot response, including on reconnect.
    // Apply only newer events and never replace newer state with a retry result.
    const responseRevision = snapshot.revision
    for (const value of events.current.get(snapshot.id) ?? []) {
      if (value.revision > snapshot.revision) snapshot = { ...apply(snapshot, value.event), revision: value.revision }
    }
    const latest = latestSnapshots.current[snapshot.id]
    // A buffered metadata event can advance an older response to the same
    // revision as a full pushed snapshot. Keep that snapshot's message payload.
    if (!snapshot.indexedHistory && latest && (latest.revision > snapshot.revision ||
      latest.revision === snapshot.revision && snapshot.revision > responseRevision)) snapshot = latest
    if (!snapshot.indexedHistory) snapshot = recentSnapshot(snapshot)
    if (!snapshot.indexedHistory && recent.current.includes(snapshot.id) && (!latestSnapshots.current[snapshot.id] || latestSnapshots.current[snapshot.id].revision <= snapshot.revision))
      latestSnapshots.current[snapshot.id] = snapshot
    updateSnapshots((previous) => {
      if (!recent.current.includes(snapshot.id) || previous[snapshot.id]?.revision > snapshot.revision) return previous
      const current = previous[snapshot.id]
      if ((current?.historyAfter || current?.indexedHistory) && !snapshot.indexedHistory) {
        const updates = new Map(snapshot.items.map((item) => [item.id, item]))
        return { ...previous, [snapshot.id]: { ...snapshot, items: current.items.map((item) => updates.get(item.id) ?? item), historyCursor: current.historyCursor, historyAfter: current.historyAfter, indexedHistory: current.indexedHistory, searchItemId: current.searchItemId } }
      }
      // Keep older pages while refreshing or receiving a mutation in the active chat.
      if (activeId.current === snapshot.id && current?.items.length && current.items[0].id !== snapshot.items[0]?.id) {
        const first = current.items.findIndex((item) => item.id === snapshot.items[0]?.id)
        if (first >= 0) snapshot = { ...snapshot, items: [...current.items.slice(0, first), ...snapshot.items], historyCursor: current.historyCursor }
      }
      const bounded = loadedItems(snapshot.items)
      if (bounded.trimmed) snapshot = { ...snapshot, items: bounded.items, historyCursor: bounded.items[0].id }
      return { ...previous, [snapshot.id]: snapshot }
    })
    setChats((previous) => previous.some((chat) => chat.id === snapshot.id && chat.revision > snapshot.revision) ? previous :
      [chatSummary(snapshot), ...previous.filter((chat) => chat.id !== snapshot.id)])
    return snapshot
  }
  function refresh(): Promise<void> {
    if (listTask.current) return listTask.current
    setListLoading(true)
    const task = (async () => {
      try {
        const startedAtRevision = discoveryRevision.current
        const rows = (await api.current.request<Chat[]>('chat-list')).filter((row) => !deleted.current.has(row.id)).map(chatSummary)
        const known = new Set(rows.map((row) => row.id))
        setChats((previous) => [...rows.map((row) => {
          const newer = previous.find((chat) => chat.id === row.id && chat.revision > row.revision)
          return newer ?? row
        }), ...previous.filter((row) => !deleted.current.has(row.id) && !known.has(row.id) && (discoveries.current.get(row.id) ?? 0) > startedAtRevision)])
        setListReady(true)
        setListError('')
        reportRecovery({ kind: 'healthy' })
      } catch (cause) {
        setListError(cause instanceof Error ? cause.message : 'Could not load conversations.')
        reportRecovery({ kind: 'failure' })
        throw cause
      }
    })().finally(() => {
      if (listTask.current === task) { listTask.current = null; setListLoading(false) }
    })
    listTask.current = task
    return task
  }
  async function markRead(chatId: string, turnId: string) {
    return remember(await api.current.request<ChatSnapshot>('chat-mark-read', { chatId, turnId }))
  }
  async function loadWorkflowRuns(offset = 0) {
    setWorkflowLoading(true)
    try {
      const page = await api.current.request<{ runs: ChatWorkflow[]; nextOffset: number | null; error?: string }>('chat-workflow-runs', { offset })
      for (const run of page.runs) rememberWorkflow(run)
      setWorkflowNextOffset(page.nextOffset)
      setWorkflowReady(true)
      setWorkflowError(page.error ?? '')
    } catch (cause) { setWorkflowError(cause instanceof Error ? cause.message : 'Could not load workflow runs.') }
    finally { setWorkflowLoading(false) }
  }
  function forget(id: string) {
    deleted.current.add(id)
    setDeletedIds(new Set(deleted.current))
    discoveries.current.delete(id)
    events.current.delete(id)
    recent.current = recent.current.filter((key) => key !== id)
    delete latestSnapshots.current[id]
    setWorkflows(previous => Object.fromEntries(Object.entries(previous).map(([key, rows]) => [key,
      rows.map(run => ({ ...run, originConversationDeleted: run.originConversationDeleted || run.originChatId === id,
        steps: run.steps.map(step => step.chat_id === id ? { ...step, conversationDeleted: true } : step) }))])))
    setProjectRuns(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id).map(([key, rows]) =>
      [key, rows.map(run => ({ ...run, childConversationDeleted: run.childConversationDeleted || run.childChatId === id,
        targets: run.targets?.map(target => ({ ...target, childConversationDeleted: target.childConversationDeleted || target.childChatId === id })) }))])))
    visited.current.delete(id)
    setChats((previous) => previous.filter((chat) => chat.id !== id).map((chat) =>
      (chat.parentChatId === undefined ? chat.originChatId : chat.parentChatId) === id ? { ...chat, parentChatId: null, parentTitle: null } : chat))
    updateSnapshots((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id).map(([key, chat]) =>
      [key, (chat.parentChatId === undefined ? chat.originChatId : chat.parentChatId) === id ? { ...chat, parentChatId: null, parentTitle: null } : chat])))
    setLaunches((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== id)
      .map(([key, rows]) => [key, rows.filter((launch) => launch.chatId !== id)])))
  }
  useEffect(() => api.current.subscribe((value) => {
    const message = value as { type: string; chatId?: string; revision: number; event: Event; chat?: ChatSnapshot; launch?: ChatLaunch; workflow?: ChatWorkflow; transfer?: Transfer; run?: ProjectRun }
    if (message.type === 'connect-project-updated' && message.run) { rememberProjectRun(message.run); return }
    if (message.type === 'connect-transfer-updated' && message.transfer) { rememberTransfer(message.transfer); return }
    if (message.type === 'chat-deleted' && message.chatId) { forget(message.chatId); return }
    if (['chat-created', 'chat-updated'].includes(message.type) && message.chat) {
      if (message.type === 'chat-updated' && snapshotReads.current.has(message.chat.id)) {
        const chat = message.chat
        events.current.set(chat.id, [...(events.current.get(chat.id) ?? []), { revision: chat.revision,
          event: { kind: 'metadata' as const, chat: chatSummary(chat) } }].slice(-128))
      }
      remember(message.chat); return
    }
    if (message.type === 'launch-updated' && message.launch) { rememberLaunch(message.launch); return }
    if (message.type === 'workflow-updated' && message.workflow) { rememberWorkflow(message.workflow); return }
    if (message.type !== 'chat-event') return
    if (!message.chatId) {
      visited.current.clear()
      latestSnapshots.current = Object.fromEntries(Object.entries(latestSnapshots.current).map(([key, snapshot]) => [key, apply(snapshot, { kind: 'connection', status: 'offline' })]))
      updateSnapshots((previous) => Object.fromEntries(Object.entries(previous).map(([key, snapshot]) => [key, apply(snapshot, { kind: 'connection', status: 'offline' })])))
      setChats((previous) => previous.map((chat) => ({ ...chat, status: 'offline' })))
      return
    }
    const id = message.chatId
    if (deleted.current.has(id)) return
    // Buffer only while a snapshot is in flight. Keeping historical deltas for
    // every visited chat would retain evicted transcript text indefinitely.
    if (snapshotReads.current.has(id))
      events.current.set(id, [...(events.current.get(id) ?? []), { revision: message.revision, event: message.event }].slice(-128))
    if (latestSnapshots.current[id] && message.revision > latestSnapshots.current[id].revision)
      latestSnapshots.current[id] = recentSnapshot({ ...apply(latestSnapshots.current[id], message.event), revision: message.revision })
    updateSnapshots((previous) => {
      if (!previous[id] || message.revision <= previous[id].revision) return previous
      const event = message.event
      const outsideWindow = (previous[id].historyAfter || previous[id].indexedHistory) &&
        (event.kind === 'item' && !previous[id].items.some((item) => item.id === event.item.id) ||
          event.kind === 'delta' && !previous[id].items.some((item) => item.id === event.itemId))
      let snapshot = { ...(outsideWindow ? previous[id] : apply(previous[id], event)), revision: message.revision }
      if (activeId.current !== id) snapshot = recentSnapshot(snapshot)
      else {
        const bounded = loadedItems(snapshot.items)
        if (bounded.trimmed) snapshot = { ...snapshot, items: bounded.items, historyCursor: bounded.items[0].id }
      }
      return { ...previous, [id]: snapshot }
    })
    if (message.event.kind === 'terminal') {
      const terminal = message.event.terminal
      setChats((previous) => previous.map((chat) => chat.id === id && message.revision > chat.revision ?
        { ...chat, terminal, revision: message.revision } : chat))
    }
    if (message.event.kind === 'status' || message.event.kind === 'request') {
      const event = message.event
      const status = event.kind === 'status' ? event.status : 'waiting'
      const statusReason = event.kind === 'status' ? event.statusReason : null
      setChats((previous) => previous.map((chat) => chat.id === id && message.revision > chat.revision ?
        { ...chat, status, statusReason: statusReason === undefined && status === 'offline' ? chat.statusReason : statusReason,
          error: event.kind === 'status' ? event.error : chat.error, revision: message.revision, updatedAt: Date.now() } : chat))
    }
    if (message.event.kind === 'requests' || message.event.kind === 'connection') {
      const event = message.event
      setChats((previous) => previous.map((chat) => chat.id === id && message.revision > chat.revision ?
        { ...chat, status: event.kind === 'connection' ? 'offline' : chat.status === 'waiting' && !event.requests.length ? 'running' : chat.status,
          revision: message.revision } : chat))
    }
  }), [])
  useEffect(() => {
    if (agents.status === 'connected') {
      void refresh().catch(() => {})
      void loadWorkflowRuns()
    } else {
      setListReady(false)
      setWorkflowReady(false)
      setChats((previous) => previous.map((chat) => ({ ...chat, status: 'offline' })))
      visited.current.clear()
      latestSnapshots.current = Object.fromEntries(Object.entries(latestSnapshots.current).map(([key, snapshot]) => [key, { ...snapshot, status: 'offline', requests: [] }]))
      updateSnapshots((previous) => Object.fromEntries(Object.entries(previous).map(([key, snapshot]) => [key, { ...snapshot, status: 'offline', requests: [] }])))
    }
    const focus = () => {
      if (api.current.status === 'connected') void refresh().catch(() => {})
    }
    window.addEventListener('focus', focus)
    return () => { window.removeEventListener('focus', focus) }
  }, [agents.status])

  async function create(args: object) {
    return requestSnapshot('chat-create', args, true)
  }
  async function inspectCreation(key: string): Promise<ChatCreationResult> {
    const result = await api.current.request<ChatCreationResult>('chat-create-status', { key })
    if (!result || result.requestId !== key || !['creating', 'uncertain', 'failed', 'created'].includes(result.state))
      throw new Error('The server could not confirm this creation request.')
    if (result.chat) remember(result.chat)
    return result
  }
  function open(id: string): Promise<ChatSnapshot> {
    const current = opened.current.get(id)
    if (current) return current
    const task = (async () => {
      let snapshot = await requestSnapshot('chat-open', { chatId: id })
      if (terminalIsActive(snapshot.terminal))
        snapshot = await requestSnapshot('chat-terminal-status', { chatId: id })
      visited.current.set(id, Date.now())
      return snapshot
    })().finally(() => { if (opened.current.get(id) === task) opened.current.delete(id) })
    opened.current.set(id, task)
    return task
  }
  function visit(id: string): Promise<ChatSnapshot> {
    activate(id)
    const cached = snapshotStore.current[id]
    if (cached?.indexedHistory) return Promise.resolve(cached)
    if (cached && !['offline', 'uncertain'].includes(cached.status) && Date.now() - (visited.current.get(id) ?? 0) < 15000) return Promise.resolve(cached)
    let task = visitTasks.current.get(id)
    if (!task) {
      task = requestSnapshot('chat-open', { chatId: id, recent: true }).then(async (snapshot) => {
        visited.current.set(id, Date.now())
        if (terminalIsActive(snapshot.terminal)) {
          // Reconcile the terminal association even when the transcript was cached.
          await requestSnapshot('chat-terminal-status', { chatId: id })
        }
        return snapshot
      }).finally(() => { visitTasks.current.delete(id) })
      visitTasks.current.set(id, task)
    }
    if (cached) {
      void task.catch((cause: Error) => {
        // A failed background read belongs only to the conversation it opened.
        if (snapshotStore.current[id] === cached) updateSnapshots(previous => ({ ...previous,
          [id]: { ...cached, status: 'offline', error: cause.message } }))
      })
      return Promise.resolve(cached)
    }
    return task
  }
  function latest(id: string) {
    navigationGeneration.current++
    const indexed = snapshotStore.current[id]?.indexedHistory
    if (indexed) {
      updateSnapshots(previous => ({ ...previous, [id]: { ...(latestSnapshots.current[id] ?? previous[id]),
        items: latestSnapshots.current[id]?.items ?? [], historyCursor: latestSnapshots.current[id]?.historyCursor ?? null,
        historyAfter: null, historyUnavailable: false, indexedHistory: false, searchItemId: undefined } }))
      void open(id).catch((cause: Error) => {
        if (activeId.current === id) updateSnapshots(previous => ({ ...previous, [id]: { ...previous[id], status: 'offline', error: cause.message } }))
      })
      return
    }
    const snapshot = latestSnapshots.current[id]
    if (snapshot) updateSnapshots((previous) => ({ ...previous, [id]: snapshot }))
  }
  function loadHistory(id: string, cursor: string, direction: 'before' | 'after'): Promise<HistoryPage> {
    const generation = navigationGeneration.current
    const key = `${id}:${generation}:${direction}:${cursor}`
    const current = historyTasks.current.get(key)
    if (current) return current
    const task = api.current.request<HistoryPage>('chat-history', { chatId: id, [direction]: cursor, limit: 5, indexed: snapshotStore.current[id]?.indexedHistory || undefined })
      .then((page) => {
        updateSnapshots((previous) => {
          const snapshot = previous[id]
          if (!snapshot || activeId.current !== id || generation !== navigationGeneration.current || (direction === 'before' ? snapshot.historyCursor : snapshot.historyAfter) !== cursor || deleted.current.has(id)) return previous
          const known = new Set(snapshot.items.map((item) => item.id))
          const added = page.items.filter((item) => !known.has(item.id))
          const items = direction === 'before' ? [...added, ...snapshot.items] : [...snapshot.items, ...added]
          const window = loadedItems(items, direction)
          const bounded = window.items
          let before = direction === 'before' ? page.cursor : snapshot.historyCursor
          let after = direction === 'after' ? page.after : snapshot.historyAfter
          if (window.trimmed) {
            if (direction === 'before') after = bounded.at(-1)!.id
            else before = bounded[0].id
          }
          return { ...previous, [id]: { ...snapshot, items: bounded, historyCursor: before, historyAfter: after, historyUnavailable: page.unavailable } }
        })
        return page
      }).finally(() => { historyTasks.current.delete(key) })
    historyTasks.current.set(key, task)
    return task
  }
  function loadOlder(id: string, before: string) { return loadHistory(id, before, 'before') }
  function loadNewer(id: string, after: string) { return loadHistory(id, after, 'after') }
  function search(args: ChatSearchArgs) { return api.current.request<ChatSearchPage>('chat-search', args) }
  async function openMatch(id: string, itemId: string | null) {
    if (!itemId) { await visit(id); return }
    activate(id)
    const generation = navigationGeneration.current
    const snapshot = await api.current.request<ChatSnapshot>('chat-open', { chatId: id, around: itemId })
    if (activeId.current !== id || generation !== navigationGeneration.current || deleted.current.has(id)) return
    const current = snapshotStore.current[id]
    remember({ ...snapshot, ...(current && current.revision > snapshot.revision ? current : {}), items: snapshot.items,
      historyCursor: snapshot.historyCursor, historyAfter: snapshot.historyAfter, historyUnavailable: snapshot.historyUnavailable,
      indexedHistory: true, searchItemId: itemId })
    visited.current.set(id, Date.now())
  }
  async function send(args: object) { return requestSnapshot('chat-send', args) }
  async function commands(chatId: string) { return requestSnapshot('chat-commands', { chatId }) }
  async function configure(args: object) { return requestSnapshot('chat-config-set', args) }
  async function confirmConfiguration(args: object) { return requestSnapshot('chat-config-confirm', args) }
  async function command(args: object) { return requestSnapshot('chat-command', args) }
  async function steer(args: object) { return requestSnapshot('chat-steer', args) }
  async function queue(args: object) { return requestSnapshot('chat-queue', args) }
  async function editQueued(args: object) { return requestSnapshot('chat-queue-edit', args) }
  async function removeQueued(args: object) { return requestSnapshot('chat-queue-remove', args) }
  async function resumeQueue(args: object) { return requestSnapshot('chat-queue-resume', args) }
  async function interrupt(args: object) { await api.current.request('chat-interrupt', args) }
  async function answer(args: object) {
    const { key: suppliedKey, ...intent } = args as { key: string; chatId: string; requestId: string } & Record<string, unknown>
    const identity = `${intent.chatId}:${intent.requestId}`
    const payload = JSON.stringify(intent)
    const previous = answerAttempts.current.get(identity)
    if (previous && previous.payload !== payload) throw new Error('Previous answer delivery is unconfirmed. Refresh before changing your answer.')
    const attempt = previous ?? { key: suppliedKey, payload }
    answerAttempts.current.set(identity, attempt)
    try {
      await api.current.request('chat-answer', { ...intent, key: attempt.key })
      answerAttempts.current.delete(identity)
    } catch (cause) {
      if ((cause as { uncertain?: boolean })?.uncertain === false) answerAttempts.current.delete(identity)
      throw cause
    }
  }
  function requireBackgroundProtocol() {
    if (!api.current.capabilities.backgroundActivity) throw new Error('This backend needs an update before native background activity can be inspected.')
  }
  async function background(chatId: string) {
    requireBackgroundProtocol()
    return api.current.request<BackgroundActivity>('chat-background', { chatId })
  }
  async function backgroundAgent(chatId: string, agentId: string) {
    requireBackgroundProtocol()
    return api.current.request<{ items: ChatItem[] }>('chat-background-agent', { chatId, agentId })
  }
  async function backgroundProcess(chatId: string, processId: string) {
    requireBackgroundProtocol()
    return api.current.request<{ text: string }>('chat-background-process', { chatId, processId })
  }
  async function stopBackground(args: { key: string; chatId: string; processId: string }) {
    requireBackgroundProtocol()
    const identity = `${args.chatId}:${args.processId}`
    const key = backgroundStopAttempts.current.get(identity) ?? args.key
    backgroundStopAttempts.current.set(identity, key)
    try {
      const result = await api.current.request<{ terminated: boolean }>('chat-background-stop', { ...args, key })
      backgroundStopAttempts.current.delete(identity)
      return result
    } catch (cause) {
      if ((cause as { uncertain?: boolean })?.uncertain === false) backgroundStopAttempts.current.delete(identity)
      throw cause
    }
  }
  async function detach(args: object) { await requestSnapshot('chat-detach', args) }
  function previewDeletion(id: string) {
    const pending = deletionPreviews.current.get(id)
    if (pending) return pending
    const task = api.current.request<ChatDeletionPreview>('chat-delete-preview', { chatId: id })
      .finally(() => { if (deletionPreviews.current.get(id) === task) deletionPreviews.current.delete(id) })
    deletionPreviews.current.set(id, task)
    return task
  }
  async function stopForDeletion(id: string, choice: ChatDeletionChoice, stopToken?: string) {
    const attempt = JSON.stringify(['stop', id, choice.scope, choice.previewToken, stopToken])
    const key = deleteAttempts.current.get(attempt) ?? randomUUID()
    deleteAttempts.current.set(attempt, key)
    await api.current.request('chat-delete-stop', { key, chatId: id, ...choice, ...(stopToken ? { stopToken } : {}) })
  }
  async function remove(id: string, choice?: ChatDeletionChoice) {
    const attempt = JSON.stringify([id, choice?.scope, choice?.previewToken])
    const key = deleteAttempts.current.get(attempt) ?? randomUUID()
    deleteAttempts.current.set(attempt, key)
    const result = await api.current.request<{ deletedIds?: string[] }>('chat-delete', { key, chatId: id, ...choice })
    const ids = result?.deletedIds ?? [id]
    for (const deletedId of ids) forget(deletedId)
    deleteAttempts.current.delete(attempt)
    return ids
  }
  async function openTerminal(args: { key: string; chatId: string }) { return requestSnapshot('chat-terminal-open', args) }
  async function releaseTerminal(args: { key: string; chatId: string }) { return requestSnapshot('chat-terminal-release', args) }
  async function prepareWorkflow(args: { key: string; workflow: import('../workflows/builder/compileCanvas').GraphWorkflow; workflowId?: string }) {
    return api.current.request<import('../workflows/builder/compileCanvas').GraphWorkflow>('chat-workflow-prepare', args)
  }
  async function startWorkflow(args: object) { return rememberWorkflow(await api.current.request<ChatWorkflow>('chat-workflow-start', args)) }
  async function openWorkflowRun(workflowId: string) {
    const run = await api.current.request<ChatWorkflow>('chat-workflow-open', { workflowId })
    if (!run || typeof run.key !== 'string' || !Array.isArray(run.steps)) throw new Error('Workflow run unavailable.')
    return rememberWorkflow(run)
  }
  async function workflowAction(chatId: string, workflowId: string, action: 'status' | 'cancel' | 'resume' | 'hold' | 'release') {
    const hasOrigin = chats.some(chat => chat.id === chatId)
    return rememberWorkflow(await api.current.request<ChatWorkflow>(hasOrigin ? `chat-workflow-${action}` : 'workflow-run-action',
      hasOrigin ? { chatId, workflowId } : { workflowId, action }))
  }
  async function amendWorkflow(args: object) { return rememberWorkflow(await api.current.request<ChatWorkflow>('chat-workflow-amend', args)) }
  async function enableWorkflowEdits(args: object) { return rememberWorkflow(await api.current.request<ChatWorkflow>('chat-workflow-enable-edits', args)) }
  const workflowRuns = Object.values(workflows).flat().sort((a, b) => b.createdAt - a.createdAt)
  return { chats, snapshots, listReady, listLoading, listError, launches, projectRuns, projectRunAction, transfers, transferAction, workflows, workflowRuns, workflowError, workflowLoading, workflowReady, workflowNextOffset, loadWorkflowRuns, openWorkflowRun,
    deletedIds, search, openMatch, refresh, markRead, create, inspectCreation, open, visit, activate, latest, loadOlder, loadNewer, send, commands, configure, confirmConfiguration, command, steer, queue, editQueued, removeQueued, resumeQueue, interrupt, answer, background, backgroundAgent, backgroundProcess, stopBackground, detach, previewDeletion, stopForDeletion, remove, openTerminal, releaseTerminal, startWorkflow, prepareWorkflow, workflowAction, amendWorkflow, enableWorkflowEdits }
}
