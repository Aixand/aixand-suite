import { saveProfileChanges } from '../agents/accountPresentation'
import { useEffect, useRef, useState } from 'react'
import { Button, Icon, Popover, Select, Tooltip, type ThemeMode } from 'bbb-design'
import type { AgentJob } from '../agents/client'
import type { AgentsModel } from '../agents/model'
import { isPendingOperation, OperationStatus } from '../agents/AgentOperations'
import { InstallationProgress } from '../agents/InstallationProgress'
import { nameError } from '../agents/names'
import { OnboardingScreen } from './OnboardingScreen'
import { AgentSetupWorkspace } from './AgentSetupWorkspace'
import { AgentAccounts } from './AgentAccounts'
import { AgentProfile } from './AgentProfile'
import { AgentSetupExtras } from './AgentSetupExtras'
import { SetupActivity, SetupCheck } from './SetupCheck'
import { useAgentSetup } from './useAgentSetup'
import { AgentProviderPicker } from './AgentProviderPicker'
import { ProjectOnboardingPreview } from './ProjectOnboardingPreview'
import { providerUsable, setupAccount, setupAgentReady, setupDraft, setupProfileMatches, loginOptions, type SetupDraft, type SetupExtra, type SetupProvider, type SetupState } from './agentSetup'
import './agent-onboarding.css'

