import { randomUUID } from '../uuid'
import { profileAccountLabel } from './accountPresentation'
import { useState } from 'react'
import { Button, TextField } from 'bbb-design'
import type { AgentJob, Provider } from './client'
import type { AgentsModel } from './model'
import { OperationStatus } from './AgentOperations'
import { providerLabel } from './presentation'

export type ManagedProfile = {
  provider: Provider; profile: string; auth: string | null; authMode: 'files' | 'native'; identity: string; revision: string
}
export type ManagementAction = {
  id: string; sourceChatId: string; sourceTurnId?: string; sourceCallId?: string; createdAt: number
  provider: Provider; profile?: string; tool: string; status: string; url: string; error?: string
  operationId?: string; operation?: AgentJob
  result?: { profile?: ManagedProfile; created?: boolean; deleted?: boolean; renamed?: boolean; assignmentError?: string; cleanupPending?: boolean }
}

export function AgentManagementCard({ action, agents: a, navigate }: {
  action: ManagementAction; agents: AgentsModel; navigate: (route: string) => void
}) {
  const profile = action.result?.profile
  const [auth, setAuth] = useState(profile?.auth ?? profile?.profile ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [job, setJob] = useState<AgentJob | null>(null)
  const operation = job ?? a.operations.find(row => row.sourceChatId === action.sourceChatId
    && row.sourceCallId === action.sourceCallId && !!action.sourceCallId
    && (row.assignProfile === action.profile || row.profile === action.profile)) ?? action.operation
  async function signIn() {
    if (!profile || busy) return
    setBusy(true); setError('')
    try {
      const current = await a.request<ManagedProfile>('agent-profile-get', { provider: profile.provider, profile: profile.profile })
      if (current.identity !== profile.identity) throw new Error('This profile was replaced. Open Manage profile to select its current version.')
      const native = current.authMode === 'native'
      const saved = a.catalog?.auths.some(login => login.provider === profile.provider && login.auth === auth.trim())
      const result = await a.request<AgentJob>('agent-operation-start', {
        key: randomUUID(), provider: profile.provider,
        kind: native ? 'profile-login' : saved ? 'reauthenticate' : 'new-login',
        ...(native ? { profile: profile.profile } : { auth: auth.trim(), assignProfile: profile.profile }),
        expectedRevision: current.revision,
        ...(!native && profile.provider === 'codex' ? { device: true, structured: true } : {}),
        sourceChatId: action.sourceChatId, sourceTurnId: action.sourceTurnId, sourceCallId: action.sourceCallId,
      })
      setJob(result)
      await a.refreshOperations()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start sign-in.') }
    finally { setBusy(false) }
  }
  return <section className="command-launch-card" aria-label="Profile management result">
    <strong>{providerLabel(action.provider)} · {action.profile ?? 'Profile management'}</strong>
    <p>{action.status === 'completed' ? ({ create_profile: 'Profile created', duplicate_profile: 'Profile duplicated',
      rename_profile: 'Profile renamed', delete_profile: 'Profile deleted', assign_login: 'Login assigned',
      unassign_login: 'Login unassigned' } as Record<string, string>)[action.tool] ?? 'Operation completed'
      : action.status === 'accepted' ? 'Sign-in started' : action.status === 'submitting' ? 'Preparing…'
        : action.status === 'uncertain' ? 'Completion needs checking' : action.status === 'cancelled' ? 'Cancelled' : 'Operation failed'}</p>
    {(action.error || error || action.result?.assignmentError) && <p role="alert">{error || action.error || action.result?.assignmentError}</p>}
    {action.result?.cleanupPending && <p>Profile removed. Some local files still need cleanup.</p>}
    {operation ? <OperationStatus job={operation} agents={a} navigate={navigate} /> : profile && action.status === 'completed' && <>
      <p>{profileAccountLabel(profile)}</p>
      {profile.authMode === 'files' && <TextField label="Saved login name" value={auth} disabled={busy}
        onChange={event => setAuth(event.target.value)} maxLength={128} />}
      <Button variant="secondary" disabled={busy || a.status !== 'connected' || profile.authMode === 'files' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(auth.trim())}
        loading={busy} onPress={() => void signIn()}>Sign in</Button>
    </>}
    <Button variant="ghost" onPress={() => navigate(profile
      ? `agents/profiles?profile=${encodeURIComponent(`${profile.provider}/${profile.profile}`)}`
      : action.url.replace(/^#\//, ''))}>Manage profile</Button>
  </section>
}
