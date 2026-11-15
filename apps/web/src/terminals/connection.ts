import { randomUUID as requestId } from '../uuid'
import { sessionSocket } from '../auth/client'
export type Session = {
  id: string
  revision?: string
  name: string
  labels?: Record<string, string> | null
  lifecycle: { state: string; code?: number | null }
  foreground?: Record<
    string,
    {
      state: string
      modality?: string
      semantic?: string
      basis?: {
        confidence_basis_points: number
        source: string | null
        disposition: string
        evidence_observed_at_millis: number | null
      }
    }
  >
  health?: { status: string }
  profile?: string | null
  profile_context?: { current_directory?: string | null }
  restart_count?: number
  restart_status?: { state: string }
  started_at_millis?: number | null
  updated_at_millis?: number
}
export type SessionMutation = (
  op: 'stop' | 'restart' | 'remove' | 'set-my-terminal',
  args: {
    sessionId: string
    force?: boolean
    confirmed?: true
    myTerminal?: boolean
  }
) => Promise<void>
export type CleanupResult = {
  selected: number
  succeeded: { session_id: string }[]
  failures: { session_id: string; message: string }[]
}
export type SessionPage = {
  items: Session[]
  next_cursor: string | null
  total: number | null
  snapshot_revision?: string
}
export type BackendPhase =
  'connecting' | 'connected' | 'recovering' | 'failed' | 'closed'
export class TerminalRequestError extends Error {
  constructor(
    message: string,
    readonly code = 'operation_failed',
    readonly submission = 'unknown',
    readonly retryable = false
  ) {
    super(message)
    this.name = 'TerminalRequestError'
  }
}
export const requestBudget = (op: string) =>
  ['clean', 'group-restore', 'group-reconcile'].includes(op) ? 65_000 : 15_000
const mutation = (op: string) =>
  [
    'input',
    'resize',
    'create',
    'stop',
    'restart',
    'remove',
    'clean',
    'set-my-terminal',
  ].includes(op) || op.startsWith('group-')
export type TerminalEvent = {
  type: string
  stream?: string
  sequence?: string
  start?: string
  offset?: string
  data?: string
  columns?: number
  rows?: number
  cursorRow?: number
  cursorColumn?: number
  cursorVisible?: boolean
  alternateScreen?: boolean
  reason?: string
  message?: string
  kind?: 'sessions' | 'events'
  scope?: 'sessions' | 'events' | 'open'
  phase?: BackendPhase
  generation?: string
  payload?: { item: string; value: unknown }
}

export class TerminalConnection {
  private listeners = new Set<(event: TerminalEvent) => void>()
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
  backend: BackendPhase = 'connecting'
  private acknowledgements = new Map<string, string>()
  private ackTimer?: ReturnType<typeof setTimeout>
  constructor(
    onReady: () => void,
    onEvent: (event: TerminalEvent) => void,
    onClose: (message: string) => void
  ) {
    this.socket = sessionSocket('/api/terminals/ws')
    this.socket.onmessage = (event) => {
      let message: TerminalEvent & {
        id?: string
        result?: unknown
        code?: string
        submission?: string
        retryable?: boolean
      }
      try {
        message = JSON.parse(event.data)
      } catch {
        this.socket.close(1002, 'Invalid terminal response')
        return
      }
      if (message.type === 'ready') {
        this.ready = true
        if (this.backend === 'connecting') this.backend = 'connected'
        onReady()
        return
      }
      if (message.type === 'backend-state' && message.phase)
        this.backend = message.phase
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (
          message.code === 'backend_recovering' &&
          this.backend !== 'recovering'
        ) {
          this.backend = 'recovering'
          const recovering: TerminalEvent = {
            type: 'backend-state',
            phase: 'recovering',
          }
          onEvent(recovering)
          for (const listener of this.listeners) listener(recovering)
        }
        if (message.type === 'error')
          pending.reject(
            new TerminalRequestError(
              message.message ?? 'Terminal request failed',
              message.code,
              message.submission,
              message.retryable
            )
          )
        else pending.resolve(message.result)
        return
      }
      onEvent(message)
      for (const listener of this.listeners) listener(message)
      if (message.type === 'metadata' && message.stream && message.sequence)
        this.ack(message.stream, message.sequence)
    }
    this.socket.onclose = (event) => {
      this.ready = false
      this.backend = 'closed'
      clearTimeout(this.ackTimer)
      this.acknowledgements.clear()
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(
          new Error('Connection lost. Pending input was not retried.')
        )
      }
      this.pending.clear()
      if (!this.closed)
        onClose(
          event.reason || 'Connection lost. Reconnect to resume your session.'
        )
    }
  }
  subscribe(listener: (event: TerminalEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  request<T>(op: string, args: object = {}): Promise<T> {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new TerminalRequestError(
          'The terminal connection is unavailable.',
          'unavailable',
          'not_sent',
          true
        )
      )
    if (
      this.backend !== 'connected' &&
      !['detach', 'unwatch', 'groups'].includes(op)
    )
      return Promise.reject(
        new TerminalRequestError(
          'Reconnecting to the terminal backend.',
          'backend_recovering',
          'not_sent',
          true
        )
      )
    const interactive = ['input', 'resize', 'detach'].includes(op)
    if (
      this.pending.size >= (interactive ? 24 : 20) ||
      this.socket.bufferedAmount > 128 * 1024
    )
      return Promise.reject(
        new TerminalRequestError(
          'Terminal is busy. The request was not sent.',
          'overloaded',
          'not_sent',
          true
        )
      )
    const id = requestId()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new TerminalRequestError(
            mutation(op)
              ? 'The action timed out. Delivery may be uncertain; it was not retried.'
              : 'The terminal request timed out.',
            'timeout',
            'unknown',
            true
          )
        )
      }, requestBudget(op))
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.socket.send(JSON.stringify({ id, op, args }))
    })
  }
  ack(stream: string, sequence: string) {
    const previous = this.acknowledgements.get(stream)
    if (!previous || BigInt(sequence) > BigInt(previous))
      this.acknowledgements.set(stream, sequence)
    if (this.ackTimer !== undefined) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      if (this.ready && this.socket.readyState === WebSocket.OPEN)
        for (const [stream, sequence] of this.acknowledgements)
          this.socket.send(
            JSON.stringify({
              id: requestId(),
              op: 'ack',
              args: { stream, sequence },
            })
          )
      this.acknowledgements.clear()
    }, 0)
  }
  close() {
    this.closed = true
    clearTimeout(this.ackTimer)
    this.socket.close()
  }
}

export { randomUUID as requestId } from '../uuid'

export function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
export function decodeBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
}
