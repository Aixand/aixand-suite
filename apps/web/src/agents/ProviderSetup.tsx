import { randomUUID } from '../uuid'
import { saveProfileChanges } from './accountPresentation'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, DescriptionList, Icon, Select } from 'bbb-design'
import type { AgentJob, Catalog, ProviderInfo } from './client'
import type { AgentsModel } from './model'
import { OperationStatus, isPendingOperation } from './AgentOperations'
import { nameError } from './names'
import { createSetupProfile } from './createSetupProfile'
import { availableSetupName, freshProviderDraft, providerDraftKey, readProviderDraft, saveProviderDraft } from './providerSetupDraft'
import { AgentInstallation } from '../auth/AgentInstallation'
import { ProviderTerminalCommand } from './ProviderTerminalCommand'
import { AgentChatSupport } from '../auth/AgentChatSupport'
import { AgentAccounts } from '../auth/AgentAccounts'
import { AgentProfile } from '../auth/AgentProfile'
import { initialSetup, loginOptions, providerTerminalUsable, providerVersionReady, providerChatSupportReady, providerSdksInstalled, providerChatSupportStatus, setupSections, setupSectionLabel, setupAccount, setupAgentReady, setupName, setupNextSection, setupProfileMatches,
  type SetupDraft, type SetupSection, type SetupSnapshot } from '../auth/agentSetup'
import './provider-setup.css'
import { failedProviderRepair } from '../auth/agentSetup'

