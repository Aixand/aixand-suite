import { randomUUID } from '../uuid'
import { useContentFieldVariant } from '../branding/ContentTheme'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Card, Checkbox, DescriptionList, DropdownMenu, EmptyState, Icon, SearchField, Select, TextField } from 'bbb-design'
import { PaneForm } from './AgentWorkspace'
import type { WorkspaceRenderer } from './AgentWorkspace'
import { AgentError, type AgentJob, type Auth, type Provider } from './client'
import type { AgentsModel } from './model'
import { isPendingOperation, OperationStatus } from './AgentOperations'
import { loginHasActiveRuns, providerLabel } from './presentation'
import { nameError } from './names'
import { allowanceSummary, AllowanceReadings } from './allowance'
import { ProfileStatus } from './ProfileControls'

type LoginMode = 'details' | 'new' | 'import' | 'rename' | 'assign' | 'remove' | 'reauthenticate'
const loginStatus = (auth: Auth) => auth.verification === 'verified' ? 'Account access verified'
  : auth.verification === 'failed' ? 'Account check failed' : auth.verification === 'unsupported'
    ? 'Login saved locally · Account verification unavailable' : 'Account access not checked'

export function LoginSheet({ agents: a, navigate, login, mode: initialMode, open, onClose, initialProvider = 'codex', onUseLogin, inline, modal, onRenamed }: {
  agents: AgentsModel; navigate: (route: string) => void; login?: Auth; mode: LoginMode
  open: boolean; onClose: (removed?: boolean) => void; initialProvider?: Provider
  onUseLogin?: (auth: string) => void
  inline?: boolean
  modal?: boolean
  onRenamed?: (auth: string) => void
}) {
  const fieldVariant = useContentFieldVariant()
  const [mode, setMode] = useState(initialMode)
  const [provider, setProvider] = useState<Provider>(login?.provider ?? initialProvider)
  const [name, setName] = useState(initialMode === 'rename' ? login?.auth ?? '' : '')
  const [device, setDevice] = useState(true)
  const [selected, setSelected] = useState(login?.profiles ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (waiting && login?.auth_id && a.catalog?.auths.some((row) => row.auth_id === login.auth_id && row.auth === name.trim())) {
      if (onRenamed) onRenamed(name.trim())
      else onClose()
    }
  }, [waiting, login?.auth_id, a.catalog, name, onRenamed, onClose])
  const [jobId, setJobId] = useState<string | null>(null)
  const [removed, setRemoved] = useState(false)
  const formId = useId()
  const pending = useRef(false)
  const renameTrigger = useRef<HTMLButtonElement>(null)
  const signInTrigger = useRef<HTMLButtonElement>(null)
  const [activity, setActivity] = useState(false)
  const current = login && (a.catalog?.auths.find((item) => item.provider === login.provider && item.auth === login.auth) ?? login)
  const creating = mode === 'new' || mode === 'import'
  const canDismiss = !busy || creating || mode === 'details' || mode === 'reauthenticate'
  const authName = current?.auth ?? name.trim()
  const job = a.operations.find((row) => row.id === jobId) ?? a.operations.find((row) =>
    row.provider === provider && row.auth === authName && isPendingOperation(row))
  const providerBusy = a.operations.some((row) => row.provider === provider && isPendingOperation(row))
  const disabled = busy || a.status !== 'connected'
  const installed = a.catalog?.capabilities.find((row) => row.provider === provider)?.installed
  const profiles = a.catalog?.profiles.filter((row) => row.provider === provider) ?? []
  const used = current?.profiles ?? []
  const accessKnown = current?.verification === 'verified' || current?.verification === 'unsupported'
  const accessFailed = current?.verification === 'failed'
  const loginActive = loginHasActiveRuns({ provider, auth: authName }, profiles, a.sessions)
  const title = mode === 'new' ? 'New saved login' : mode === 'import' ? 'Import local login'
    : mode === 'rename' ? 'Rename saved login' : mode === 'assign' ? 'Assign to profiles'
      : mode === 'remove' ? `Remove ${authName}?` : mode === 'reauthenticate' ? `Sign in to ${authName}` : authName
  const primary = mode === 'new' ? 'Start sign-in' : mode === 'import' ? 'Import login'
    : mode === 'rename' ? 'Save name' : mode === 'assign' ? 'Save assignments'
      : mode === 'remove' ? 'Remove saved login' : 'Sign in again'
  const validation = mode === 'rename' ? nameError(name, (a.catalog?.auths ?? []).filter((item) => item.provider === provider).map((item) => item.auth), authName) : ''
  function close() {
    if (!canDismiss) return
    if (mode !== 'details' && initialMode === 'details' && !removed) {
      const wasSignIn = mode === 'reauthenticate'
      setMode('details'); setError('')
      requestAnimationFrame(() => (wasSignIn ? signInTrigger.current ?? renameTrigger.current : renameTrigger.current)?.focus())
      return
    }
    onClose(removed)
  }
  function rename() { setName(authName); setError(''); setMode('rename') }
  function signInAgain() { setMode('reauthenticate'); setError('') }
  function assignProfiles() { setSelected(used); setMode('assign') }

  async function run(kind: 'new-login' | 'reauthenticate' | 'import-login' | 'check-login') {
    const key = randomUUID()
    setJobId(key)
    const result = await a.request<AgentJob>('agent-operation-start', {
      key, provider, kind, auth: authName,
      ...(provider === 'codex' && ['new-login', 'reauthenticate'].includes(kind) ? { device, structured: device } : {}),
    })
    setJobId(result.id)
    await a.refreshOperations()
  }

  async function checkLogin() {
    if (disabled || providerBusy || pending.current) return
    pending.current = true
    setBusy(true); setError('')
    try { await run('check-login') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check login.') }
    finally { pending.current = false; setBusy(false) }
  }

  async function submit() {
    if (disabled || waiting || pending.current || providerBusy || validation || mode === 'details' || mode === 'remove' && (used.length > 0 || loginActive)
    || mode === 'rename' && (loginActive && !login?.rename_can_drain || name === authName)) return
    pending.current = true
    setBusy(true); setError('')
    try {
      if (mode === 'new' || mode === 'reauthenticate' || mode === 'import') {
        await run(mode === 'new' ? 'new-login' : mode === 'import' ? 'import-login' : 'reauthenticate')
      } else if (mode === 'rename') {
        await a.request('rename-login', { provider, auth: authName, authId: login?.auth_id, newName: name.trim() })
        await a.refresh()
        if (onRenamed) onRenamed(name.trim())
        else onClose()
      } else if (mode === 'remove') {
        const result = await a.request<{ cleanupPending?: boolean }>('remove-login', { provider, auth: authName, confirmed: true })
        await a.refresh()
        if (result.cleanupPending) {
          setRemoved(true)
          setError('Login removed from the catalog. Some local credential files could not be deleted. Check storage permissions.')
        } else onClose(true)
      } else {
        for (const profile of profiles) {
          if (selected.includes(profile.profile) && profile.auth !== authName)
            await a.request('switch-auth', { provider, profile: profile.profile, auth: authName })
          else if (!selected.includes(profile.profile) && profile.auth === authName)
            await a.request('switch-auth', { provider, profile: profile.profile, auth: null })
        }
        await a.refresh(); onClose()
      }
    } catch (cause) {
      if (cause instanceof AgentError && cause.code === 'identity_change_pending') setWaiting(true)
      setError(cause instanceof Error ? cause.message : 'Login operation failed.')
      void a.refreshOperations(); void a.refresh()
    } finally { pending.current = false; setBusy(false) }
  }

  return <PaneForm inline={inline} modal={modal} title={title} description={creating ? 'Save a reusable login for your agent profiles.' : `${providerLabel(provider)} saved login`}
    headerActions={mode === 'details' && <><ProfileStatus label={current ? loginStatus(current) : 'Account access not checked'} tone={accessFailed ? 'warning' : current?.verification === 'verified' ? 'success' : 'neutral'} />
      <DropdownMenu label="Saved login actions" trigger={<Button ref={renameTrigger} variant="ghost" iconOnly aria-label="Saved login actions"><Icon name="ellipsis" /></Button>}
      items={[{ id: 'check', label: 'Check login', disabled: disabled || providerBusy },
        { id: 'signin', label: 'Sign in again', disabled: disabled || providerBusy || !installed },
        { id: 'assign', label: 'Assign to profiles', disabled: disabled || providerBusy },
        { id: 'rename', label: 'Rename login', disabled: disabled || providerBusy || !!loginActive && !login?.rename_can_drain },
        { id: 'create', label: 'Create profile using this login', disabled: disabled || providerBusy },
        { id: 'remove', label: 'Remove saved login', danger: true, disabled: disabled || providerBusy }]}
      renderItem={item => <span className="agent-overview-menu-item">{item.label}{item.id === 'rename' && loginActive && !login?.rename_can_drain && <small>Stop agents using this login to rename it.</small>}</span>}
      onAction={action => { requestAnimationFrame(() => {
        if (action === 'check') void checkLogin()
        else if (action === 'signin') signInAgain()
        else if (action === 'assign') assignProfiles()
        else if (action === 'rename') rename()
        else if (action === 'remove') setMode('remove')
        else navigate('agents/providers?' + new URLSearchParams({ provider, setup: 'profile', auth: authName, flow: randomUUID() }))
      }) }} /></>}
    trigger={<Button hidden className={modal ? 'agent-dialog-trigger' : undefined}>Open saved login</Button>}
    className="agents-sheet" open={open} onOpenChange={(next) => { if (!next) close() }}
    footer={<>
      <Button variant="ghost" disabled={!canDismiss} autoFocus={mode === 'remove'} onPress={close}>{job || busy || removed || mode === 'details' ? 'Close' : 'Cancel'}</Button>
      {creating && job?.status === 'succeeded' && <Button onPress={() => {
        if (onUseLogin) { onUseLogin(authName); onClose() }
        else { setSelected([]); setMode('assign') }
      }}>{onUseLogin ? 'Use this login' : 'Assign to profiles'}</Button>}
      {creating && job?.status === 'succeeded' && !onUseLogin && <Button onPress={() => navigate(`agents/providers?provider=${encodeURIComponent(provider)}&setup=profile&auth=${encodeURIComponent(authName)}&flow=${randomUUID()}`)}>Create profile<Icon name="arrow-right" /></Button>}
      {!removed && !(mode === 'details') && (!job || !creating || job.status === 'failed' || job.status === 'cancelled') && <Button form={formId} type="submit" variant={mode === 'remove' ? 'danger' : 'primary'} loading={busy} disabled={disabled || providerBusy || (mode === 'remove' && (!!used.length || !!loginActive))
        || (mode === 'rename' && (!!loginActive && !login?.rename_can_drain || !!validation || name.trim() === authName)) || ((mode === 'new' || mode === 'reauthenticate') && !installed)}>{primary}</Button>}
    </>}>
    <form id={formId} className={`agents-sheet-form${mode === 'details' ? ' agent-login-overview' : ''}`} onSubmit={(event) => {
      event.preventDefault(); event.stopPropagation(); void submit()
    }}>
      {error && <p role="alert" className="agents-error">{error}</p>}
      {creating && <Select label="Provider" variant={fieldVariant} value={provider} disabled={disabled || !!job}
        options={(a.catalog?.capabilities ?? []).filter(row => row.savedAuth !== false && row.authMode !== 'native').map(row => ({ id: row.provider, label: providerLabel(row.provider) }))}
        onChange={(value) => setProvider(value as Provider)} />}
      {(creating || mode === 'rename') && <TextFieldName name={name} setName={(value) => { setName(value); setError('') }} disabled={disabled || creating && !!job || mode === 'rename' && !!loginActive && !login?.rename_can_drain} hint={validation} />}
      {mode === 'rename' && <p className="ws-note">Profiles assigned to this login will keep using the same account under its new name.</p>}
      {mode === 'import' && <p className="ws-note">Save the login already available on this machine. Conversation history stays with its profile.</p>}
      {(mode === 'new' || mode === 'reauthenticate') && <>
        {provider === 'codex' && <Select label="Sign-in method" variant={fieldVariant} value={device ? 'device' : 'browser'} disabled={disabled || providerBusy} options={[{ id: 'device', label: 'Device code' }, { id: 'browser', label: 'Browser' }]} onChange={(value) => setDevice(value === 'device')}/>}
        <p className="ws-note">Start sign-in, then open its terminal to complete the provider's steps. {provider === 'antigravity' && 'Complete personal Google sign-in, then enter /exit in Antigravity to save the login. '}You can close these details while it runs.</p>
        {!installed && <p className="agents-error">Install {providerLabel(provider)} from Providers before signing in.</p>}
      </>}
      {mode === 'details' && current && (activity ? <>
        <Button variant="ghost" className="agent-task-back" size="sm" onPress={() => setActivity(false)}><Icon name="chevron-left" />Account overview</Button>
        <h3>Allowance and activity</h3>
        <AllowanceReadings rows={a.budgets[provider + '/' + authName]} />
        {a.catalog?.capabilities.find(row => row.provider === provider)?.budgets && <Button variant="secondary" disabled={disabled || a.budgetLoading.includes(provider + '/' + authName)} onPress={() => void a.refreshBudget(provider, authName)}>Check allowance</Button>}
        <DescriptionList items={[
          { id: 'signin', label: 'Last saved sign-in', value: current.signedInAt ? new Date(current.signedInAt).toLocaleString() : 'Not recorded' },
          { id: 'check', label: 'Last account check', value: current.checkedAt ? new Date(current.checkedAt).toLocaleString() : 'Not checked' },
        ]} />
      </> : <>
        {!installed && <p className="agents-error">Install {providerLabel(provider)} from Providers before signing in.</p>}
        <div className="agent-overview-actions">
          {accessFailed ? <Button ref={signInTrigger} disabled={disabled || providerBusy || !installed} onPress={signInAgain}>Sign in again</Button>
            : !accessKnown ? <Button disabled={disabled || providerBusy} loading={busy} onPress={() => void checkLogin()}>Check login</Button>
            : <Button variant="secondary" disabled={disabled || providerBusy} onPress={assignProfiles}>Assign to profiles</Button>}
        </div>
        <section className="agent-task-section"><h3>Profiles using this account</h3>
          {used.length ? <div className="agent-login-profiles">{used.map(name => <Button key={name} variant="ghost"
            onPress={() => navigate('agents/profiles?profile=' + encodeURIComponent(provider + '/' + name))}>{name}</Button>)}</div>
            : <p className="carrier-muted">No profiles use this account yet.</p>}
        </section>
        <Button className="agent-setup-row" variant="ghost" onPress={() => { setActivity(true); if (a.catalog?.capabilities.find(row => row.provider === provider)?.budgets && !a.budgets[provider + '/' + authName]) void a.refreshBudget(provider, authName) }}><span><strong>Allowance and activity</strong>
          <small>{a.catalog?.capabilities.find(row => row.provider === provider)?.budgets ? allowanceSummary(a.budgets[provider + '/' + authName]) : 'Review account checks and sign-in history'}</small></span><Icon name="chevron-right" /></Button>
      </>)}
      {mode === 'assign' && <>
        <p className="ws-note">Checked profiles use this login for new agents. Unchecking a profile clears its local login and requires that profile to be idle.</p>
        {profiles.map((profile) => <Checkbox key={profile.id} label={profile.profile}
          description={profile.auth && profile.auth !== authName ? `Currently uses ${profile.auth}` : profile.active_runs ? 'Active agents keep their current login' : undefined}
          isSelected={selected.includes(profile.profile)} disabled={disabled || profile.auth === authName && profile.active_runs > 0}
          onChange={(checked) => setSelected((values) => checked ? [...values, profile.profile] : values.filter((value) => value !== profile.profile))} />)}
        {!profiles.length && <p>No profiles for this provider yet.</p>}
      </>}
      {mode === 'rename' && loginActive && !login?.rename_can_drain && <p className="agents-error">Stop agents using this login before renaming it.</p>}
      {mode === 'remove' && <>
        <p>Remove this saved login from this machine. Your provider account stays signed in elsewhere.</p>
        {!!used.length && <div className="agents-sheet-form"><p>Used by {used.join(', ')}. Unassign or replace this login before removing it.</p>
          <Button variant="secondary" onPress={() => { setSelected(used); setMode('assign') }}>Manage assignments</Button></div>}
        {loginActive && <p className="agents-error">Stop agents using this login in Terminals before removing it.</p>}
      </>}
    </form>
    {job && <OperationStatus job={job} agents={a} navigate={navigate} />}
  </PaneForm>
}

