import type { ProjectRun } from './model'

export function ProjectProfile({ run }: { run: ProjectRun }) {
  const policy = run.profileSelection
  if (!policy) return null
  const profile = run.selectedProfile ?? run.profileDecision?.profile
  const quota = run.profileDecision?.quota
  return <p className="settings-help">
    {policy.mode === 'auto' ? 'Auto' : policy.mode === 'direct' ? 'Direct Codex' : 'Agent Manager'}
    {profile ? ` → ${profile}` : policy.mode === 'specific' ? ` · ${policy.profile}` : ''}
    {quota && ` · ${quota.weekly_left}% weekly allowance remaining at selection`}
  </p>
}
