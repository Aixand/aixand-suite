import type { Ref } from 'react'
import { Button, DropdownMenu, Icon, Tooltip } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import type { useSessionLibrary } from '../sessions/model'
import { PageLoading } from '../components/PageLoading'
import { providerLabel } from './presentation'
import { ProfileSettings } from './ProfileSettings'
import { ProfileStatus } from './ProfileControls'
import { requestResourceNavigation } from '../resources/editor/drafts'
import { ProfileConnections } from './ProfileConnections'

export function ProfileOverview({ agents, profile, active, unavailable, maintenance, disabled, renameReason, library,
  actionTrigger, onStart, onName, onDelete, onTerminals, navigate }: {
  agents: AgentsModel; profile: Profile; active: number; unavailable: boolean; maintenance: boolean; disabled: boolean
  renameReason: string; library: ReturnType<typeof useSessionLibrary>; actionTrigger: Ref<HTMLButtonElement>
  onStart: () => void; onName: (mode: 'rename' | 'duplicate') => void
  onDelete: () => void; onTerminals: () => void; navigate: (route: string) => void
}) {
  const sessions = library.data?.sessions?.filter(item => item.profile === profile.profile && item.provider === profile.provider) ?? []
  const login = agents.catalog?.auths.find(row => row.provider === profile.provider && row.auth === profile.auth)
  const status = unavailable ? 'Provider setup required' : maintenance ? 'Provider maintenance in progress'
    : profile.readiness?.ready ? 'Ready to start' : profile.readiness?.reason || (login?.verification === 'failed' ? 'Account needs sign-in' : active > 0 ? active + (active === 1 ? ' running session' : ' running sessions') : 'Profile configured')
  const attention = unavailable || maintenance || login?.verification === 'failed' || profile.readiness?.ready === false
  return <div className="carrier-reader-scroll"><section className="agent-profile-details agent-profile-overview" aria-label={providerLabel(profile.provider) + ' ' + profile.profile}>
    <header className="agent-profile-header"><div className="agent-overview-heading">
      <h2 tabIndex={-1}>{profile.profile}</h2><span className="agent-profile-provider">{providerLabel(profile.provider)}</span>
      {(!profile.authentication || maintenance) && <ProfileStatus tone={attention ? 'warning' : profile.readiness?.ready ? 'success' : 'neutral'} label={status} />}
      {active > 0 && <Tooltip content={`${active} running ${active === 1 ? 'session' : 'sessions'}`}><Button variant="ghost" size="sm"
        aria-label={`Open ${active} running ${active === 1 ? 'session' : 'sessions'}`} onPress={onTerminals}><Icon name="square-terminal" />{active}</Button></Tooltip>}
    </div><div className="agent-overview-actions">
      {unavailable ? <Button onPress={() => navigate('agents/providers?provider=' + encodeURIComponent(profile.provider))}>Set up provider</Button>
        : <Button disabled={disabled || maintenance} onPress={() => requestResourceNavigation(onStart)}>Open terminal</Button>}
      <DropdownMenu label={'Actions for ' + profile.profile} trigger={<Button ref={actionTrigger} iconOnly variant="ghost" aria-label={'Actions for ' + profile.profile}><Icon name="ellipsis" /></Button>}
        items={[
          { id: 'rename', label: 'Rename profile', disabled: !!renameReason },
          { id: 'duplicate', label: 'Duplicate profile', disabled },
          { id: 'terminals', label: 'Open Terminals' },
          { id: 'delete', label: 'Delete profile', danger: true, disabled: disabled || profile.profile === 'default' },
        ]}
        renderItem={item => <span className="agent-overview-menu-item">{item.label}{item.id === 'rename' && renameReason && <small>{renameReason}</small>}</span>}
        onAction={action => {
          if (action === 'rename' || action === 'duplicate') requestAnimationFrame(() => requestResourceNavigation(() => onName(action)))
          else if (action === 'delete') onDelete()
          else onTerminals()
        }} />
    </div></header>
    <ProfileConnections agents={agents} profile={profile} />
    <div className="agent-profile-body"><div className="agent-profile-settings"><ProfileSettings agents={agents} profile={profile} navigate={navigate} /></div>
    <section className="agent-overview-section agent-profile-recent" aria-label="Recent sessions">
      <div className="agent-overview-section-heading"><h3>Recent sessions</h3>
        <Button variant="ghost" size="sm" aria-label="View sessions" onPress={() => navigate('agents/sessions?home=' + encodeURIComponent(profile.id))}>View all<Icon name="arrow-right" /></Button>
      </div>
      {library.loading && !library.data && <PageLoading label="Loading sessions…" size="panel" />}
      {library.error && <p className="agents-error" role="alert">{library.error}</p>}
      <div className="agent-overview-sessions">{sessions.slice(0, 3).map(item => <Button key={item.key} variant="ghost"
        onPress={() => navigate('agents/sessions/' + item.provider + '/' + encodeURIComponent(item.profile) + '/' + encodeURIComponent(item.id) + '?home=' + encodeURIComponent(profile.id))}>
        <strong>{item.title}</strong><small>{item.cwd.split('/').at(-1)} · {new Date(item.updatedAt).toLocaleDateString()} · {item.state}</small>
      </Button>)}</div>
      {!library.loading && !library.error && !sessions.length && <p className="carrier-muted">No sessions yet.</p>}
    </section></div>
  </section></div>
}
