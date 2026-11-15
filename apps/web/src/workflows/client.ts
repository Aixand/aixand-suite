import { sessionSocket } from '../auth/client'
import { requestId } from '../terminals/connection'
import type {
  Catalog,
  Failure,
  Json,
  ReferenceOption,
  RunEvent,
  Type,
  Validation,
  Workflow,
} from './ir'
export type CatalogResult = { catalogs: Catalog[]; sdkConfigured: boolean }
export class WorkflowConnection {
  private socket: WebSocket
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private runId?: string
  private onRun?: (message: {
    event?: RunEvent
    outputs?: Record<string, Json>
    failure?: Failure
  }) => void
  private closed = false
  private ready = false
  private failureReason?: string
  constructor(
    onReady: () => void,
    onClose: (message: string) => void
  ) {
    this.socket = sessionSocket('/api/workflows/ws')
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'ready') {
        this.ready = true
        onReady()
        return
      }
      if (message.type === 'fatal') {
        this.failureReason ??= message.message
        this.socket.close()
        return
      }
      if (message.id === this.runId) {
        if (message.type === 'run-event') this.onRun?.({ event: message.event })
        if (['run-result', 'run-failure', 'error'].includes(message.type)) {
          this.onRun?.(
            message.type === 'run-result'
              ? { outputs: message.outputs }
              : {
                  failure: message.failure ?? {
                    code: 'request',
                    message: message.message,
                  },
                }
          )
          this.runId = undefined
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.type === 'error') pending.reject(new Error(message.message))
        else pending.resolve(message.result)
      }
    }
    this.socket.onclose = (event) => {
      const message =
        this.failureReason ||
        event.reason ||
        (!this.ready
          ? 'Could not connect to the Aixand backend. Check that the server is running and the /api proxy points to it.'
          : 'Workflow connection lost. Reconnect to validate again.')
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(message))
      }
      this.pending.clear()
      if (this.runId) {
        this.onRun?.({
          failure: {
            code: 'connection_lost',
            message:
              'The connection ended. The server requests cancellation and cleanup; completion is unconfirmed.',
          },
        })
        this.runId = undefined
      }
      if (!this.closed) onClose(message)
    }
  }
  request<T>(op: string, args: object = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Connect to the workspace first'))
    const id = requestId()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Workflow request timed out'))
      }, 20_000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.socket.send(JSON.stringify({ id, op, args }))
    })
  }
  validate(source: string) {
    return this.request<Validation>('validate', { source })
  }
  references(
    workflow: Workflow,
    expected: Type,
    before: number,
    sequence = '/body'
  ) {
    return this.request<ReferenceOption[]>('references', {
      source: JSON.stringify(workflow),
      expected,
      before,
      sequence,
    })
  }
  run(
    source: string,
    inputs: Record<string, Json>,
    onRun: NonNullable<WorkflowConnection['onRun']>
  ) {
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error('Connect to the workspace first')
    this.runId = requestId()
    this.onRun = onRun
    this.socket.send(
      JSON.stringify({ id: this.runId, op: 'run', args: { source, inputs } })
    )
  }
  close() {
    this.closed = true
    this.socket.close()
  }
}
