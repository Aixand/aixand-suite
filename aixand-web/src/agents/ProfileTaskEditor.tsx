import { accountStatusLabel, profileAccountLabel, saveProfileChanges } from './accountPresentation'
import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, DropdownMenu, Icon, SearchField, Select, StatusIndicator, Textarea, TextField } from 'bbb-design'
import type { AgentsModel } from './model'
import type { AgentJob, Auth, Profile } from './client'
import { resourceKey, resourceLabel, validDefaults } from './ResourcePicker'
import type { Defaults, Item, ResourceCatalog } from './ResourcePicker'
import { useProfileResources, profileResourceName } from './profileResources'
import { PageLoading } from '../components/PageLoading'
import { useResourceDraft } from '../resources/editor/drafts'
import { NewLoginButton } from './SavedLogins'
import { ClaudeAccounts } from './ClaudeAccounts'
import { SdkCredentials } from './SdkCredentials'
import { OperationStatus, isPendingOperation } from './AgentOperations'
import { useProfileModels } from './useProfileModels'
import { providerLabel } from './presentation'
import { PromptInputs } from '../prompts/PromptInputs'
import type { Catalog as PromptCatalog, InputContract } from '../prompts/model'

export type ProfileTask = 'account' | 'behavior' | 'resources'
const titles = { account: 'Account', behavior: 'Model & instructions', resources: 'Skills & tools' }
export function accountStatus(account?: Auth) {
  if (account?.state === 'unavailable') return "Couldn't check status"
  if (account?.state === 'credential-unavailable') return 'Saved credentials are unavailable'
  return account?.verification === 'verified' ? 'Account access verified' : account?.verification === 'failed'
    ? 'Sign-in required' : account?.verification === 'unsupported' ? 'Credentials configured · access not checked' : 'Account access not checked'
}

export function ProfileTaskEditor({ task, agents, profile, onClose, navigate }: {
  task: ProfileTask; agents: AgentsModel; profile: Profile; onClose: () => void; navigate: (route: string) => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [task])
  const [close, setClose] = useState<(() => void) | null>(null)
  const back = () => close ? close() : onClose()
  return <div className="carrier-reader-scroll"><section className="agent-task" aria-label={titles[task]}>
    <Button variant="ghost" size="sm" className="agent-task-back" onPress={back}><Icon name="chevron-left" />{profile.profile}</Button>
    <header><h2 ref={heading} tabIndex={-1}>{titles[task]}</h2><p>{task === 'account' ? 'Manage the account this profile uses.'
      : task === 'behavior' ? 'Model and guidance for new sessions.' : 'Additional skills and tools included in new sessions.'}</p></header>
    {task === 'account' ? <AccountEditor agents={agents} profile={profile} onClose={onClose} navigate={navigate} registerClose={setClose} />
      : <ConfigurationEditor key={task} task={task} agents={agents} profile={profile} onClose={onClose} registerClose={setClose} />}
  </section></div>
}

