// Browser/Desktop retain their existing same-origin transport. Only the bundled
// Client workspace has the restricted native capability used below.
type SocketEvent = { type: 'open' | 'message' | 'close' | 'error'; data?: string; code?: number; reason?: string }
type Channel<T> = { onmessage: (value: T) => void }
type Native = { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>; Channel: new <T>() => Channel<T> } }
const host = window as unknown as { __TAURI__?: Native; __AIXAND_CLIENT__?: boolean; __AIXAND_CONNECTION__?: number }
const native = host.__AIXAND_CLIENT__ ? host.__TAURI__ : undefined
export const nativeClient = Boolean(native)

export async function workspaceFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (!native) return fetch(path, options)
  if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
  const headers = [...new Headers(options.headers).entries()]
  if (options.body !== undefined && typeof options.body !== 'string') throw new TypeError('Unsupported workspace request body')
  const pending = native.core.invoke<{ status: number; headers: [string, string][]; body: number[] }>('client_request', { connection: host.__AIXAND_CONNECTION__,
    request: { path, method: options.method ?? 'GET', headers, body: options.body === undefined ? null : [...new TextEncoder().encode(options.body)] },
  })
  // Stop delivery to unmounted consumers. Native requests also stop on server
  // switch/window destruction and have a bounded network timeout.
  let abort: (() => void) | undefined
  try {
    const value = await (options.signal ? Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Request aborted', 'AbortError'))
      options.signal!.addEventListener('abort', abort, { once: true })
    })]) : pending)
    return new Response([204, 205, 304].includes(value.status) ? null : new Uint8Array(value.body), { status: value.status, headers: value.headers })
  } finally { if (abort) options.signal?.removeEventListener('abort', abort) }
}

class NativeSocket extends EventTarget {
  readonly url: string
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private id = crypto.randomUUID()
  private pending: Promise<unknown>
  private closing = false
  constructor(path: string) {
    super()
    this.url = path
    const events = new native!.core.Channel<SocketEvent>()
    events.onmessage = value => {
      if (this.readyState === WebSocket.CLOSED) return
      if (value.type === 'open') {
        if (this.closing) return
        this.readyState = WebSocket.OPEN
        const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event)
      } else if (value.type === 'message' && !this.closing) {
        const event = new MessageEvent('message', { data: value.data }); this.dispatchEvent(event); this.onmessage?.(event)
      } else if (value.type === 'error') this.error()
      else if (value.type === 'close') this.closed(value.code ?? 1006, value.reason ?? '')
    }
    this.pending = native!.core.invoke('client_socket_open', { connection: host.__AIXAND_CONNECTION__, id: this.id, path, events })
    void this.pending.catch(() => { this.error(); this.closed(1006, 'Cannot open server connection') })
  }
  private error() { const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event) }
  private closed(code: number, reason: string) {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    const event = new CloseEvent('close', { code, reason, wasClean: code === 1000 }); this.dispatchEvent(event); this.onclose?.(event)
  }
  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new DOMException('Socket is not open', 'InvalidStateError')
    if (typeof data !== 'string') throw new TypeError('Workspace sockets accept text messages')
    const length = new TextEncoder().encode(data).length
    if (this.bufferedAmount + length > 1024 * 1024) throw new Error('Workspace socket is busy')
    this.bufferedAmount += length
    // Serialize IPC sends so terminal input and operation ordering are retained.
    this.pending = this.pending.then(() => native!.core.invoke('client_socket_send', { connection: host.__AIXAND_CONNECTION__, id: this.id, data, close: false }))
      .catch(() => { this.error(); this.close() }).finally(() => { this.bufferedAmount -= length })
  }
  close(_code?: number, _reason?: string) {
    if (this.closing || this.readyState === WebSocket.CLOSED) return
    this.closing = true; this.readyState = WebSocket.CLOSING
    void this.pending.then(() => native!.core.invoke('client_socket_send', { connection: host.__AIXAND_CONNECTION__, id: this.id, data: null, close: true }))
      .catch(() => {}).finally(() => this.closed(1000, ''))
  }
}
export function workspaceSocket(path: string): WebSocket {
  if (native) return new NativeSocket(path) as unknown as WebSocket
  const url = new URL(path, location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url)
}
