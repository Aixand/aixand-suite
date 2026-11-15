import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Card, EmptyState, Icon, Sheet } from 'bbb-design'
import { requestId } from '../terminals/connection'
import type { Workspace } from '../workspace/model'
import type { CarrierModel } from './model'
import type { CarrierMessage, Conversation, OutboxItem } from './client'
import { CarrierNavigation } from './CarrierNavigation'
import { CarrierConnection } from './CarrierConnection'
import type { CarrierSection } from './CarrierNavigation'
import { CarrierMessageList } from './CarrierMessageList'
import { CarrierMessageReader } from './CarrierMessageReader'
import { CarrierComposer } from './CarrierComposer'
import { useCarrierDraft } from './draft'
import { CarrierAgentList, CarrierAgentReader, CarrierOutboxList, CarrierOutboxReader } from './CarrierActivity'
import { PageLoading } from '../components/PageLoading'
import { WorkspaceSidebar } from '../components/WorkspaceSidebar'
import './carrier.css'
import { useDelegatedWork } from './delegated'
import { CarrierDelegatedList, CarrierDelegatedReader } from './CarrierDelegatedWork'

const actionLabels = {
  send: 'Sending message…', acknowledge: 'Acknowledging message…', update: 'Saving message changes…',
  retry: 'Checking the original send…', recover: 'Restoring agent delivery…', stop: 'Requesting agent stop…',
}
type CarrierAction = keyof typeof actionLabels

// Chat also uses this panel when its agent transport is reconnecting.
export function CarrierConnectionPanel({ carrier: c }: { carrier: CarrierModel }) {
  if (c.status === 'connected') return null
  return <Card as="section" title={c.retryRequired ? 'Inbox unavailable' : c.status === 'offline' && !c.error ? 'Inbox disconnected' : c.error ? 'Reconnecting to your inbox' : 'Connecting to your inbox'} headingLevel={2} className="ws-panel">
    {c.status === 'offline' && <form className="carrier-connect" onSubmit={event => { event.preventDefault(); c.connect() }}><Button type="submit">Retry connection</Button></form>}
    <p role="status">{c.retryRequired ? c.error : c.status === 'offline' && !c.error ? 'Retry to reopen your inbox.' : c.error ? 'Reconnecting automatically…' : 'Connecting…'}</p>
  </Card>
}

