import { accountStatusLabel, profileAccountLabel } from './accountPresentation'
import { ProfileConnections } from './ProfileConnections'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Button, DropdownMenu, Icon, StatusIndicator } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import type { useSessionLibrary } from '../sessions/model'
import { PageLoading } from '../components/PageLoading'
import { providerLabel } from './presentation'
import { useProfileResources, profileResourceName } from './profileResources'
import { accountStatus, ProfileTaskEditor } from './ProfileTaskEditor'
import type { ProfileTask } from './ProfileTaskEditor'

export function ProfileOverview({ agents, profile, active, unavailable, maintenance, disabled, renameReason, library,
  actionTrigger, onStart, onName, onDelete, onTerminals, navigate }: {
  agents: AgentsModel; profile: Profile; active: number; unavailable: boolean; maintenance: boolean; disabled: boolean
  renameReason: string; library: ReturnType<typeof useSessionLibrary>; actionTrigger: Ref<HTMLButtonElement>
  onStart: () => void; onName: (mode: 'rename' | 'duplicate') => void
  onDelete: () => void; onTerminals: () => void; navigate: (route: string) => void
}) {
  const [task, setTask] = useState<ProfileTask | null>(null)
  const resources = useProfileResources(agents, profile)
  const lastTask = useRef<ProfileTask | null>(null)
  const root = useRef<HTMLElement>(null)
  const closeTask = useCallback(() => { setTask(null); void resources.refresh() }, [resources.refresh])
  useEffect(() => {
    if (!task && lastTask.current) root.current?.querySelector<HTMLElement>('[data-profile-task="' + lastTask.current + '"]')?.focus()
    if (task) lastTask.current = task
  }, [task])
  if (task) return <ProfileTaskEditor task={task} agents={agents} profile={profile} onClose={closeTask} navigate={navigate} />
  const sessions = library.data?.sessions?.filter(item => item.profile === profile.profile && item.provider === profile.provider) ?? []
  const provider = agents.catalog?.capabilities.find(item => item.provider === profile.provider)
  const login = agents.catalog?.auths.find(row => row.provider === profile.provider && row.auth === profile.auth)
  const account = profileAccountLabel(profile)
  const verification = profile.authentication ? accountStatusLabel(profile.authentication.terminal) : provider?.authMode === 'native' ? profile.readiness?.verification === 'verified' ? 'Account access verified' : profile.readiness?.reason || 'Remote account verification unavailable' : accountStatus(login)
  const status = unavailable ? 'Provider setup required' : maintenance ? 'Provider maintenance in progress'
    : profile.readiness?.ready ? 'Ready to start' : profile.readiness?.reason || (login?.verification === 'failed' ? 'Account needs sign-in' : active > 0 ? active + (active === 1 ? ' running session' : ' running sessions') : 'Profile configured')
  const saved = resources.saved
  const instruction = saved?.instructions ? profileResourceName(resources.catalog, 'instructions', saved.instructions.target) : 'No additional instructions'
  const summary = saved ? [...saved.skills.slice(0, 3).map(row => profileResourceName(resources.catalog, 'skills', row.target)),
    ...saved.mcp.slice(0, 2).map(row => profileResourceName(resources.catalog, 'mcp', row.target))].join(' · ') : ''
  const setup = [
    { id: 'account' as const, title: 'Account', value: account, description: verification },
    { id: 'behavior' as const, title: 'Model & instructions', value: (profile.model || 'Provider default model') + ' · ' + (saved ? instruction : 'Instructions not loaded'),
      description: saved?.instructions ? resources.catalog?.choices.instructions.find(row => profileResourceName(resources.catalog, 'instructions', row.target) === instruction)?.description : 'Guidance used when starting new sessions.' },
    { id: 'resources' as const, title: 'Skills & tools', value: saved ? saved.skills.length + (saved.skills.length === 1 ? ' skill · ' : ' skills · ') + saved.mcp.length + (saved.mcp.length === 1 ? ' tool' : ' tools') : 'Attachments not loaded',
      description: summary || (saved ? 'No extra skills or tools attached.' : 'Open to review the saved setup.') },
  ]
  return <div className="carrier-reader-scroll"><section ref={root} className="agent-profile-details agent-profile-overview" aria-label={providerLabel(profile.provider) + ' ' + profile.profile}>
    <header className="agent-profile-header"><div className="agent-overview-heading">
      <h2 tabIndex={-1}>{profile.profile}</h2><p className="carrier-muted">{providerLabel(profile.provider)} profile</p>
      <StatusIndicator tone={unavailable || login?.verification === 'failed' || profile.readiness?.ready === false ? 'warning' : 'neutral'} label={status} />
    </div><div className="agent-overview-actions">
      {unavailable ? <Button onPress={() => navigate('agents/providers?provider=' + encodeURIComponent(profile.provider))}>Set up provider</Button>
        : <Button disabled={disabled || maintenance} onPress={onStart}>Start session</Button>}
      <DropdownMenu label={'Actions for ' + profile.profile} trigger={<Button ref={actionTrigger} iconOnly variant="ghost" aria-label={'Actions for ' + profile.profile}><Icon name="ellipsis" /></Button>}
        items={[
          { id: 'rename', label: 'Rename profile', disabled: !!renameReason },
          { id: 'duplicate', label: 'Duplicate profile', disabled },
          { id: 'terminals', label: 'Open Terminals' },
          { id: 'delete', label: 'Delete profile', danger: true, disabled: disabled || profile.profile === 'default' },
        ]}
        renderItem={item => <span className="agent-overview-menu-item">{item.label}{item.id === 'rename' && renameReason && <small>{renameReason}</small>}</span>}
        onAction={action => {
          if (action === 'rename' || action === 'duplicate') requestAnimationFrame(() => onName(action))
          else if (action === 'delete') onDelete()
          else onTerminals()
        }} />
    </div></header>
    {maintenance && <p className="carrier-muted">You can start a session when provider maintenance finishes.</p>}
    <section className="agent-profile-setup" aria-label="Profile setup"><h3>Setup</h3>
      {resources.loading && !saved && <p role="status" className="carrier-muted">Loading saved setup…</p>}
      {setup.map(row => <Button key={row.id} variant="ghost" className="agent-setup-row" data-profile-task={row.id} onPress={() => setTask(row.id)}>
        <span><strong>{row.title}</strong><span>{row.value}</span>{row.description && <small>{row.description}</small>}</span><Icon name="chevron-right" />
      </Button>)}
      {resources.error && <p className="agents-error" role="alert">{resources.error} <Button variant="ghost" size="sm" disabled={agents.status !== 'connected'} onPress={() => void resources.refresh()}>Try again</Button></p>}
    </section>
    <ProfileConnections agents={agents} profile={profile} />
    <section className="agent-overview-section" aria-label="Recent sessions">
      <div className="agent-overview-section-heading"><h3>Recent sessions</h3>
        <Button className="content-utility" variant="ghost" size="sm" onPress={() => navigate('agents/sessions?home=' + encodeURIComponent(profile.id))}>View sessions<Icon name="chevron-right" /></Button>
      </div>
      {library.loading && !library.data && <PageLoading label="Loading sessions…" size="panel" />}
      {library.error && <p className="agents-error" role="alert">{library.error}</p>}
      <div className="agent-overview-sessions">{sessions.slice(0, 3).map(item => <Button key={item.key} variant="ghost"
        onPress={() => navigate('agents/sessions/' + item.provider + '/' + encodeURIComponent(item.profile) + '/' + encodeURIComponent(item.id) + '?home=' + encodeURIComponent(profile.id))}>
        <strong>{item.title}</strong><small>{item.cwd.split('/').at(-1)} · {new Date(item.updatedAt).toLocaleDateString()} · {item.state}</small>
      </Button>)}</div>
      {!library.loading && !library.error && !sessions.length && <p className="carrier-muted">No saved sessions in this profile yet.</p>}
    </section>
  </section></div>
}
