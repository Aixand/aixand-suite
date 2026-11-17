import { AgentManagementCard, type ManagementAction } from '../agents/AgentManagementCard'
import type { AgentsModel } from '../agents/model'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Icon, LoadingIndicator } from 'bbb-design'
import { AgentQuestions } from './AgentQuestions'
import { Mark } from '../components/Mark'
import { CopyButton, MessageContent } from './MessageContent'
import { ActivityGroup } from './ActivityGroup'
import { toolCardEntries, type ToolCard } from './toolCardEntries'
import { supervisionItems } from './history'
import { TransferCard } from '../connect/TransferCard'
import { ProjectRunCard } from '../connect/ProjectRunCard'
import type { ProjectRun, Transfer } from '../connect/model'
import { DiscoveryCards } from '../projects/DiscoveryCards'
import type { Discovery } from '../projects/model'
import type { ChatLaunch, ChatRequest, ChatSnapshot } from './model'
import { sourceLabel, sourceMessageText } from './sourceMessage'
import { LaunchCards } from './LaunchCards'
import type { ChatWorkflow } from './model'
import { WorkflowCards } from './WorkflowCards'
import { terminalIsActive } from './model'

export function AgentRequest({ request, disabled, onAnswer }: {
  request: ChatRequest
  disabled: boolean
  onAnswer: (requestId: string, values: { decision?: string; answers?: Record<string, string>; response?: import('./model').BackendResponse }) => Promise<void>
}) {
  const questions = request.params.questions
  if (['item/tool/requestUserInput', 'sdk/question'].includes(request.method) && questions) {
    return <AgentQuestions key={request.requestId} request={request} disabled={disabled} onAnswer={onAnswer} />
  }
  if (['server-manager/request', 'conversation-manager/request'].includes(request.method) && request.params.kind === 'permission') {
    return <section className="command-agent-request" aria-label="Agent approval"><strong>Approval requested</strong><p>{request.params.message}</p>
      {request.autoApprovalError && <p role="alert">Automatic approval failed: {request.autoApprovalError}. Choose an option below to respond manually.</p>}
      <div className="command-answer-options">{request.params.choices?.map(option => <Button key={option.option_id ?? option.optionId} disabled={disabled}
        onPress={() => { void onAnswer(request.requestId, { response: { outcome: 'selected', option_id: (option.option_id ?? option.optionId)! } }) }}>{option.name}</Button>)}
        <Button variant="ghost" disabled={disabled} onPress={() => { void onAnswer(request.requestId, { response: { outcome: 'cancelled' } }) }}>Cancel permission request</Button>
      </div></section>
  }
  const mcpToolApproval = request.method === 'mcpServer/elicitation/request' && request.params.mode === 'form'
    && request.params._meta?.codex_approval_kind === 'mcp_tool_call' && request.params.requestedSchema?.type === 'object'
    && !Object.keys(request.params.requestedSchema.properties ?? {}).length && !request.params.requestedSchema.required?.length
  const approval = mcpToolApproval || ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method)
  return <section className="command-agent-request" aria-label="Agent approval">
    <div className="command-request-heading"><Icon name="info" /><strong>{approval ? 'Approval requested' : 'Agent needs your input'}</strong></div>
    {request.autoApprovalError && <p role="alert">Automatic approval failed: {request.autoApprovalError}. Use the approval buttons below to respond manually.</p>}
    {request.params.reason && <p>{request.params.reason}</p>}
    {request.params.message && <p>{request.params.message}</p>}
    {request.params.command && <pre>{request.params.command}</pre>}
    {request.params.networkApprovalContext && <p>Network access: {request.params.networkApprovalContext.host} ({request.params.networkApprovalContext.protocol})</p>}
    {request.params.permissions !== undefined && <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>}
    <div className="command-answer-options">
      {approval && <Button disabled={disabled} onPress={() => { void onAnswer(request.requestId, { decision: 'accept' }) }}>Approve once</Button>}
      {(approval || request.method === 'mcpServer/elicitation/request') &&
        <Button variant="ghost" disabled={disabled} onPress={() => { void onAnswer(request.requestId, { decision: 'decline' }) }}>Deny</Button>}
      {!approval && request.method !== 'mcpServer/elicitation/request' && <p>Use Stop to cancel this request.</p>}
    </div>
  </section>
}

