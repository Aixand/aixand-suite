import { profileAccountLabel } from './accountPresentation'
import { useRef, useState } from 'react'
import { PageLoading } from '../components/PageLoading'
import { Button, Card, DropdownMenu, EmptyState, Icon, SearchField, SegmentedControl, Select } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import type { Project } from '../projects/model'
import { readStorage } from '../storage'
import { isActiveRun, providerLabel } from './presentation'
import type { AgentOperation } from './presentation'
import { LaunchAgentSheet } from './LaunchAgentSheet'
import { DeleteProfileDialog } from './DeleteProfileDialog'
import { ProfileNamingSheet } from './ProfileNamingSheet'
import { isPendingOperation } from './AgentOperations'

type ProfileActions = {
  agents: AgentsModel
  projects: Project[]
  disabled: boolean
  busy: string
  error: string
  launching: Profile | null
  act: AgentOperation
  onEdit: (profile: Profile, trigger?: HTMLElement | null) => void
  onTerminals: (profile: Profile) => void
  onDelete: (profile: Profile) => Promise<void>
  onLaunch: (profile: Profile | null) => void
  onLaunched: () => void
  onName: (profile: Profile, mode: 'rename' | 'duplicate') => void
}

function ProfileCard({ profile, onDeleted, ...props }: ProfileActions & { profile: Profile; onDeleted: () => void }) {
  const { agents: a, disabled, onEdit, onTerminals } = props
  const [deleting, setDeleting] = useState(false)
  const name = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLButtonElement>(null)
  const providerInstalled = a.catalog?.capabilities.find((item) => item.provider === profile.provider)?.installed
  const unavailable = !(profile.authMode === 'native' ? providerInstalled : profile.readiness?.terminal?.ready ?? providerInstalled)
  const maintenance = a.operations.some((job) => job.provider === profile.provider && ['install', 'update', 'repair'].includes(job.kind)
    && isPendingOperation(job) && job.status !== 'queued')
  const active = a.sessions ? a.sessions.runs.filter((run) =>
    run.provider === profile.provider && run.profile === profile.profile && isActiveRun(run)).length : profile.active_runs

  return (
    <Card as="section" className="agents-profile" aria-label={`${providerLabel(profile.provider)} ${profile.profile}`}>
      <div className="agents-profile-copy">
        <h2><Button ref={name} className="agents-profile-name" variant="ghost"
          disabled={disabled} onPress={() => onEdit(profile, name.current)}>{profile.profile}</Button></h2>
        <p>{providerLabel(profile.provider)} <span aria-hidden="true">·</span> {profileAccountLabel(profile)}</p>
        {profile.sdk_credential && <p>Chat API credential: {profile.sdk_credential.name}</p>}
        {unavailable && <p className="agents-profile-warning"><Icon name="triangle-alert" />{providerLabel(profile.provider)} unavailable</p>}
      </div>
      <div className="agents-profile-menu">
        {profile.profile !== 'default' && <DeleteProfileDialog profile={profile} open={deleting}
          onOpenChange={setDeleting} disabled={disabled} active={active} onDelete={props.onDelete}
          onDeleted={onDeleted} onTerminals={() => onTerminals(profile)} />}
        <DropdownMenu label={`Actions for ${profile.profile}`} trigger={<Button ref={menu} iconOnly
          variant="ghost" size="sm" aria-label={`Actions for ${profile.profile}`}><Icon name="ellipsis" /></Button>}
          items={[
            { id: 'edit', label: 'Edit profile', disabled },
            { id: 'rename', label: 'Rename profile', disabled: disabled || profile.profile === 'default' || active > 0 && !profile.rename_can_drain },
            { id: 'duplicate', label: 'Duplicate profile', disabled },
            { id: 'terminals', label: 'Open Terminals' },
            { id: 'delete', label: 'Delete profile', danger: true, disabled: disabled || profile.profile === 'default' },
          ]}
          onAction={(action) => {
            if (action === 'edit') onEdit(profile, menu.current)
            else if (action === 'delete') setDeleting(true)
            else if (action === 'rename' || action === 'duplicate') props.onName(profile, action)
            else onTerminals(profile)
          }} />
      </div>
      <div className="agents-profile-footer">
        {active > 0 && <Button variant="ghost" size="sm" className="agents-profile-sessions"
          onPress={() => onTerminals(profile)}>{active} active {active === 1 ? 'session' : 'sessions'}</Button>}
        <LaunchAgentSheet agents={a} profile={profile} projects={props.projects}
          open={props.launching?.id === profile.id} disabled={disabled || maintenance} unavailable={unavailable}
          busy={props.busy} error={props.error} act={props.act}
          onOpenChange={(open) => props.onLaunch(open ? profile : null)} onLaunched={props.onLaunched} />
      </div>
    </Card>
  )
}

export function AgentProfiles(props: Omit<ProfileActions, 'onName'> & { onCreate: () => void }) {
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [naming, setNaming] = useState<{ profile: Profile; mode: 'rename' | 'duplicate' } | null>(null)
  const [layout, setLayout] = useState(() => {
    try { return readStorage('aixand.agents.view') === 'list' ? 'list' : 'grid' }
    catch { return 'grid' }
  })
  const search = useRef<HTMLInputElement>(null)
  const profiles = props.agents.catalog?.profiles ?? []
  const matches = profiles.filter((profile) => (provider === 'all' || profile.provider === provider) &&
    `${profile.profile} ${providerLabel(profile.provider)} ${profile.auth ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className="agents-collection">
      <div className="agents-toolbar">
        <SearchField ref={search} label="Search profiles" placeholder="Search profiles…"
          value={query} onChange={setQuery} />
        <Select label="Filter by provider" hideLabel variant="subtle" value={provider} onChange={setProvider}
          options={[{ id: 'all', label: 'All providers' }, ...(props.agents.catalog?.capabilities ?? []).map(row => ({ id: row.provider, label: row.label ?? providerLabel(row.provider) }))]} />
        <SegmentedControl label="Profile view" value={layout} onChange={(value) => {
          setLayout(value)
          try { localStorage.setItem('aixand.agents.view', value) } catch { /* The view still works without storage. */ }
        }} options={[{ value: 'grid', label: 'Grid', icon: <Icon name="layout-grid" /> },
          { value: 'list', label: 'List', icon: <Icon name="menu" /> }]} />
      </div>
      {props.agents.catalog ? matches.length ? <div className="agents-profiles" data-view={layout}>
        {matches.map((profile) => <ProfileCard key={profile.id} {...props} profile={profile}
          onName={(profile, mode) => setNaming({ profile, mode })}
          onDeleted={() => requestAnimationFrame(() => search.current?.focus())} />)}
      </div> : <EmptyState headingLevel={2} icon="search" title={profiles.length ? 'No profiles found' : 'No profiles yet'}
        description={profiles.length ? 'Try another search or clear your filters.' : 'Create a profile to launch an agent.'}
        action={profiles.length ? <Button variant="secondary" onPress={() => {
          setQuery(''); setProvider('all'); search.current?.focus()
        }}>Clear filters</Button> : <Button disabled={props.disabled} onPress={props.onCreate}>New profile</Button>} />
        : props.agents.loading || props.agents.status === 'connecting'
          ? <PageLoading label="Loading profiles…" size="panel" />
          : <p className="agents-empty" role="status">Connect to load your local profiles.</p>}
      {naming && <ProfileNamingSheet agents={props.agents} profile={naming.profile} mode={naming.mode}
        onClose={() => setNaming(null)} onSaved={() => requestAnimationFrame(() => search.current?.focus())} />}
    </div>
  )
}
