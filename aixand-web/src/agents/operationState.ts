import type { AgentJob } from './client'

export const isPendingOperation = (job: AgentJob) => ['queued', 'starting', 'running', 'uncertain'].includes(job.status)

export const isWaitingForSignIn = (job: AgentJob) => job.status === 'running' && !job.result?.loginSaved
  && ['new-login', 'reauthenticate', 'profile-login'].includes(job.kind)
  && (job.structured ? job.phase === 'awaiting-user' : !['verifying', 'finishing'].includes(job.phase ?? ''))
