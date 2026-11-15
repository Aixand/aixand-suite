import { useState } from 'react'
import { Switch } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import { accountStatusLabel, saveProfileChanges } from './accountPresentation'
import { ProfileIconAction, ProfileStatus } from './ProfileControls'

export function ProfileConnections({ agents, profile, preference = false }: { agents: AgentsModel; profile: Profile; preference?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!profile.authentication && profile.authMode !== 'native') return null
  async function change(preferred?: boolean) {
    if (busy || agents.status !== 'connected') return
    setBusy(true); setError('')
    try {
      if (preferred === undefined) await agents.request('agent-profile-check', { provider: profile.provider, profile: profile.profile })
      else await saveProfileChanges(agents, profile, { preferred })
      await agents.refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this profile.') }
    finally { setBusy(false) }
  }
  if (preference) return <div className="agent-setting-row agent-preference-row"><h3>New chats</h3><div className="agent-setting-content">
    <Switch label="Use as default profile" checked={!!profile.preferred} disabled={busy || agents.status !== 'connected'} onChange={event => void change(event.target.checked)} />
    {error && <p role="alert" className="agents-error">{error}</p>}
  </div></div>
  return <section className="agent-profile-connections" aria-label="Profile connections">
    <div className="agent-connection-indicators">{!profile.authentication && <ProfileStatus
      label={profile.readiness?.verification === 'verified' ? 'Account access verified' : profile.readiness?.reason || 'Sign-in status needs checking.'}
      tone={busy ? 'pending' : profile.readiness?.verification === 'verified' ? 'success' : 'warning'} />}
      {(profile.authentication ? ['terminal', 'chat'] as const : []).map(scope => {
      const account = profile.authentication![scope]
      const readiness = profile.readiness?.[scope]
      const limited = account.usage?.state === 'limit-reached'
      const verified = ['signed-in', 'verified'].includes(account.state) && !account.stale
      const warning = limited || readiness?.ready === false || ['sign-in-required', 'credential-unavailable', 'account-mismatch', 'identity-unavailable'].includes(account.state)
      const reason = limited ? 'Usage limit reached at the last allowance check.' : readiness?.reason || account.statusLabel
      const label = `${scope === 'terminal' ? 'Terminal' : 'Chat'}: ${account.label} · ${accountStatusLabel(account)}${account.scope === 'shared' ? ' · Shared login' : ''}${warning && reason ? ` · ${reason}` : ''}`
      return <ProfileStatus key={scope} text={scope === 'terminal' ? 'Terminal' : 'Chat'} label={label}
        tone={busy ? 'pending' : warning ? 'warning' : verified ? 'success' : 'neutral'} />
    })}
      <ProfileIconAction label="Refresh connection status" icon="refresh-cw" disabled={busy || agents.status !== 'connected'} onPress={() => void change()} />
    </div>
    {error && <p role="alert">{error}</p>}
  </section>
}
