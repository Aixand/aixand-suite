import { useEffect, useRef, useState } from 'react'
import { Button, ListRow, Select } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { spawnDefaultModes } from '../agents/permissions'
import type { SpawnDefaultMode, SpawnSettings as Settings } from '../agents/permissions'
import { SettingsHelp } from './SettingsHelp'

export function SpawnSettings({ agents }: { agents: AgentsModel }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<SpawnDefaultMode>()
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
      if (event.type === 'spawn-settings-changed' && event.settings) receive(event.settings)
    })
    void api.current.request<Settings>('spawn-settings-get')
      .then((value) => { if (alive) { receive(value); setError('') } })
      .catch((cause: Error) => { if (alive) setError(cause.message) })
    return () => { alive = false; unsubscribe() }
  }, [connected])
  const mode = draft ?? settings?.defaultMode ?? 'read-only'
  async function save() {
    if (!settings || !connected || busy) return
    setBusy(true); setError(''); setSaved(false)
    try {
      receive(await agents.request<Settings>('spawn-settings-set', { defaultMode: mode, expectedRevision: settings.revision }))
      setDraft(undefined); setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the default access.')
      try { receive(await agents.request<Settings>('spawn-settings-get')) } catch { /* Keep the failed save visible. */ }
    } finally { setBusy(false) }
  }
  return <div className="settings-control settings-spawn">
    <ListRow label="Spawned Codex agents" description="Default access for new Codex chats and workflow stages."
      trailing={<div className="settings-control-actions">
        <SettingsHelp label="Spawned Codex agents">Applies to Native Codex and is shared across browsers. Other providers and Codex ACP have separate approval settings. Override access in your launch request. Existing chats and scheduled workflows keep their selected access.</SettingsHelp>
        <Select label="Default access" hideLabel variant="outlined" value={mode} options={spawnDefaultModes.map((option) => ({ ...option }))}
          disabled={!connected || !settings || busy} onChange={(value) => { setDraft(value as SpawnDefaultMode); setSaved(false) }} />
        <Button variant="secondary" size="sm" aria-label="Save default access" disabled={!connected || !settings || busy || mode === settings.defaultMode} loading={busy} onPress={() => { void save() }}>Save</Button>
      </div>} />
    <p className="settings-note">{spawnDefaultModes.find((option) => option.id === mode)?.description}</p>
    {!connected && <p role="status">Connect to load the saved default. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    {error && <p role="alert">{error}</p>}
    <p className="settings-feedback" role="status">{busy ? 'Saving default access…' : saved ? 'Default access saved.' : ''}</p>
  </div>
}
