import type { AgentsModel } from './model'

// Both setup surfaces use the same receipt and assignment checks.
export async function createSetupProfile(agents: AgentsModel, provider: string, profile: string, auth: string | undefined, key: string, options: { model?: string } = {}) {
  const result = await agents.request<{ assignmentError?: string; status?: string; profile?: { identity: string } }>('create-profile', {
    key, provider, profile, ...(auth ? { auth } : {}), ...options,
  })
  if (result.status === 'uncertain' || result.assignmentError) {
    await agents.refresh()
    throw new Error(result.assignmentError || 'Profile creation is unconfirmed. Refresh profiles before retrying.')
  }
  return result.profile?.identity
}
