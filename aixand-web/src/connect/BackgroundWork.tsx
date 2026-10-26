import { useEffect, useRef, useState } from 'react'
import { Badge, Button } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { BackgroundActivity, Device } from './model'

const labels: Record<string, string> = {
  running: 'Running', waiting: 'Needs attention', uncertain: 'Outcome unknown', offline: 'Connection unavailable',
  report_pending: 'Work finished · report delivery pending', preparing: 'Preparing', sending: 'Sending',
  staging: 'Preparing workspace', starting: 'Starting', queued: 'Queued',
}

export function BackgroundWork({ agents, devices }: { agents: AgentsModel; devices: Device[] }) {
  const api = useRef(agents); api.current = agents
  const [rows, setRows] = useState<BackgroundActivity[]>([])
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const attempts = useRef(new Map<string, string>())
  const connected = agents.status === 'connected'

  useEffect(() => {
    if (!connected) return
    let alive = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const result = await api.current.request<{ activities?: BackgroundActivity[] }>('connect-activity-list')
        if (alive) { setRows(result.activities ?? []); setReady(true); setError('') }
      } catch (cause) { if (alive) setError((cause as Error).message) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 15000)
    const unsubscribe = api.current.subscribe(value => {
      const message = value as { type: string }
      if (['connect-activity-updated', 'connect-project-updated', 'workflow-updated', 'chat-deleted'].includes(message.type)) void refresh()
    })
    return () => { alive = false; clearInterval(timer); unsubscribe() }
  }, [connected])

  async function act(row: BackgroundActivity, stop = false) {
    if (busy) return
    setBusy(row.id); setError('')
    try {
      const key = attempts.current.get(row.id) ?? crypto.randomUUID()
      if (stop) attempts.current.set(row.id, key)
      const result = await agents.request<{ activities?: BackgroundActivity[] }>(stop ? 'connect-activity-stop' : 'connect-activity-check',
        { activityId: row.id, ...(stop ? { key } : {}) })
      const refreshed = await agents.request<{ activities?: BackgroundActivity[] }>('connect-activity-list')
      setRows(refreshed.activities ?? result.activities ?? [])
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(null) }
  }

  return <section aria-label="Background work">
    <h3>Background work</h3>
    <p>Project operations and workflow reports stay manageable after their conversations are deleted.</p>
    {ready && !rows.length && <p>No unresolved background work.</p>}
    {rows.map(row => {
      const device = devices.find(device => device.id === row.deviceId)
      const offline = Boolean(row.deviceId && device?.status !== 'ready')
      return <article className="connect-device" key={row.id}>
        <div className="connect-row"><strong>{row.title}</strong><Badge>{labels[row.status] ?? row.status}</Badge></div>
        <p>{row.device}{offline ? ' · Device offline or unavailable' : ''}{row.conversationDeleted ? ' · Conversation deleted' : ''}</p>
        {row.updatedAt && <p className="settings-help">Last observed: {new Date(row.updatedAt).toLocaleString()}</p>}
        {row.error && <p>{row.error}</p>}
        {row.status === 'waiting' && row.conversationDeleted && <p>The task needs a response. You can stop it here or manage it on its device.</p>}
        <div className="connect-row">
          <Button variant="secondary" size="sm" disabled={!connected || busy !== null} onPress={() => { void act(row) }}>Check status</Button>
          <Button variant="ghost" size="sm" disabled={!connected || busy !== null || offline} onPress={() => { void act(row, true) }}>
            {row.kind === 'workflow' ? 'Cancel workflow' : 'Stop work'}
          </Button>
          {row.workflowId && <a href={`#/workflows/runs/${row.workflowId}`}>Open workflow</a>}
          {row.chatId && !row.conversationDeleted && <a href={`#/chat/${row.chatId}`}>Open conversation</a>}
        </div>
      </article>
    })}
    {error && <p role="alert">{error}</p>}
  </section>
}