export function ProviderSetup({ agents: a, catalog, info, snapshot, refresh, navigate, initialAuth, initialName, context, forceNew = false }: {
  agents: AgentsModel
  catalog: Catalog
  info: ProviderInfo
  snapshot: SetupSnapshot
  refresh: () => Promise<void>
  navigate: (route: string) => void
  initialAuth?: string
  initialName?: string
  context?: string
  forceNew?: boolean
}) {
  const provider = info.provider
  const key = providerDraftKey(provider, catalog.cwd)
  const [draft, setDraft] = useState(() => {
    const saved = readProviderDraft(key)
    if (forceNew && (!saved || saved.context !== context || initialAuth && saved.auth !== initialAuth && !saved.operationId)) return {
      ...freshProviderDraft(provider, catalog, initialAuth && catalog.auths.some(row => row.provider === provider && row.auth === initialAuth) ? initialAuth : ''),
      context,
      ...(initialName ? { profileName: initialName } : {}),
    }
    if (saved) return saved
    const pending = a.operations.find(row => row.provider === provider && isPendingOperation(row))
    return { ...freshProviderDraft(provider, catalog), ...(pending ? {
      operationId: pending.id, auth: pending.auth ?? '', nativeProfile: pending.kind === 'profile-login' ? pending.profile ?? null : null,
      ...(pending.profile ? { profileName: pending.profile } : {}),
    } : {}) }
  })
  const currentDraft = useRef(draft)
  currentDraft.current = draft
  const [creating, setCreating] = useState(forceNew || !draft.done && Boolean(readProviderDraft(key)))
  const [choice, setChoice] = useState(draft.auth || '@new')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<SetupSection | null | undefined>(undefined)
  const mutation = useRef(false)
  const heading = useRef<HTMLDivElement>(null)
  const id = useId()
  const progress = { ...initialSetup(), step: 'install' as const, current: provider, selected: [provider], drafts: { [provider]: draft } }
  const account = setupAccount(provider, progress, catalog, a.operations)
  const installed = providerTerminalUsable(info) && providerVersionReady(info) && (info?.terminalCommand?.ready ?? true)
  const chatSupportReady = providerChatSupportReady(info)
  const sdksInstalled = providerSdksInstalled(info)
  const matches = setupProfileMatches(provider, progress, catalog, a.operations)
  const ready = setupAgentReady(provider, progress, snapshot, catalog, a.operations)
    && (!draft.profileIdentity || !catalog.profiles.find(row => row.provider === provider && row.profile === draft.profileName)?.identity
      || catalog.profiles.find(row => row.provider === provider && row.profile === draft.profileName)?.identity === draft.profileIdentity)
  const profiles = catalog.profiles.filter(row => row.provider === provider && (row.readiness?.ready ?? (!account.native
    && catalog.auths.some(login => login.provider === provider && login.auth === row.auth && ['verified', 'unsupported'].includes(login.verification ?? '')))))
  const overview = !creating && !account.pending && installed && chatSupportReady && profiles.length > 0
  const next = setupNextSection(installed, account.ready, ready, account.primaryPending ?? account.pending ?? failedProviderRepair(provider, a.operations), chatSupportReady)
  const section = expanded === undefined ? next : expanded
  const disabled = busy || a.status !== 'connected' || Boolean(info.software?.disabled)
  const loginError = nameError(draft.loginName, account.logins.map(row => row.auth))
  const profileError = matches ? '' : nameError(draft.profileName, catalog.profiles.filter(row => row.provider === provider).map(row => row.profile), undefined, true)
  const name = setupName(provider, snapshot)
  const completedOperations = a.operations.filter(row => row.provider === provider && !isPendingOperation(row)).map(row => `${row.id}:${row.updatedAt}`).join(',')
  const previousStep = useRef(next)
  useEffect(() => {
    setExpanded(undefined)
    if (previousStep.current !== next && !overview) requestAnimationFrame(() => heading.current?.querySelector<HTMLElement>(`[data-section="${next}"] h3 button`)?.focus())
    previousStep.current = next
  }, [next, overview])
  useEffect(() => { if (completedOperations) void a.refresh() }, [completedOperations])

  function change(changes: Partial<SetupDraft>) {
    const previous = currentDraft.current
    const changedIdentity = changes.auth !== undefined && changes.auth !== previous.auth || changes.profileName !== undefined && changes.profileName !== previous.profileName
    const value = { ...previous, ...changes, ...(changedIdentity ? { done: false, profileRequestId: undefined, profileIdentity: undefined } : {}) }
    currentDraft.current = value
    saveProviderDraft(key, value)
    setDraft(value)
    return value
  }
  async function act(work: () => Promise<unknown>, changesSetup = true) {
    if (mutation.current || a.status !== 'connected') return
    mutation.current = true; setBusy(true); setError(''); if (changesSetup) setCreating(true)
    try { await work() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not finish this setup step.') }
    finally { mutation.current = false; setBusy(false) }
  }
  async function start(kind: AgentJob['kind'], args: object = {}, changes: Partial<SetupDraft> = {}) {
    if (a.operations.some(row => row.provider === provider && isPendingOperation(row))) return
    const receipt = randomUUID()
    change({ ...changes, done: false, operationId: receipt })
    try { await a.request('agent-operation-start', { key: receipt, provider, kind, ...args }) }
    finally { await a.refreshOperations() }
  }
  async function setupCommand(terminalPolicy: 'keep' | 'prefer') {
    await a.request('agent-operation-start', { key: randomUUID(), provider, kind: 'setup-command', terminalPolicy, whenIdle: true })
    await a.refreshOperations()
  }
  function renderOperation(job?: AgentJob) {
    return job ? <OperationStatus job={job} agents={a} navigate={navigate} /> : null
  }
  async function finishProfile() {
    if (!account.ready || profileError || account.pending) return
    const receipt = draft.profileRequestId ?? randomUUID()
    change({ profileRequestId: receipt })
    const identity = matches ? catalog.profiles.find(row => row.provider === provider && row.profile === draft.profileName)?.identity
      : await createSetupProfile(a, provider, draft.profileName, account.native ? undefined : draft.auth, receipt)
    const completedProfile = catalog?.profiles.find(row => row.provider === provider && row.profile === draft.profileName)
    if (a && completedProfile?.authentication)
      await saveProfileChanges(a, completedProfile, { preferIfUnset: true })
    await a.refresh()
    change({ done: true, profileIdentity: identity })
  }
  function addProfile() {
    const fresh = { ...freshProviderDraft(provider, catalog), context }
    currentDraft.current = fresh; saveProviderDraft(key, fresh); setDraft(fresh)
    setChoice(fresh.auth || '@new'); setCreating(true); setExpanded(undefined); setError('')
  }
  const selectedProfile = catalog.profiles.find(row => row.provider === provider && row.profile === draft.profileName)
  const profileRoute = (profile: string) => `agents/profiles?profile=${encodeURIComponent(profile)}`

  return <section className="provider-setup" aria-label={`${name} setup`} ref={heading}>
    <div className="provider-setup-intro">
      <div><h3>{overview ? 'Your profiles' : ready ? `${name} is ready` : 'Finish setting up your provider'}</h3>
        <p>{overview ? `${profiles.length} ${profiles.length === 1 ? 'profile is' : 'profiles are'} available.`
          : ready ? 'Your account and profile are ready to use.' : 'Install the provider, connect an account, and create a profile.'}</p></div>
      {(overview || ready) && <Icon name="circle-check" />}
    </div>
    {info.sdkInstallations?.length ? <div className="provider-setup-availability" aria-label="Provider availability">
      <span><Icon name={sdksInstalled ? 'check' : 'info'} />Chat support: {providerChatSupportStatus(info)}</span>
      <span><Icon name={installed ? 'check' : 'info'} />Terminal: {installed ? 'Installed' : 'Needs installation'}</span>
    </div> : null}
    {error && <div className="provider-setup-error" role="alert"><p>{error}</p>
      <Button variant="ghost" size="sm" disabled={busy} onPress={() => void act(async () => { await a.refreshOperations(); await a.refresh(); await refresh() })}>Refresh setup</Button></div>}
    {(overview || ready) && <>
      <ProviderTerminalCommand provider={info} disabled={disabled || !!account.pending} onSetup={policy => void act(() => setupCommand(policy), false)} />
      {renderOperation(a.operations.find(job => job.provider === provider && job.kind === 'setup-command'))}
    </>}
    {overview ? <div className="ws-actions">
      <Button onPress={() => navigate(`agents/profiles?provider=${encodeURIComponent(provider)}`)}>View profiles<Icon name="arrow-right" /></Button>
      <Button variant="secondary" disabled={disabled} onPress={addProfile}>Add profile</Button>
    </div> : ready && selectedProfile ? <>
      <DescriptionList items={[{ id: 'account', label: account.native ? 'Sign-in' : 'Saved login', value: account.native ? 'Provider sign-in' : draft.auth },
        { id: 'profile', label: 'Profile', value: draft.profileName }]} />
      <div className="ws-actions"><Button onPress={() => navigate(profileRoute(selectedProfile.id))}>Open profile<Icon name="arrow-right" /></Button>
        <Button variant="secondary" disabled={disabled} onPress={() => navigate(`${profileRoute(selectedProfile.id)}&launch=1`)}>Start a session</Button>
        <Button variant="ghost" disabled={disabled} onPress={addProfile}>Add another profile</Button></div>
    </> : <>
      {installed && catalog.profiles.some(row => row.provider === provider && row.profile !== 'default') && <Select label="Use an existing profile" variant="outlined"
        value={matches ? draft.profileName : ''} disabled={disabled || Boolean(account.pending)}
        options={catalog.profiles.filter(row => row.provider === provider && row.profile !== 'default').map(row => ({ id: row.profile, label: row.profile }))}
        onChange={value => {
          const profile = catalog.profiles.find(row => row.provider === provider && row.profile === value)
          if (!profile) return
          change({ profileName: profile.profile, auth: profile.auth ?? '', nativeProfile: account.native ? profile.profile : null, done: false, operationId: null })
          setChoice(profile.auth ?? '@new'); setCreating(true); setExpanded(undefined)
        }} />}
      <div className="provider-setup-sections">{setupSections(info).map((value, index) => {
      const locked = value === 'sdk' && !installed || value === 'account' && (!installed || !chatSupportReady)
        || value === 'profile' && (!installed || !chatSupportReady || !account.ready)
      const complete = value === 'install' ? installed : value === 'sdk' ? sdksInstalled : value === 'account' ? account.ready : ready
      const open = section === value && !locked
      return <section key={value} data-section={value} data-complete={complete}>
        <h3><Button variant="ghost" className="provider-setup-toggle" aria-expanded={open} aria-controls={`${id}-${value}`} disabled={busy || locked}
          onPress={() => setExpanded(open ? null : value)}>
          <span className="provider-setup-step" aria-hidden="true">{complete ? <Icon name="check" /> : index + 1}</span>
          <span><strong>{setupSectionLabel[value]}</strong>
            <small>{value === 'install' ? installed ? `Installed${info.version ? ` · ${info.version}` : ''}` : 'Install on the computer running Suite'
              : value === 'sdk' ? providerChatSupportStatus(info)
              : value === 'account' ? account.ready ? account.native ? 'Signed in to profile' : draft.auth : 'Use a saved login or sign in'
              : 'Choose a name for this agent configuration'}</small></span><Icon name="chevron-down" />
        </Button></h3>
        <div id={`${id}-${value}`} role="region" aria-label={`${name} ${value === 'install' ? 'installation' : value === 'sdk' ? 'chat support' : value}`} hidden={!open}>
          {open && (value === 'install' ? <AgentInstallation provider={provider} snapshot={snapshot} operations={a.operations} disabled={disabled} preview={false}
            onInstall={method => void act(() => start('install', { ...(method ? { method } : {}), whenIdle: true }))}
            onRestoreVersion={() => void act(() => start('repair', { versionTarget: 'recommended', whenIdle: true }))}
            onSetupCommand={terminalPolicy => void act(() => setupCommand(terminalPolicy), false)}
            onCheck={() => void act(refresh)} renderOperation={renderOperation} />
            : value === 'sdk' ? <AgentChatSupport info={info} operations={a.operations} disabled={disabled}
              onInstall={() => void act(() => start('install-sdk', { whenIdle: true }))}
              onCheck={() => void act(refresh)} renderOperation={renderOperation} />
            : value === 'account' ? <AgentAccounts provider={provider} progress={progress} catalog={catalog} operations={a.operations}
              choice={choice} preferSaved disabled={disabled} errors={{ login: loginError, profile: profileError }} renderOperation={renderOperation}
              actions={{
                choose: choice => { setChoice(choice); change({ auth: choice.startsWith('@') ? '' : choice, operationId: null,
                  loginName: choice.startsWith('@') ? availableSetupName(draft.loginName || 'personal', account.logins.map(row => row.auth)) : draft.loginName }) },
                edit: changes => { setCreating(true); change(changes) },
                signIn: () => void act(() => start(choice === '@import' ? 'import-login' : 'new-login', { auth: draft.loginName,
                  ...(choice === '@import' ? {} : loginOptions(provider, catalog)) }, { auth: draft.loginName })),
                check: auth => void act(() => start('check-login', { auth }, { auth })),
                reauthenticate: auth => void act(() => start('reauthenticate', { auth, ...loginOptions(provider, catalog) }, { auth })),
                refresh: () => void act(async () => { await a.refreshOperations(); await a.refresh(); await refresh() }),
                signInNative: () => void act(async () => {
                  if (profileError || account.pending) return
                  const receipt = draft.profileRequestId ?? randomUUID()
                  change({ profileRequestId: receipt })
                  if (!catalog.profiles.some(row => row.provider === provider && row.profile === draft.profileName)) {
                    const identity = await createSetupProfile(a, provider, draft.profileName, undefined, receipt)
                    change({ profileIdentity: identity }); await a.refresh()
                  }
                  await start('profile-login', { profile: draft.profileName }, { nativeProfile: draft.profileName })
                }),
              }} />
              : <><p className="provider-setup-account-summary">{account.native ? 'Uses this profile’s provider sign-in.' : <>Uses {name} with saved login <strong>{draft.auth}</strong>.</>}</p>
                <AgentProfile provider={provider} progress={progress} catalog={catalog} operations={a.operations} disabled={disabled}
                  error={profileError} profileMatches={matches} onNameChange={profileName => change({ profileName })} onFinish={() => void act(finishProfile)} />
              </>)}
        </div>
      </section>
    })}</div></>}
  </section>
}
