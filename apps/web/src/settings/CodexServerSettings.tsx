import { useEffect, useRef, useState } from 'react'
import { Button, ListRow, Select } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { SettingsHelp } from './SettingsHelp'

type Mode = 'separate' | 'shared'
type Settings = { mode: Mode; revision: number; sharedSupported: boolean }

export function CodexServerSettings({ agents }: { agents: AgentsModel }) {
  const fieldVariant = useContentFieldVariant()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<Mode>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const api = useRef(agents)
  api.current = agents
  const connected = agents.status === 'connected'
  const receive = (value: Settings) => setSettings(previous => !previous || value.revision >= previous.revision ? value : previous)
  useEffect(() => {
    if (!connected) return
    let alive = true
    const unsubscribe = api.current.subscribe(message => {
      const event = message as { type?: string; settings?: Settings }
      if (event.type === 'codex-server-settings-changed' && event.settings) receive(event.settings)
    })
    void api.current.request<Settings>('codex-server-settings-get')
      .then(value => { if (alive) { receive(value); setError('') } })
      .catch((cause: Error) => { if (alive) setError(cause.message) })
    return () => { alive = false; unsubscribe() }
  }, [connected])
  const mode = draft ?? settings?.mode ?? 'separate'
  async function save() {
    if (!settings || !connected || busy) return
    setBusy(true); setError(''); setSaved(false)
    try {
      receive(await agents.request<Settings>('codex-server-settings-set', { mode, expectedRevision: settings.revision }))
      setDraft(undefined); setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save Codex server settings.')
      try { receive(await agents.request<Settings>('codex-server-settings-get')) } catch { /* Retain the failed save. */ }
    } finally { setBusy(false) }
  }
  return <div className="settings-control">
    <ListRow label="Codex process isolation" description="Choose how new Codex conversations share memory."
      trailing={<div className="settings-control-actions">
        <SettingsHelp label="Codex process isolation">Separate servers use more RAM and isolate server failures to one conversation. Shared servers are expected to use less RAM, but a failure may interrupt conversations sharing that server. Sharing stays within the same environment and workspace. Applies to new chats and newly started workflow conversations; existing sessions keep their mode. RAM savings vary by workload.</SettingsHelp>
        <Select label="Codex server mode" hideLabel variant={fieldVariant} value={mode}
          options={[{ id: 'separate', label: 'Separate servers (default)' }, ...(settings?.sharedSupported ? [{ id: 'shared', label: 'Shared servers' }] : [])]}
          disabled={!connected || !settings || busy} onChange={value => { setDraft(value as Mode); setSaved(false) }} />
        <Button variant="secondary" size="sm" aria-label="Save Codex server mode" loading={busy}
          disabled={!connected || !settings || busy || mode === settings.mode} onPress={() => { void save() }}>Save</Button>
      </div>} />
    <p className="settings-note">{mode === 'separate'
      ? 'RAM usage grows with each conversation. A server failure affects only its conversation.'
      : 'Lower expected RAM with multiple conversations. A server failure may interrupt conversations sharing it.'}</p>
    {settings && !settings.sharedSupported && <p className="settings-note">Shared servers are not yet available on this host.</p>}
    {mode === 'shared' && <p className="settings-note">A five-conversation test used about 50% less RAM during simple replies without tools. A single conversation may use more RAM because of the shared server manager.</p>}
    {!connected && <p role="status">Connect to load the saved setting. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    {error && <p role="alert">{error}</p>}
    <p className="settings-feedback" role="status">{busy ? 'Saving Codex server mode…' : saved ? 'Codex server mode saved.' : ''}</p>
  </div>
}
