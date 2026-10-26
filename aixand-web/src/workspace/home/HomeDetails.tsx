import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { Button, Icon, Link, LoadingIndicator, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { Workspace } from '../model'
import type { HomeWork } from './work'
import type { useTerminalOverview } from './useTerminalOverview'
import type { CarrierMessage } from '../../carrier/client'
import { AgentRequest } from '../../chats/Conversation'
import { MessageContent } from '../../chats/MessageContent'
import { requestId } from '../../terminals/connection'
import { rememberWork } from './history'

export function HomeSheet({ title, description, onClose, children, footer, centered = false, closeLabel = 'Close details' }: {
  title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; centered?: boolean; closeLabel?: string
}) {
  const theme = useThemeAttributes()
  return <ModalOverlay {...theme} className={`bbb-theme bbb-modal-overlay home-sheet-overlay${centered ? ' home-search-overlay' : ''}`} isOpen isDismissable onOpenChange={open => { if (!open) onClose() }}>
    <Modal className={`bbb-modal home-sheet${centered ? ' home-search-dialog' : ''}`}><Dialog className="home-sheet-dialog">
      <header className="home-sheet-header"><div><Heading slot="title">{title}</Heading>{description && <p>{description}</p>}</div>
        <Button variant="ghost" size="sm" iconOnly aria-label={closeLabel} onPress={onClose}><Icon name="x" /></Button>
      </header>
      <div className="home-sheet-body">{children}</div>
      {footer && <footer className="home-sheet-footer">{footer}</footer>}
    </Dialog></Modal>
  </ModalOverlay>
}

export function HomeDetails({ row, workspace: w, terminals, messages, onClose, onAcknowledged, openInbox }: {
  row: HomeWork; workspace: Workspace; terminals: ReturnType<typeof useTerminalOverview>; messages: CarrierMessage[]
  onClose: () => void; onAcknowledged: () => void; openInbox: (id?: string) => void
}) {
  const chatId = row.route.match(/^chat\/([^/]+)$/)?.[1]
  const terminalId = row.route.match(/^terminals\/([^/]+)$/)?.[1]
  const snapshot = chatId ? w.chats.snapshots[decodeURIComponent(chatId)] : undefined
  const [loading, setLoading] = useState(Boolean(chatId || terminalId))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [revision, refresh] = useState(0)
  const [notice, setNotice] = useState('')
  const [reply, setReply] = useState('')
  const [events, setEvents] = useState<Awaited<ReturnType<typeof terminals.inspect>>['items']>([])
  const [message, setMessage] = useState(() => messages.find(message => message.id === row.messageId))
  const attempt = useRef<{ key: string; op: string; args: Record<string, unknown> } | null>(null)
  const api = useRef({ w, terminals }); api.current = { w, terminals }
  const online = terminalId ? terminals.status === 'connected' : row.kind === 'message' ? w.carrier.status === 'connected' && w.carrier.service?.connected : w.agents.status === 'connected'

  useEffect(() => {
    if (!chatId) return
    api.current.w.chats.activate(decodeURIComponent(chatId))
    return () => api.current.w.chats.activate(null)
  }, [chatId])

  useEffect(() => {
    let alive = true
    rememberWork(row.key)
    async function load() {
      setLoading(true); setError('')
      try {
        if (chatId) await api.current.w.chats.open(decodeURIComponent(chatId))
        else if (terminalId) {
          const result = await api.current.terminals.inspect(decodeURIComponent(terminalId))
          if (alive) setEvents(Array.isArray(result.items) ? result.items.slice(-30) : [])
        }
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : 'Could not load this item.') }
      finally { if (alive) setLoading(false) }
    }
    if (online && (chatId || terminalId)) void load()
    else setLoading(false)
    return () => { alive = false }
  }, [row.key, chatId, terminalId, online, revision])

  async function act(op: string, args: Record<string, unknown>) {
    if (inFlight.current || !online) return
    const pending = attempt.current
    if (pending && (pending.op !== op || JSON.stringify(pending.args) !== JSON.stringify(args))) {
      setError('Retry the pending response before sending a different one.'); return
    }
    inFlight.current = true; setBusy(true); setError(''); setNotice('')
    const current = pending ?? { key: requestId(), op, args }; attempt.current = current
    try {
      if (op === 'acknowledge') {
        const result = await w.carrier.request<{ acknowledged_at: string }>(op, { mailbox: 'user', id: Number(row.messageId) })
        if (!result.acknowledged_at) throw new Error('Acknowledgment could not be confirmed. Check the inbox before trying again.')
        setMessage(previous => previous ? { ...previous, acknowledged_at: result.acknowledged_at } : previous)
        onAcknowledged()
      } else {
        const values = { key: current.key, chatId: decodeURIComponent(chatId!), ...current.args }
        if (op === 'chat-answer') await w.chats.answer(values)
        else if (op === 'chat-queue') await w.chats.queue(values)
        else await w.chats.send(values)
      }
      attempt.current = null
      setReply(''); setNotice(op === 'acknowledge' ? 'Message acknowledged.' : op === 'chat-answer' ? 'Response sent.' : op === 'chat-queue' ? 'Message queued.' : 'Message sent.')
      if (chatId) refresh(value => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The response could not be confirmed. Retry keeps the same operation.') }
    finally { inFlight.current = false; setBusy(false) }
  }
  const answer: ComponentProps<typeof AgentRequest>['onAnswer'] = async (requestId, values) => { await act('chat-answer', { requestId, ...values }) }
  const workflow = w.chats.workflowRuns.find(run => row.key === `workflow:${run.key}`)
  const terminal = terminals.sessions.find(session => session.id === decodeURIComponent(terminalId ?? ''))
  const canRespond = online && !loading && !error && !snapshot?.syncing && !w.chats.deletedIds.has(decodeURIComponent(chatId ?? ''))
  const canReply = snapshot && !snapshot.requests.length && !['offline', 'uncertain'].includes(snapshot.status) &&
    (!['running', 'waiting'].includes(snapshot.status) || snapshot.backendRoute !== 'managed' || snapshot.chatCapabilities?.queue)

  return <HomeSheet title={row.title} description={row.context} onClose={onClose} footer={<>
    <span className="home-sheet-state">{notice || (snapshot?.status ?? workflow?.state ?? terminal?.lifecycle.state ?? row.reason)}</span>
    <Link className="home-full-view" href={`#/${row.route}`} onClick={event => {
      if (row.messageId && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openInbox(row.messageId) }
    }}>Open full view<Icon name="arrow-right" /></Link>
  </>}>
    {!online && <p className="home-panel-notice" role="status">Reconnect to view the latest status and respond.</p>}
    {loading && <LoadingIndicator label="Loading details…" />}
    {error && <div role="alert" className="home-panel-error"><p>{error}</p>
      {attempt.current ? <Button variant="secondary" disabled={busy || !online} onPress={() => { const value = attempt.current!; void act(value.op, value.args) }}>Retry response</Button>
        : <Button variant="secondary" disabled={!online} onPress={() => refresh(value => value + 1)}>Retry details</Button>}
    </div>}
    {notice && <p role="status" className="home-panel-success"><Icon name="check" />{notice}</p>}
    {snapshot && <>
      {snapshot.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type)).slice(-4).map(item => <article key={item.id} className="home-chat-preview">
        <strong>{item.type === 'userMessage' ? 'You' : 'Agent'}</strong><MessageContent text={item.text ?? ''} />
      </article>)}
      {snapshot.requests.map(request => <AgentRequest key={request.requestId} request={request} disabled={!canRespond || busy || Boolean(attempt.current)} onAnswer={answer} />)}
      {canReply && <form className="home-reply" onSubmit={event => { event.preventDefault(); if (reply.trim()) void act(['running', 'waiting'].includes(snapshot.status) ? 'chat-queue' : 'chat-send', { text: reply.trim() }) }}>
        <label htmlFor="home-follow-up">{['running', 'waiting'].includes(snapshot.status) ? 'Add a follow-up' : 'Continue the conversation'}</label>
        <textarea id="home-follow-up" rows={3} value={reply} onChange={event => setReply(event.target.value)} placeholder="Give the agent a direction…" disabled={busy || Boolean(attempt.current)} />
        <Button type="submit" disabled={!canRespond || busy || Boolean(attempt.current) || !reply.trim()}>{['running', 'waiting'].includes(snapshot.status) ? 'Queue message' : 'Send message'}<Icon name="arrow-right" /></Button>
      </form>}
    </>}
    {message && <article className="home-message-preview"><span className="home-eyebrow">FROM {message.source}</span><MessageContent text={message.body || message.content} />
      {!message.acknowledged_at && <Button disabled={!online || busy} loading={busy} onPress={() => { void act('acknowledge', {}) }}><Icon name="check" />Acknowledge</Button>}
    </article>}
    {workflow && !chatId && <div className="home-workflow-progress"><p>{row.reason}</p><ol>
      {workflow.steps.map(step => <li key={step.id}><span>{step.title}</span><span>{step.executionState ?? step.state}</span>
        {step.chat_id && !step.conversationDeleted && !w.chats.deletedIds.has(step.chat_id) && <Link href={`#/chat/${step.chat_id}`}>Open chat<Icon name="arrow-right" /></Link>}
      </li>)}
    </ol></div>}
    {terminalId && <div className="home-terminal-preview"><p>{row.reason}</p>
      {row.priority === 0 && <p>Open the terminal to enter your response.</p>}
      <h3>Recent activity</h3>{events.length ? <ol>{events.map(event => <li key={event.sequence}><strong>{event.kind.replace(/[._]/g, ' ')}</strong>
        <time dateTime={new Date(event.occurred_at_millis).toISOString()}>{new Date(event.occurred_at_millis).toLocaleTimeString()}</time>
      </li>)}</ol> : !loading && <p>No recent activity is available. Open the terminal to view its output.</p>}
    </div>}
  </HomeSheet>
}
