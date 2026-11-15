import { sessionSocket } from '../../auth/client'
import { requestId } from '../../terminals/connection'
import type { Json, RunEvent } from '../ir'
import type { AgentSession } from './terminals'

export type JobState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'uncertain'
export type JobEvent = {
  sequence: number
  kind: string
  data: RunEvent | (AgentSession & { event: 'agent_session' })
}
export type JobEvents = {
  events: JobEvent[]
  state: JobState
  next_after: number
  has_more: boolean
}
export type JobResult = {
  id: string
  state: JobState
  result: Record<string, Json> | null
  error: { code: string; message: string; invocation_id?: string } | null
}
export type RunPlan = { id: string; revision: number; workflow: import('./compileCanvas').GraphWorkflow;
  authoring: import('./model').CanvasDraft | null; held: boolean; phase: string;
  locked_groups: string[]; operations: Record<string, string> }
export type Continuation = { id: string; parent_id: string; key: string; state: string;
  child_id: string | null; error: { code: string; message: string } | null }
export class JobError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}
export class JobsConnection {
  private socket: WebSocket
  private ready = false
  private closed = false
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    onReady: () => void,
    onClose: (message: string) => void,
  ) {
    this.socket = sessionSocket('/api/workflow-jobs/ws')
    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'ready') {
          this.ready = true
          onReady()
          return
        }
        const task = this.pending.get(message.id)
        if (!task) return
        clearTimeout(task.timer)
        this.pending.delete(message.id)
        if (message.type === 'error')
          task.reject(new JobError(message.message, message.code, message.details))
        else task.resolve(message.result)
      } catch {
        this.socket.close(1002, 'Invalid Runner response')
      }
    }
    this.socket.onclose = (event) => {
      this.ready = false
      for (const task of this.pending.values()) {
        clearTimeout(task.timer)
        task.reject(
          new JobError(
            'Connection lost. Reconnect to recover the existing run.',
            'connection_lost',
          ),
        )
      }
      this.pending.clear()
      if (!this.closed) onClose(
        event.reason ||
          'Runner connection closed. Reconnect to recover the existing run.',
      )
    }
  }
  request<T>(op: string, args: object = {}): Promise<T> {
    if (!this.ready)
      return Promise.reject(
        new JobError('Connect to Runner first.', 'connection_lost'),
      )
    const id = requestId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new JobError(
            'Request timed out. Reconnect to recover the existing run.',
            'runner_timeout',
          ),
        )
      }, 30_000)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
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
