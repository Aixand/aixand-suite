import type { Backend, Catalog, Profile } from './client'

export function profileTerminalAvailable(catalog: Catalog | null, profile: Profile) {
  return profile.readiness?.terminal?.available ?? profile.readiness?.terminal?.ready ?? (profile.readiness?.ready === false && !profile.readiness.chat ? false :
    catalog?.capabilities.find(row => row.provider === profile.provider)?.installed ?? false)
}

export function profileChatReady(catalog: Catalog | null, profile: Profile) {
  if ((profile.readiness?.chat?.ready ?? profile.readiness?.ready) === false) return false
  const backends = catalog?.backends?.filter(row => row.provider === profile.provider) ?? []
  if (backends.length) return backends.some(row => row.available)
  // Older catalogs omit readiness and backend metadata; honor their installation flag when present.
  return catalog?.capabilities.find(row => row.provider === profile.provider)?.installed ?? profile.readiness?.ready ?? true
}

export function preferredBackend(backends: Backend[] | undefined, provider: string) {
  const choices = backends?.filter(row => row.provider === provider) ?? []
  return choices.find(row => row.default && row.available) ?? choices.find(row => row.available) ??
    choices.find(row => row.default) ?? choices[0]
}
