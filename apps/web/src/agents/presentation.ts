import type { Auth, Profile, Provider, Run, Sessions } from './client'

export const providerLabel = (provider: Provider) =>
  ({ codex: 'Codex', opencode: 'OpenCode', claude: 'Claude', antigravity: 'Antigravity (agy)', copilot: 'GitHub Copilot' })[provider] ?? provider

const terminal = new Set(['stopped', 'exited', 'failed'])

export const isActiveRun = (run: Run) =>
  run.observation ? !terminal.has(run.observation.lifecycle) : run.active

export function profileDeletionReason(profile: Profile, sessions: Sessions | null) {
  if (profile.profile === 'default') return 'Default profiles cannot be deleted.'
  if (profile.active_runs > 0 || sessions?.runs.some(run => run.provider === profile.provider && run.profile === profile.profile && isActiveRun(run)))
    return 'Stop active agents in Terminals before deleting this profile.'
  return ''
}

export function loginHasActiveRuns(login: Pick<Auth, 'provider' | 'auth'>, profiles: Profile[], sessions: Sessions | null) {
  return profiles.some(profile => profile.provider === login.provider && profile.auth === login.auth && profile.active_runs > 0)
    || Boolean(sessions?.runs.some(run => run.provider === login.provider && run.auth === login.auth && isActiveRun(run)))
}

export type AgentOperation = (
  key: string,
  operation: () => Promise<void>,
) => Promise<void>
