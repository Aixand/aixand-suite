import { profileAccountLabel } from './accountPresentation'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, DropdownMenu, EmptyState, Icon, SearchField, Select } from 'bbb-design'
import type { AgentsModel } from './model'
import type { Profile, SavedSession } from './client'
import type { Project } from '../projects/model'
import { NewProfile } from './NewProfile'
import { ProfileOverview } from './ProfileOverview'
import { isActiveRun, profileDeletionReason, providerLabel } from './presentation'
import { SavedLogins } from './SavedLogins'
import { Providers } from './Providers'
import { isPendingOperation, operationLabel, OperationStatus } from './AgentOperations'
import { DeleteProfileDialog } from './DeleteProfileDialog'
import { DeleteProfilesDialog } from './DeleteProfilesDialog'
import { ProfileNamingSheet } from './ProfileNamingSheet'
import { AgentWorkspace } from './AgentWorkspace'
import type { WorkspacePanes } from './AgentWorkspace'
import { ToolsWorkspace } from './ToolsWorkspace'
import { PageLoading } from '../components/PageLoading'
import { SessionsPage } from '../sessions/SessionsPage'
import { agentRoute, agentSection } from './routes'
import { AgentNavigation } from './AgentNavigation'
import { SessionForm } from '../sessions/SessionForm'
import { useSessionLibrary } from '../sessions/model'
import { requestResourceNavigation } from '../resources/editor/drafts'
import './agents.css'