export function AgentOnboarding({ agents, preview = false, mode, onModeChange, onClose, onReplay, navigate, embedded = false, onTitleChange }: {
  agents?: AgentsModel
  preview?: boolean
  mode?: ThemeMode
  onModeChange?: (mode: ThemeMode) => void
  onClose: () => void
  onReplay?: () => void
  navigate?: (route: string) => void
  embedded?: boolean
  onTitleChange?: (title: string) => void
}) {
  const setup = useAgentSetup(agents, preview)
  const { progress: p, catalog, snapshot, operations } = setup
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loginChoice, setLoginChoice] = useState('@new')
  const projectStep = p?.step === 'projects'
  const workspaceReady = Boolean(p && catalog && setup.detected)
  const setupError = error || setup.error || (!setup.connected && agents?.error) || ''
  const actionPending = useRef(false)
  const provider = p?.current && p.selected.includes(p.current) ? p.current : p?.selected[0] ?? snapshot.providers[0]?.provider ?? ''
  const { draft, native, logins, pending: providerPending, ready: loginReady } = setupAccount(provider, p, catalog, operations)
  const profileMatches = setupProfileMatches(provider, p, catalog, operations)
  const disabled = busy || !setup.connected || setup.loading
  const loginNameError = nameError(draft.loginName, logins.map(row => row.auth))
  const profileNameError = profileMatches ? '' : nameError(draft.profileName,
    (catalog?.profiles ?? []).filter(row => row.provider === provider).map(row => row.profile), undefined, true)

  useEffect(() => {
    if (!p || p.selectionInitialized || setup.loading || !setup.detected) return
    setup.setProgress({ ...p, selectionInitialized: true,
      selected: snapshot.providers.filter(providerUsable).map(row => row.provider) })
  }, [p, setup.loading, setup.detected, snapshot.providers, setup.setProgress])
  useEffect(() => {
    setLoginChoice(p?.drafts[provider]?.auth || '@new')
    setError('')
  }, [provider, p?.step])

  async function act(work: () => Promise<unknown>) {
    if (actionPending.current) return
    actionPending.current = true; setBusy(true); setError('')
    try { await work() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not finish this setup step.') }
    finally { actionPending.current = false; setBusy(false) }
  }
  const withDraft = (state: SetupState, id: SetupProvider, changes: Partial<SetupDraft>): SetupState => ({ ...state,
    drafts: { ...state.drafts, [id]: { ...(state.drafts[id] ?? setupDraft()), ...changes } } })
  function editDraft(changes: Partial<SetupDraft>) {
    if (p) setup.setProgress(withDraft(p, provider, { ...changes,
      ...(changes.profileName !== undefined ? { profileEdited: true } : {}),
      ...(changes.profileName !== undefined && changes.profileName !== draft.profileName || changes.auth !== undefined && changes.auth !== draft.auth ? { done: false, profileRequestId: undefined, profileIdentity: undefined } : {}),
    }))
  }
  async function startOperation(id: SetupProvider, kind: AgentJob['kind'], args: object = {}, changes: Partial<SetupDraft> = {}) {
    if (!p || operations.some(job => job.provider === id && isPendingOperation(job))) return
    const key = crypto.randomUUID()
    // Persist the receipt key before starting a side effect. A reconnect never
    // automatically repeats an installation or sign-in request.
    await setup.save(withDraft(p, id, { ...changes, done: false, operationId: key }))
    await setup.start(id, kind, key, args)
  }
  function openTerminal(route: string) {
    void act(async () => { if (p) await setup.save(p); onClose(); navigate?.(route) })
  }
  function renderJob(value?: AgentJob) {
    if (!value) return null
    if (!preview && agents) return <OperationStatus job={value} agents={agents} navigate={openTerminal} />
    return <div className="setup-operation">
      <p role={value.status === 'failed' ? 'alert' : 'status'}>{value.message}</p>
      <InstallationProgress job={value} />
      {isPendingOperation(value) && !['install', 'check-login'].includes(value.kind) && <Button variant="secondary" onPress={() => setup.finishPreview(value)}>Complete sign-in (preview)</Button>}
    </div>
  }
  async function finishProfile() {
    if (!p) return
    let state = p
    let identity = catalog?.profiles.find(row => row.provider === provider && row.profile === draft.profileName)?.identity
    if (!profileMatches) {
      const key = draft.profileRequestId ?? crypto.randomUUID()
      state = await setup.save(withDraft(p, provider, { profileRequestId: key }))
      identity = await setup.createProfile(provider, draft.profileName, native ? undefined : draft.auth, key)
    }
    const completedProfile = catalog?.profiles.find(row => row.provider === provider && row.profile === draft.profileName)
    if (!preview && agents && completedProfile?.authentication)
      await saveProfileChanges(agents, completedProfile, { preferIfUnset: true })
    const next = withDraft(state, provider, { done: true, ...(identity ? { profileIdentity: identity } : {}) })
    await setup.save({ ...next, step: 'profile', current: provider })
  }
  async function deferProvider() {
    if (p) await setup.save(withDraft(p, provider, { deferred: true }))
  }
  function selectProvider(id: SetupProvider) {
    if (!p) return
    // Keep the persisted step format compatible with existing setup progress.
    // Installation, account, and profile now share the same workspace.
    void act(() => setup.save({ ...p, current: id, step: !providerUsable(snapshot.providers.find(row => row.provider === id))
      ? 'install' : setupAccount(id, p, catalog, operations).ready ? 'profile' : 'login' }))
  }
  async function closeSetup() {
    if (p) await setup.saveCurrent()
    onClose()
  }
  async function finishSetup() {
    if (!p || !catalog) return
    const active = p.selected.filter(id => !p.drafts[id]?.deferred)
    if (!active.length || !active.every(id => setupAgentReady(id, p, snapshot, catalog, operations))) return
    await setup.save({ ...p, step: 'projects' })
  }
  function availableName(base: string, existing: string[]) {
    let name = base
    let suffix = 2
    while (existing.some(value => value.toLowerCase() === name.toLowerCase())) {
      const ending = `-${suffix++}`
      name = `${base.slice(0, 128 - ending.length)}${ending}`
    }
    return name
  }
  function extraState(changes: Partial<SetupExtra>) {
    const extra: SetupExtra = { mode: null, auth: draft.auth, loginName: '', profileName: '', nativeProfile: null, operationId: null, ...draft.extra, ...changes }
    if (changes.profileName !== undefined && changes.profileName !== draft.extra?.profileName
      || changes.auth !== undefined && changes.auth !== draft.extra?.auth) extra.profileRequestId = crypto.randomUUID()
    return { extra, progress: withDraft(p!, provider, { extra }) }
  }
  async function openExtra(mode: 'account' | 'profile', auth = draft.auth) {
    if (!p || providerPending) return
    const state = extraState({ mode, resumeMode: mode, auth: mode === 'profile' ? auth : '',
      loginName: availableName('company', logins.map(row => row.auth)),
      profileName: availableName(draft.profileName, (catalog?.profiles ?? []).filter(row => row.provider === provider).map(row => row.profile)),
      operationId: null, nativeProfile: null, profileRequestId: crypto.randomUUID() })
    await setup.save(state.progress)
  }
  async function startExtra(kind: AgentJob['kind'], auth: string) {
    if (!p || providerPending || !draft.extra) return
    if (['new-login', 'import-login'].includes(kind) && nameError(auth, logins.map(row => row.auth))) return
    const key = crypto.randomUUID()
    await setup.save(extraState({ auth, operationId: key }).progress)
    await setup.start(provider, kind, key, { auth,
      ...(['new-login', 'reauthenticate'].includes(kind) ? loginOptions(provider, catalog) : {}) })
  }
  async function createExtraProfile() {
    if (!p || !catalog || !draft.extra || providerPending) return
    const extra = draft.extra
    const state = { ...p, drafts: { ...p.drafts, [provider]: { ...setupDraft(), ...extra } } }
    if (!setupAccount(provider, state, catalog, operations).ready
      || nameError(extra.profileName, catalog.profiles.filter(row => row.provider === provider).map(row => row.profile), extra.nativeProfile ?? undefined, true)) return
    const saved = await setup.save(p)
    if (!native) await setup.createProfile(provider, extra.profileName, extra.auth, extra.profileRequestId)
    await setup.save(withDraft(saved, provider, { extra: { ...extra, mode: null } }))
  }
  async function signInExtraNative() {
    if (!p || !catalog || !draft.extra || providerPending) return
    const extra = draft.extra
    if (nameError(extra.profileName, catalog.profiles.filter(row => row.provider === provider).map(row => row.profile), extra.nativeProfile ?? undefined, true)) return
    const key = crypto.randomUUID()
    let saved = await setup.save(extraState({ operationId: key }).progress)
    if (!extra.nativeProfile) {
      await setup.createProfile(provider, extra.profileName, undefined, extra.profileRequestId ?? key)
      saved = await setup.save(withDraft(saved, provider, { extra: { ...extra, operationId: key, nativeProfile: extra.profileName } }))
    }
    await setup.start(provider, 'profile-login', key, { profile: extra.profileName })
  }
  const title = projectStep ? 'Add your projects' : 'Set up your agents'
  useEffect(() => { onTitleChange?.(title) }, [onTitleChange, title])

  const previewControls = preview && <details className="setup-preview-controls"><summary>Preview controls</summary>
        <p>All installations, accounts, and profiles in this preview are simulated.</p>
        <Select variant="outlined" label="Preview operating system" value={snapshot.environment?.wsl ? 'wsl' : snapshot.environment?.os ?? 'linux'} onChange={setup.previewOS}
          options={[{ id: 'linux', label: 'Linux' }, { id: 'macos', label: 'macOS · Apple silicon' }, { id: 'windows', label: 'Windows' }, { id: 'wsl', label: 'Windows Subsystem for Linux' }]} />
        <Select variant="outlined" label="Preview operation outcome" value={setup.outcome} onChange={setup.setOutcome}
          options={[{ id: 'success', label: 'Success' }, { id: 'failure', label: 'Failure' }, { id: 'unverified', label: 'Account verification unavailable' }]} />
      </details>
  const hostLabel = `${preview ? 'Preview machine' : 'Suite host'} · ${snapshot.environment?.label ?? 'Checking…'}`
  const hostControl = <Popover title="Installation target" className="setup-host-popover"
    trigger={<Tooltip content={hostLabel}><Button variant="ghost" iconOnly aria-label={hostLabel}><Icon name="monitor" /></Button></Tooltip>}>
    <div className="setup-host-details">
      <strong>{hostLabel}</strong>
      <p>Agents run here, even when you open Suite on another computer.</p>
      {snapshot.environment && <p>{snapshot.environment.architecture} · Tools: {snapshot.environment.tools.join(', ') || 'None detected'}</p>}
    </div>
  </Popover>
  const content = <div className="agent-setup">
    {!workspaceReady && <SetupCheck connected={setup.connected} connecting={agents?.status === 'connecting'} restored={Boolean(p)}
      detected={setup.detected} snapshot={snapshot} error={setupError}
      onRetry={() => { setError(''); void setup.reload() }} onReconnect={() => agents?.connect()} />}
    {workspaceReady && setupError && <div role="alert" className="auth-error"><p>{setupError}</p>
      <Button variant="secondary" disabled={busy} onPress={() => { setError(''); void setup.reload() }}>Refresh setup</Button></div>}
    {workspaceReady && !setup.connected && !preview && <Button variant="secondary" onPress={() => agents?.connect()}>Reconnect to Agent Manager</Button>}
    {workspaceReady && setup.loading && <SetupActivity label="Refreshing your setup…" />}
    {workspaceReady && p && catalog && <AgentSetupWorkspace progress={p} provider={provider} snapshot={snapshot} catalog={catalog} operations={operations} disabled={disabled} preview={preview} hostControl={hostControl}
      onSelect={selectProvider} onChooseAgents={() => void act(() => setup.save({ ...p, step: 'providers' }))}
      onInstall={method => void act(() => startOperation(provider, 'install', { ...(method ? { method } : {}), whenIdle: true }))}
      onCheck={() => void act(setup.detect)} onDefer={() => void act(deferProvider)}
      onInclude={() => void act(() => setup.save(withDraft(p, provider, { deferred: false })))}
      onClose={() => void act(closeSetup)} onFinish={() => void act(finishSetup)} renderOperation={renderJob}
      existingProfiles={catalog.profiles.some(row => row.provider === provider && (row.profile !== 'default' || row.readiness?.ready)) && <Select
        variant="outlined" label="Use an existing profile" value={profileMatches ? draft.profileName : ''} disabled={disabled || !!providerPending}
        options={catalog.profiles.filter(row => row.provider === provider).map(row => ({ id: row.profile, label: row.profile }))}
        onChange={value => {
          const profile = catalog.profiles.find(row => row.provider === provider && row.profile === value)
          if (!profile) return
          setup.setProgress(withDraft(p, provider, { done: false, profileName: profile.profile, auth: profile.auth ?? '',
            nativeProfile: native ? profile.profile : null, profileIdentity: profile.identity, profileRequestId: undefined }))
          setLoginChoice(profile.auth ?? '@new')
        }} />}
      chooser={<AgentProviderPicker providers={snapshot.providers} selected={p.selected} disabled={disabled} refreshing={setup.loading}
        pending={operations.filter(isPendingOperation).map(job => job.provider)}
        onSelectionChange={selected => void act(() => setup.save({ ...p, selectionInitialized: true, selectionExplicit: true, selected }))}
        onRefresh={() => void act(setup.detect)}
        onContinue={() => selectProvider(p.selected.includes(provider) ? provider : p.selected[0])} />}
      accountContent={<AgentAccounts key={provider} progress={p} provider={provider} catalog={catalog} operations={operations}
        choice={loginChoice} disabled={disabled || !!providerPending && draft.done} errors={{ login: loginNameError, profile: profileNameError }} renderOperation={renderJob}
        actions={{
          choose: value => {
            let loginName = draft.loginName
            if (value.startsWith('@')) {
              const base = loginName || 'personal'
              let suffix = 2
              while (logins.some(row => row.auth.toLowerCase() === loginName.toLowerCase())) {
                const ending = `-${suffix++}`
                loginName = `${base.slice(0, 128 - ending.length)}${ending}`
              }
            }
            setLoginChoice(value)
            editDraft({ auth: value.startsWith('@') ? '' : value, operationId: null, loginName })
          },
          edit: editDraft,
          signIn: () => void act(() => startOperation(provider, loginChoice === '@import' ? 'import-login' : 'new-login', {
            auth: draft.loginName, ...(loginChoice !== '@import' ? loginOptions(provider, catalog) : {}),
          }, { auth: draft.loginName })),
          signInNative: () => void act(async () => {
            const key = crypto.randomUUID()
            await setup.save(withDraft(p, provider, { nativeProfile: draft.profileName, done: false, operationId: key }))
            const existing = catalog.profiles.find(row => row.provider === provider && row.profile === draft.profileName)
            if (!existing) await setup.createProfile(provider, draft.profileName, undefined, key)
            await setup.start(provider, 'profile-login', key, { profile: draft.profileName })
          }),
          check: auth => void act(() => startOperation(provider, 'check-login', { auth }, { auth })),
          reauthenticate: auth => void act(() => startOperation(provider, 'reauthenticate', { auth,
            ...loginOptions(provider, catalog) }, { auth })),
          refresh: () => void act(async () => { if (!preview) await agents?.refreshOperations(); await setup.detect() }),
        }} />}
      profileContent={<AgentProfile progress={p} provider={provider} catalog={catalog} operations={operations}
        disabled={disabled || !!providerPending && draft.done} error={profileNameError} profileMatches={profileMatches}
        onNameChange={profileName => editDraft({ profileName })}
        onFinish={() => { if (!profileNameError && loginReady) void act(finishProfile) }} />}
      onAddExtra={section => void act(() => openExtra(section))}
      onRestoreFirst={initial => setup.setProgress(withDraft(p, provider, { ...initial, extra: draft.extra }))}
      renderExtras={(section, primaryContent, firstEditor) => <AgentSetupExtras key={`${provider}-${section}`} section={section} primaryContent={primaryContent} firstEditor={firstEditor}
        progress={p} provider={provider} catalog={catalog} operations={operations} disabled={disabled} renderOperation={renderJob}
        actions={{
          open: (mode, auth) => void act(() => openExtra(mode, auth)),
          edit: changes => setup.setProgress(extraState(changes).progress),
          close: () => void act(() => setup.save(extraState({ mode: null }).progress)),
          resume: () => void act(() => setup.save(extraState({ mode: draft.extra?.resumeMode ?? (draft.extra?.nativeProfile ? 'profile' : 'account') }).progress)),
          start: (kind, auth) => void act(() => startExtra(kind, auth)),
          createProfile: () => void act(createExtraProfile),
          signInNative: () => void act(signInExtraNative),
          refresh: () => void act(async () => { if (!preview) await agents?.refreshOperations(); await setup.detect() }),
        }} />} />}
    {previewControls}
  </div>
  const flow = <>
    {!projectStep && content}
    {p && <ProjectOnboardingPreview active={projectStep} preview={preview} selection={p.projects}
      onSave={setup.saveProjects} onDraft={setup.updateProjectDraft}
      onComplete={async (projects, skip) => {
        const saved = await setup.saveProjects(projects)
        if (preview) { onClose(); return saved }
        const result = await setup.complete(saved.revision, skip)
        if (result.status === 'complete') { onClose(); navigate?.('home') }
        return result
      }}
      onBack={() => void act(() => setup.saveCurrent({ step: 'profile' }))} />}
  </>
  return embedded ? flow : <OnboardingScreen title={title} mode={mode} onModeChange={onModeChange} wide layout="setup" preview={preview} skipIntro
    onClose={() => void act(closeSetup)} onReplay={onReplay}>{flow}</OnboardingScreen>
}
