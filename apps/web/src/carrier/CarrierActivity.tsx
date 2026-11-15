import { Avatar, Badge, Button, EmptyState, Icon } from 'bbb-design'
import { MessageContent } from '../chats/MessageContent'
import type { CarrierRun, OutboxItem } from './client'
import { messageTime } from './CarrierMessageList'
import { CarrierListHeader } from './CarrierListHeader'
import type { ReactNode } from 'react'

export function outboxStatus(item: OutboxItem) {
  return ['unknown', 'submitting'].includes(item.status) ? 'Confirmation pending' : item.status === 'failed' ? 'Send failed' : item.status
}

export function CarrierOutboxList({ items, activeId, navigation, onSelect }: { items: OutboxItem[]; activeId: string; navigation?: ReactNode; onSelect: (key: string) => void }) {
  return <><CarrierListHeader title="Outbox" description="Sends needing attention" navigation={navigation} />
    <div className="carrier-message-scroll">
      {items.map(item => <Button key={item.key} variant="ghost" className="carrier-message-row" aria-pressed={activeId === item.key} onPress={() => onSelect(item.key)}>
        <span className="carrier-row-top"><span className="carrier-row-sender">To: {item.recipient}</span><Icon name="triangle-alert" /></span>
        <span className="carrier-row-title">{outboxStatus(item)}</span><span className="carrier-row-preview">{item.content.slice(0, 180)}</span>
      </Button>)}
      {!items.length && <EmptyState headingLevel={2} icon="check" title="Your outbox is clear" description="Messages awaiting send confirmation will appear here." />}
    </div></>
}

export function CarrierOutboxReader({ item, online, busy, onRetry }: { item: OutboxItem; online: boolean; busy: boolean; onRetry: () => void }) {
  return <div className="carrier-reader-scroll"><div className="carrier-subject"><h2 tabIndex={-1}>{outboxStatus(item)}</h2></div>
    <p className="carrier-muted">To: {item.recipient}</p>
    <p>The original message may already have arrived. Retry uses the same message and send reference to confirm its delivery.</p>
    {item.error && <p className="carrier-error" role="alert">{item.error}</p>}
    <div className="carrier-message-body"><MessageContent text={item.content} /></div>
    <Button variant="secondary" disabled={!online || busy || item.status === 'submitting'} loading={busy} onPress={onRetry}><Icon name="refresh-cw" />Retry same send</Button>
  </div>
}

export function CarrierAgentList({ runs, activeId, navigation, onSelect }: { runs: CarrierRun[]; activeId: string; navigation?: ReactNode; onSelect: (key: string) => void }) {
  return <><CarrierListHeader title="Agent conversations" description={`${runs.length} conversations`} navigation={navigation} />
    <div className="carrier-message-scroll">{runs.map(run => <Button key={run.key} variant="ghost" className="carrier-message-row" aria-pressed={activeId === run.key} onPress={() => onSelect(run.key)}>
      <span className="carrier-row-top"><span className="carrier-row-sender">{run.profile}</span><time>{messageTime(new Date(run.created_at * 1000).toISOString())}</time></span>
      <span className="carrier-row-title">{run.prompt.split('\n')[0]}</span><span className="carrier-row-preview">{run.task_status ?? run.status} · {run.provider}</span>
    </Button>)}
      {!runs.length && <EmptyState headingLevel={2} icon="user-round" title="No agent conversations yet" description="Start a conversation in Chat to see its activity here." />}
    </div></>
}

export function CarrierAgentReader({ run, online, busy, onRecover, onStop, navigate }: { run: CarrierRun; online: boolean; busy: boolean; onRecover: () => void; onStop: () => void; navigate: (route: string) => void }) {
  return <div className="carrier-reader-scroll"><div className="carrier-subject"><h2 tabIndex={-1}>{run.prompt.split('\n')[0]}</h2><Badge>{run.task_status ?? run.status}</Badge></div>
    <div className="carrier-message-envelope"><Avatar name={run.profile} size="sm" decorative /><div><strong>{run.profile}</strong><span>{run.provider}</span></div></div>
    <p className="carrier-muted">{run.address}</p>
    {run.error && <p className="carrier-error" role="alert">{run.error}</p>}
    <div className="carrier-message-body"><MessageContent text={run.prompt} /></div>
    <div className="carrier-context-links">
      {run.session_id && <Button variant="secondary" onPress={() => navigate(`terminals/${encodeURIComponent(run.session_id!)}`)}><Icon name="external-link" />Open terminal</Button>}
      {['inactive', 'unknown'].includes(run.status) && <Button variant="secondary" disabled={!online || busy} onPress={onRecover}>Restore delivery</Button>}
      {run.status === 'active' && <Button variant="ghost" disabled={busy} onPress={onStop}>Stop agent</Button>}
    </div>
  </div>
}