function TextFieldName({ name, setName, disabled, hint }: { name: string; setName: (value: string) => void; disabled: boolean; hint?: string }) {
  const fieldVariant = useContentFieldVariant()
  return <TextField label="Login name" variant={fieldVariant} required autoFocus value={name} disabled={disabled}
    pattern="[A-Za-z0-9][A-Za-z0-9_-]*" maxLength={128} hint={hint || 'Letters, numbers, hyphens and underscores.'}
    onChange={(event) => setName(event.target.value)} />
}

export function NewLoginButton({ agents, provider, navigate, onCreated, disabled }: {
  agents: AgentsModel; provider: Provider; navigate: (route: string) => void; onCreated: (auth: string) => void; disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  return <><Button variant="ghost" size="sm" disabled={disabled || agents.status !== 'connected'} onPress={() => setOpen(true)}><Icon name="plus" />New login</Button>
    {open && <LoginSheet agents={agents} navigate={navigate} mode="new" initialProvider={provider} open
      onUseLogin={onCreated} onClose={() => setOpen(false)} />}</>
}

export function SavedLogins({ agents: a, navigate, workspace }: { agents: AgentsModel; navigate: (route: string) => void; workspace?: WorkspaceRenderer }) {
  const [editing, setEditing] = useState<{ login?: Auth; mode: LoginMode } | null>(null)
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const deletionTrigger = useRef<HTMLElement | null>(null)
  const searchButton = useRef<HTMLButtonElement>(null)
  const disabled = a.status !== 'connected'
  const auths = a.catalog?.auths ?? []
  const matches = auths.filter(auth => (provider === 'all' || auth.provider === provider) && `${auth.auth} ${auth.provider}`.toLowerCase().includes(query.toLowerCase()))
  function closeEditing(removed = false) {
    setEditing(null)
    const trigger = deletionTrigger.current
    deletionTrigger.current = null
    requestAnimationFrame(() => (!removed && trigger?.isConnected && trigger.getClientRects().length ? trigger : searchButton.current)?.focus())
  }
  function renamed(auth: string) {
    if (!editing?.login) return
    setQuery('')
    setEditing({ login: { ...editing.login, auth }, mode: 'details' })
  }
  if (workspace) return workspace({ title: 'Saved logins', description: `${auths.length} saved logins`, selected: !!editing, onBack: closeEditing,
    primary: { label: 'New login', disabled, onPress: () => setEditing({ mode: 'new' }) },
    actions: <DropdownMenu label="Saved login library actions" trigger={<Button ref={searchButton} iconOnly variant="ghost" size="sm" aria-label="Saved login library actions"><Icon name="ellipsis" /></Button>}
      items={[{ id: 'import', label: 'Import local login', disabled }]} onAction={() => setEditing({ mode: 'import' })} />,
    controls: <><SearchField label="Search saved logins" placeholder="Search saved logins…" value={query} onChange={setQuery} />
      <Select label="Filter saved logins by provider" hideLabel variant="subtle" value={provider} onChange={setProvider}
        options={[{ id: 'all', label: 'All providers' }, ...[...new Set(auths.map(auth => auth.provider))].map(id => ({ id, label: providerLabel(id) }))]} /></>,
    list: <div className="carrier-message-scroll">{matches.map((auth) => {
      const budget = a.budgets[`${auth.provider}/${auth.auth}`]
      const selected = editing?.login?.provider === auth.provider && editing?.login?.auth === auth.auth
      return <div key={`${auth.provider}/${auth.auth}`} className="agent-profile-row" data-selected={selected || undefined}>
        <Button variant="ghost" className="carrier-message-row" aria-label={auth.auth}
          aria-pressed={selected} onPress={() => setEditing({ login: auth, mode: 'details' })}>
          <span className="carrier-row-title">{auth.auth}</span><span className="carrier-row-preview">{providerLabel(auth.provider)} · {auth.profiles.length} profiles</span>
          <span className="carrier-row-preview">{allowanceSummary(budget, loginStatus(auth))}</span>
        </Button>
      </div>
    })}{!matches.length && <EmptyState headingLevel={2} icon="user-round" title={auths.length ? 'No matching logins' : 'No saved logins'} description={auths.length ? 'Try another search or provider.' : 'Create a login or import one already available on this machine.'} />}</div>,
    reader: editing ? <LoginSheet inline key={`${editing.login?.provider}/${editing.login?.auth}/${editing.mode}`} agents={a} navigate={navigate}
      login={editing.login} mode={editing.mode} open onClose={closeEditing} onRenamed={renamed} />
      : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="user-round" title="Select a saved login" description="Review account access, manage assignments, or sign in again." /></div>,
  })
  return <div className="agents-collection">
    <div className="agents-section-heading"><p>Reusable logins shared by your profiles.</p><div className="ws-actions">
      <Button variant="secondary" disabled={disabled} onPress={() => setEditing({ mode: 'import' })}>Import local login</Button>
      <Button disabled={disabled} onPress={() => setEditing({ mode: 'new' })}><Icon name="plus" />New login</Button>
    </div></div>
    {auths.length ? <Card className="agents-logins" as="section" aria-label="Saved logins">
      {auths.map((auth) => {
        const pending = a.operations.some((row) => row.provider === auth.provider && isPendingOperation(row))
        const budget = a.budgets[`${auth.provider}/${auth.auth}`]
        return <div key={`${auth.provider}/${auth.auth}`} className="agents-login-row">
          <div className="agents-login-copy">
            <h2><Button variant="ghost" className="agents-profile-name" disabled={disabled}
              onPress={() => setEditing({ login: auth, mode: 'details' })}>{auth.auth}</Button></h2>
            <p>{providerLabel(auth.provider)} · {auth.profiles.length} {auth.profiles.length === 1 ? 'profile' : 'profiles'}</p>
            <p>{allowanceSummary(budget, loginStatus(auth))}</p>
          </div>
          <div className="ws-actions">
            <Button variant="secondary" size="sm" disabled={disabled || pending}
              onPress={() => setEditing({ login: auth, mode: 'details' })}>Sign in again</Button>
            <DropdownMenu label={`Actions for ${auth.auth} login`} trigger={<Button iconOnly variant="ghost" size="sm"
              aria-label={`Actions for ${auth.auth} login`}><Icon name="ellipsis" /></Button>}
              items={[{ id: 'assign', label: 'Assign to profiles', disabled: disabled || pending },
                { id: 'rename', label: 'Rename', disabled: disabled || pending },
                { id: 'remove', label: 'Remove saved login', danger: true, disabled: disabled || pending }]}
              onAction={(mode) => setEditing({ login: auth, mode: mode as LoginMode })} />
          </div>
        </div>
      })}
    </Card> : <EmptyState title={a.catalog ? 'No saved logins' : 'Loading saved logins…'}
      description="Create a login or import one already available on this machine."
      action={<Button disabled={disabled} onPress={() => setEditing({ mode: 'new' })}>New login</Button>} />}
    {editing && <LoginSheet key={`${editing.login?.provider}/${editing.login?.auth}/${editing.mode}`} agents={a} navigate={navigate}
      login={editing.login} mode={editing.mode} open onClose={() => setEditing(null)} onRenamed={renamed} />}
  </div>
}
