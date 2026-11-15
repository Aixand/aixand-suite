import { randomUUID } from '../uuid'
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Select, TextField } from 'bbb-design'
import type { AgentsModel } from './model'
import type { SdkCredential } from './client'
import { providerLabel } from './presentation'
import { availableSetupName } from './providerSetupDraft'
import { nameError } from './names'

type Connection = { id: string; label: string; auth?: string; claudeAccountId?: string; sdkCredential?: string }

export function NewProfile({ agents, onClose, navigate }: {
  agents: AgentsModel; onClose: () => void; navigate: (route: string) => void
}) {
  const providers = agents.catalog?.capabilities ?? []
  const [provider, setProvider] = useState(providers[0]?.provider ?? '')
  const [connections, setConnections] = useState<Connection[]>([])
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const attempt = useRef({ signature: '', key: '' })
  const names = agents.catalog?.profiles.filter(row => row.provider === provider).map(row => row.profile) ?? []
  const validation = nameError(name, names, undefined, true)
  useEffect(() => {
    let active = true
    setSelected(''); setConnections([]); setError(''); setLoading(true)
    setName(availableSetupName('work', agents.catalog?.profiles.filter(row => row.provider === provider).map(row => row.profile) ?? []))
    async function load() {
      const catalog = agents.catalog
      const preferred = catalog?.profiles.find(row => row.provider === provider && row.preferred)
      const rows: Connection[] = (catalog?.auths ?? []).filter(row => row.provider === provider && row.verification !== 'failed')
        .map(row => ({ id: 'saved:' + row.auth, label: row.auth, auth: row.auth }))
      if (provider === 'claude') {
        const inventory = await agents.request<{ accounts: { id: string; name: string }[] }>('claude-accounts', {})
        rows.push(...inventory.accounts.map(row => ({ id: 'native:' + row.id, label: row.name + ' · Claude account', claudeAccountId: row.id })))
      }
      if (['claude', 'antigravity'].includes(provider)) {
        const credentials = await agents.request<SdkCredential[]>('sdk-credentials-list', { provider })
        rows.push(...credentials.map(row => ({ id: 'sdk:' + row.id, label: row.name + ' · Chat credential', sdkCredential: row.name })))
      }
      if (active) {
        setConnections(rows)
        const preferredId = rows.find(row => row.auth && row.auth === preferred?.auth || row.claudeAccountId && row.claudeAccountId === preferred?.claude_account?.id || row.sdkCredential && row.sdkCredential === preferred?.sdk_credential?.name)?.id
        setSelected(preferredId ?? (rows.length === 1 ? rows[0].id : ''))
      }
    }
    void load().catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load accounts.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [provider, agents.request])
  async function continueSetup() {
    const connection = connections.find(row => row.id === selected)
    if (!connection) {
      navigate('agents/providers?' + new URLSearchParams({ provider, setup: 'profile', flow: randomUUID() }))
      return
    }
    if (validation) return
    setBusy(true); setError('')
    try {
      const { id: _id, label: _label, ...assignment } = connection
      const signature = JSON.stringify([provider, name.trim(), assignment])
      if (attempt.current.signature !== signature) attempt.current = { signature, key: randomUUID() }
      const result = await agents.request<{ status?: string; assignmentError?: string }>('create-profile', {
        key: attempt.current.key, provider, profile: name.trim(), ...assignment,
      })
      if (result.status === 'uncertain' || result.assignmentError) throw new Error(result.assignmentError || 'Profile creation is unconfirmed. Refresh profiles before retrying.')
      await agents.refresh()
      navigate('agents/profiles?' + new URLSearchParams({ profile: provider + '/' + name.trim() }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create the profile.') }
    finally { setBusy(false) }
  }
  return <div className="carrier-reader-scroll"><section className="agent-task" aria-label="New agent profile">
    <Button className="agent-task-back" variant="ghost" size="sm" onPress={onClose}><Icon name="chevron-left" />Profiles</Button>
    <header><h2 tabIndex={-1}>New profile</h2><p>Choose the provider and account this profile will use.</p></header>
    <form className="agent-task-form" onSubmit={event => { event.preventDefault(); if (provider) void continueSetup() }}>
      <Select variant="outlined" label="Provider" value={provider} onChange={setProvider} disabled={busy || agents.status !== 'connected'}
        options={providers.map(row => ({ id: row.provider, label: row.label ?? providerLabel(row.provider), description: row.installed ? 'Installed' : 'Setup required' }))} />
      {!!connections.length && <Select variant="outlined" label="Account or credential" value={selected} onChange={setSelected} disabled={busy || loading}
        options={[...connections.map(row => ({ id: row.id, label: row.label })), { id: '', label: 'Set up another connection' }]} />}
      {selected && <TextField variant="outlined" label="Profile name" value={name} onChange={event => setName(event.target.value)}
        error={validation || undefined} disabled={busy} required />}
      <p className="carrier-muted">Existing accounts can be shared by multiple profiles. Creating another profile keeps your preferred profile unchanged.</p>
      {error && <p role="alert">{error}</p>}
      <footer className="agent-task-actions"><Button variant="ghost" disabled={busy} onPress={onClose}>Cancel</Button>
        <Button type="submit" disabled={!provider || busy || loading || !!selected && !!validation || agents.status !== 'connected'}>{selected ? 'Create profile' : 'Continue'}<Icon name="arrow-right" /></Button></footer>
    </form>
  </section></div>
}
