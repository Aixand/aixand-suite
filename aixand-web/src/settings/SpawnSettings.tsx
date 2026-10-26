import { useEffect, useRef, useState } from 'react'
import { Button, Card, Select } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { spawnDefaultModes } from '../agents/permissions'
import type { SpawnDefaultMode, SpawnSettings as Settings } from '../agents/permissions'
import { useContentFieldVariant } from '../branding/ContentTheme'

export function SpawnSettings({ agents }: { agents: AgentsModel }) {
  const fieldVariant = useContentFieldVariant()
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
  return <Card as="section" className="ws-panel settings-spawn" title="Spawned agents" headingLevel={2}>
    <p>Choose the default access for new chats and workflow stages spawned from a chat. This preference is shared across browsers. It also applies to audit and review stages.</p>
    <Select label="Default access" variant={fieldVariant} value={mode} options={spawnDefaultModes.map((option) => ({ ...option }))}
      disabled={!connected || !settings || busy} onChange={(value) => { setDraft(value as SpawnDefaultMode); setSaved(false) }} />
    <p className="settings-help">{spawnDefaultModes.find((option) => option.id === mode)?.description}</p>
    <p className="settings-help">Override it for one launch by asking, for example, “Spawn this agent with read-only access.” Existing chats and already scheduled workflows keep their selected access.</p>
    <Button disabled={!connected || !settings || busy || mode === settings.defaultMode} loading={busy} onPress={() => { void save() }}>Save default access</Button>
    {!connected && <p role="status">Connect to load the saved default. <Button variant="ghost" onPress={agents.connect}>Reconnect</Button></p>}
    {error && <p role="alert">{error}</p>}
    <p className="settings-feedback" role="status">{busy ? 'Saving default access…' : saved ? 'Default access saved.' : ''}</p>
  </Card>
}
