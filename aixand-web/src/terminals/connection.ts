import { sessionSocket } from '../auth/client'
export type Session = {
  id: string
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
  args: { sessionId: string; force?: boolean; confirmed?: true; myTerminal?: boolean }
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
}
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
  constructor(
    onReady: () => void,
    onEvent: (event: TerminalEvent) => void,
    onClose: (message: string) => void
  ) {
    this.socket = sessionSocket('/api/terminals/ws')
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as TerminalEvent & {
        id?: string
        result?: unknown
      }
      if (message.type === 'ready') {
        this.ready = true
        onReady()
        return
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.type === 'error')
          pending.reject(
            new Error(message.message ?? 'Terminal request failed')
          )
        else pending.resolve(message.result)
        return
      }
      if (message.type === 'metadata' && message.stream && message.sequence)
        this.ack(message.stream, message.sequence)
      onEvent(message)
      for (const listener of this.listeners) listener(message)
    }
    this.socket.onclose = (event) => {
      this.ready = false
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
      return Promise.reject(new Error('Connect to Undercurrent first.'))
    if (this.pending.size >= 24 || this.socket.bufferedAmount > 128 * 1024)
      return Promise.reject(new Error('Terminal is busy. Input was not sent.'))
    const id = requestId()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            'Request timed out. Its effect may be uncertain; it was not retried.'
          )
        )
        this.socket.close()
      }, 15_000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.socket.send(JSON.stringify({ id, op, args }))
    })
  }
  ack(stream: string, sequence: string) {
    if (this.ready && this.socket.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({
          id: requestId(),
          op: 'ack',
          args: { stream, sequence },
        })
      )
  }
  close() {
    this.closed = true
    this.socket.close()
  }
}

export function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // randomUUID requires a secure context; LAN HTTP previews still expose
  // getRandomValues, so retain cryptographically random UUIDs there too.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}
export function decodeBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
}
