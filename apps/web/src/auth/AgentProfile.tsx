import { Button, Icon, TextField } from 'bbb-design'
import type { AgentJob, Catalog } from '../agents/client'
import { setupAccount, type SetupProvider, type SetupState } from './agentSetup'

export function AgentProfile({ progress, provider, catalog, operations, disabled, error, profileMatches, onNameChange, onFinish }: {
  progress: SetupState
  provider: SetupProvider
  catalog: Catalog
  operations: AgentJob[]
  disabled: boolean
  error: string
  profileMatches: boolean
  onNameChange: (name: string) => void
  onFinish: () => void
}) {
  const { draft, native, ready, pending, verification } = setupAccount(provider, progress, catalog, operations)
  const account = catalog.profiles.find(row => row.provider === provider && row.profile === (draft.nativeProfile || draft.profileName))?.authentication?.terminal
  const status = provider === 'opencode' && draft.freeModels ? 'Use free models without signing in.' : account?.statusLabel ?? (verification === 'verified' ? 'Account access verified' : native ? 'Sign-in is managed by the provider.' : 'Credentials configured · access not checked')
  const canFinish = !disabled && !error && ready && !pending
  return <form className="setup-section-content setup-profile-form" onSubmit={event => {
    event.preventDefault()
    if (canFinish) onFinish()
  }}>
    <TextField variant="outlined" label="Profile name" value={draft.profileName} disabled={disabled || !!draft.nativeProfile} required
      hint={draft.nativeProfile ? 'Profile created.' : undefined}
      error={error || undefined} onChange={event => onNameChange(event.target.value)} />
    {profileMatches && <p role="status" className="setup-profile-existing"><Icon name="circle-check" />Existing profile</p>}
    <p className="setup-note">{status}</p>
    {pending && <p role="status" className="setup-note">Wait for this agent’s current operation to finish before continuing.</p>}
    <Button type="submit" disabled={!canFinish}>{profileMatches ? 'Use this profile' : 'Create profile'}<Icon name="arrow-right" /></Button>
  </form>
}