const PromptsPage = lazy(() => import('../prompts/PromptsPage').then(module => ({ default: module.PromptsPage })))
const SkillsPage = lazy(() => import('../skills/SkillsPage').then(module => ({ default: module.SkillsPage })))
export function AgentsPage({ agents: a, navigate, route, projects = [] }: {
  agents: AgentsModel; navigate: (route: string) => void; route: string; projects?: Project[]
}) {
  const profileActionTrigger = useRef<HTMLButtonElement>(null)
  const section = agentSection(route)!
  const view = section.label
  const parameters = new URLSearchParams(route.split('?')[1])
  const selectedId = view === 'Profiles' ? parameters.get('profile') ?? '' : ''
  const query = view === 'Profiles' ? parameters.get('q') ?? '' : ''
  const provider = view === 'Profiles' ? parameters.get('provider') ?? 'all' : 'all'
  function profileFilters(patch: Record<string, string>) {
    const next = new URLSearchParams(parameters)
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key) }
    navigate(`agents/profiles${next.size ? '?' + next.toString() : ''}`)
  }
  const setSelectedId = (id: string) => profileFilters({ profile: id })
  const setQuery = (q: string) => profileFilters({ q })
  const setProvider = (value: string) => profileFilters({ provider: value === 'all' ? '' : value })
  const [editing, setEditing] = useState<'new' | null>(null)
  const [launching, setLaunching] = useState<{ profile?: Profile; session?: SavedSession; customize?: boolean } | null>(null)
  const [naming, setNaming] = useState<{ profile: Profile; mode: 'rename' | 'duplicate' } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [profileSelection, setProfileSelection] = useState<string[]>([])
  const [batchProfiles, setBatchProfiles] = useState<Profile[] | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [operationId, setOperationId] = useState(() => new URLSearchParams(route.split('?')[1] ?? '').get('operation') ?? '')
  const [operationQuery, setOperationQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const selectionButton = useRef<HTMLButtonElement>(null)
  const deletionTrigger = useRef<HTMLElement | null>(null)
  const mutation = useRef(false)
  const connected = a.status === 'connected'
  const disabled = !connected || !!busy
  const profiles = a.catalog?.profiles ?? []
  const selected = profiles.find((profile) => profile.id === selectedId)
  const launchRequest = useRef('')
  useEffect(() => {
    if (section.id !== 'profiles' || parameters.get('launch') !== '1' || !selected || launchRequest.current === route) return
    launchRequest.current = route
    setLaunching({ profile: selected })
  }, [route, selected?.id])
  const library = useSessionLibrary(a, selected ? { home: selected.id } : {}, view === 'Profiles' && Boolean(selected))
  const runs = (a.sessions?.runs ?? []).filter((run) => selected && run.provider === selected.provider && run.profile === selected.profile)
  const active = selected ? runs.length ? runs.filter(isActiveRun).length : selected.active_runs : 0
  const backgroundServer = runs.some((run) => isActiveRun(run) && run.mode === 'app-server')
  const unconfirmedLaunch = runs.some((run) => isActiveRun(run) && run.status === 'uncertain')
  const renameReason = selected?.profile === 'default' ? 'The native default profile keeps its name.'
    : !connected ? 'Reconnect to Agent Manager to rename this profile.'
      : busy ? 'Wait for the current profile action to finish before renaming.'
        : active > 0 && !selected?.rename_can_drain ? `Stop this profile's running agents to rename it.${backgroundServer ? ' A background Codex server is still running, even between messages.' : ''}${unconfirmedLaunch ? ' An unconfirmed launch also holds this home; review it in Terminals.' : ''}`
          : ''
  const providerInstalled = a.catalog?.capabilities.find((item) => item.provider === selected?.provider)?.installed
  const unavailable = !!selected && !(selected.authMode === 'native' ? providerInstalled : selected.readiness?.terminal?.ready ?? providerInstalled)
  const maintenance = selected && a.operations.some((job) => job.provider === selected.provider && ['install', 'update', 'repair'].includes(job.kind) && isPendingOperation(job))
  const matches = profiles.filter((profile) => (provider === 'all' || provider === profile.provider) &&
    `${profile.profile} ${profile.provider} ${profile.auth ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const selectedProfiles = profiles.filter(profile => profileSelection.includes(profile.id))
  const selectableMatches = matches.filter(profile => !profileDeletionReason(profile, a.sessions))
  const visibleSelected = selectableMatches.filter(profile => profileSelection.includes(profile.id)).length
  const hiddenSelected = selectedProfiles.filter(profile => !matches.some(row => row.id === profile.id)).length

  useEffect(() => {
    setProfileSelection(ids => {
      const retained = ids.filter(id => profiles.some(profile => profile.id === id))
      return retained.length === ids.length ? ids : retained
    })
  }, [a.catalog])
  useEffect(() => {
    if (section.id !== 'profiles') { setSelecting(false); setProfileSelection([]); setBatchProfiles(null) }
  }, [section.id])

  useEffect(() => {
    if (!connected) return
    void a.refresh()
    void a.refreshSessions()
    const timer = setInterval(() => void a.refreshSessions(), 5000)
    return () => clearInterval(timer)
  }, [connected])
  function closeNaming() {
    setNaming(null)
    requestAnimationFrame(() => (profileActionTrigger.current ?? document.querySelector<HTMLElement>('.agent-name-heading button'))?.focus())
  }
  function back() { setEditing(null); setNaming(null); setLaunching(null); setSelectedId('') }
  function toggleSelection() {
    setProfileSelection([]); setSelecting(!selecting)
    if (!selecting) { setSelectedId(''); setEditing(null); setNaming(null); setLaunching(null); setError('') }
  }
  function closeBatchDeletion() {
    setBatchProfiles(null)
    const trigger = deletionTrigger.current
    requestAnimationFrame(() => requestAnimationFrame(() => (trigger?.isConnected && trigger.getClientRects().length ? trigger : selectionButton.current)?.focus()))
  }
  function confirmDeletion(targets: Profile[], trigger: Element) {
    if (disabled || !targets.length || targets.some(profile => profileDeletionReason(profile, a.sessions))) return
    deletionTrigger.current = trigger instanceof HTMLElement ? trigger : null
    setNotice(''); setBatchProfiles(targets.map(profile => ({ ...profile })))
  }
  function openTerminals(profile: Profile) {
    const rows = (a.sessions?.runs ?? []).filter((run) => run.provider === profile.provider && run.profile === profile.profile)
    const run = rows.find((run) => run.session_id && isActiveRun(run)) ?? rows.find((run) => run.session_id)
    navigate(run?.session_id ? `terminals/${encodeURIComponent(run.session_id)}` : 'terminals')
  }
  function renderWorkspace(panes: WorkspacePanes) {
    const navigation = (close: () => void) => <AgentNavigation section={section.id} counts={{ profiles: profiles.length,
      logins: a.catalog?.auths.length, providers: a.catalog?.capabilities.length, operations: a.operations.filter(isPendingOperation).length }}
      disabled={!!busy} close={close} subnavigation={panes.subnavigation} onSelect={id => {
        setError(''); setEditing(null); setNaming(null); setLaunching(null)
        if (section.id !== id) navigate(agentRoute(id))
      }} />
    return <AgentWorkspace agents={a} navigation={navigation} panes={panes} error={panes.error || error} notice={panes.notice || notice} />
  }
  if (view === 'Prompts' || view === 'Skills') return <Suspense fallback={renderWorkspace({ title: view, selected: false, onBack: () => {},
    list: <PageLoading label={`Loading ${view.toLowerCase()}…`} size="panel" />, reader: null })}>
    {view === 'Prompts' ? <PromptsPage agents={a} route={route} navigate={navigate} workspace={renderWorkspace} />
      : <SkillsPage agents={a} route={route} navigate={navigate} workspace={renderWorkspace} />}
  </Suspense>
  if (view === 'Sessions') return <SessionsPage agents={a} projects={projects} navigate={navigate} route={route} workspace={renderWorkspace} />
  if (view === 'Saved logins') return <SavedLogins agents={a} navigate={navigate} workspace={renderWorkspace} />
  if (view === 'Providers') return <Providers agents={a} navigate={navigate} workspace={renderWorkspace} route={route} />
  if (view === 'Tools (MCP)') return <ToolsWorkspace agents={a} projects={projects} route={route} navigate={navigate} workspace={renderWorkspace} />
  if (view === 'Operations') {
    const operation = a.operations.find((job) => job.id === operationId)
    const matchesOperation = (job: typeof a.operations[number]) => `${operationLabel(job.kind)} ${job.auth ?? ''} ${job.profile ?? ''} ${providerLabel(job.provider)} ${job.status} ${job.message}`.toLowerCase().includes(operationQuery.toLowerCase())
    const groups = [
      { title: 'Needs attention', jobs: a.operations.filter(job => ['failed', 'uncertain'].includes(job.status) || job.phase === 'awaiting-user') },
      { title: 'In progress', jobs: a.operations.filter(job => isPendingOperation(job) && job.status !== 'uncertain' && job.phase !== 'awaiting-user') },
      { title: 'History', jobs: a.operations.filter(job => !isPendingOperation(job) && !['failed', 'uncertain'].includes(job.status) && job.phase !== 'awaiting-user') },
    ]
    return renderWorkspace({ title: 'Operations', description: `${a.operations.length} operations`, selected: !!operation, onBack: () => setOperationId(''),
      controls: <SearchField label="Search operations" placeholder="Search operations…" value={operationQuery} onChange={setOperationQuery} />,
      actions: <Button iconOnly size="sm" variant="ghost" aria-label="Refresh operations" disabled={!connected} onPress={() => void a.refreshOperations()}><Icon name="refresh-cw" /></Button>,
      list: <div className="carrier-message-scroll">{groups.map(group => ({ ...group, jobs: group.jobs.filter(matchesOperation) })).filter(group => group.jobs.length).map(group => <section key={group.title} aria-label={group.title}><h2 className="agent-operation-group agent-operation-list-heading"><Icon name={group.title === 'Needs attention' ? 'triangle-alert' : group.title === 'In progress' ? 'refresh-cw' : 'rotate-ccw-clock'} />{group.title}</h2>{group.jobs.map((job) => <Button key={job.id} variant="ghost" className="carrier-message-row"
        aria-pressed={operationId === job.id} onPress={() => setOperationId(job.id)}><span className="carrier-row-title">{operationLabel(job.kind)} · {job.auth ?? providerLabel(job.provider)}</span>
        <span className="carrier-row-preview">{job.status} · {job.message}</span></Button>)}</section>)}
        {!a.operations.length && <EmptyState headingLevel={2} icon="refresh-cw" title="No operations yet" description="Sign-in and provider setup progress will appear here." />}
        {!!a.operations.length && !a.operations.some(matchesOperation) && <EmptyState headingLevel={2} icon="search" title="No matching operations" description="Try another search." />}
        {a.operationsError && <p className="agents-error" role="alert">{a.operationsError}</p>}</div>,
      reader: <div className={operation ? 'carrier-reader-scroll' : 'carrier-reader-empty'}>{operation ? <section className="agent-operation-details"><header><h2 tabIndex={-1}>{operationLabel(operation.kind)}</h2><p className="carrier-muted">{operation.auth ?? operation.profile ?? providerLabel(operation.provider)} · {providerLabel(operation.provider)}</p></header><OperationStatus job={operation} agents={a} navigate={navigate} hideHeading /></section>
        : <EmptyState headingLevel={2} icon="refresh-cw" title="Select an operation" description="Review progress and open its retained terminal." />}</div>,
    })
  }
  const profileDeletion = selected && selected.profile !== 'default' ? <DeleteProfileDialog profile={selected} open={deleting} hideTrigger
    onOpenChange={open => { setDeleting(open); if (!open) requestAnimationFrame(() => profileActionTrigger.current?.focus()) }} disabled={disabled} active={active}
    onTerminals={() => openTerminals(selected)} onDeleted={() => { setSelectedId(''); void library.refresh(true) }}
    onDelete={async (profile) => {
      const result = await a.request<{ cleanupPending?: boolean }>('delete-profile', { provider: profile.provider, profile: profile.profile, confirmed: true })
      setNotice(result.cleanupPending ? 'Profile deleted. Some local files could not be removed.' : `Profile “${profile.profile}” deleted.`)
      await a.refresh()
    }} /> : null
  const reader = selecting ? <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="user-round" title="Select profiles to delete"
    description="Choose profiles in the list, then review and confirm their deletion together." /></div> : naming ? <ProfileNamingSheet inline key={`${naming.profile.id}/${naming.mode}`} agents={a} profile={naming.profile} mode={naming.mode}
    onClose={closeNaming} onSaved={(name) => {
      profileFilters({ profile: `${naming.profile.provider}/${name}`, q: '' }); setNotice(naming.mode === 'rename' ? `Profile renamed to “${name}”.` : `Profile “${name}” created.`)
      setNaming(null); void a.refreshSessions(); void library.refresh(true)
    }} /> : editing ? <NewProfile agents={a} onClose={() => setEditing(null)} navigate={navigate} /> : launching ? <SessionForm agents={a} projects={projects} initialProfile={launching.profile} session={launching.session}
    customize={launching.customize} navigate={navigate} onClose={() => setLaunching(null)} />
      : selected ? <><ProfileOverview key={selected.id} agents={a} profile={selected} active={active}
        unavailable={unavailable} maintenance={!!maintenance} disabled={disabled} renameReason={renameReason} library={library}
        actionTrigger={profileActionTrigger} onStart={() => setLaunching({ profile: selected })}
        onName={mode => setNaming({ profile: { ...selected, active_runs: active }, mode })} onDelete={() => setDeleting(true)}
        onTerminals={() => openTerminals(selected)} navigate={navigate} />{profileDeletion}</>
       : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="user-round" title="Select an agent profile" description="Review its settings, start a session, or browse its conversation history." /></div>
  return <>
    {renderWorkspace({ title: 'Profiles', description: `${profiles.length} profiles`, selected: !selecting && (!!selected || !!editing || !!naming || !!launching), onBack: back,
      primary: { label: 'New profile', disabled: disabled || !a.catalog || selecting, onPress: () => { setNaming(null); setEditing('new'); setLaunching(null); setError('') } }, reader,
      actions: <DropdownMenu label="Profile library actions" trigger={<Button ref={selectionButton} iconOnly variant="ghost" size="sm" aria-label="Profile library actions"><Icon name="ellipsis" /></Button>}
        items={[{ id: 'select', label: selecting ? 'Cancel profile selection' : 'Select profiles', disabled: !!busy || !a.catalog },
          { id: 'refresh', label: 'Refresh agents', disabled: disabled || a.loading }]}
        onAction={action => { if (action === 'select') requestResourceNavigation(toggleSelection); else { void a.refresh(); void a.refreshSessions(); void library.refresh(true) } }} />,
      controls: <><SearchField ref={search} label="Search profiles" placeholder="Search profiles…" value={query} onChange={setQuery} />
        <Select label="Filter by provider" hideLabel variant="subtle" value={provider} onChange={setProvider}
          options={[{ id: 'all', label: 'All providers' }, ...(a.catalog?.capabilities ?? []).map(row => ({ id: row.provider, label: row.label ?? providerLabel(row.provider) }))]} />
        {selecting && <div className="agent-profile-selection-toolbar" role="group" aria-label="Profile selection">
          <Checkbox label="Select all visible profiles" disabled={!!busy || !selectableMatches.length}
            isSelected={selectableMatches.length > 0 && visibleSelected === selectableMatches.length}
            isIndeterminate={visibleSelected > 0 && visibleSelected < selectableMatches.length}
            onChange={checked => setProfileSelection(ids => checked ? [...new Set([...ids, ...selectableMatches.map(profile => profile.id)])] :
              ids.filter(id => !selectableMatches.some(profile => profile.id === id)))} />
          <div className="agent-profile-selection-actions">
            <p className="session-filter-summary" role="status">{selectedProfiles.length} selected{hiddenSelected ? ` · ${hiddenSelected} hidden by filters` : ''}</p>
            <Button variant="danger" size="sm" disabled={disabled || !selectedProfiles.length || selectedProfiles.some(profile => profileDeletionReason(profile, a.sessions))}
              onPress={event => confirmDeletion(selectedProfiles, event.target)}>Delete selected</Button>
          </div>
        </div>}
      </>,
      list: <div className="carrier-message-scroll" aria-busy={a.loading}>{matches.map((profile) => selecting ?
        <div key={profile.id} className="agent-profile-selection-row" data-selected={profileSelection.includes(profile.id) || undefined}>
          <Checkbox label={`${profile.profile} · ${providerLabel(profile.provider)}`}
            description={[profileAccountLabel(profile), profileDeletionReason(profile, a.sessions)].filter(Boolean).join(' · ')}
            disabled={!!busy || Boolean(profileDeletionReason(profile, a.sessions) && !profileSelection.includes(profile.id))}
            isSelected={profileSelection.includes(profile.id)} onChange={checked => setProfileSelection(ids => checked ? [...new Set([...ids, profile.id])] : ids.filter(id => id !== profile.id))} />
        </div> : <div key={profile.id} className="agent-profile-row" data-selected={selectedId === profile.id || undefined}>
        <Button className="carrier-message-row" variant="ghost" aria-label={`${profile.profile} · ${providerLabel(profile.provider)}`}
          aria-pressed={selectedId === profile.id} onPress={() => { setSelectedId(profile.id); setEditing(null); setNaming(null); setLaunching(null); setError('') }}>
          <span className="carrier-row-title">{profile.profile}</span><span className="carrier-row-preview">{providerLabel(profile.provider)} · {profileAccountLabel(profile)}</span>
          {profile.active_runs > 0 && <span className="agent-session-state" data-state="running">{profile.active_runs} running</span>}
        </Button>
      </div>)}{!matches.length && (a.loading || a.status === 'connecting' ? <PageLoading label="Loading profiles…" size="panel" /> :
        <EmptyState headingLevel={2} icon="user-round" title={profiles.length ? 'No profiles found' : 'No profiles yet'} description={profiles.length ? 'Try another search or provider.' : 'Create a profile to start a session.'} />)}</div>,
    })}
    {batchProfiles && <DeleteProfilesDialog agents={a} profiles={batchProfiles} disabled={disabled}
      onBusyChange={value => { mutation.current = value; setBusy(value ? 'delete-profiles' : '') }}
      onDeleted={profile => {
        setProfileSelection(ids => ids.filter(id => id !== profile.id))
        if (profile.id === selectedId) { back(); void library.refresh(true) }
      }}
      onComplete={({ deleted, failed, cleanupPending }) => {
        setNotice(`${deleted} ${deleted === 1 ? 'profile' : 'profiles'} deleted.${failed ? ` ${failed} could not be deleted.` : ''}${cleanupPending ? ' Some local files could not be removed.' : ''}`)
        if (!failed) { setSelecting(false); setProfileSelection([]) }
      }} onClose={closeBatchDeletion} />}
  </>
}
