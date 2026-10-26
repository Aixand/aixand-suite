import { useState } from 'react'
import { Button, Checkbox } from 'bbb-design'
import type { Profile } from './client'
import type { AgentsModel } from './model'
import { accountStatusLabel, saveProfileChanges } from './accountPresentation'

export function ProfileConnections({ agents, profile }: { agents: AgentsModel; profile: Profile }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!profile.authentication) return null
  async function change(preferred?: boolean) {
    setBusy(true); setError('')
    try {
      if (preferred === undefined) await agents.request('agent-profile-check', { provider: profile.provider, profile: profile.profile })
      else await saveProfileChanges(agents, profile, { preferred })
      await agents.refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update this profile.') }
    finally { setBusy(false) }
  }
  return <section className="agent-task-section" aria-label="Profile connections">
    {(['terminal', 'chat'] as const).map(scope => {
      const account = profile.authentication![scope]
      const readiness = profile.readiness?.[scope]
      return <div key={scope}>
        <strong>{scope === 'terminal' ? 'Terminal' : 'Chat'}: {account.label}</strong>
        <p>{accountStatusLabel(account)}{account.scope === 'shared' ? ' · Shared login' : ''}</p>
        {account.usage?.state === 'limit-reached' && <p>Usage limit reached at the last allowance check.</p>}
        {readiness?.ready === false && readiness.reason !== account.statusLabel && <p>{readiness.reason}</p>}
      </div>
    })}
    <Button variant="secondary" disabled={busy || agents.status !== 'connected'} onPress={() => void change()}>Refresh connection status</Button>
    <Checkbox label="Preferred profile for new chats" isSelected={!!profile.preferred}
      disabled={busy || agents.status !== 'connected'} onChange={value => void change(value)} />
    {error && <p role="alert">{error}</p>}
  </section>
}
