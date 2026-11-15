import type { AgentJob } from './client'

export const isPendingOperation = (job: AgentJob) => ['queued', 'starting', 'running', 'uncertain'].includes(job.status)

export const isWaitingForSignIn = (job: AgentJob) => job.status === 'running' && !job.result?.loginSaved
  && ['new-login', 'reauthenticate', 'profile-login'].includes(job.kind)
  && (job.kind === 'profile-login' || job.structured ? job.phase === 'awaiting-user' : !['verifying', 'finishing'].includes(job.phase ?? ''))

const signinBlockers: Record<string, string> = {
  active_turns: 'Finishing a response', active_thread: 'Agent is still working',
  delegated_task: 'Child task has not finished', requests: 'Waiting for an approval or answer',
  queued_work: 'Has queued messages', background_commands: 'Has running commands',
  active_goal: 'Has an active goal', inflight_operations: 'Finishing an operation',
  external_session: 'Close this profile’s native terminal sessions',
  component_upgrade_required: 'Update the conversation service before signing in',
  shared_server_session: 'Close this profile’s shared server sessions before signing in',
  unconfirmed_startup: 'Chat startup needs checking', stop_unconfirmed: 'Waiting to confirm the session stopped',
}
export const signinBlockerLabel = (kind: string) => signinBlockers[kind] ?? 'Could not confirm that this session is idle'
