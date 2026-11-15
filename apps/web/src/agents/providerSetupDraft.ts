import type { Catalog } from './client'
import { setupDraft, type SetupDraft } from '../auth/agentSetup'

export type ProviderDraft = SetupDraft & { context?: string }
const memory = new Map<string, ProviderDraft>()
export const providerDraftKey = (provider: string, cwd: string) => `aixand.agents.provider-setup.v1:${cwd}:${provider}`

export function availableSetupName(base: string, existing: string[]) {
  let name = base
  let suffix = 2
  while (existing.some(value => value.toLowerCase() === name.toLowerCase())) {
    const ending = `-${suffix++}`
    name = base.slice(0, 128 - ending.length) + ending
  }
  return name
}

export function freshProviderDraft(provider: string, catalog: Catalog, auth = ''): ProviderDraft {
  const compatible = catalog.auths.filter(row => row.provider === provider && row.verification !== 'failed')
  const preferred = catalog.profiles.find(row => row.provider === provider && row.preferred)?.auth
  auth ||= compatible.find(row => row.auth === preferred)?.auth ?? (compatible.length === 1 ? compatible[0].auth : '')
  return { ...setupDraft(), auth,
    loginName: availableSetupName('personal', catalog.auths.filter(row => row.provider === provider).map(row => row.auth)),
    profileName: availableSetupName('work', catalog.profiles.filter(row => row.provider === provider).map(row => row.profile)),
  }
}

export function readProviderDraft(key: string): ProviderDraft | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!raw || typeof raw !== 'object') return memory.get(key) ?? null
    const value = raw as Record<string, unknown>
    if (!['auth', 'loginName', 'profileName'].every(name => typeof value[name] === 'string' && (value[name] as string).length <= 128)) return null
    return { ...setupDraft(), auth: value.auth as string, loginName: value.loginName as string, profileName: value.profileName as string,
      operationId: typeof value.operationId === 'string' ? value.operationId : null,
      nativeProfile: typeof value.nativeProfile === 'string' ? value.nativeProfile : null,
      profileRequestId: typeof value.profileRequestId === 'string' ? value.profileRequestId : undefined,
      profileIdentity: typeof value.profileIdentity === 'string' ? value.profileIdentity : undefined,
      context: typeof value.context === 'string' ? value.context : undefined,
      done: value.done === true,
    }
  } catch { return memory.get(key) ?? null }
}

export function saveProviderDraft(key: string, draft: ProviderDraft) {
  memory.set(key, draft)
  // Store names and operation receipts only; credentials remain in Agent Manager.
  try { localStorage.setItem(key, JSON.stringify(draft)) } catch { /* Keep progress for this visit. */ }
}
