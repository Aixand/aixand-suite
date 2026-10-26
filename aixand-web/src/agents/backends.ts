import type { Backend } from './client'

export function preferredBackend(backends: Backend[] | undefined, provider: string) {
  const choices = backends?.filter(row => row.provider === provider) ?? []
  return choices.find(row => row.default && row.available) ?? choices.find(row => row.available) ??
    choices.find(row => row.default) ?? choices[0]
}
