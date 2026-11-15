import { sessionSocket } from '../auth/client'
import { requestId } from '../terminals/connection'

export type DelegatedTaskSummary = {
  taskId: string
  attemptId: string | null
  status: string
  mode: string
  provider: string
  title: string
  parentChat: { id: string; title: string }
  childChat: { id: string; title: string } | null
  executionId: string | null
  turnId: string | null
  reportAccepted: boolean
  executionOutcome: string | null
}
export type DelegatedTaskDetail = DelegatedTaskSummary & {
  report: { outcome: string; body: string; artifacts: { uri: string; description?: string; sha256?: string }[] } | null
  receipt: { messageId: number; acknowledged: boolean } | null
  error: string | null
}
export type DelegatedTaskPage = { tasks: DelegatedTaskSummary[]; next_before: number | null }

export type CarrierMessage = {
  id: string
  title: string
  source: string
  body: string
  content: string
  sender: string
  recipient: string
  created_at: string
  reply_to: number | null
  acknowledged_at: string | null
  read: boolean
  archived: boolean
  direction: 'incoming' | 'outgoing'
  metadata: {
    kind: string
    title: string
    project_id?: string
    run_id?: string
    document_id?: string
    links?: { label: string; route: string }[]
  } | null
}
export type CarrierStatus = {
  connected: boolean
  syncing: boolean
  error: string | null
  last_sync: number | null
  instance: string
  outgoing_history: boolean
  agent_configured: boolean
  providers: string[]
  version: number
}
export type Mailbox = {
  id: string
  address: string
  name: string
  role: string
}
export type Recipient = { address: string; name: string | null }
export type AgentProfile = {
  id: string
  provider: string
  profile: string
  model?: string | null
}
export type CarrierRun = {
  key: string
  status: string
  address: string
  provider: string
  profile: string
  model?: string | null
  prompt: string
  project: string
  mode: 'chat' | 'work'
  created_at: number
  run_id?: string
  session_id?: string
  error?: string
  task_status?: string
}
export type OutboxItem = {
  key: string
  content: string
  recipient: string
  reply_to: number | null
  status: string
  message_id: number | null
  error: string | null
  created_at: number
}
export type MessagePage = {
  messages: CarrierMessage[]
  total: number
  next_offset: number | null
}
export type Snapshot = MessagePage & {
  status: CarrierStatus
  counts: Record<string, number>
}
export type Conversation = {
  messages: CarrierMessage[]
  total: number
  partial: boolean
}
export class CarrierError extends Error {
  constructor(
    message: string,
    readonly code = 'request_failed',
  ) {
    super(message)
  }
}

export class CarrierConnection {
  private socket: WebSocket
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private ready = false
  private closed = false
  private reason = ''
  private reasonCode = 'connection_lost'
  private retryable = true
  constructor(
    onReady: () => void,
    onChange: () => void,
    onClose: (error: CarrierError, retryable: boolean) => void,
  ) {
    this.socket = sessionSocket('/api/carrier/ws')
    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'ready') {
          this.ready = true
          onReady()
          return
        }
        if (message.type === 'changed') {
          onChange()
          return
        }
        if (message.type === 'fatal') {
          this.reason = message.message
          this.reasonCode = message.code ?? 'adapter_failed'
          this.retryable = message.retryable !== false
          this.socket.close()
          return
        }
        const item = this.pending.get(message.id)
        if (!item) return
        clearTimeout(item.timer)
        this.pending.delete(message.id)
        if (message.type === 'error')
          item.reject(new CarrierError(message.message, message.code))
        else item.resolve(message.result)
      } catch {
        this.reason =
          'Carrier returned an invalid response. Reconnect to refresh the saved inbox.'
        this.socket.close()
      }
    }
    this.socket.onclose = (event) => {
      this.ready = false
      const reason =
        this.reason ||
        event.reason ||
        'Connection lost. Reconnect to inspect the saved inbox and outbox.'
      for (const item of this.pending.values()) {
        clearTimeout(item.timer)
        item.reject(new CarrierError(reason, 'connection_lost'))
      }
      this.pending.clear()
      if (!this.closed) onClose(new CarrierError(reason, this.reasonCode), this.retryable)
    }
  }
  request<T>(op: string, args: object = {}): Promise<T> {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new CarrierError('Connect to the workspace first.'))
    if (this.pending.size >= 16 || this.socket.bufferedAmount > 1024 * 1024)
      return Promise.reject(new CarrierError('Carrier connection is busy.'))
    const id = requestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(
            new CarrierError(
              ['delegated_tasks', 'delegated_task'].includes(op)
                ? 'Delegated work took too long to respond. Retry to refresh its saved state.'
                : 'Confirmation is pending. Inspect the outbox or conversation before retrying.',
              ['delegated_tasks', 'delegated_task'].includes(op) ? 'request_timeout' : 'effect_unknown',
            ),
          )
        },
        ['launch', 'recover', 'stop_agent'].includes(op) ? 365_000 : 35_000,
      )
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.socket.send(JSON.stringify({ id, op, args }))
    })
  }
  close() {
    this.closed = true
    this.socket.close()
  }
}
