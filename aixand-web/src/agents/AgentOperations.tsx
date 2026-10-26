import { useState } from 'react'
import { LoginChallenge } from './LoginChallenge'
import { InstallationProgress } from './InstallationProgress'
import { Accordion, Button, Icon, StatusIndicator } from 'bbb-design'
import type { AgentJob, OperationKind } from './client'
import type { AgentsModel } from './model'
import { providerLabel } from './presentation'
import { isPendingOperation, isWaitingForSignIn } from './operationState'

export { isPendingOperation } from './operationState'
export const operationLabel = (kind: OperationKind) => ({
  'new-login': 'New login', reauthenticate: 'Sign in again', 'import-login': 'Import login',
  'profile-login': 'Sign in to profile',
  'install-sdk': 'Install provider SDK',
  'check-login': 'Check login', install: 'Install', update: 'Update', repair: 'Repair installation',
  uninstall: 'Uninstall CLI', disable: 'Disable provider', enable: 'Restore provider',
})[kind]

export function OperationStatus({ job: initialJob, agents: a, navigate }: {
  job: AgentJob; agents: AgentsModel; navigate: (route: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resolving, setResolving] = useState(false)
  const [retryId, setRetryId] = useState<string | null>(null)
  const job = a.operations.find((row) => row.id === retryId) ?? initialJob
  const pending = isPendingOperation(job)
  const waiting = isWaitingForSignIn(job)
  const loginAlreadySaved = job.result?.loginSaved || ['new-login', 'import-login'].includes(job.kind) && a.catalog?.auths.some((auth) => auth.provider === job.provider && auth.auth === job.auth)
  return <div className="agents-operation" aria-label={`${operationLabel(job.kind)} ${job.auth || providerLabel(job.provider)}`}>
    <div className="agents-operation-copy">
      <strong>{job.origin === 'external' ? 'Credentials changed' : operationLabel(job.kind)} · {job.auth || job.profile || providerLabel(job.provider)}</strong>
      {job.origin && <p className="ws-note">{job.origin === 'external' ? 'Detected outside Manager.' : `Started in ${job.origin === 'cli' ? 'the CLI' : job.origin === 'sdk' ? 'the SDK' : 'the suite'}.`}</p>}
      <StatusIndicator tone={job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'danger'
        : job.status === 'uncertain' ? 'warning' : 'neutral'}
        label={job.status === 'succeeded' ? 'Completed' : job.status === 'queued'
          ? ['install', 'update', 'repair', 'uninstall', 'disable', 'enable'].includes(job.kind) ? 'Waiting for idle' : 'Queued'
          : job.status === 'uncertain' ? 'Needs attention' : waiting ? 'Waiting for you' : job.status === 'running'
            ? job.phase === 'finishing' ? 'Finishing sign-in' : job.phase === 'verifying' ? 'Checking sign-in' : 'In progress'
          : job.status === 'starting' ? 'Starting' : job.status === 'cancelled' ? 'Cancelled' : 'Failed'} />
      <p>{job.structured && job.status === 'running' && !job.result?.loginSaved ? job.phase === 'verifying' ? 'Verifying account access…'
        : job.phase === 'awaiting-user' ? 'Complete sign-in in your browser.' : 'Preparing sign-in…'
        : waiting && !(job.provider === 'antigravity' && job.kind === 'profile-login') ? 'Open the terminal to continue signing in.' : job.message}</p>
      <LoginChallenge job={job} agents={a} />
      {job.provider === 'antigravity' && job.kind === 'profile-login' && job.status === 'running' && !job.observed && job.phase !== 'finishing' && <Button
        variant="secondary" size="sm" disabled={busy || a.status !== 'connected'} onPress={() => {
          setBusy(true); setError('')
          void a.refreshOperations().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not check sign-in.'))
            .finally(() => setBusy(false))
        }}>Check sign-in</Button>}
      <InstallationProgress job={job} connected={a.status === 'connected'} />
      {job.result?.assignmentError && <p role="alert">{job.result.assignmentError}</p>}
      {job.result?.recovery?.map((recovery) => <p key={recovery.id} role={recovery.phase === 'needs_attention' ? 'alert' : 'status'}>
        {recovery.profile}: {recovery.phase === 'ready' ? 'Ready to reconnect conversations.'
          : recovery.phase === 'needs_attention' ? 'Sign-in saved. This profile needs attention before its conversations can reconnect.'
            : recovery.phase === 'superseded' ? 'A newer sign-in replaced this recovery.'
              : recovery.blockers.some((blocker) => blocker.kind === 'login_activity_unavailable')
                ? 'Sign-in saved. Finish the existing server session, then reconnect this conversation.'
              : recovery.blockers.some((blocker) => blocker.kind === 'logins')
                ? 'Sign-in saved. Complete or cancel the other pending sign-in before reconnecting.'
              : recovery.blockers.some((blocker) => ['native_clients', 'terminal_attachment', 'terminal_process', 'cli_process'].includes(blocker.kind))
                ? 'Sign-in saved. Close the attached terminal sessions to reconnect conversations.'
                : recovery.blockers.some((blocker) => ['active_thread', 'requests', 'realtime', 'active_goal', 'queued_work', 'background_commands'].includes(blocker.kind))
                  ? 'Sign-in saved. Waiting for active work to finish.' : 'Sign-in saved. Reconnecting conversations…'}
      </p>)}
      {job.kind === 'check-login' && job.result?.verification === 'unsupported' && <p>Credentials are readable. Account verification is unavailable for this provider.</p>}
    </div>
    <div className="agents-operation-actions">
      {['failed', 'cancelled'].includes(job.status) && !['uninstall', 'disable', 'enable'].includes(job.kind) && !loginAlreadySaved && !job.observed && <Button variant="secondary" size="sm"
        disabled={busy || a.status !== 'connected' || a.operations.some((row) => row.provider === job.provider && isPendingOperation(row))}
        onPress={() => {
          setBusy(true); setError('')
          const key = crypto.randomUUID()
          setRetryId(key)
          void a.request('agent-operation-start', {
            key, provider: job.provider, kind: job.kind,
            ...(job.kind === 'profile-login' ? { profile: job.profile } : job.auth ? { auth: job.auth } : { whenIdle: true }),
            ...(job.provider === 'codex' && ['new-login', 'reauthenticate'].includes(job.kind) ? { device: job.device ?? true } : {}),
            ...(job.kind === 'install' && job.method ? { method: job.method } : {}),
            ...(job.structured ? { structured: true } : {}),
            ...(job.assignProfile ? { assignProfile: job.assignProfile, expectedRevision: job.expectedProfileRevision } : {}),
            ...(job.sourceChatId ? { sourceChatId: job.sourceChatId, sourceTurnId: job.sourceTurnId, sourceCallId: job.sourceCallId } : {}),
          }).then(() => a.refreshOperations())
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not retry this operation.'))
            .finally(() => setBusy(false))
        }}>Retry operation</Button>}
      {job.status === 'uncertain' && !job.cancellable && <Button variant="secondary" size="sm"
        disabled={busy || a.status !== 'connected'} onPress={() => {
          if (!resolving) { setResolving(true); return }
          setBusy(true); setError('')
          void a.request('agent-operation-resolve', { operationId: job.id, confirmed: true }).then(() => a.refreshOperations())
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not resolve this operation.'))
            .finally(() => setBusy(false))
        }}>{resolving ? 'Confirm unconfirmed completion' : 'Resolve missing operation'}</Button>}
      {job.sessionId && <Button variant="secondary" size="sm" onPress={() => navigate(`terminals/${encodeURIComponent(job.sessionId!)}`)}>
        <Icon name="monitor" />Open terminal</Button>}
      {pending && (job.status === 'queued' || job.cancellable) && <Button variant="ghost" size="sm"
        disabled={busy || a.status !== 'connected'} loading={busy} onPress={() => {
          if (busy) return
          setBusy(true); setError('')
          void a.request('agent-operation-cancel', { operationId: job.id }).then(() => a.refreshOperations())
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not cancel this operation.'))
            .finally(() => setBusy(false))
        }}>Cancel operation</Button>}
    </div>
    {resolving && <p className="ws-note">Check the originating terminal before resolving. This acknowledges missing progress; completion remains unconfirmed.</p>}
    {error && <p role="alert" className="agents-error">{error}</p>}
  </div>
}

export function AgentOperations({ agents: a, navigate }: { agents: AgentsModel; navigate: (route: string) => void }) {
  const active = a.operations.filter(isPendingOperation)
  const waiting = active.filter(isWaitingForSignIn)
  const recent = a.operations.filter((job) => !isPendingOperation(job)).slice(0, 5)
  if (!active.length && !recent.length && !a.operationsError) return null
  return <section className="agents-operations" aria-label="Agent operations">
    <h2 className="tw-sr-only">Agent operations</h2>
    {a.operationsError && <div className="agents-operation">
      <p role="alert" className="agents-error">{a.operationsError}</p>
      <Button variant="ghost" size="sm" disabled={a.status !== 'connected'} onPress={() => void a.refreshOperations()}>Refresh operations</Button>
    </div>}
    {active.length > 0 && <div role="status" className="agents-operation-summary">
      {waiting.length === active.length ? `${waiting.length} ${waiting.length === 1 ? 'sign-in needs' : 'sign-ins need'} your attention`
        : `${active.length} ${active.length === 1 ? 'operation' : 'operations'} in progress${waiting.length ? `; ${waiting.length} waiting for sign-in` : ''}`}
    </div>}
    {active.map((job) => <OperationStatus key={job.id} job={job} agents={a} navigate={navigate} />)}
    {recent.length > 0 && <><h3 className="tw-sr-only">Operation history</h3><Accordion items={[{ id: 'recent-operations', title: 'Recent operations',
      content: recent.map((job) => <OperationStatus key={job.id} job={job} agents={a} navigate={navigate} />),
    }]} /></>}
  </section>
}
