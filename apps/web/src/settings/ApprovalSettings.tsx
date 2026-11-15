import { useEffect, useRef, useState } from 'react'
import { Button, Switch } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { ApprovalSettings as Settings } from '../agents/permissions'
import { SettingsHelp } from './SettingsHelp'

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

  return <div className="settings-control settings-approvals">
    <div className="settings-switch-row">
    <Switch label="Automatically approve requests" checked={settings?.autoApprove ?? false}
      disabled={!connected || !settings || busy} onChange={(event) => { void save(event.target.checked) }}
      description="Allow commands, file changes, and permissions across connected chats." />
    <SettingsHelp label="Automatic approvals">Includes remote devices, background chats, and requests already waiting. Shared across browsers. Questions that need your answers still appear. Agent sandbox and operating system restrictions still apply.</SettingsHelp>
    </div>
    {!connected && <p role="status">Connect to load approval settings. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    {error && <p role="alert">{error}</p>}
    <p className="settings-feedback" role="status">{busy ? 'Saving approval settings…' : saved ? 'Approval settings saved.' : ''}</p>
  </div>
}
