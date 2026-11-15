import './ChatStatus.css'

const activities = {
  recovering: { label: 'Waiting to reconnect', detail: 'The saved login or profile is changing. Existing work must finish before reconnection.' },
  reconnecting: { label: 'Reconnecting', detail: 'Restoring the connection to this conversation.' },
  attention: { label: 'Needs attention', detail: 'The original profile or account could not be confirmed.' },
  working: { label: 'Working', detail: 'The agent is working on this turn.' },
  waiting: { label: 'Waiting for you', detail: 'The agent needs your response before continuing.' },
  done: { label: 'Done', detail: 'The latest turn has finished.' },
  stopped: { label: 'Stopped', detail: 'The turn was stopped before it finished.' },
  failed: { label: 'Failed', detail: 'The turn failed. Check the conversation for details.' },
  disconnected: { label: 'Disconnected', detail: 'The connection was interrupted. Reconnect to check the conversation’s status.' },
  unknown: { label: 'Status unknown', detail: 'The current status cannot be confirmed. Work may still be running.' },
  starting: { label: 'Starting', detail: 'The agent is starting.' },
  checking: { label: 'Checking status', detail: 'Loading the current conversation status.' },
  ready: { label: 'Ready', detail: 'Ready for your next message.' },
  draft: { label: 'Draft', detail: 'Saved locally. No agent has been started.' },
  queued: { label: 'Queued', detail: 'Waiting to start.' },
  active: { label: 'Session active', detail: 'The agent session is active. Turn progress is unavailable.' },
} as const

export type ChatActivity = keyof typeof activities

export function chatActivity(status: string | undefined, connected = true, statusReason?: string | null, connectionState?: string): ChatActivity {
  if (connectionState === 'needs_attention') return 'attention'
  if (connectionState === 'reconnecting' || connectionState === 'ready_to_reconnect') return 'reconnecting'
  if (connectionState === 'waiting_for_active_work' && !['running', 'waiting'].includes(status ?? '')) return 'recovering'
  if (statusReason === 'session_ended') return 'disconnected'
  if (!connected || status === 'offline') return 'disconnected'
  if (status === 'uncertain') return 'unknown'
  switch (status?.toLowerCase()) {
    case 'running': return 'working'
    case 'waiting': return 'waiting'
    case 'completed': case 'done': return 'done'
    case 'interrupted': case 'stopped': case 'cancelled': return 'stopped'
    case 'failed': return 'failed'
    case 'starting': case 'launching': return 'starting'
    case 'ready': case 'idle': return 'ready'
    case 'draft': return 'draft'
    case 'queued': return 'queued'
    case 'active': return 'active'
    default: return 'unknown'
  }
}

export function ChatStatus({ activity, compact = false, unread = false }: { activity: ChatActivity; compact?: boolean; unread?: boolean }) {
  const { label, detail } = unread && activity === 'done' ? { label: 'Finished · Unread', detail: 'Finished · Unread' } : activities[activity]
  return <span className={`chat-status${compact ? ' chat-status--compact' : ''}`} data-state={activity} data-unread={unread && activity === 'done' || undefined}
    role={compact ? undefined : 'status'} aria-label={compact ? undefined : 'Conversation status'}
    aria-atomic={compact ? undefined : true} title={activity === 'working' ? label : detail}>
    {activity === 'working' && <span className="chat-status-indicator" aria-hidden="true" />}
    {unread && activity === 'done' && <span className="chat-unread-indicator" aria-hidden="true" />}
    <span className="bbb-visually-hidden">{label}</span>
  </span>
}