type EditorProps = { agents: AgentsModel; profile: Profile; onClose: () => void; registerClose: (close: (() => void) | null | ((old: (() => void) | null) => (() => void) | null)) => void }
function AccountEditor({ agents, profile, onClose, navigate, registerClose }: EditorProps & { navigate: (route: string) => void }) {
  const capability = agents.catalog?.capabilities.find(row => row.provider === profile.provider)
  const native = capability?.authMode === 'native'
  const accounts = agents.catalog?.auths.filter(row => row.provider === profile.provider) ?? []
  const [auth, setAuth] = useState(profile.auth ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [credentials, setCredentials] = useState(false)
  const job = agents.operations.filter(row => row.provider === profile.provider && (native ? row.profile === profile.profile : row.auth === auth)
    && ['check-login', 'reauthenticate', 'profile-login'].includes(row.kind)).sort((a, b) => b.createdAt - a.createdAt)[0]
  const pending = !!job && isPendingOperation(job)
  const disabled = busy || agents.status !== 'connected' || pending
  const current = accounts.find(row => row.auth === auth)
  const dirty = auth !== (profile.auth ?? '')
  const draft = useResourceDraft(dirty, busy)
  useEffect(() => { registerClose(() => () => draft.guard(onClose)); return () => registerClose(null) }, [draft.guard, onClose, registerClose])
  async function run(kind?: AgentJob['kind']) {
    if (disabled) return
    setBusy(true); setError('')
    try {
      if (kind) {
        await agents.request('agent-operation-start', { key: crypto.randomUUID(), provider: profile.provider, kind,
          ...(native ? { profile: profile.profile } : { auth }), ...(profile.provider === 'codex' && kind === 'reauthenticate' ? { device: true } : {}) })
        await agents.refreshOperations()
      } else {
        await saveProfileChanges(agents, profile, { auth: auth || null })
        await agents.refresh()
        draft.complete(onClose)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this account.') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (job?.status === 'succeeded') void agents.refresh()
  }, [job?.id, job?.status, agents.refresh])
  if (credentials) return <>
    <Button variant="ghost" size="sm" onPress={() => setCredentials(false)}><Icon name="chevron-left" />Account connection</Button>
    <SdkCredentials agents={agents} profile={profile} disabled={disabled} />
  </>
  return <div className="agent-task-form">
    {profile.provider === 'claude' ? <ClaudeAccounts agents={agents} profile={profile} disabled={disabled} navigate={navigate} />
      : native ? <section className="agent-task-section">
        <h3>{providerLabel(profile.provider)} sign-in</h3>
        <p>{capability?.homeScope === 'shared' ? 'These profiles share the provider’s settings and login. Signing in affects every profile using this provider.' : 'The provider manages sign-in. Its credential store or environment may be shared with other profiles.'}</p>
        <StatusIndicator tone={profile.readiness?.verification === 'failed' ? 'warning' : 'neutral'} label={profile.authentication ? accountStatusLabel(profile.authentication.terminal) : profile.readiness?.verification === 'verified' ? 'Account access verified' : 'Automatic status check unavailable'} />
        <Button disabled={disabled} onPress={() => void run('profile-login')}>Sign in to profile</Button>
      </section> : <form onSubmit={event => { event.preventDefault(); void run() }}>
        <div className="agent-current-value"><span className="agent-eyebrow">Current account</span><strong>{profileAccountLabel(profile)}</strong>
          <span>{accountStatus(accounts.find(row => row.auth === profile.auth))}</span></div>
        <Select variant="outlined" label="Saved account" value={auth} onChange={setAuth} disabled={disabled}
          options={[{ id: '', label: 'No saved account' }, ...accounts.map(row => ({ id: row.auth, label: row.auth, description: accountStatus(row) }))]} />
        {auth && <div className="agent-account-state"><p role="status">{accountStatus(current)}</p>
          {current?.verification !== 'verified' && current?.verification !== 'unsupported' && <Button variant="secondary" disabled={disabled}
            onPress={() => void run(current?.verification === 'failed' ? 'reauthenticate' : 'check-login')}>{current?.verification === 'failed' ? 'Sign in again' : 'Check account'}</Button>}</div>}
        <NewLoginButton agents={agents} provider={profile.provider} navigate={navigate} disabled={disabled} onCreated={setAuth} />
        <p className="carrier-muted">New sessions use the selected account. Existing sessions keep their current account.</p>
        <footer className="agent-task-actions"><Button variant="ghost" disabled={busy} onPress={() => draft.guard(onClose)}>Cancel</Button>
          <Button type="submit" disabled={disabled || !dirty || !!auth && current?.verification !== 'verified' && current?.verification !== 'unsupported'} loading={busy}>
            {auth ? 'Use ' + auth + ' account' : 'Clear saved account'}</Button></footer>
      </form>}
    {['claude', 'antigravity'].includes(profile.provider) && <Button className="agent-setup-row" variant="ghost" onPress={() => draft.guard(() => { setAuth(profile.auth ?? ''); setCredentials(true) })}>
      <span><strong>Chat authentication</strong><small>{profile.sdk_authentication === 'profile-login' ? 'Uses the selected provider account' : profile.sdk_credential?.name ?? 'Choose an API credential for SDK chats'}</small></span><Icon name="chevron-right" /></Button>}
    {job && <OperationStatus job={job} agents={agents} navigate={navigate} />}
    {error && <p role="alert" className="agents-error">{error}</p>}
    {draft.confirmation}
  </div>
}

function ConfigurationEditor({ task, agents, profile, onClose, registerClose }: EditorProps & { task: 'behavior' | 'resources' }) {
  const resources = useProfileResources(agents, profile)
  if (!resources.saved || !resources.catalog) return <div className="agent-task-section">
    {resources.loading ? <PageLoading label="Loading profile setup…" size="panel" /> : <><p role="alert">{resources.error || 'Connect to load this profile’s setup.'}</p>
      <Button variant="secondary" disabled={agents.status !== 'connected'} onPress={() => void resources.refresh()}>Try again</Button></>}
  </div>
  return <ConfigurationForm key={profile.id} {...{ task, agents, profile, onClose, registerClose }} saved={resources.saved} catalog={resources.catalog} />
}

function ConfigurationForm({ task, agents, profile, onClose, registerClose, saved: initial, catalog }: EditorProps & {
  task: 'behavior' | 'resources'; saved: Defaults; catalog: ResourceCatalog
}) {
  const [saved, setSaved] = useState(initial)
  const [value, setValue] = useState(initial)
  const [model, setModel] = useState(profile.model ?? '')
  const [savedModel, setSavedModel] = useState(profile.model ?? '')
  const [customModel, setCustomModel] = useState(false)
  const [inputs, setInputs] = useState(JSON.stringify(initial.instructions?.inputs ?? {}, null, 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  const [contracts, setContracts] = useState<Record<string, InputContract> | null>(null)
  const [inputEditor, setInputEditor] = useState(Object.keys(initial.instructions?.inputs ?? {}).length > 0)
  const capability = agents.catalog?.capabilities.find(row => row.provider === profile.provider)
  const models = useProfileModels(agents, task === 'behavior' && capability?.savedModels ? {
    id: profile.id, provider: profile.provider, profile: profile.profile, auth: profile.auth, cwd: agents.catalog?.cwd ?? '',
  } : undefined)
  const dirty = model !== savedModel || JSON.stringify(value) !== JSON.stringify(saved) || inputs !== JSON.stringify(saved.instructions?.inputs ?? {}, null, 2)
  const draft = useResourceDraft(dirty, busy)
  const disabled = busy || agents.status !== 'connected'
  const request = useRef(agents.request); request.current = agents.request
  const instructionIdentity = value.instructions ? resourceKey(value.instructions.target) : ''
  useEffect(() => { registerClose(() => () => draft.guard(onClose)); return () => registerClose(null) }, [draft.guard, onClose, registerClose])
  useEffect(() => {
    let active = true
    setContracts(null)
    if (task !== 'behavior' || !value.instructions) return
    void request.current<PromptCatalog>('prompts-catalog').then(result => {
      const reference = typeof value.instructions!.target === 'string' ? value.instructions!.target : value.instructions!.target.reference
      const prompt = result.packs?.flatMap(pack => pack.prompts.map(prompt => ({ ...prompt, reference: pack.reference + '/' + prompt.name }))).find(prompt => prompt.reference === reference)
      if (active && prompt) { setContracts(prompt.inputs ?? {}); if (Object.keys(prompt.inputs ?? {}).length) setInputEditor(true) }
    }).catch(() => { /* Managed prompts may not expose an input contract; preserve explicit JSON editing. */ })
    return () => { active = false }
  }, [instructionIdentity, task])
  async function save() {
    if (disabled || saving.current) return
    setError('')
    let parsed: Record<string, unknown> = {}
    try {
      if (task === 'behavior' && value.instructions) {
        parsed = JSON.parse(inputs)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Instruction inputs must be a JSON object.')
        for (const [name, spec] of Object.entries(contracts ?? {}))
          if (!(name in parsed) && !('default' in spec)) throw new Error('Enter a value for ' + name + '.')
      }
    } catch (cause) { setError(cause instanceof SyntaxError ? 'Check the instruction inputs: enter valid JSON.' : (cause as Error).message); return }
    saving.current = true; setBusy(true)
    let modelUpdated = false
    try {
      if (task === 'behavior' && capability?.savedModels && model.trim() !== savedModel) {
        await agents.request('set-model', { provider: profile.provider, profile: profile.profile, model: model.trim() || null })
        setSavedModel(model.trim()); setModel(model.trim()); modelUpdated = true
      }
      const next = task === 'behavior' ? { ...saved, instructions: value.instructions ? { ...value.instructions, inputs: parsed } : null }
        : { ...saved, skills: value.skills, mcp: value.mcp }
      const { revision: _revision, ...bindings } = next
      if (JSON.stringify(next) !== JSON.stringify(saved)) {
        const result = await agents.request<Defaults>('profile-resources-set', { provider: profile.provider, profile: profile.profile, expectedRevision: saved.revision, resources: bindings })
        setSaved(result); setValue(result)
      }
      await agents.refresh()
      draft.complete(onClose)
    } catch (cause) { setError((modelUpdated ? 'The model was saved. ' : '') + (cause instanceof Error ? cause.message : 'Could not save this setup.')) }
    finally { saving.current = false; setBusy(false) }
  }
  async function reloadSaved() {
    if (disabled || saving.current) return
    setBusy(true); setError('')
    try {
      const next = await agents.request<Defaults>('profile-resources-get', { provider: profile.provider, profile: profile.profile })
      validDefaults(next)
      setSaved(next); setValue(next); setInputs(JSON.stringify(next.instructions?.inputs ?? {}, null, 2))
      setModel(savedModel)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reload this setup.') }
    finally { setBusy(false) }
  }
  const instructionChoices = [...catalog.choices.instructions]
  if (value.instructions && !instructionChoices.some(row => resourceKey(row.target) === instructionIdentity))
    instructionChoices.push({ label: resourceLabel(value.instructions.target), target: value.instructions.target })
  return <form className="agent-task-form" onSubmit={event => { event.preventDefault(); void save() }}>
    {task === 'behavior' ? <>
      <section className="agent-task-section"><h3>Model</h3>
        {capability?.savedModels ? <>
          <Select variant="outlined" label="Default model" value={customModel ? '@custom' : model} disabled={disabled}
            options={[{ id: '', label: 'Provider default' }, ...models.models.map(row => ({ id: row.id, label: row.name, description: row.description })),
              ...(!models.models.some(row => row.id === model) && model ? [{ id: model, label: model }] : []), { id: '@custom', label: 'Enter a model ID…' }]}
            onChange={next => { setCustomModel(next === '@custom'); if (next !== '@custom') setModel(next) }} />
          {models.loading && <p role="status" className="carrier-muted">Loading available models…</p>}
          {models.error && <p className="carrier-muted">Available models could not be loaded. You can enter a model ID.</p>}
          {customModel && <TextField variant="outlined" label="Model ID" value={model} disabled={disabled} onChange={event => setModel(event.target.value)} />}
        </> : <div className="agent-current-value"><strong>Provider default</strong><span>The model is managed in {providerLabel(profile.provider)}.</span></div>}
      </section>
      <section className="agent-task-section"><h3>Instructions</h3>
        <Select variant="outlined" label="Instructions" value={instructionIdentity || '@none'} disabled={disabled}
          options={[{ id: '@none', label: 'No additional instructions' }, ...instructionChoices.map(row => ({ id: resourceKey(row.target), label: row.label, description: row.description }))]}
          onChange={key => {
            const choice = instructionChoices.find(row => resourceKey(row.target) === key)
            setValue(current => ({ ...current, instructions: choice ? { target: choice.target, required: false, inputs: {} } : null }))
            setInputs('{}'); setInputEditor(false)
          }} />
        {value.instructions && <>
          {instructionChoices.find(row => resourceKey(row.target) === instructionIdentity)?.description && <p>{instructionChoices.find(row => resourceKey(row.target) === instructionIdentity)?.description}</p>}
          <Checkbox label="Require these instructions" description="These instructions must be available before a session can start." disabled={disabled}
            isSelected={value.instructions.required ?? false} onChange={required => setValue(current => ({ ...current, instructions: { ...current.instructions!, required } }))} />
          {inputEditor ? contracts && Object.keys(contracts).length ? <PromptInputs contracts={contracts} value={inputs} onChange={setInputs} disabled={disabled} label="Instruction inputs" />
            : <Textarea variant="outlined" label="Instruction inputs (JSON)" value={inputs} rows={5} disabled={disabled} onChange={event => setInputs(event.target.value)} hint="Values passed to these instructions." />
            : <Button variant="ghost" size="sm" onPress={() => setInputEditor(true)}>Configure instruction inputs</Button>}
        </>}
      </section>
    </> : (['skills', 'mcp'] as const).map(kind => <AttachedResources key={kind} kind={kind} catalog={catalog} items={value[kind]} disabled={disabled}
      onChange={items => setValue(current => ({ ...current, [kind]: items }))} />)}
    {Object.entries(catalog.integrations ?? {}).filter(([kind, row]) => !row.available && (task === 'resources' ? kind !== 'instructions' : kind === 'instructions')).map(([kind, row]) =>
      <p key={kind} role="status" className="carrier-muted">{row.reason?.message || row.manager + ' is unavailable.'} Saved assignments are retained.</p>)}
    {error && <div><p className="agents-error" role="alert">{error}</p>
      <Button variant="secondary" disabled={disabled} onPress={() => draft.guard(() => void reloadSaved())}>Reload saved setup</Button></div>}
    <p className="carrier-muted">Changes apply to new sessions. Existing sessions keep their saved configuration.</p>
    <footer className="agent-task-actions"><Button variant="ghost" disabled={busy} onPress={() => draft.guard(onClose)}>Cancel</Button>
      <Button type="submit" disabled={disabled || !dirty} loading={busy}>Save changes</Button></footer>
    {draft.confirmation}
  </form>
}

function AttachedResources({ kind, catalog, items, onChange, disabled }: {
  kind: 'skills' | 'mcp'; catalog: ResourceCatalog; items: Item[]; onChange: (items: Item[]) => void; disabled: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const title = kind === 'skills' ? 'Skills' : 'Tools'
  const available = catalog.choices[kind].filter(row => !items.some(item => resourceKey(item.target) === resourceKey(row.target))
    && (row.label + ' ' + (row.description ?? '')).toLowerCase().includes(query.toLowerCase()))
  return <section className="agent-task-section" aria-label={title}>
    <div className="agent-section-heading"><h3>{title}</h3><Button variant="ghost" size="sm" disabled={disabled} onPress={() => { setAdding(!adding); setQuery('') }}>{adding ? 'Done adding' : 'Add ' + title.toLowerCase()}</Button></div>
    {items.length ? <ul className="agent-attached-list">{items.map(item => {
      const key = resourceKey(item.target)
      const choice = catalog.choices[kind].find(row => resourceKey(row.target) === key)
      return <li key={key}><div><strong>{profileResourceName(catalog, kind, item.target)}</strong>
        {choice?.description && <p>{choice.description}</p>}<small>{item.required ? 'Required to start a session' : 'Optional'}</small>
        {!choice && <p className="agent-inline-warning">Not available in the current library. The saved assignment is retained.</p>}
        {choice?.installation?.installation_required && <p className="agent-inline-warning">Setup required. <a href="#/agents/tools">Open tool setup</a></p>}
        {choice?.reconciliation_required && <p className="agent-inline-warning">An update needs review in the library.</p>}
      </div><DropdownMenu label={'Actions for ' + profileResourceName(catalog, kind, item.target)}
        trigger={<Button iconOnly size="sm" variant="ghost" aria-label={'Actions for ' + profileResourceName(catalog, kind, item.target)} disabled={disabled}><Icon name="ellipsis" /></Button>}
        items={[{ id: 'required', label: item.required ? 'Make optional' : 'Require for new sessions' }, { id: 'remove', label: 'Remove from profile' }]}
        onAction={action => onChange(action === 'remove' ? items.filter(row => resourceKey(row.target) !== key) : items.map(row => resourceKey(row.target) === key ? { ...row, required: !row.required } : row))} /></li>
    })}</ul> : <p className="carrier-muted">No {title.toLowerCase()} attached.</p>}
    {adding && <div className="agent-resource-choices"><SearchField label={'Search ' + title.toLowerCase()} placeholder={'Search ' + title.toLowerCase() + '…'} value={query} onChange={setQuery} />
      <div className="agent-resource-choice-list">{available.map(row => <Button variant="ghost" key={resourceKey(row.target)} disabled={disabled} onPress={() => onChange([...items, { target: row.target, required: false }])}>
        <span><strong>{row.label}</strong>{row.description && <small>{row.description}</small>}</span><span>Add</span></Button>)}</div>
      {!available.length && <p className="carrier-muted">{query ? 'No matching ' + title.toLowerCase() + '.' : 'No more ' + title.toLowerCase() + ' available to attach.'}</p>}
    </div>}
  </section>
}
