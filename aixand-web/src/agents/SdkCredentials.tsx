import { saveProfileChanges, type ProfileChanges } from './accountPresentation'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { useEffect, useRef, useState } from 'react'
import { Button, PasswordField, Select, TextField } from 'bbb-design'
import type { AgentsModel } from './model'
import type { Profile, SdkCredential } from './client'
import { useBackendDiscovery } from './useBackendDiscovery'

export function SdkCredentials({ agents, profile, disabled, onSelectionChange }: { agents: AgentsModel; profile: Profile; disabled: boolean; onSelectionChange?: (changes: ProfileChanges) => void }) {
  const fieldVariant = useContentFieldVariant()
  const [credentials, setCredentials] = useState<SdkCredential[]>([])
  const [selected, setSelected] = useState(profile.sdk_credential?.name ?? '')
  const [method, setMethod] = useState(profile.sdk_authentication ?? 'api-key')
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discovering, setDiscovering] = useState(false)
  const discovery = useBackendDiscovery(agents, discovering ? { provider: profile.provider, profile: profile.profile,
    backend: `${profile.provider}-sdk` } : undefined)
  const request = useRef(agents.request)
  request.current = agents.request
  useEffect(() => {
    let active = true
    request.current<SdkCredential[]>('sdk-credentials-list', { provider: profile.provider })
      .then(rows => { if (active) setCredentials(rows) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load API credentials.') })
    return () => { active = false }
  }, [profile.provider])
  useEffect(() => { setSelected(profile.sdk_credential?.name ?? '') }, [profile.sdk_credential?.name])
  useEffect(() => { setMethod(profile.sdk_authentication ?? 'api-key') }, [profile.sdk_authentication])

  async function saveMethod() {
    setBusy(true); setError(''); setNotice('')
    try {
      await saveProfileChanges(agents, profile, { sdkAuthentication: method, ...(method === 'api-key' ? { sdkCredential: selected || null } : {}) })
      await agents.refresh()
      setNotice(method === 'profile-login' ? 'Claude Code login selected for new SDK chats.' : 'API credential authentication selected for new SDK chats.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save SDK authentication.')
    } finally { setApiKey(''); setBusy(false) }
  }

  async function assign(credentialName: string | null) {
    if (onSelectionChange) { onSelectionChange({ sdkCredential: credentialName, ...(profile.provider === 'claude' ? { sdkAuthentication: method } : {}) }); return }
    await saveProfileChanges(agents, profile, { sdkCredential: credentialName,
      ...(profile.provider === 'claude' ? { sdkAuthentication: method } : {}) })
    await agents.refresh()
  }

  async function save() {
    if (!name.trim() || !apiKey.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const existing = credentials.find(row => row.name === name.trim())
      const saved = await agents.request<SdkCredential>('sdk-credential-save', { provider: profile.provider,
        name: name.trim(), method: 'api-key', apiKey: apiKey.trim(), ...(existing ? { expectedRevision: existing.revision } : {}) })
      setApiKey('')
      await assign(saved.name)
      setCredentials(await agents.request<SdkCredential[]>('sdk-credentials-list', { provider: profile.provider }))
      setSelected(saved.name); setName(''); setNotice(onSelectionChange ? 'API credential saved. Save profile to apply its assignment.' : 'API credential saved and assigned.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save API credential.')
    } finally { setApiKey(''); setBusy(false) }
  }

  return <section className="agents-sheet-form" aria-label={profile.provider === 'claude' ? 'SDK authentication' : 'Chat API credentials'}>
    {profile.provider === 'claude' && <>
      <Select variant={fieldVariant} label="Authentication method" value={method} disabled={disabled || busy}
        options={[{ id: 'profile-login', label: 'Use the selected Claude account' }, { id: 'api-key', label: 'Use an API credential' }]}
        onChange={value => { setMethod(value as typeof method); onSelectionChange?.({ sdkAuthentication: value as typeof method }); setApiKey(''); setError(''); setNotice('') }} />
      {!onSelectionChange && <Button type="button" variant="secondary" disabled={disabled || busy} onPress={() => { void saveMethod() }}>Save chat authentication</Button>}
    </>}
    {profile.provider === 'claude' && method === 'profile-login' ? <p>Uses the Claude account selected above. Claude manages sign-in and credentials. Subscription sign-in uses plan limits; API billing uses the corresponding API balance. Existing chats retain their selected authentication.</p> : <>
    <p>Choose the API credential used by this profile’s SDK chats.</p>
    <Select variant={fieldVariant} label="Assigned credential" value={selected} disabled={disabled || busy}
      options={[{ id: '', label: 'None' }, ...credentials.map(row => ({ id: row.name, label: row.name }))]} onChange={value => { setSelected(value); onSelectionChange?.({ sdkCredential: value || null }) }} />
    {!onSelectionChange && profile.provider !== 'claude' && <Button type="button" variant="secondary" disabled={disabled || busy} onPress={() => {
      setBusy(true); setError(''); setNotice('')
      void assign(selected || null).then(() => setNotice('API credential assignment saved.'))
        .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not assign credential.')).finally(() => setBusy(false))
    }}>Save assignment</Button>}
    <TextField variant={fieldVariant} label="Credential name" value={name} autoComplete="off" disabled={disabled || busy} onChange={event => setName(event.target.value)} />
    <PasswordField variant={fieldVariant} label={profile.provider === 'claude' ? 'Anthropic API key' : 'Gemini API key'} value={apiKey}
      showLabel="Show API key" hideLabelText="Hide API key"
      autoComplete="new-password" disabled={disabled || busy} onChange={event => setApiKey(event.target.value)} />
    <Button type="button" disabled={disabled || busy || !name.trim() || !apiKey.trim()} onPress={() => { void save() }}>Save and assign API key</Button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="agents-error">{error}</p>}
    <Button type="button" variant="secondary" disabled={disabled || busy || discovery.loading}
      onPress={() => { setDiscovering(true); discovery.refresh() }}>Refresh discovery</Button>
    {discovering && <p role="status">{discovery.error || (discovery.loading ? 'Discovering available models and settings…' :
      discovery.snapshot?.discoveredAt ? `Discovered at ${new Date(discovery.snapshot.discoveredAt).toLocaleTimeString()}` : 'Discovery has not completed.')}</p>}
  </section>
}
