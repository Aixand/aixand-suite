import type { AccountObservation, Profile } from './client'
import type { AgentsModel } from './model'

export type ProfileChanges = {
  auth?: string | null; claudeAccountId?: string | null
  sdkCredential?: string | null; sdkAuthentication?: 'api-key' | 'profile-login'
  model?: string | null; preferred?: boolean; preferIfUnset?: boolean
}

export function profileAccountLabel(profile: Pick<Profile, 'provider' | 'auth'> & Partial<Profile>, scope: 'terminal' | 'chat' = 'terminal') {
  const observed = profile.authentication?.[scope]
  if (observed) return observed.label
  if (scope === 'chat' && profile.sdk_authentication !== 'profile-login' && profile.sdk_credential) return profile.sdk_credential.name
  return profile.claude_account?.name ?? profile.auth ??
    (profile.authMode === 'native' || ['claude', 'copilot', 'antigravity'].includes(profile.provider)
      ? 'Provider-managed login' : profile.provider === 'opencode' ? 'Provider connections' : 'No saved account selected')
}

export function accountStatusLabel(account?: AccountObservation) {
  if (!account) return 'Status not checked'
  return account.statusLabel + (account.stale && ['signed-in', 'verified'].includes(account.state) ? ' · last checked ' +
    new Date(account.checkedAt!).toLocaleString() : '')
}

export async function saveProfileChanges(agents: AgentsModel, profile: Profile, changes: ProfileChanges) {
  // Catalogs from older companions remain usable during a rolling upgrade.
  if (!profile.authentication) {
    if ('auth' in changes) await agents.request('switch-auth', { provider: profile.provider, profile: profile.profile, auth: changes.auth })
    if ('model' in changes) await agents.request('set-model', { provider: profile.provider, profile: profile.profile, model: changes.model })
    if ('claudeAccountId' in changes) {
      const current = await agents.request<{ revision: string }>('agent-profile-get', { provider: profile.provider, profile: profile.profile })
      await agents.request('claude-account-bind', { key: crypto.randomUUID(), profile: profile.profile,
        accountId: changes.claudeAccountId, expectedRevision: current.revision })
    }
    if ('sdkCredential' in changes || 'sdkAuthentication' in changes) {
      for (const [field, op, values] of [
        ['sdkCredential', 'sdk-credential-assign', { name: changes.sdkCredential }],
        ['sdkAuthentication', 'sdk-auth-configure', { method: changes.sdkAuthentication }],
      ] as const) if (field in changes) {
        const current = await agents.request<{ revision: string }>('agent-profile-get', { provider: profile.provider, profile: profile.profile })
        await agents.request(op, { provider: profile.provider, profile: profile.profile, ...values, expectedRevision: current.revision })
      }
    }
    return
  }
  const revision = profile.revision ?? (await agents.request<{ revision: string }>('agent-profile-get', {
    provider: profile.provider, profile: profile.profile,
  })).revision
  await agents.request('agent-profile-update', { key: crypto.randomUUID(), provider: profile.provider,
    profile: profile.profile, expectedRevision: revision, changes })
}
