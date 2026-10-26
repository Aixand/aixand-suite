import { useEffect, useRef, useState } from 'react'
import { Button, Card, Switch } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { ApprovalSettings as Settings } from '../agents/permissions'

export function ApprovalSettings({ agents }: { agents: AgentsModel }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const api = useRef(agents)
  api.current = agents
  const connected = agents.status === 'connected'
  const receive = (value: Settings) => setSettings((previous) => !previous || value.revision >= previous.revision ? value : previous)
  useEffect(() => {
    if (!connected) return
    let alive = true
    const unsubscribe = api.current.subscribe((message) => {
      const event = message as { type?: string; settings?: Settings }
      if (event.type === 'approval-settings-changed' && event.settings) { receive(event.settings); setSaved(false) }
    })
    void api.current.request<Settings>('approval-settings-get')
      .then((value) => { if (alive) { receive(value); setError('') } })
      .catch((cause: Error) => { if (alive) setError(cause.message) })
    return () => { alive = false; unsubscribe() }
  }, [connected])

  async function save(autoApprove: boolean) {
    if (!settings || !connected || busy) return
    setBusy(true); setError(''); setSaved(false)
    try {
      receive(await agents.request<Settings>('approval-settings-set', { autoApprove, expectedRevision: settings.revision }))
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save approval settings.')
      try { receive(await agents.request<Settings>('approval-settings-get')) } catch { /* Keep the failed save visible. */ }
    } finally { setBusy(false) }
  }

  return <Card as="section" className="ws-panel settings-approvals" title="Approvals" headingLevel={2}>
    <Switch label="Automatically approve requests" checked={settings?.autoApprove ?? false}
      disabled={!connected || !settings || busy} onChange={(event) => { void save(event.target.checked) }}
      description="Automatically allow command execution, file changes, and permission requests in all connected chats, including remote devices and background chats." />
    <p className="settings-help">This setting is shared across browsers and applies to requests already waiting. Questions that need your answers still appear. Agent sandbox and operating system restrictions still apply.</p>
    {!connected && <p role="status">Connect to load approval settings. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    {error && <p role="alert">{error}</p>}
    <p className="settings-feedback" role="status">{busy ? 'Saving approval settings…' : saved ? 'Approval settings saved.' : ''}</p>
  </Card>
}