export function Conversation({ agentActions = [], agents, navigate, chat, disabled, onAnswer, launches = [], connected = true, onOpenChat, workflows = [], onInbox, onWorkflowAction, onViewWorkflow, discoveries = [], onViewDiscovery, transfers = [], onTransferAction, projectRuns = [], onProjectRunAction, onLoadOlder, onLoadNewer, onLatest, onReadLatest }: {
  onReadLatest?: (chatId: string, turnId: string) => Promise<unknown>
  agentActions?: ManagementAction[]
  agents?: AgentsModel
  navigate?: (route: string) => void
  chat: ChatSnapshot
  disabled: boolean
  onAnswer: (requestId: string, values: { decision?: string; answers?: Record<string, string>; response?: import('./model').BackendResponse }) => Promise<void>
  launches?: ChatLaunch[]
  connected?: boolean
  onOpenChat?: (chatId: string) => void
  workflows?: ChatWorkflow[]
  onInbox?: (messageId?: number) => void
  onWorkflowAction?: (workflow: ChatWorkflow, action: 'status' | 'cancel' | 'resume') => Promise<unknown>
  onViewWorkflow?: (key: string) => void
  projectRuns?: ProjectRun[]
  onProjectRunAction?: (id: string, action: 'cancel' | 'check', targetId?: string) => Promise<unknown>
  transfers?: Transfer[]
  onTransferAction?: (id: string, action: 'cancel' | 'check') => Promise<unknown>
  discoveries?: Discovery[]
  onViewDiscovery?: (jobId: string) => void
  onLoadOlder?: (before: string) => Promise<unknown>
  onLoadNewer?: (after: string) => Promise<unknown>
  onLatest?: () => void
}) {
  const area = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  // Following is scroll intent; the button reflects the measured position.
  // Expanding activity can pause following without moving the transcript.
  const [atLatest, setAtLatest] = useState(true)
  const historyAfter = useRef(chat.historyAfter)
  historyAfter.current = chat.historyAfter
  const loadingHistory = useRef(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const previousScrollTop = useRef(0)
  const historyScrollPaused = useRef(false)
  const anchor = useRef<{ id?: string; offset: number; top: number; height: number } | null>(null)
  const readingPosition = useRef<typeof anchor.current>(null)
  const working = ['running', 'waiting'].includes(chat.status)
  const cards: ToolCard[] = [
    ...(agents && navigate ? agentActions.map((value): ToolCard => ({ kind: "agentManagement", value })) : []),
    ...projectRuns.map((value): ToolCard => ({ kind: 'projectRun', value })),
    ...transfers.map((value): ToolCard => ({ kind: 'transfer', value })),
    ...(onOpenChat ? launches.filter((launch) => launch.attached !== false).map((value): ToolCard => ({ kind: 'launch', value })) : []),
    ...(onViewDiscovery ? discoveries.map((value): ToolCard => ({ kind: 'discovery', value })) : []),
    ...(onOpenChat && onInbox && onWorkflowAction ? workflows.map((value): ToolCard => ({ kind: 'workflow', value })) : []),
  ]
  cards.sort((a, b) => a.value.createdAt - b.value.createdAt)
  const entries = toolCardEntries(supervisionItems(chat).filter(item => item.type !== 'supervisionEvent'), cards)
  let lastSender = ''
  const senderHeadings = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'message') continue
    const sender = `${entry.item.type}:${entry.item.supervisionUpdate ? 'supervisor' : entry.item.turnId ?? ''}`
    if (sender !== lastSender) senderHeadings.add(entry.item.id)
    lastSender = sender
  }
  const terminal = chat.terminal
  const terminalActive = terminalIsActive(terminal)

  function measureLatest() {
    const element = area.current
    const latest = Boolean(element && !historyAfter.current && element.scrollHeight - element.scrollTop - element.clientHeight < 80)
    setAtLatest(latest)
    return latest
  }
  function scrollToBottom() {
    if (!area.current) return
    area.current.scrollTop = area.current.scrollHeight
    previousScrollTop.current = area.current.scrollTop
  }

  function capturePosition() {
    if (!area.current) return null
    const bounds = area.current.getBoundingClientRect()
    const visible = [...area.current.querySelectorAll<HTMLElement>('[data-transcript-entry]')].find((element) => element.getBoundingClientRect().bottom > bounds.top)
    return { id: visible?.dataset.transcriptEntry, offset: visible?.getBoundingClientRect().top ?? 0, top: area.current.scrollTop, height: area.current.scrollHeight }
  }
  function restorePosition(previous: NonNullable<typeof anchor.current>) {
    if (!area.current) return
    const element = [...area.current.querySelectorAll<HTMLElement>('[data-transcript-entry]')].find((element) => element.dataset.transcriptEntry === previous.id)
    if (element) area.current.scrollTop += element.getBoundingClientRect().top - previous.offset
    else area.current.scrollTop = previous.top + area.current.scrollHeight - previous.height
    previousScrollTop.current = area.current.scrollTop
  }
  function jumpToLatest() {
    anchor.current = null
    readingPosition.current = null
    historyScrollPaused.current = true
    if (chat.historyAfter || chat.indexedHistory) onLatest?.()
    following.current = true
    scrollToBottom()
    measureLatest()
    readingPosition.current = capturePosition()
  }
  useLayoutEffect(() => { if (!chat.indexedHistory) jumpToLatest() }, [chat.id])
  useLayoutEffect(() => {
    const previous = anchor.current ?? (!following.current ? readingPosition.current : null)
    if (previous && area.current) {
      restorePosition(previous)
      anchor.current = null
    } else if (following.current) scrollToBottom()
    if (measureLatest() && !loadingHistory.current) following.current = true
    readingPosition.current = capturePosition()
  }, [chat.items, chat.supervisionUpdates, chat.requests, chat.status, chat.historyAfter])

  useLayoutEffect(() => {
    if (!chat.searchItemId || !area.current) return
    const element = [...area.current.querySelectorAll<HTMLElement>('[data-transcript-entry]')]
      .find(node => node.dataset.transcriptEntry === chat.searchItemId)
    if (!element) return
    following.current = false
    historyScrollPaused.current = true
    element.scrollIntoView({ block: 'center' })
    element.dataset.searchMatch = 'true'
    setAtLatest(false)
    return () => { delete element.dataset.searchMatch }
  }, [chat.searchItemId])

  const readLatest = useRef(onReadLatest)
  readLatest.current = onReadLatest
  const canMarkRead = Boolean(onReadLatest)
  const pendingReads = useRef(new Set<string>())
  const acknowledgedTurn = useRef<string | null>(null)
  useEffect(() => {
    const turnId = chat.latestCompletedTurnId
    if (!turnId || chat.lastReadTurnId === turnId || chat.status !== 'completed' || !canMarkRead) return
    let disposed = false
    const acknowledge = () => {
      if (disposed || !connected || document.visibilityState !== 'visible' || !document.hasFocus()
          || !measureLatest() || chat.historyUnavailable || chat.backendHistoryPending || chat.syncing || pendingReads.current.has(turnId) || acknowledgedTurn.current === turnId) return
      pendingReads.current.add(turnId)
      void readLatest.current!(chat.id, turnId).then(() => {
        acknowledgedTurn.current = turnId
      }).catch(() => {}).finally(() => { pendingReads.current.delete(turnId) })
    }
    acknowledge()
    const retry = setInterval(acknowledge, 3000)
    window.addEventListener('focus', acknowledge)
    document.addEventListener('visibilitychange', acknowledge)
    return () => {
      disposed = true
      clearInterval(retry)
      window.removeEventListener('focus', acknowledge)
      document.removeEventListener('visibilitychange', acknowledge)
    }
  }, [chat.id, chat.latestCompletedTurnId, chat.lastReadTurnId, chat.status, chat.historyUnavailable,
    chat.backendHistoryPending, chat.syncing, chat.historyAfter, atLatest, connected, canMarkRead])

  async function loadHistory(direction: 'before' | 'after') {
    const cursor = direction === 'before' ? chat.historyCursor : chat.historyAfter
    const load = direction === 'before' ? onLoadOlder : onLoadNewer
    if (!cursor || !load || loadingHistory.current || !area.current || !connected) return
    loadingHistory.current = true
    historyScrollPaused.current = true
    setHistoryLoading(true)
    setHistoryError('')
    following.current = false
    measureLatest()
    anchor.current = capturePosition()
    try { await load(cursor) }
    catch (cause) { anchor.current = null; setHistoryError(cause instanceof Error ? cause.message : 'Could not load conversation history.') }
    finally { loadingHistory.current = false; setHistoryLoading(false) }
  }
  useEffect(() => {
    if (!transcript.current) return
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToBottom()
      else if (readingPosition.current) restorePosition(readingPosition.current)
      if (measureLatest() && !loadingHistory.current) following.current = true
      readingPosition.current = capturePosition()
    })
    observer.observe(transcript.current)
    if (area.current) observer.observe(area.current)
    return () => observer.disconnect()
  }, [])

  const status = chat.status === 'waiting' ? 'Waiting for your response.' : chat.status === 'uncertain' && chat.statusReason !== 'notification_error' ? 'Inspect the outcome before continuing.' : chat.status === 'failed' ? chat.error ?? 'The turn failed.' : ''
  return <section className="command-conversation command-live-conversation" data-search-history={chat.indexedHistory || undefined} aria-label="Agent conversation">
    <div ref={area} className="command-transcript-scroll" tabIndex={0} aria-label="Conversation scroll area"
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('summary')) following.current = false
      }}
      onKeyDownCapture={(event) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) historyScrollPaused.current = false
        if (['Enter', ' '].includes(event.key) && event.target instanceof Element && event.target.closest('summary')) following.current = false
      }}
      onScroll={(event) => {
        if (event.target !== event.currentTarget) return
        const area = event.currentTarget
        const movingUp = area.scrollTop < previousScrollTop.current
        const movingDown = area.scrollTop > previousScrollTop.current
        previousScrollTop.current = area.scrollTop
        readingPosition.current = capturePosition()
        if (loadingHistory.current) anchor.current = readingPosition.current
        const latest = measureLatest()
        // Content growth can emit scroll events before ResizeObserver pins the
        // transcript. Only an actual upward move should cancel live following.
        if (latest) following.current = true
        else if (movingUp) following.current = false
        if (!historyScrollPaused.current && movingUp && !following.current && area.scrollTop < 80) void loadHistory('before')
        else if (!historyScrollPaused.current && movingDown && chat.historyAfter && area.scrollHeight - area.scrollTop - area.clientHeight < 80) void loadHistory('after')
      }}
      onPointerDown={() => { historyScrollPaused.current = false }}
      onTouchStart={() => { historyScrollPaused.current = false }}
      onWheel={(event) => {
        // A nested code block can consume the gesture without moving the chat.
        // Only the transcript's scroll event changes follow intent.
        let target = event.target instanceof Element ? event.target : null
        while (target && target !== event.currentTarget) {
          const style = getComputedStyle(target)
          if (/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight
            && (event.deltaY < 0 ? target.scrollTop > 0 : target.scrollTop + target.clientHeight < target.scrollHeight - 1)) return
          target = target.parentElement
        }
        historyScrollPaused.current = false
        if (event.deltaY < 0 && event.currentTarget.scrollTop < 80) void loadHistory('before')
      }}>
      <div ref={transcript} className="command-transcript-body">
        {chat.historyCursor && onLoadOlder && <div className="command-history-pagination"><Button variant="ghost" size="sm" disabled={!connected || historyLoading} onPress={() => { void loadHistory('before') }}>Load older messages</Button></div>}
        {historyLoading && <p className="command-history-truncated command-history-loading" role="status">Loading messages…</p>}
        {historyError && <p className="command-history-truncated" role="alert">{historyError}</p>}
        {chat.syncing && <p className="command-history-truncated" role="status">Reconnecting to your conversation…</p>}
        {(chat.historyUnavailable || chat.historyTruncated && !chat.historyCursor) && <p className="command-history-truncated" role="status">Earlier activity is unavailable from this connection.</p>}
        <div className="command-transcript" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions text">
          {entries.map((entry) => {
            if (entry.kind === 'card') {
              const card = entry.card
              if (card.kind === 'agentManagement') return <AgentManagementCard key={card.value.id} action={card.value} agents={agents!} navigate={navigate!} />
              if (card.kind === 'projectRun') return <ProjectRunCard key={`projectRun:${card.value.id}`} run={card.value} connected={connected} onAction={onProjectRunAction} onOpen={onOpenChat} />
              if (card.kind === 'transfer') return <TransferCard key={`transfer:${card.value.id}`} transfer={card.value} connected={connected} onAction={onTransferAction} />
              if (card.kind === 'discovery') return <DiscoveryCards key={`discovery:${card.value.id}`} jobs={[card.value]} connected={connected} onView={onViewDiscovery!} />
              if (card.kind === 'launch') return <LaunchCards key={`launch:${card.value.id}`} launches={[card.value]} connected={connected} onOpen={onOpenChat!} />
              return <WorkflowCards key={`workflow:${card.value.key}`} workflows={[card.value]} connected={connected} onOpen={onOpenChat!} onInbox={onInbox!} onAction={onWorkflowAction!} onView={onViewWorkflow} />
            }
            if (entry.kind === 'activity') return <div key={entry.items[0].id} data-transcript-entry={entry.items[0].id}><ActivityGroup items={entry.items} active={working && !chat.historyAfter && entry.items.at(-1)?.id === chat.items.at(-1)?.id} /></div>
            const item = entry.item
            const user = item.type === 'userMessage'
            const streaming = !chat.historyAfter && chat.status === 'running' && item.id === chat.items.at(-1)?.id
            return <div key={item.id} data-transcript-entry={item.id}><article className={`command-chat-message command-chat-message--${item.type}`} aria-label={user ? item.source ? `${sourceLabel(item.source)} ${item.source.title}` : 'Your message' : item.supervisionUpdate ? 'Supervision update' : `${chat.profile} message`}>
              {!user && senderHeadings.has(item.id) && <div className="command-assistant-heading"><Mark small /><strong>{item.supervisionUpdate ? 'Supervisor' : chat.profile}</strong></div>}
              {user && <span className="command-message-label">{item.source ? sourceLabel(item.source) : 'You'}</span>}
              <MessageContent text={sourceMessageText(item.text, item.source)} />
              {user && item.source && <small>{sourceLabel(item.source)} {item.source.url ? <a href={item.source.url}>{item.source.title}</a> : item.source.title}</small>}
              {!user && !item.text && streaming && <span className="command-thinking-dots" aria-label="Writing a reply"><span /><span /><span /></span>}
              {!user && item.text && !streaming && <div className="command-message-actions"><CopyButton text={item.text} label="Copy response" /></div>}
            </article></div>
          })}
        </div>
        {connected && !chat.syncing && !chat.historyAfter && chat.status === 'running' && chat.requests.length === 0 &&
          <LoadingIndicator className="command-agent-activity" label="Working…" />}
        {chat.historyAfter && onLoadNewer && <div className="command-history-pagination"><Button variant="ghost" size="sm" disabled={!connected || historyLoading} onPress={() => { void loadHistory('after') }}>Load newer messages</Button></div>}
        {chat.requests.map((request) => <AgentRequest key={request.requestId} request={request} disabled={disabled} onAnswer={onAnswer} />)}
        {terminalActive && <p className="command-terminal-status" role="status">{terminal?.status === 'queued' ? terminal.error || 'Your terminal will open after this turn finishes.' :
          terminal?.status === 'launching' ? 'Starting your terminal…' : terminal?.status === 'releasing' ? 'Stopping the terminal client…' :
          terminal?.error || 'This conversation is also open in a terminal. You can continue here or there.'}</p>}
        {!terminalActive && terminal?.error && <p className="command-terminal-status" role="alert">{terminal.error}</p>}
        {status && <p className="command-chat-status" role="status">{status}</p>}
      </div>
    </div>
    {(!atLatest || chat.historyAfter || chat.indexedHistory) && <Button variant="secondary" size="sm" className="command-jump-latest" onPress={jumpToLatest}><Icon name="arrow-down" />Jump to latest</Button>}
  </section>
}
