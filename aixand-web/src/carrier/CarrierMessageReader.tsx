import { Avatar, Badge, Button, DropdownMenu, Icon, Toolbar, useThemeAttributes } from 'bbb-design'
import { MessageContent } from '../chats/MessageContent'
import type { CarrierMessage, CarrierRun, Conversation } from './client'
import type { ReactNode } from 'react'

export function CarrierMessageReader({ message, thread, threadLoading, threadError, onRetryThread, linkedRun, canWrite, online, connected, busy, acknowledging = false, reply, onReply, onState, onAcknowledge, onLoadMore, navigate }: {
  message: CarrierMessage
  thread: Conversation | null
  threadLoading: boolean
  threadError?: string
  onRetryThread?: () => void
  linkedRun?: CarrierRun
  canWrite: boolean
  online: boolean
  connected: boolean
  busy: boolean
  acknowledging?: boolean
  reply?: ReactNode
  onReply: (message: CarrierMessage) => void
  onState: (patch: { read?: boolean; archived?: boolean }) => void
  onAcknowledge: () => void
  onLoadMore: () => void
  navigate: (route: string) => void
}) {
  const incoming = message.direction === 'incoming'
  const soft = useThemeAttributes()['data-bbb-mode'] === 'dark'
  const needsAcknowledgment = incoming && canWrite && !message.acknowledged_at
  const earlier = thread?.messages.filter(item => item.id !== message.id) ?? []
  const kind = message.metadata?.kind?.split('.').at(-1)?.replace(/_/g, ' ')
  return <>
    <Toolbar label="Message actions" className="carrier-reader-toolbar">
      {soft && incoming && canWrite && <>
        {needsAcknowledgment && <Button size="sm" data-carrier-acknowledge disabled={!online || busy} loading={acknowledging} onPress={onAcknowledge}><Icon name="check" />Acknowledge</Button>}
        <Button variant={needsAcknowledgment ? 'ghost' : 'primary'} size="sm" className="carrier-reply-button"
          disabled={!online || busy} onPress={() => onReply(message)}><Icon name="mail" />Reply</Button>
      </>}
      {!soft && incoming && canWrite && <>
        <Button variant="ghost" size="sm" disabled={!connected || busy} onPress={() => onState({ archived: !message.archived })}>
          <Icon name="box" />{message.archived ? 'Move to inbox' : 'Archive'}</Button>
        <Button variant="ghost" size="sm" disabled={!connected || busy} onPress={() => onState({ read: !message.read })}>
          <Icon name="mail" />{message.read ? 'Mark unread' : 'Mark read'}</Button>
      </>}
      <DropdownMenu label="More message actions" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="More message actions"><Icon name="ellipsis" /></Button>}
        items={[
          ...(soft && incoming && canWrite ? [
            { id: 'archive', label: message.archived ? 'Move to inbox' : 'Archive', disabled: !connected || busy },
            { id: 'read', label: message.read ? 'Mark unread' : 'Mark read', disabled: !connected || busy },
          ] : []),
          ...(linkedRun?.session_id ? [{ id: 'terminal', label: 'Open agent terminal' }] : []),
          ...(!soft ? (message.metadata?.links ?? []).map(link => ({ id: link.route, label: link.label })) : []),
          ...(!soft || !incoming || !canWrite ? [{ id: 'reply', label: 'Reply', disabled: !incoming || !canWrite || !online || busy }] : []),
        ]}
        onAction={id => { if (id === 'reply') onReply(message); else if (id === 'archive') onState({ archived: !message.archived }); else if (id === 'read') onState({ read: !message.read }); else if (id === 'terminal' && linkedRun?.session_id) navigate(`terminals/${encodeURIComponent(linkedRun.session_id)}`); else navigate(id) }} />
    </Toolbar>
    <div className="carrier-reader-scroll">
      <div className="carrier-subject"><h2 aria-level={1} tabIndex={-1}>{message.title}</h2>{kind && <Badge>{kind}</Badge>}</div>
      <section className="carrier-conversation" aria-label="Conversation" aria-busy={threadLoading}>
        {threadLoading && !thread && <p role="status" className="carrier-muted">Loading conversation…</p>}
        {threadError && <div className="carrier-offline-banner"><span role="status">{threadError}</span>{onRetryThread && <Button variant="ghost" size="sm" disabled={threadLoading || !connected} onPress={onRetryThread}>Retry conversation</Button>}</div>}
        {thread?.partial && <p className="carrier-muted">Some earlier messages are unavailable in this mailbox.</p>}
        {earlier.length > 0 && <details className="carrier-history">
          <summary>Other messages in this conversation <span>{earlier.length}</span><Icon name="chevron-down" /></summary>
          {earlier.map(item => <div className="carrier-history-message" key={item.id}>
            <div className="carrier-history-heading"><strong>{item.sender}</strong><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time></div>
            <MessageContent text={item.body} />
            {item.direction === 'incoming' && canWrite && <Button variant="ghost" size="sm" disabled={!online || busy} onPress={() => onReply(item)}>Reply to this message</Button>}
          </div>)}
        </details>}
        {thread && thread.messages.length < thread.total && <Button variant="ghost" size="sm" disabled={threadLoading} onPress={onLoadMore}>Load more messages</Button>}
        <div className="carrier-message-envelope">
          <Avatar name={incoming ? message.source : 'You'} size="sm" decorative />
          <div><strong>{incoming ? message.source : 'You'}</strong><span>To: {message.recipient}</span></div>
          <time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
        </div>
        <details className="carrier-address-details"><summary>Message details</summary><dl>
          <dt>From</dt><dd>{message.sender}</dd><dt>To</dt><dd>{message.recipient}</dd>
          <dt>Date</dt><dd>{new Date(message.created_at).toLocaleString()}</dd>
          <dt>Acknowledgment</dt><dd>{message.acknowledged_at ? 'Acknowledged' : 'Awaiting acknowledgment'}</dd>
        </dl></details>
        <div className="carrier-message-body"><MessageContent text={message.body} /></div>
        {message.metadata?.links?.length ? <div className="carrier-context-links">{message.metadata.links.map(link => <Button key={link.route} variant="secondary" size="sm" onPress={() => navigate(link.route)}>{link.label}<Icon name="arrow-right" /></Button>)}</div> : null}
        {!soft && linkedRun?.session_id && <Button variant="ghost" size="sm" onPress={() => navigate(`terminals/${encodeURIComponent(linkedRun.session_id!)}`)}><Icon name="external-link" />Open agent terminal</Button>}
        {incoming && canWrite && !message.acknowledged_at && <div className="carrier-acknowledgment">
          <div><strong>Awaiting your acknowledgment</strong><span>Confirm acceptance of this message.</span></div>
          {!soft && <Button variant="secondary" size="sm" data-carrier-acknowledge disabled={!online || busy} loading={acknowledging} onPress={onAcknowledge}><Icon name="check" />Acknowledge</Button>}
        </div>}
        {message.acknowledged_at && <p className="carrier-acknowledged"><Icon name="check" />Acknowledged</p>}
      </section>
      {reply ?? (!soft && incoming && canWrite && <Button variant="secondary" className="carrier-reply-button" disabled={!online || busy} onPress={() => onReply(message)}><Icon name="mail" />Reply</Button>)}
    </div>
  </>
}
