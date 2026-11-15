import { useEffect, useRef, useState } from 'react'
import type { AgentsModel } from '../agents/model'

export type MonitorState = 'scheduled' | 'running' | 'waiting' | 'needs_input' | 'paused' | 'completed' | 'cancelled'
export type Watch = { id?: string; kind: 'chat' | 'receipt' | 'workflow' | 'inbox' | 'timer'; targetId?: string;
  at?: number; intervalSeconds?: number; nextAt?: number; done?: boolean; includeExisting?: boolean }
export type Monitor = {
  id: string; title: string; instruction: string; instructionRevision: number; generation: number;
  state: MonitorState; progress: string; memory: string; evidence: string[]; projectId?: string | null;
  supervisorChatId?: string | null; sourceChatId?: string | null; profile?: string | null; model?: string | null;
  watchedChatIds?: string[];
  conversationChatId?: string | null;
  conversationDeleted?: boolean;
  permissionMode: string; limits: { maxEvaluations: number; maxActionsPerEvaluation: number; deadline?: number };
  evaluations: number; currentRunId?: string | null; error?: string | null; createdAt: number; updatedAt: number; revision: number; url: string;
}
export type Activity = { sequence: number; kind: string; text: string; createdAt: number; state?: string; executionId?: string; actionId?: string; evidenceId?: string }
export type MonitorDetail = { monitor: Monitor; watches: Watch[]; execution?: { id: string; state: string; chatId: string; turnId?: string | null } | null; activity: Activity[];
  delegations?: { id: string; chatId: string; title: string; status: string; phase: string }[];
  actions?: { id: string; executionId: string; state: string; tool: string }[];
  observations?: { id: string; kind: string; targetId: string; evidenceId?: string }[] }
export const monitorLabels: Record<MonitorState, string> = {
  scheduled: 'Scheduled', running: 'Evaluating', waiting: 'Watching', needs_input: 'Needs you', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled',
}

export function useCommand(agents: AgentsModel) {
  const [monitors, setMonitors] = useState<Monitor[]>([])
  const [detail, setDetail] = useState<MonitorDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const api = useRef(agents); api.current = agents
  const selected = useRef<string | null>(null)
  const epoch = useRef(0)
  const inFlight = useRef(false)
  const connected = agents.status === 'connected'
  const receive = (monitor: Monitor) => setMonitors(rows => {
    const prior = rows.find(row => row.id === monitor.id)
    return prior && prior.revision > monitor.revision ? rows : [monitor, ...rows.filter(row => row.id !== monitor.id)].sort((a, b) => b.createdAt - a.createdAt)
  })
  async function refresh() {
    const requestEpoch = epoch.current
    setLoading(true)
    try {
      let before: number | undefined
      do {
        const value = await api.current.request<{ monitors: Monitor[]; nextBefore?: number | null }>('command-list', before ? { before } : {})
        if (requestEpoch !== epoch.current) return
        if (!Array.isArray(value.monitors)) throw new Error('Supervision is unavailable on this server.')
        for (const monitor of value.monitors) receive(monitor)
        before = value.nextBefore ?? undefined
      } while (before)
      setError('')
    } catch (cause) {
      if (requestEpoch === epoch.current) setError(cause instanceof Error ? cause.message : 'Could not load monitors.')
    } finally { if (requestEpoch === epoch.current) setLoading(false) }
  }
  async function open(id: string | null) {
    selected.current = id
    if (!id) { setDetail(null); return }
    try {
      const value = await api.current.request<MonitorDetail>('command-get', { monitorId: id })
      if (selected.current === id) {
        setDetail(prior => prior?.monitor.id === id && prior.monitor.revision > value.monitor.revision ? prior : value)
        receive(value.monitor); setError('')
      }
    } catch (cause) { if (selected.current === id) setError(cause instanceof Error ? cause.message : 'Could not open monitor.') }
  }
  useEffect(() => {
    epoch.current++
    if (!connected) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = api.current.subscribe(message => {
      const event = message as { type?: string; monitor?: Monitor; monitorId?: string; entry?: Activity }
      if (event.type === 'command-updated' && event.monitor) {
        receive(event.monitor)
        setDetail(prior => prior?.monitor.id === event.monitor!.id && prior.monitor.revision <= event.monitor!.revision ? { ...prior, monitor: event.monitor! } : prior)
        if (selected.current === event.monitor.id && !timer) timer = setTimeout(() => { timer = undefined; void open(selected.current) }, 500)
      }
      if (event.type === 'command-activity' && event.entry) setDetail(prior => prior && prior.monitor.id === event.monitorId
        ? { ...prior, activity: [...prior.activity.filter(row => row.sequence !== event.entry!.sequence), event.entry!].sort((a, b) => a.sequence - b.sequence).slice(-100) } : prior)
      if (event.type === 'workspace-reset') { setMonitors([]); setDetail(null); void refresh() }
    })
    void refresh()
    if (selected.current) void open(selected.current)
    return () => { epoch.current++; clearTimeout(timer); unsubscribe() }
  }, [connected])
  async function mutate(op: string, args: object): Promise<MonitorDetail> {
    if (inFlight.current) throw new Error('A monitor request is still in progress.')
    inFlight.current = true; setBusy(true); setError('')
    try {
      const result = await api.current.request<MonitorDetail>(op, args)
      receive(result.monitor)
      if (selected.current === result.monitor.id) setDetail(result)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The monitor request failed; inspect its current state before retrying.')
      throw cause
    } finally { inFlight.current = false; setBusy(false) }
  }
  return { monitors, detail, error, loading, busy, connected, refresh, open, mutate,
    request: <T,>(op: string, args: object = {}) => api.current.request<T>(op, args) }
}

export type CommandModel = ReturnType<typeof useCommand>
