import { randomUUID } from '../uuid'
import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, Link, ListRow, SettingsSection, Tooltip } from 'bbb-design'
import { Disclosure, DisclosurePanel } from 'react-aria-components'
import type { AgentsModel } from '../agents/model'
import type { BackgroundActivity, Device } from './model'

const labels: Record<string, string> = {
  running: 'Running', waiting: 'Needs attention', uncertain: 'Outcome unknown', offline: 'Connection unavailable',
  report_pending: 'Report pending', preparing: 'Preparing', sending: 'Sending',
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
      const key = attempts.current.get(row.id) ?? randomUUID()
      if (stop) attempts.current.set(row.id, key)
      const result = await agents.request<{ activities?: BackgroundActivity[] }>(stop ? 'connect-activity-stop' : 'connect-activity-check',
        { activityId: row.id, ...(stop ? { key } : {}) })
      const refreshed = await agents.request<{ activities?: BackgroundActivity[] }>('connect-activity-list')
      setRows(refreshed.activities ?? result.activities ?? [])
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(null) }
  }

  return <SettingsSection className="settings-group connect-background" title="Background work" headingLevel={2}
    description={ready ? rows.length ? `${rows.length} active or unresolved ${rows.length === 1 ? 'task' : 'tasks'}.` : 'No unresolved background work.' : connected ? 'Checking activity…' : 'Reconnect to check activity.'}>
    {rows.map(row => {
      const device = devices.find(device => device.id === row.deviceId)
      const offline = Boolean(row.deviceId && device?.status !== 'ready')
      const stopLabel = row.kind === 'workflow' ? 'Cancel workflow' : 'Stop work'
      return <Disclosure className="connect-row-item connect-activity-row" key={row.id}>
        <ListRow label={row.title} description={`${row.device}${offline ? ' · Device offline' : ''}${row.conversationDeleted ? ' · Conversation deleted' : ''}`}
          trailing={<div className="connect-row-actions">
            <Badge tone={['waiting', 'uncertain', 'offline'].includes(row.status) ? 'warning' : 'neutral'}>{labels[row.status] ?? row.status}</Badge>
            <Tooltip content="Check status"><Button variant="ghost" size="sm" iconOnly aria-label={`Check status for ${row.title}`} disabled={!connected || busy !== null} onPress={() => { void act(row) }}><Icon name="refresh-cw" /></Button></Tooltip>
            <Tooltip content={stopLabel}><Button variant="ghost" size="sm" iconOnly aria-label={`${stopLabel} for ${row.title}`} disabled={!connected || busy !== null || offline} onPress={() => { void act(row, true) }}><Icon name="x" /></Button></Tooltip>
            <Button slot="trigger" variant="ghost" size="sm" iconOnly className="connect-details-trigger" aria-label={`Activity details for ${row.title}`}><Icon name="chevron-down" /></Button>
          </div>} />
        <DisclosurePanel className="connect-row-details">
          {row.updatedAt && <p className="settings-note">Last observed: {new Date(row.updatedAt).toLocaleString()}</p>}
          {row.error && <p className="settings-note">{row.error}</p>}
          {row.status === 'waiting' && row.conversationDeleted && <p className="settings-note">The task needs a response. You can stop it here or manage it on its device.</p>}
          {row.status === 'report_pending' && <p className="settings-note">Work has finished. Report delivery is still pending.</p>}
          <p className="settings-note">Work remains manageable here after its conversation is deleted.</p>
          <div className="connect-row-links">
            {row.workflowId && <Link href={`#/workflows/runs/${encodeURIComponent(row.workflowId)}`}>Open workflow</Link>}
            {row.chatId && !row.conversationDeleted && <Link href={`#/chat/${encodeURIComponent(row.chatId)}`}>Open conversation</Link>}
          </div>
        </DisclosurePanel>
      </Disclosure>
    })}
    {error && <p role="alert">{error}</p>}
  </SettingsSection>
}
