import { randomUUID } from '../uuid'
import { saveProfileChanges } from './accountPresentation'
import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { Button, DropdownMenu, Icon, TextField } from 'bbb-design'
import { ProfileSelect as Select } from './ProfileSelect'
import { useContentFieldVariant } from '../branding/ContentTheme'
import type { AgentsModel } from './model'
import type { AgentJob, Auth, Profile } from './client'
import { useResourceDraft } from '../resources/editor/drafts'
import { LoginSheet } from './SavedLogins'
import { ClaudeAccounts } from './ClaudeAccounts'
import { SdkCredentials } from './SdkCredentials'
import { OperationStatus, isPendingOperation } from './AgentOperations'
import { useProfileModels } from './useProfileModels'
import { providerLabel } from './presentation'
import { ProfileConnections } from './ProfileConnections'
import { ProfileStatus } from './ProfileControls'

type SettingsProps = { agents: AgentsModel; profile: Profile }
type DraftState = { dirty: boolean; busy: boolean }
type DraftReporter = Dispatch<SetStateAction<DraftState>>

function accountStatus(account?: Auth) {
  if (account?.state === 'unavailable') return "Couldn't check status"
  if (account?.state === 'credential-unavailable') return 'Saved credentials are unavailable'
  return account?.verification === 'verified' ? 'Account access verified' : account?.verification === 'failed'
    ? 'Sign-in required' : account?.verification === 'unsupported' ? 'Credentials configured · access not checked' : 'Account access not checked'
}

export function ProfileSettings({ agents, profile, navigate }: SettingsProps & { navigate: (route: string) => void }) {
  const [account, setAccount] = useState<DraftState>({ dirty: false, busy: false })
  const [configuration, setConfiguration] = useState<DraftState>({ dirty: false, busy: false })
  // One guard covers the whole page, including drafts in several sections at once.
  const draft = useResourceDraft(account.dirty || configuration.dirty, account.busy || configuration.busy)
  return <>
    <AccountSettings agents={agents} profile={profile} navigate={navigate} onDraftChange={setAccount} />
    <ConfigurationSettings agents={agents} profile={profile} onDraftChange={setConfiguration} guard={draft.guard} />
    <section className="agent-settings-group" aria-label="Resource libraries">
      <h3 className="agent-settings-heading">Resource libraries</h3>
      <p className="carrier-muted">Choose instructions and MCP tools when starting a chat. Skills are managed in the library; chat delivery support is shown at launch.</p>
      <div className="agent-setting-controls">{(['prompts', 'skills', 'tools'] as const).map((section, index) =>
        <Button key={section} variant="secondary" size="sm" onPress={() => draft.guard(() => navigate('agents/' + section))}>{['Prompts', 'Skills', 'Tools (MCP)'][index]}</Button>)}</div>
    </section>
    {draft.confirmation}
  </>
}

