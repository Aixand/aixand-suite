import { useEffect, useRef, type ReactNode } from 'react'
import { Button, Icon, Select, StatusIndicator, TextField } from 'bbb-design'
import type { AgentJob, Catalog } from '../agents/client'
import { nameError } from '../agents/names'
import { setupAccount, setupDraft, setupName, type SetupExtra, type SetupProvider, type SetupState } from './agentSetup'
import './agent-extras.css'

export type SetupExtraActions = {
  open: (mode: 'account' | 'profile', auth?: string) => void
  edit: (changes: Partial<SetupExtra>) => void
  close: () => void
  resume: () => void
  start: (kind: AgentJob['kind'], auth: string) => void
  createProfile: () => void
  signInNative: () => void
  refresh: () => void
}

export type SetupFirstEditor = {
  editing: boolean
  open: () => void
  close: () => void
}

export function AgentSetupExtras({ section, primaryContent, firstEditor, progress, provider, catalog, operations, disabled, actions, renderOperation }: {
  section: 'account' | 'profile'
  primaryContent: ReactNode
  firstEditor: SetupFirstEditor
  progress: SetupState
  provider: SetupProvider
  catalog: Catalog
  operations: AgentJob[]
  disabled: boolean
  actions: SetupExtraActions
  renderOperation: (job?: AgentJob) => ReactNode
}) {
  const first = setupAccount(provider, progress, catalog, operations)
  const extra = first.draft.extra
  const root = useRef<HTMLDivElement>(null)
  const collection = useRef<HTMLElement>(null)
  const editingExtra = extra?.mode === section
  const editing = firstEditor.editing || editingExtra
  const previousEditing = useRef(false)
  useEffect(() => {
    if (editing) {
      const target = root.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? root.current?.querySelector<HTMLElement>('h4')
      target?.focus({ preventScroll: true })
    } else if (previousEditing.current) collection.current?.focus({ preventScroll: true })
    previousEditing.current = editing
  }, [editing])
  const extraProgress: SetupState = { ...progress, drafts: { ...progress.drafts,
    [provider]: { ...setupDraft(), ...extra },
  } }
  const account = setupAccount(provider, extraProgress, catalog, operations)
  const profiles = catalog.profiles.filter(row => row.provider === provider)
  const pending = first.pending
  const job = extra?.operationId ? operations.filter(row => row.provider === provider && (row.kind === 'profile-login'
    ? row.profile === extra.nativeProfile : !!row.auth && row.auth === extra.auth && ['new-login', 'import-login', 'check-login', 'reauthenticate'].includes(row.kind)))
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? operations.find(row => row.id === extra.operationId) : undefined
  const extraPending = pending && (pending.id === extra?.operationId || !!extra?.auth && pending.auth === extra.auth || !!extra?.nativeProfile && pending.profile === extra.nativeProfile)
  const failed = job?.status === 'failed' || job?.status === 'cancelled'
  const loginError = extra ? nameError(extra.loginName, first.logins.map(row => row.auth)) : ''
  const profileError = extra ? nameError(extra.profileName, profiles.map(row => row.profile), extra.nativeProfile ?? undefined, true) : ''
  const accountSaved = !!account.login && account.ready && !failed && !extraPending
  const unavailable = disabled || !!pending
  const unverified = account.verification === 'unsupported'
  const accountStatus = (auth: string) => {
    const value = setupAccount(provider, { ...extraProgress, drafts: { ...extraProgress.drafts, [provider]: { ...setupDraft(), auth } } }, catalog, operations)
    return value.verification === 'verified' ? 'Verified' : value.verification === 'unsupported' ? 'Verification unavailable'
      : value.verification === 'failed' ? 'Needs sign-in' : 'Not checked'
  }

  const resumeSection = extra?.resumeMode ?? (extra?.nativeProfile ? 'profile' : 'account')
  const resumable = resumeSection === section && !extra?.mode && (extraPending || failed)
  const title = section === 'account' ? 'accounts' : 'profiles'

  return <div ref={root} className="setup-entries">
    {firstEditor.editing ? <div className="setup-extras-editor">
      <Button className="setup-entry-back" variant="ghost" size="sm" disabled={unavailable} onPress={firstEditor.close}><Icon name="chevron-left" />Back to {title}</Button>
      {primaryContent}
    </div> : editingExtra ? <>
      {editingExtra && section === 'account' && extra && <section className="setup-extras-editor" aria-label="Additional account">
        <Button className="setup-entry-back" variant="ghost" size="sm" disabled={disabled} onPress={actions.close}><Icon name="chevron-left" />Back to accounts</Button>
        <h4 tabIndex={-1}>Connect another account</h4>
        {accountSaved ? <div className="setup-section-content"><p role="status"><Icon name="circle-check" />Account {extra.auth} added.</p>
          {unverified && <p className="setup-note">Credentials are configured. Account access has not been checked.</p>}
          <Button variant="secondary" disabled={unavailable} onPress={() => actions.open('profile', extra.auth)}>Add profile for this account</Button>
        </div> : extraPending ? <p className="setup-note">Finish signing in to {extra.auth}. Your first profile is still ready.</p>
          : account.login ? <div className="setup-section-content"><p className="setup-note">Account {extra.auth} is saved. Check its access before using it for a profile.</p>
            <Button disabled={unavailable} onPress={() => actions.start(account.verification === 'failed' ? 'reauthenticate' : 'check-login', extra.auth)}>
              {account.verification === 'failed' ? 'Sign in again' : 'Check account'}</Button></div>
            : <form className="setup-section-content" onSubmit={event => { event.preventDefault(); if (!unavailable && !loginError) actions.start('new-login', extra.loginName) }}>
              <TextField variant="outlined" label="Account name" value={extra.loginName} disabled={unavailable} required maxLength={128}
                hint="A name in Suite, such as company or personal." error={loginError || undefined} onChange={event => actions.edit({ loginName: event.target.value })} />
              <Button type="submit" disabled={unavailable || !!loginError}>Sign in to {setupName(provider, catalog)}<Icon name="external-link" /></Button>
              <details><summary>Use an account on this machine</summary><p className="setup-note">Import the account already signed in on the Suite host.</p>
                <Button variant="secondary" disabled={unavailable || !!loginError} onPress={() => actions.start('import-login', extra.loginName)}>Import local account</Button></details>
            </form>}
        {job && (extraPending || failed || !accountSaved) && renderOperation(job)}
        {job && accountSaved && <details className="setup-entry-details"><summary>Connection details</summary>{renderOperation(job)}</details>}
      </section>}
      {editingExtra && section === 'profile' && extra && <section className="setup-extras-editor" aria-label="Additional profile">
        <Button className="setup-entry-back" variant="ghost" size="sm" disabled={disabled} onPress={actions.close}><Icon name="chevron-left" />Back to profiles</Button>
        <h4 tabIndex={-1}>Create another profile</h4>
        <form className="setup-section-content" onSubmit={event => {
          event.preventDefault()
          if (unavailable || profileError) return
          if (first.native && !account.ready) actions.signInNative()
          else if (account.ready) actions.createProfile()
        }}>
          {!first.native && <Select variant="outlined" label="Account for this profile" value={extra.auth} disabled={unavailable}
            options={first.logins.map(row => ({ id: row.auth, label: row.auth, description: accountStatus(row.auth) }))}
            onChange={auth => actions.edit({ auth, operationId: null })} />}
          <TextField variant="outlined" label="Profile name" value={extra.profileName} disabled={unavailable || !!extra.nativeProfile} required maxLength={128}
            hint={extra.nativeProfile ? 'Created for this sign-in; the first profile stays unchanged.' : 'Use letters, numbers, hyphens, or underscores.'}
            error={profileError || undefined} onChange={event => actions.edit({ profileName: event.target.value })} />
          {first.native && <p className="setup-note">This profile has its own provider sign-in. Remote account verification is unavailable.</p>}
          {!first.native && !account.ready && <div className="setup-section-content"><p className="setup-note">Check this account before creating the profile.</p>
            <Button variant="secondary" disabled={unavailable || !extra.auth} onPress={() => actions.start(account.verification === 'failed' ? 'reauthenticate' : 'check-login', extra.auth)}>
              {account.verification === 'failed' ? 'Sign in again' : 'Check account'}</Button></div>}
          {!first.native && unverified && <p className="setup-note">Creating the profile will use its configured credentials.</p>}
          <Button type="submit" disabled={unavailable || !!profileError || !first.native && !account.ready}>
            {first.native ? account.ready ? 'Use this profile' : extra.nativeProfile ? 'Sign in to profile' : 'Create profile and sign in'
              : unverified ? 'Create profile' : 'Create additional profile'}<Icon name="arrow-right" /></Button>
        </form>
        {job && renderOperation(job)}
      </section>}

    </> : <section ref={collection} tabIndex={-1} className="setup-entry-collection" aria-label={`Provider ${title}`}>
      {section === 'account' ? first.native ? <p className="setup-note">This provider signs in through each profile. Add a profile to use another account.</p>
        : <ul className="setup-entry-list">{first.logins.map(row => {
          const status = accountStatus(row.auth)
          const used = profiles.filter(profile => profile.auth === row.auth).length
          return <li key={row.auth}>
            <span className="setup-entry-icon"><Icon name="user-round" /></span>
            <span className="setup-entry-copy"><strong>{row.auth}</strong><span>{used ? `${used} ${used === 1 ? 'profile' : 'profiles'}` : 'No profiles yet'}</span></span>
            <StatusIndicator label={status} tone={status === 'Verified' ? 'success' : status === 'Needs sign-in' ? 'warning' : 'neutral'} />
          </li>
        })}</ul>
        : <ul className="setup-entry-list">{profiles.map(row => <li key={row.id}>
          <span className="setup-entry-icon"><Icon name="layers" /></span>
          <span className="setup-entry-copy"><strong>{row.profile}</strong><span>{first.native ? extraPending && row.profile === extra?.nativeProfile ? 'Sign-in in progress' : 'Provider sign-in'
            : row.auth ? `Account: ${row.auth}` : 'No account assigned'}</span></span>
          {row.profile === first.draft.profileName && <span className="setup-entry-first">First profile</span>}
        </li>)}</ul>}
      {resumable && <div className="setup-entry-resume">
        <span className="setup-entry-icon"><Icon name={failed ? 'triangle-alert' : 'clock'} /></span>
        <span className="setup-entry-copy"><strong>{section === 'account' ? extra?.auth : extra?.profileName}</strong><span>{failed ? 'Sign-in needs attention' : 'Sign-in in progress'}</span></span>
        <Button variant="secondary" size="sm" disabled={disabled} onPress={actions.resume}>Resume extra setup</Button>
      </div>}
      <Button variant="ghost" size="sm" className="setup-entry-edit-first" disabled={unavailable || !!extra?.mode} onPress={firstEditor.open}>
        <Icon name="pencil" />{section === 'account' ? 'Change first account' : 'Edit first profile'}
      </Button>
    </section>}
    {editingExtra && extra?.operationId && !job && !accountSaved && <div className="setup-entry-resume">
      <p className="setup-note">Sign-in progress is not available yet.</p>
      <Button variant="secondary" disabled={disabled} onPress={actions.refresh}>Refresh extra setup</Button>
    </div>}
  </div>
}
