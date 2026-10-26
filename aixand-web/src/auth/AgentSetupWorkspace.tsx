import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, DropdownMenu, Icon, SearchField, Select } from 'bbb-design'
import type { AgentJob, Catalog } from '../agents/client'
import { AgentInstallation } from './AgentInstallation'
import type { SetupFirstEditor } from './AgentSetupExtras'
import { OnboardingActions } from './OnboardingActions'
import { providerUsable, setupAccount, setupAgentReady, setupName, setupNextSection, type SetupDraft, type SetupProvider, type SetupSnapshot, type SetupState } from './agentSetup'
import './agent-workspace.css'

type Section = 'install' | 'account' | 'profile'
const sections: { id: Section; label: string }[] = [
  { id: 'install', label: 'Installation' }, { id: 'account', label: 'Account' }, { id: 'profile', label: 'Profile' },
]

export function AgentSetupWorkspace({ progress, provider, snapshot, catalog, operations, disabled, preview, chooser, existingProfiles, accountContent, profileContent, renderExtras, onAddExtra, onRestoreFirst, hostControl,
  onSelect, onChooseAgents, onInstall, onCheck, onDefer, onInclude, onClose, onFinish, renderOperation }: {
  progress: SetupState
  provider: SetupProvider
  snapshot: SetupSnapshot
  catalog: Catalog
  operations: AgentJob[]
  disabled: boolean
  preview: boolean
  chooser: ReactNode
  hostControl: ReactNode
  existingProfiles: ReactNode
  accountContent: ReactNode
  profileContent: ReactNode
  renderExtras: (section: 'account' | 'profile', primaryContent: ReactNode, firstEditor: SetupFirstEditor) => ReactNode
  onAddExtra: (section: 'account' | 'profile') => void
  onRestoreFirst: (draft: SetupDraft) => void
  onSelect: (provider: SetupProvider) => void
  onChooseAgents: () => void
  onInstall: (method?: string) => void
  onCheck: () => void
  onDefer: () => void
  onInclude: () => void
  onClose: () => void
  onFinish: () => void
  renderOperation: (job?: AgentJob) => ReactNode
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<{ provider: SetupProvider; section: Section | null } | null>(null)
  const [firstEditor, setFirstEditor] = useState<{ provider: SetupProvider; section: 'account' | 'profile'; draft: SetupDraft } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const id = useId()
  const account = setupAccount(provider, progress, catalog, operations)
  const { draft, ready: connected, primaryPending: pending, pending: providerPending } = account
  const info = snapshot.providers.find(row => row.provider === provider)
  const installed = providerUsable(info)
  const active = progress.selected.filter(value => !progress.drafts[value]?.deferred)
  const ready = (value: SetupProvider) => setupAgentReady(value, progress, snapshot, catalog, operations)
  const providerReady = ready(provider)
  const previousReady = useRef({ provider, ready: providerReady })
  const previousExtra = useRef({ provider, mode: draft.extra?.mode })
  const completed = active.filter(ready)
  const progressLabel = `${completed.length} of ${active.length} ${active.length === 1 ? 'agent' : 'agents'} ready`
  const canFinish = active.length > 0 && completed.length === active.length
  const choosing = progress.step === 'providers' || progress.selected.length === 0
  const next = active.find(value => value !== provider && !ready(value))
  const extraSection = draft.extra?.mode ?? (providerPending && !pending ? draft.extra?.resumeMode ?? null : null)
  const nextSection = setupNextSection(installed, connected, providerReady, pending) ?? extraSection
  const currentSection = expanded?.provider === provider ? expanded.section : nextSection
  const visible = progress.selected.filter(value => setupName(value, snapshot).toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    const section = draft.extra?.mode ?? (previousExtra.current.provider === provider ? previousExtra.current.mode : null)
    const becameReady = previousReady.current.provider === provider && providerReady && !previousReady.current.ready
    setExpanded(current => section ? { provider, section } : becameReady ? current : null)
    previousExtra.current = { provider, mode: draft.extra?.mode }
  }, [provider, providerReady, installed, connected, draft.auth, draft.nativeProfile, draft.done, pending?.id, draft.extra?.mode])
  useEffect(() => {
    if (previousReady.current.provider !== provider) setFirstEditor(null)
    else if (providerReady && !previousReady.current.ready && firstEditor?.provider === provider) {
      setExpanded({ provider, section: firstEditor.section })
      setFirstEditor(null)
    }
    previousReady.current = { provider, ready: providerReady }
  }, [provider, providerReady, firstEditor])

  function editor(section: 'account' | 'profile'): SetupFirstEditor {
    return {
      editing: firstEditor?.provider === provider && firstEditor.section === section,
      open: () => setFirstEditor({ provider, section, draft }),
      close: () => {
        if (firstEditor?.provider === provider) onRestoreFirst(firstEditor.draft)
        setFirstEditor(null)
        setExpanded({ provider, section })
      },
    }
  }

  function choose(value: SetupProvider) {
    onSelect(value)
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }))
  }
  function status(value: SetupProvider) {
    const account = setupAccount(value, progress, catalog, operations)
    if (account.draft.deferred) return 'Set up later'
    if (ready(value)) return 'Ready'
    if (account.pending) return account.pending.status === 'uncertain' ? 'Needs attention' : account.pending.kind === 'install' ? 'Installing'
      : ['new-login', 'import-login', 'check-login', 'reauthenticate', 'profile-login'].includes(account.pending.kind) ? 'Sign-in in progress' : 'Agent busy'
    if (!providerUsable(snapshot.providers.find(row => row.provider === value))) return 'Needs installation'
    if (!account.ready) return 'Connect account'
    return 'Create profile'
  }
  function summary(section: Section) {
    if (section === 'install') return installed ? `Installed${info?.version ? ` · ${info.version}` : ''}` : pending?.kind === 'install' ? 'Installing…' : 'Not installed'
    if (section === 'account') return !installed ? 'After installation' : connected
      ? `${account.native ? 'Signed in' : draft.auth}${account.native || account.verification === 'unsupported' ? ' · Not verified' : ' · Verified'}${account.logins.length > 1 ? ` · ${account.logins.length} accounts` : ''}` : 'Not connected'
    const profiles = catalog.profiles.filter(row => row.provider === provider).length
    return !connected ? account.native ? 'Created during sign-in' : 'After sign-in' : ready(provider)
      ? `${draft.profileName}${profiles > 1 ? ` · ${profiles} profiles` : ''}` : 'Name your profile'
  }

  return <div className="setup-workspace">
    {!choosing && <div className="setup-workspace-mobile">
      {progress.selected.length > 0 && <Select variant="outlined" label="Selected agent" value={provider} disabled={disabled}
        options={progress.selected.map(value => ({ id: value, label: setupName(value, snapshot), description: status(value) }))}
        onChange={value => choose(value as SetupProvider)} />}
      <Button variant="secondary" iconOnly aria-label="Add agents" disabled={disabled} onPress={onChooseAgents}><Icon name="plus" /></Button>
    </div>}
    <div className="setup-workspace-layout">
      <nav className="setup-workspace-list" aria-label="Selected agents">
        {progress.selected.length > 6 && <SearchField label="Search selected agents" placeholder="Search agents…" value={query} onChange={setQuery} />}
        <ul>{visible.map(value => <li key={value}>
          <Button variant="ghost" className="setup-workspace-row" disabled={disabled} aria-current={!choosing && value === provider ? 'true' : undefined}
            onPress={() => choose(value)} aria-controls={`${id}-panel`}>
            <Icon name={ready(value) ? 'check' : progress.drafts[value]?.deferred ? 'minus' : 'square-terminal'} />
            <span><strong>{setupName(value, snapshot)}</strong><span className={ready(value) ? 'bbb-visually-hidden' : undefined}>{status(value)}</span></span>
            {!choosing && value === provider && <Icon name="chevron-right" />}
          </Button>
        </li>)}</ul>
        {visible.length === 0 && <p className="setup-note">{progress.selected.length ? 'No matching agents.' : 'Add an agent to get started.'}</p>}
        <Button variant="ghost" className="setup-workspace-add" disabled={disabled} onPress={onChooseAgents}><Icon name="plus" />Add agents</Button>
      </nav>
      <section id={`${id}-panel`} className="setup-workspace-panel" aria-label={choosing ? 'Choose agents' : `${setupName(provider, snapshot)} setup`}>
        <header className="setup-workspace-heading">
          <h2 ref={heading} tabIndex={-1}>{choosing ? 'Choose your agents' : setupName(provider, snapshot)}</h2>
          <div className="setup-workspace-tools">
            {ready(provider) && !choosing && <DropdownMenu label="More agent options"
              trigger={<Button variant="ghost" iconOnly aria-label="More agent options" disabled={disabled || !!providerPending || !!draft.extra?.mode || !!firstEditor}><Icon name="ellipsis" /></Button>}
              items={[
                ...(!account.native ? [{ id: 'account', label: 'Add account', leading: <Icon name="user-round" /> }] : []),
                { id: 'profile', label: 'Add profile', leading: <Icon name="layers" /> },
              ]} onAction={value => onAddExtra(value as 'account' | 'profile')} />}
            {hostControl}
          </div>
        </header>
        <div key={provider} className="setup-workspace-panel-body" data-choosing={choosing || undefined}>
        {choosing ? chooser : draft.deferred ? <div className="setup-section-content setup-workspace-deferred">
          <p className="setup-note">You can finish this agent later in Agents.</p>
          {pending && renderOperation(pending)}
          <Button variant="secondary" disabled={disabled || !!providerPending} onPress={onInclude}>Include {setupName(provider, snapshot)}</Button>
          {next && <Button variant="ghost" disabled={disabled} onPress={() => choose(next)}>Next agent<Icon name="arrow-right" /></Button>}
        </div> : <>
          {installed && existingProfiles}
          <div className="setup-sections">{sections.map(section => {
            const locked = section.id === 'account' && !installed || section.id === 'profile' && (!installed || !connected)
            const open = currentSection === section.id && !locked
            const complete = section.id === 'install' ? installed : section.id === 'account' ? connected : ready(provider)
            return <div className="setup-section" key={section.id} data-complete={complete}>
              <div className="setup-section-heading"><h3><Button variant="ghost" className="setup-section-toggle" aria-label={section.label} aria-expanded={open}
                aria-controls={`${id}-${section.id}`} disabled={disabled || locked}
                onPress={() => setExpanded({ provider, section: open ? null : section.id })}>
                <Icon name={complete ? 'circle-check' : locked ? 'info' : 'clock'} />
                <span><strong>{section.label}</strong><span>{section.id === 'install' && installed ? <>Installed{info?.version && <span className="setup-section-version"> · {info.version}</span>}</> : summary(section.id)}</span></span>
                <Icon name="chevron-down" className={open ? 'setup-section-chevron--open' : undefined} />
              </Button></h3></div>
              <div id={`${id}-${section.id}`} hidden={!open} role="region" aria-label={`${setupName(provider, snapshot)} ${section.id === 'install' ? 'installation' : section.id}`}>
                {open && (section.id === 'install' ? <AgentInstallation key={provider} provider={provider} snapshot={snapshot} operations={operations}
                  disabled={disabled} preview={preview} onInstall={onInstall} onCheck={onCheck} renderOperation={renderOperation} />
                  : providerReady || firstEditor?.provider === provider && firstEditor.section === section.id
                    ? renderExtras(section.id, section.id === 'account' ? accountContent : profileContent, editor(section.id))
                    : section.id === 'account' ? accountContent : profileContent)}
              </div>
            </div>
          })}</div>
          {ready(provider) && <div className="setup-workspace-ready"><span role="status">{setupName(provider, snapshot)} is ready</span>
            {next && <Button variant="secondary" disabled={disabled} onPress={() => choose(next)}>Next agent<Icon name="arrow-right" /></Button>}
          </div>}
          <Button variant="ghost" size="sm" disabled={disabled || !!providerPending} onPress={onDefer}>Set up {setupName(provider, snapshot)} later</Button>
        </>}
        </div>
      </section>
    </div>
    {active.length === 0 && <p role="status" className="setup-note">Include at least one agent to finish setup.</p>}
    <OnboardingActions className="setup-workspace-footer">
      <Button variant="ghost" aria-label={preview ? 'Close preview' : 'Save and close'} disabled={disabled} onPress={onClose}>{preview ? 'Close' : 'Save & close'}</Button>
      {!choosing && <div className="setup-workspace-progress" role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={active.length || 1} aria-valuenow={completed.length}>{progressLabel}</div>}
      <Button aria-label="Continue to projects" disabled={disabled || !canFinish || choosing} onPress={onFinish}>Continue<Icon name="arrow-right" /></Button>
    </OnboardingActions>
  </div>
}