function AccountSettings({ agents, profile, navigate, onDraftChange }: SettingsProps & {
  navigate: (route: string) => void; onDraftChange: DraftReporter
}) {
  const capability = agents.catalog?.capabilities.find(row => row.provider === profile.provider)
  const native = capability?.authMode === 'native' || profile.authMode === 'native'
  const accounts = agents.catalog?.auths.filter(row => row.provider === profile.provider) ?? []
  const [auth, setAuth] = useState(profile.auth ?? '')
  const [claudeDirty, setClaudeDirty] = useState(false)
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [sdkDirty, setSdkDirty] = useState(false)
  const [sdkBusy, setSdkBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const accountActions = useRef<HTMLButtonElement>(null)
  const fieldVariant = useContentFieldVariant()
  const job = agents.operations.filter(row => row.provider === profile.provider && (native ? row.profile === profile.profile : row.auth === auth)
    && ['check-login', 'reauthenticate', 'profile-login'].includes(row.kind)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const pending = !!job && isPendingOperation(job)
  const disabled = busy || agents.status !== 'connected' || pending
  const current = accounts.find(row => row.auth === auth)
  const dirty = profile.provider === 'claude' ? claudeDirty : !native && auth !== (profile.auth ?? '')
  useEffect(() => { onDraftChange({ dirty: dirty || sdkDirty, busy: busy || claudeBusy || sdkBusy }); return () => onDraftChange({ dirty: false, busy: false }) }, [dirty, sdkDirty, busy, claudeBusy, sdkBusy, onDraftChange])
  useEffect(() => { setAuth(profile.auth ?? '') }, [profile.auth])
  async function run(kind?: AgentJob['kind']) {
    if (disabled) return
    setBusy(true); setError('')
    try {
      if (kind) {
        await agents.request('agent-operation-start', { key: randomUUID(), provider: profile.provider, kind,
          ...(native ? { profile: profile.profile } : { auth }), ...(profile.provider === 'codex' && kind === 'reauthenticate' ? { device: true } : {}) })
        await agents.refreshOperations()
      } else {
        await saveProfileChanges(agents, profile, { auth: auth || null })
        await agents.refresh()
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this account.') }
    finally { setBusy(false) }
  }
  useEffect(() => { if (job?.status === 'succeeded') void agents.refresh() }, [job?.id, job?.status, agents.refresh])
  const status = accountStatus(current)
  return <section className="agent-settings-group agent-account-settings" aria-label="Account">
    <h3 className="agent-settings-heading">Account & access</h3>
    {profile.provider === 'claude' ? <div className="agent-setting-row"><h3>Account</h3><div className="agent-setting-content">
      <ClaudeAccounts agents={agents} profile={profile} disabled={disabled} navigate={navigate} compact onDirtyChange={setClaudeDirty} onBusyChange={setClaudeBusy} />
    </div></div> : native ? <div className="agent-setting-row"><h3>Account</h3><div className="agent-setting-content">
      <div className="agent-setting-controls"><span>Provider-managed login</span>
        {!profile.authentication && <ProfileStatus label={profile.readiness?.verification === 'verified' ? 'Account access verified' : 'Account access not checked'}
          tone={profile.readiness?.verification === 'verified' ? 'success' : 'neutral'} />}
        <Button variant="secondary" size="sm" disabled={disabled} onPress={() => void run('profile-login')}>Sign in</Button>
      </div>
      {capability?.homeScope === 'shared' && <p className="carrier-muted">Sign-in is shared across this provider’s profiles.</p>}
    </div></div> : <form onSubmit={event => { event.preventDefault(); void run() }}>
      <div className="agent-setting-row"><h3>Account</h3><div className="agent-setting-content">
        <div className="agent-setting-controls"><Select variant={fieldVariant} label="Saved account" hideLabel value={auth} onChange={setAuth} disabled={disabled}
          options={[{ id: '', label: 'No saved account' }, ...accounts.map(row => ({ id: row.auth, label: row.auth, description: accountStatus(row) }))]} />
          {!profile.authentication && auth && <ProfileStatus label={status} tone={pending ? 'pending' : current?.verification === 'verified' ? 'success' : current?.verification === 'failed' ? 'warning' : 'neutral'} />}
          <DropdownMenu label="Account actions" trigger={<Button ref={accountActions} iconOnly variant="ghost" size="sm" disabled={disabled} aria-label="Account actions"><Icon name="ellipsis" /></Button>}
            items={[{ id: 'connect', label: 'Connect another account' }, { id: 'check', label: 'Refresh account status', disabled: !auth },
              { id: 'signin', label: 'Sign in again', disabled: !auth }]}
            onAction={action => { if (action === 'connect') setConnecting(true); else void run(action === 'check' ? 'check-login' : 'reauthenticate') }} />
        </div>
        {auth && current?.verification !== 'verified' && current?.verification !== 'unsupported' && <div className="agent-account-state">
          <Button variant="secondary" size="sm" disabled={disabled}
            onPress={() => void run(current?.verification === 'failed' ? 'reauthenticate' : 'check-login')}>{current?.verification === 'failed' ? 'Sign in again' : 'Check account'}</Button>
        </div>}
        {dirty && <div className="agent-setting-actions"><Button variant="ghost" size="sm" disabled={busy} onPress={() => setAuth(profile.auth ?? '')}>Cancel</Button>
          <Button type="submit" size="sm" aria-label="Save account" disabled={disabled || !!auth && current?.verification !== 'verified' && current?.verification !== 'unsupported'} loading={busy}>Save</Button></div>}
      </div></div>
    </form>}
    {connecting && <LoginSheet modal agents={agents} navigate={navigate} mode="new" initialProvider={profile.provider}
      open onUseLogin={setAuth} onClose={() => { setConnecting(false); requestAnimationFrame(() => accountActions.current?.focus()) }} />}
    {['claude', 'antigravity'].includes(profile.provider) && <div className="agent-setting-row"><h3>Chat API key</h3><div className="agent-setting-content">
      <SdkCredentials agents={agents} profile={profile} disabled={disabled} compact onDirtyChange={setSdkDirty} onBusyChange={setSdkBusy} />
    </div></div>}
    <ProfileConnections agents={agents} profile={profile} preference />
    {job && <OperationStatus job={job} agents={agents} navigate={navigate} />}
    {error && <p role="alert" className="agents-error">{error}</p>}
  </section>
}

function ConfigurationSettings({ agents, profile, onDraftChange }: SettingsProps & { onDraftChange: DraftReporter; guard: (action: () => void) => void }) {
  const capability = agents.catalog?.capabilities.find(row => row.provider === profile.provider)
  const fieldVariant = useContentFieldVariant()
  const [model, setModel] = useState(profile.model ?? '')
  const [savedModel, setSavedModel] = useState(profile.model ?? '')
  const [custom, setCustom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = model !== savedModel
  const models = useProfileModels(agents, capability?.savedModels ? {
    id: profile.id, provider: profile.provider, profile: profile.profile, auth: profile.auth,
    revision: profile.revision, cwd: agents.catalog?.cwd ?? '',
  } : undefined)
  useEffect(() => {
    onDraftChange({ dirty, busy })
    return () => onDraftChange({ dirty: false, busy: false })
  }, [dirty, busy, onDraftChange])
  useEffect(() => {
    if (!dirty && !busy) { setModel(profile.model ?? ''); setSavedModel(profile.model ?? '') }
  }, [profile.model, dirty, busy])
  async function save() {
    if (busy || agents.status !== 'connected') return
    setBusy(true); setError('')
    try {
      const value = model.trim()
      await saveProfileChanges(agents, profile, { model: value || null })
      await agents.refresh()
      setModel(value); setSavedModel(value)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the default model.') }
    finally { setBusy(false) }
  }
  const disabled = busy || agents.status !== 'connected'
  return <section className="agent-settings-group" aria-label="Profile defaults">
    <h3 className="agent-settings-heading">Defaults</h3>
    <div className="agent-setting-row"><h3>Model</h3><div className="agent-setting-content">
      {capability?.savedModels ? <>
        <Select variant={fieldVariant} label="Default model" hideLabel value={custom ? '@custom' : model} disabled={disabled}
          options={[{ id: '', label: 'Provider default' }, ...models.models.map(row => ({ id: row.id, label: row.name, description: row.description ?? undefined })),
            ...(!models.models.some(row => row.id === model) && model ? [{ id: model, label: model }] : []), { id: '@custom', label: 'Enter a model ID…' }]}
          onChange={value => { setCustom(value === '@custom'); if (value !== '@custom') setModel(value) }} />
        {models.loading && <span role="status" className="carrier-muted">Loading models…</span>}
        {models.error && <p className="carrier-muted">Couldn’t load models. Enter a model ID to continue.</p>}
        {custom && <TextField variant={fieldVariant} label="Model ID" value={model} disabled={disabled} onChange={event => setModel(event.target.value)} />}
      </> : <div className="agent-setting-controls"><span className="carrier-muted">Provider default</span><ProfileStatus label={'The model is managed in ' + providerLabel(profile.provider) + '.'} /></div>}
      {dirty && <div className="agent-setting-actions"><Button variant="ghost" size="sm" disabled={busy} onPress={() => { setModel(savedModel); setCustom(false); setError('') }}>Cancel</Button>
        <Button size="sm" aria-label="Save default model" disabled={disabled} loading={busy} onPress={() => void save()}>Save</Button></div>}
      {error && <p className="agents-error" role="alert">{error}</p>}
    </div></div>
  </section>
}
