import { useEffect, useState, type ReactNode } from 'react'
import { Button, Icon, SegmentedControl, Select, TextField, Tooltip } from 'bbb-design'
import type { AgentJob, Catalog } from '../agents/client'
import { setupAccount, setupName, type SetupDraft, type SetupProvider, type SetupState } from './agentSetup'
import './agent-accounts.css'

export type AccountActions = {
  choose: (choice: string) => void
  edit: (changes: Partial<SetupDraft>) => void
  signIn: () => void
  signInNative: () => void
  useFreeModels?: () => void
  check: (auth: string) => void
  reauthenticate: (auth: string) => void
  refresh: () => void
}

export function AgentAccounts({ progress, provider, catalog, operations, choice, disabled, errors, actions, renderOperation, preferSaved = false }: {
  progress: SetupState
  provider: SetupProvider
  catalog: Catalog
  operations: AgentJob[]
  choice: string
  disabled: boolean
  errors: { login: string; profile: string }
  actions: AccountActions
  renderOperation: (job?: AgentJob) => ReactNode
  preferSaved?: boolean
}) {
  const account = setupAccount(provider, progress, catalog, operations)
  const [editingProvider, setEditingProvider] = useState<SetupProvider | null>(null)
  const [savedChoice, setSavedChoice] = useState<{ provider: SetupProvider; auth: string } | null>(() =>
    preferSaved && !account.draft.auth && account.logins.length ? { provider, auth: account.logins[0].auth } : null)
  const { draft, native, logins, login, job, verification, ready } = account
  const [accessChoice, setAccessChoice] = useState<'signin' | 'free' | null>(null)
  const optionalSignIn = native && provider === 'opencode' && !!actions.useFreeModels
  const needsAccessChoice = optionalSignIn && !draft.nativeProfile && !accessChoice
  const pending = account.primaryPending ?? (!draft.done ? account.pending : undefined)
  const changing = editingProvider === provider
  const observed = catalog.profiles.find(row => row.provider === provider && row.profile === draft.nativeProfile)?.authentication?.terminal
  const unverified = observed ? !['signed-in', 'verified'].includes(observed.state) : verification !== 'verified'
  const browsingSaved = savedChoice?.provider === provider
  const usingSaved = browsingSaved || !!login
  const selectedLogin = logins.find(row => row.auth === (browsingSaved ? savedChoice.auth : draft.auth))
  const savedVerification = browsingSaved ? selectedLogin?.verification : verification
  const capability = catalog.capabilities.find(row => row.provider === provider)
  const loginMethods = capability?.loginMethods ?? ['terminal']
  const loginMethod = loginMethods.includes(draft.loginMethod ?? '') ? draft.loginMethod! : capability?.defaultLoginMethod ?? loginMethods[0]
  const importing = choice === '@import'
  const accountKinds = ['new-login', 'import-login', 'check-login', 'reauthenticate', 'profile-login']
  const accountJob = job && accountKinds.includes(job.kind) ? operations.filter(row => row.provider === provider && accountKinds.includes(row.kind)
    && (native ? row.profile === draft.nativeProfile : row.auth === draft.auth)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? job : undefined

  useEffect(() => {
    if (!native && !draft.auth && logins.some(row => row.auth.toLowerCase() === draft.loginName.toLowerCase())) actions.choose('@new')
  }, [provider])

  function choose(value: string) {
    setEditingProvider(null)
    setSavedChoice(null)
    actions.choose(value)
  }
  function useSaved() {
    if (!selectedLogin) return
    setEditingProvider(null)
    setSavedChoice(null)
    if (savedVerification === 'verified' || savedVerification === 'unsupported') actions.choose(selectedLogin.auth)
    else if (savedVerification === 'failed') actions.reauthenticate(selectedLogin.auth)
    else actions.check(selectedLogin.auth)
  }

  return <div className="setup-section-content setup-account-content">
          {ready && !changing && !pending ? <div className="setup-account-connected">
            <span className="setup-account-symbol" data-unverified={unverified}><Icon name={unverified ? 'user-round' : 'circle-check'} /></span>
            <div>
              <p className="setup-account-name">{native ? observed?.label ?? draft.nativeProfile : draft.auth}</p>
              <p role="status">{provider === 'opencode' && draft.freeModels ? 'Use free models without signing in.' : observed?.statusLabel ?? (unverified ? 'Credentials configured · access not checked' : 'Account access verified.')}</p>
              {!native && <Button variant="ghost" disabled={disabled} onPress={() => {
                setSavedChoice({ provider, auth: draft.auth }); setEditingProvider(provider)
              }}>Use another account</Button>}
            </div>
          </div> : pending ? <div className="setup-account-waiting">
            <Icon name="clock" />
            <div><h3>{pending.status === 'uncertain' ? 'Check sign-in progress' : pending.phase === 'waiting-for-work' ? 'Waiting for existing work' : !accountKinds.includes(pending.kind) ? 'Agent is busy' : pending.kind === 'check-login' ? 'Checking your account' : pending.kind === 'profile-login' && pending.phase !== 'awaiting-user' ? 'Preparing sign-in' : 'Finish signing in'}</h3>
              <p>{pending.status === 'uncertain' ? 'Review the current operation before starting another sign-in.' : !accountKinds.includes(pending.kind) ? 'Wait for this agent’s current operation to finish.'
                : pending.kind === 'profile-login' && pending.phase !== 'awaiting-user' ? pending.message
                : pending.kind !== 'check-login' && !pending.structured ? 'Open the sign-in terminal to continue. This page will update when sign-in finishes.'
                  : 'Follow the provider’s instructions. This page will update when the connection is ready.'}</p></div>
          </div> : needsAccessChoice ? <div className="setup-account-access-choice">
            <h3>Do you want to sign in to a provider?</h3>
            <p className="setup-note">OpenCode can use free models without signing in. You can connect a provider later.</p>
            <Button variant="secondary" disabled={disabled} onPress={() => setAccessChoice('signin')}>Sign in to a provider<Icon name="arrow-right" /></Button>
            <Button variant="secondary" disabled={disabled} onPress={() => setAccessChoice('free')}>Continue without signing in<Icon name="arrow-right" /></Button>
          </div> : <>
            {(native || importing) && <p className="setup-note">{native ? provider === 'opencode' && actions.useFreeModels ? accessChoice === 'free' ? 'Name your profile to use free models without signing in.' : 'Name your profile, then sign in to a provider.' : 'Name your profile, then sign in.'
              : `Use the ${setupName(provider, catalog)} account already signed in on the Suite host.`}</p>}
            {native && catalog.capabilities.find(row => row.provider === provider)?.homeScope === 'shared' && <p className="setup-note">These profiles share the provider’s settings, conversation history, and OS login. Signing in applies to all of them.</p>}
            {!native && logins.length > 0 && <SegmentedControl label="Account source" value={usingSaved ? 'saved' : 'new'} disabled={disabled}
              options={[{ value: 'new', label: 'New account' }, { value: 'saved', label: 'Saved accounts' }]}
              onChange={value => {
                if (value === 'saved') { setSavedChoice({ provider, auth: login?.auth ?? logins[0].auth }); setEditingProvider(provider) }
                else choose('@new')
              }} />}
            <form className="setup-account-form" onSubmit={event => {
              event.preventDefault()
              if (disabled || pending) return
              if (native) { if (!errors.profile) { if (optionalSignIn && accessChoice === 'free') actions.useFreeModels?.(); else actions.signInNative() } }
              else if (usingSaved) useSaved()
              else if (!errors.login) actions.signIn()
            }}>
              {native && accessChoice !== 'free' && loginMethods.length > 1 && <Select variant="outlined" label="Sign-in method" value={loginMethod} disabled={disabled}
                options={loginMethods.map(id => ({ id, label: id === 'device' ? 'Device code' : id === 'browser' ? 'Browser' : id === 'terminal' ? 'Provider terminal' : id }))}
                onChange={loginMethod => actions.edit({ loginMethod })} />}
              {native && accessChoice !== 'free' && loginMethod === 'device' && <p className="setup-note">Open the link shown in the sign-in terminal and enter the one-time code.</p>}
              {native ? <>
                <TextField variant="outlined" label="Profile name" value={draft.profileName} disabled={disabled || !!draft.nativeProfile}
                  hint="Use letters, numbers, hyphens, or underscores." error={errors.profile || undefined} required
                  onChange={event => actions.edit({ profileName: event.target.value })} />
                <Button type="submit" disabled={disabled || !!errors.profile}>{optionalSignIn && accessChoice === 'free' ? 'Create profile without signing in' : draft.nativeProfile ? 'Sign in to profile' : 'Create profile and sign in'}<Icon name="arrow-right" /></Button>
                {optionalSignIn && !draft.nativeProfile && <Button variant="ghost" disabled={disabled} onPress={() => setAccessChoice(null)}>Change sign-in choice</Button>}
              </> : usingSaved ? <>
                <Select variant="outlined" label="Saved account" value={selectedLogin?.auth} disabled={disabled}
                  onChange={auth => { setSavedChoice({ provider, auth }); setEditingProvider(provider) }}
                  options={logins.map(value => ({ id: value.auth, label: value.auth }))} />
                {savedVerification === 'failed' && <p role="alert" className="auth-error">Account access could not be verified. Sign in again before continuing.</p>}
                <Button type="submit" disabled={disabled || !selectedLogin}>{savedVerification === 'failed' ? 'Sign in again' : savedVerification === 'verified' || savedVerification === 'unsupported' ? 'Use saved account' : 'Check account'}</Button>
              </> : <>
                <Button type="submit" disabled={disabled || !!errors.login}>{importing ? 'Import local account' : `Sign in to ${setupName(provider, catalog)}`}<Icon name={importing ? 'arrow-right' : 'external-link'} /></Button>
                <details className="setup-account-name-option" open={errors.login ? true : undefined}>
                  <summary>Account name · {draft.loginName || 'Choose a name'}</summary>
                  <TextField variant="outlined" label="Account name" value={draft.loginName} disabled={disabled} required
                    hint="A name in Suite, such as personal or work." error={errors.login || undefined}
                    onChange={event => actions.edit({ loginName: event.target.value })} />
                </details>
              </>}
            </form>
            {!native && <div className="setup-account-alternatives">
              {importing ? <Button variant="ghost" disabled={disabled} onPress={() => choose('@new')}>Sign in instead</Button>
                : <details><summary>Other ways to connect</summary><p className="setup-note">Already signed in to this agent on the Suite host?</p>
                  <Button variant="secondary" disabled={disabled} onPress={() => choose('@import')}>Use an account on this machine</Button></details>}
              {changing && login && <Button variant="ghost" onPress={() => { setEditingProvider(null); setSavedChoice(null) }}>Keep current account</Button>}
            </div>}
          </>}
          {(pending || accountJob?.status === 'failed' || accountJob?.status === 'cancelled') && <div className="setup-account-operation">{renderOperation(pending ?? accountJob)}</div>}
          {accountJob && !pending && !changing && !['failed', 'cancelled'].includes(accountJob.status) && <details className="setup-account-details">
            <summary>Connection details</summary>{renderOperation(accountJob)}
          </details>}
          {draft.operationId && !job && !ready && <p className="setup-note">Sign-in progress is not available yet. Refresh account status before retrying.</p>}

    <Tooltip content="Refresh account status"><Button variant="ghost" size="sm" iconOnly aria-label="Refresh account status" disabled={disabled} onPress={actions.refresh}><Icon name="refresh-cw" /></Button></Tooltip>
  </div>
}