export function CarrierPage({ workspace: w, navigate }: { workspace: Workspace; navigate: (route: string) => void }) {
  const c = w.carrier
  const [section, setSection] = useState<CarrierSection>('messages')
  const delegated = useDelegatedWork(c, section === 'delegated')
  const [menuOpen, setMenuOpen] = useState(false)
  const [compose, setCompose] = useState(false)
  const { draft, setDraft, storageError } = useCarrierDraft()
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<CarrierAction | null>(null)
  const actionCount = useRef(0)
  const acknowledgmentFocus = useRef<{ id: string; mailbox: string; trigger: Element | null } | null>(null)
  const [notice, setNotice] = useState('')
  const [thread, setThread] = useState<Conversation | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState('')
  const [threadRetry, setThreadRetry] = useState(0)
  const [selectedMessage, setSelectedMessage] = useState<CarrierMessage | null>(null)
  const [messageLookup, setMessageLookup] = useState<{ key: string; error: string } | null>(null)
  const [messageRetry, setMessageRetry] = useState(0)
  const [activeRun, setActiveRun] = useState('')
  const [activeSend, setActiveSend] = useState('')
  const [pageHistory, setPageHistory] = useState<number[]>([])
  const readerRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const composeTriggerRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const drawerFocus = useRef<'menu' | 'content' | null>(null)
  const selectionRef = useRef({ mailbox: c.mailbox, id: w.activeMessage })
  selectionRef.current = { mailbox: c.mailbox, id: w.activeMessage }
  const listedMessage = c.messages.find(item => item.id === w.activeMessage)
  const cachedMessage = selectedMessage?.id === w.activeMessage ? selectedMessage : null
  const message = listedMessage && cachedMessage?.acknowledged_at && !listedMessage.acknowledged_at
    ? { ...listedMessage, acknowledged_at: cachedMessage.acknowledged_at } : listedMessage ?? cachedMessage
  const online = c.status === 'connected' && Boolean(c.service?.connected)
  const activeMailbox = c.mailboxes.find(item => item.id === c.mailbox)
  const canWrite = ['human', 'application'].includes(activeMailbox?.role ?? 'application')
  const pendingSends = c.outbox.filter(item => !['stored', 'acknowledged'].includes(item.status))
  const selectedSend = pendingSends.find(item => item.key === activeSend)
  const selectedRun = c.runs.find(item => item.key === activeRun)
  const linkedRun = c.runs.find(item => item.run_id === message?.metadata?.run_id && item.address === message?.sender)
  const inlineReply = compose && draft?.replyMessage && message?.id === draft.replyMessage.id
  const hasReader = compose || Boolean(section === 'messages' ? w.activeMessage : section === 'outbox' ? selectedSend : section === 'delegated' ? delegated.selected : selectedRun)
  const outsideList = Boolean(w.activeMessage && !c.messages.some(item => item.id === w.activeMessage))
  const lookupKey = `${c.mailbox}:${w.activeMessage}:${c.service?.instance ?? ''}`
  const lookupError = messageLookup?.key === lookupKey ? messageLookup.error : ''

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (section === 'delegated' && delegated.detail) focusReader()
  }, [section, delegated.detail?.taskId])

  useEffect(() => {
    if (compose && c.status === 'connected') void c.directory().catch((error: Error) => c.setError(error.message))
  }, [compose, c.mailbox, c.status])

  useEffect(() => {
    if (menuOpen || !compose) return
    let frame: number
    function focusComposer() {
      // Hand focus to the draft after the drawer's exiting focus scope unmounts.
      if (drawerRef.current) frame = requestAnimationFrame(focusComposer)
      else frame = requestAnimationFrame(() => readerRef.current?.querySelector<HTMLTextAreaElement>('.carrier-composer textarea')?.focus())
    }
    frame = requestAnimationFrame(focusComposer)
    return () => cancelAnimationFrame(frame)
  }, [menuOpen, compose])

  useEffect(() => {
    if (menuOpen || !drawerFocus.current) return
    let frame: number
    function restoreDrawerFocus() {
      if (drawerRef.current) { frame = requestAnimationFrame(restoreDrawerFocus); return }
      frame = requestAnimationFrame(() => {
        const menu = menuTriggerRef.current
        const content = window.matchMedia('(max-width: 760px)').matches && hasReader
          ? readerRef.current?.querySelector<HTMLElement>('h2')
          : listRef.current?.querySelector<HTMLElement>('[data-carrier-list-title]')
        const target = drawerFocus.current === 'menu' && menu?.getClientRects().length ? menu : content
        target?.focus()
        drawerFocus.current = null
      })
    }
    frame = requestAnimationFrame(restoreDrawerFocus)
    return () => cancelAnimationFrame(frame)
  }, [menuOpen, section, hasReader])

  // A delivered report may be archived or older than the current inbox page.
  // Fetch its exact identity without changing its read or acknowledgment state.
  useEffect(() => {
    if (section !== 'messages' || !outsideList || c.status !== 'connected' || !c.service?.instance) return
    let alive = true
    const id = w.activeMessage
    const mailbox = c.mailbox
    const opening = !message
    setMessageLookup({ key: lookupKey, error: '' })
    void c.request<CarrierMessage>('message_get', { mailbox, id: Number(id), instance: c.service.instance })
      .then(value => {
        if (!alive) return
        if (!value || String(value.id) !== id || typeof value.body !== 'string') throw new Error('This message could not be loaded. Try again or choose another message.')
        setSelectedMessage(value)
        if (opening) focusReader()
      })
      .catch((error: Error) => { if (alive) setMessageLookup({ key: lookupKey, error: error.message }) })
    return () => { alive = false }
  }, [section, outsideList, w.activeMessage, c.mailbox, c.service?.instance, c.service?.version, c.status, messageRetry])

  useLayoutEffect(() => {
    const pending = acknowledgmentFocus.current
    if (!pending || busy) return
    acknowledgmentFocus.current = null
    if (pending.id !== w.activeMessage || pending.mailbox !== c.mailbox) return
    if (document.activeElement === document.body || document.activeElement === pending.trigger)
      readerRef.current?.querySelector<HTMLButtonElement>(message?.acknowledged_at ? '.carrier-reply-button' : '[data-carrier-acknowledge]')?.focus()
  }, [busy, w.activeMessage, c.mailbox, message?.acknowledged_at])

  useEffect(() => {
    let alive = true
    if (!w.activeMessage || c.status !== 'connected' || section !== 'messages') return
    setThreadLoading(true)
    setThreadError('')
    void c.request<Conversation>('conversation', { mailbox: c.mailbox, id: Number(w.activeMessage), limit: 50 })
      .then(value => { if (alive) setThread(value) })
      .catch(() => { if (alive) setThreadError('Conversation history could not be loaded. The selected message is still available.') })
      .finally(() => { if (alive) setThreadLoading(false) })
    return () => { alive = false }
  }, [w.activeMessage, c.mailbox, c.service?.version, c.status, section, messageRetry, threadRetry])

  function focusReader() {
    requestAnimationFrame(() => {
      readerRef.current?.querySelector('.carrier-reader-scroll')?.scrollTo(0, 0)
      if (window.matchMedia('(max-width: 760px)').matches) readerRef.current?.querySelector<HTMLElement>('h2')?.focus()
    })
  }

  async function action(work: () => Promise<unknown>, success = '', pending: CarrierAction | null = null) {
    actionCount.current++
    setBusy(true)
    if (pending) setPendingAction(pending)
    c.setError('')
    if (pending) setNotice('')
    try { await work(); await c.refresh(); if (success) setNotice(success) }
    catch (error) { c.setError(error instanceof Error ? error.message : 'Operation failed') }
    finally { if (--actionCount.current === 0) setBusy(false); if (pending) setPendingAction(null) }
  }

  function changeView(view: string) {
    if (menuOpen) drawerFocus.current = 'content'
    setSection('messages')
    c.setView(view)
    setPageHistory([])
    w.setActiveMessage('')
    setSelectedMessage(null)
    setThread(null)
    setCompose(false)
    setMenuOpen(false)
  }

  function changeMailbox(mailbox: string) {
    c.setMailbox(mailbox)
    setActiveSend('')
    changeView('Inbox')
  }

  function changeSection(value: CarrierSection) {
    if (menuOpen) drawerFocus.current = 'content'
    setSection(value)
    setCompose(false)
    setMenuOpen(false)
    w.setActiveMessage('')
    setActiveRun('')
    setActiveSend('')
  }

  function select(item: CarrierMessage) {
    w.setActiveMessage(item.id)
    setSelectedMessage(item.direction === 'incoming' && canWrite ? { ...item, read: true } : item)
    setThread(null)
    setCompose(false)
    focusReader()
    if (item.direction === 'incoming' && !item.read && c.status === 'connected' && canWrite)
      void action(() => c.setMessageState(item.id, { read: true }))
  }

  function selectRun(key: string) {
    if (menuOpen) drawerFocus.current = 'content'
    setSection('agents'); setActiveRun(key); setCompose(false); setMenuOpen(false); focusReader()
  }

  function openComposer(incoming?: CarrierMessage) {
    drawerFocus.current = null
    if (draft && (draft.body.trim() || draft.attempted)) {
      if (draft.replyMessage?.id !== incoming?.id) setNotice('Your draft is ready to resume. Send or discard it before starting another message.')
      if (draft.mailbox !== c.mailbox) {
        w.setActiveMessage(''); setSelectedMessage(null); setThread(null); setPageHistory([])
      }
      c.setMailbox(draft.mailbox)
      if (draft.replyMessage) { w.setActiveMessage(draft.replyMessage.id); setSelectedMessage(draft.replyMessage) }
    } else {
      setDraft({ mailbox: c.mailbox, recipient: incoming?.sender ?? '', body: '', replyMessage: incoming, key: requestId(), attempted: false })
      if (incoming) { w.setActiveMessage(incoming.id); setSelectedMessage(incoming) }
    }
    setSection('messages'); setCompose(true); setMenuOpen(false); c.setError('')
  }

  function closeComposer(discard = false) {
    setCompose(false)
    if (discard) setDraft(null)
    requestAnimationFrame(() => {
      const replyButton = readerRef.current?.querySelector<HTMLButtonElement>('.carrier-reply-button')
      if (replyButton?.getClientRects().length) replyButton.focus()
      else if (composeTriggerRef.current?.getClientRects().length) composeTriggerRef.current.focus()
      else document.querySelector<HTMLButtonElement>('.carrier-compose-button')?.focus()
    })
  }

  function sendDraft() {
    if (!draft || !online || busy || !draft.recipient.trim() || !draft.body.trim()) return
    const sending = { ...draft, attempted: true }
    setDraft(sending)
    void action(async () => {
      await c.request('send', { mailbox: sending.mailbox, key: sending.key, to: sending.recipient.trim(), content: sending.body,
        ...(sending.replyMessage ? { reply_to: Number(sending.replyMessage.id) } : {}) })
      closeComposer(true)
    }, 'Message sent.', 'send')
  }

  function changeMessageState(patch: { read?: boolean; archived?: boolean }) {
    if (!message) return
    const current = message
    void action(async () => {
      await c.setMessageState(current.id, patch)
      if (patch.archived !== undefined || patch.read === false && c.view === 'Unread') {
        const next = c.messages.find(item => item.id !== current.id)
        w.setActiveMessage(next?.id ?? '')
        setSelectedMessage(next ?? null)
        setThread(null)
        if (next?.direction === 'incoming' && !next.read) await c.setMessageState(next.id, { read: true })
      } else setSelectedMessage({ ...current, ...patch })
    }, patch.archived !== undefined ? patch.archived ? 'Archived.' : 'Moved to inbox.' : patch.read ? 'Marked as read.' : 'Marked as unread.', 'update')
  }

  async function retry(item: OutboxItem) {
    await action(() => c.request('send', { mailbox: c.mailbox, key: item.key, to: item.recipient, content: item.content,
      ...(item.reply_to ? { reply_to: item.reply_to } : {}) }), 'Send confirmed.', 'retry')
  }

  function backToList() {
    const previousId = w.activeMessage
    setCompose(false); w.setActiveMessage(''); setActiveSend(''); setActiveRun('')
    delegated.select('')
    requestAnimationFrame(() => {
      const row = previousId ? listRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(previousId)}"]`) : null
      ;(row ?? listRef.current?.querySelector<HTMLElement>('[data-carrier-list-title]'))?.focus()
    })
  }

  const navigation = <CarrierNavigation carrier={c} section={section} activeRun={activeRun} pendingCount={pendingSends.length}
    canCompose={canWrite} hasDraft={Boolean(draft)} onCompose={() => openComposer()} onMailbox={changeMailbox} onView={changeView} onSection={changeSection} onRun={selectRun} />
  const navigationTools = <>
    <Sheet title="Mailboxes and folders" side="start" open={menuOpen} onOpenChange={open => {
      if (open) drawerFocus.current = 'menu'
      setMenuOpen(open)
    }}
      bodyClassName="workspace-sidebar-sheet-body" footer={<CarrierConnection carrier={c} />}
      trigger={<Button ref={menuTriggerRef} className="carrier-menu-trigger" variant="ghost" size="sm" iconOnly aria-label="Open mailboxes and folders"><Icon name="menu" /></Button>}>
      <div ref={drawerRef} className="workspace-sidebar__content">{navigation}</div>
    </Sheet>
    <Button ref={composeTriggerRef} className="carrier-mobile-compose" variant="secondary" size="sm" iconOnly
      aria-label={draft ? 'Resume draft' : 'Compose'} disabled={!canWrite && !draft} onPress={() => openComposer()}>
      <Icon name={draft ? 'file-text' : 'plus'} />
    </Button>
  </>
  const composer = compose && draft ? <CarrierComposer carrier={c} draft={draft} busy={busy} online={online}
    onChange={setDraft} onSend={sendDraft} onClose={() => closeComposer()} onDiscard={() => closeComposer(true)}
    onEdit={() => { setDraft({ ...draft, attempted: false, key: requestId() }); c.setError('') }} /> : undefined

  return <div className="carrier-page" data-reader-open={hasReader || undefined}>
    <div className="carrier-workspace">
      <WorkspaceSidebar className="carrier-sidebar" aria-label="Mailbox navigation" footer={<CarrierConnection carrier={c} />}>
        {navigation}
      </WorkspaceSidebar>
      <div className="carrier-announcements">
        {storageError && <p role="alert" className="carrier-error">{storageError}</p>}
        {lookupError && message && <div className="carrier-offline-banner"><span role="status">This message could not be refreshed. Showing its last known copy.</span><Button variant="ghost" size="sm" onPress={() => setMessageRetry(value => value + 1)}>Retry message</Button></div>}
        {!compose && (c.error || c.service?.error) && <p role="alert" className="carrier-error">{c.error || c.service?.error}</p>}
        {c.status !== 'connected' && <div className="carrier-offline-banner"><span role="status">{c.status === 'connecting' ? 'Connecting to your inbox…' : 'Inbox disconnected. Cached messages are still available.'}</span>
          {c.status === 'offline' && <Button variant="ghost" size="sm" onPress={c.connect}>Retry connection</Button>}</div>}
        {c.status === 'connected' && c.service && !c.service.connected && <p className="carrier-offline-banner" role="status">Carrier is unavailable. You can still read cached messages.</p>}
      </div>
      <section ref={listRef} className="carrier-list-pane" aria-label={section === 'messages' ? 'Messages' : section === 'outbox' ? 'Outbox' : section === 'delegated' ? 'Delegated work' : 'Agent conversations'}>
        {section === 'messages' ? <CarrierMessageList carrier={c} activeId={w.activeMessage} navigation={navigationTools} onSelect={select} onView={changeView}
          onSearch={value => { c.setSearch(value); setPageHistory([]); setCompose(false); w.setActiveMessage('') }}
          onRefresh={() => { void c.refresh(); void c.directory().catch((error: Error) => c.setError(error.message)) }}
          onPrevious={() => { c.setOffset(pageHistory.at(-1) ?? 0); setPageHistory(pageHistory.slice(0, -1)); w.setActiveMessage('') }}
          onNext={() => { if (c.nextOffset !== null) { setPageHistory([...pageHistory, c.offset]); c.setOffset(c.nextOffset) }; w.setActiveMessage('') }} />
          : section === 'outbox' ? <CarrierOutboxList items={pendingSends} activeId={activeSend} navigation={navigationTools} onSelect={key => { setActiveSend(key); focusReader() }} />
            : section === 'delegated' ? <CarrierDelegatedList model={delegated} navigation={navigationTools} onSelect={id => { delegated.select(id); focusReader() }} />
              : <CarrierAgentList runs={c.runs} activeId={activeRun} navigation={navigationTools} onSelect={selectRun} />}
        {section === 'messages' && c.view === 'Sent' && c.status === 'connected' && c.service && !c.service.outgoing_history && <p className="carrier-history-note">Sent history currently includes messages sent through this workspace.</p>}
      </section>
      <article ref={readerRef} className="carrier-reader" aria-label={section === 'delegated' ? 'Delegated work details' : 'Message reader'}>
        <div className="carrier-mobile-back"><Button variant="ghost" size="sm" onPress={backToList}><Icon name="chevron-left" />Back to {section === 'outbox' ? 'Outbox' : section === 'agents' ? 'conversations' : section === 'delegated' ? 'delegated work' : 'messages'}</Button></div>
        {composer && !inlineReply ? <div className="carrier-reader-scroll">{composer}</div>
          : section === 'messages' && message ? <CarrierMessageReader message={message} thread={thread} threadLoading={threadLoading} threadError={threadError} onRetryThread={() => setThreadRetry(value => value + 1)} linkedRun={linkedRun}
            canWrite={canWrite} online={online} connected={c.status === 'connected'} busy={busy} acknowledging={pendingAction === 'acknowledge'} reply={inlineReply ? composer : undefined}
            onReply={openComposer} onState={changeMessageState} navigate={navigate}
            onAcknowledge={() => {
              const selected = { id: message.id, mailbox: c.mailbox }
              acknowledgmentFocus.current = { ...selected, trigger: document.activeElement }
              void action(async () => {
                const result = await c.request<{ acknowledged_at: string }>('acknowledge', { mailbox: selected.mailbox, id: Number(selected.id) })
                if (selectionRef.current.id === selected.id && selectionRef.current.mailbox === selected.mailbox && result.acknowledged_at)
                  setSelectedMessage({ ...message, acknowledged_at: result.acknowledged_at })
              }, 'Acknowledged. Message history has been retained.', 'acknowledge')
            }}
            onLoadMore={() => {
              if (!thread || threadLoading) return
              const selected = { ...selectionRef.current }
              setThreadLoading(true)
              setThreadError('')
              void c.request<Conversation>('conversation', { mailbox: c.mailbox, id: Number(message.id), offset: thread.messages.length, limit: 50 })
                .then(next => {
                  if (selectionRef.current.id === selected.id && selectionRef.current.mailbox === selected.mailbox)
                    setThread({ ...next, messages: [...thread.messages, ...next.messages] })
                })
                .catch(() => {
                  if (selectionRef.current.id === selected.id && selectionRef.current.mailbox === selected.mailbox) setThreadError('More conversation history could not be loaded. Your current messages are still available.')
                }).finally(() => {
                  if (selectionRef.current.id === selected.id && selectionRef.current.mailbox === selected.mailbox) setThreadLoading(false)
                })
            }} />
            : section === 'messages' && w.activeMessage ? <div className="carrier-reader-empty">
              <h1 className="bbb-visually-hidden">Message</h1>
              {lookupError || c.status === 'offline' ? <EmptyState headingLevel={2} icon="mail" title={c.status === 'offline' ? 'Reconnect to open this message' : 'Message unavailable'}
                description={lookupError || 'Your inbox and drafts are still available. Reconnect to load this message.'}
                action={<Button variant="secondary" onPress={() => { if (c.status === 'offline') c.connect(); else setMessageRetry(value => value + 1) }}>Try again</Button>} />
                : <PageLoading label="Opening your message…" size="panel" />}
            </div>
            : section === 'delegated' ? <CarrierDelegatedReader model={delegated} />
              : section === 'outbox' && selectedSend ? <CarrierOutboxReader item={selectedSend} online={online} busy={busy} onRetry={() => { void retry(selectedSend) }} />
              : section === 'agents' && selectedRun ? <CarrierAgentReader run={selectedRun} online={online} busy={busy} navigate={navigate}
                onRecover={() => { void action(() => c.request('recover', { key: selectedRun.key }), 'Delivery restored.', 'recover') }}
                onStop={() => { void action(() => c.request('stop_agent', { key: selectedRun.key }), 'Agent stopped.', 'stop') }} />
                : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon={section === 'agents' ? 'user-round' : section === 'outbox' ? 'arrow-right' : 'mail'} title={section === 'agents' ? 'Select an agent conversation' : section === 'outbox' ? 'Select a send to review' : 'Your inbox, with room to focus'}
                  description={section === 'messages' ? 'Select a message to read and reply to its conversation.' : section === 'outbox' ? 'Review delivery details and retry messages from your outbox.' : 'View the conversation’s status and open its terminal.'} /></div>}
      </article>
    </div>
    <p role="status" className="carrier-notice">{pendingAction ? actionLabels[pendingAction] : notice}</p>
  </div>
}
