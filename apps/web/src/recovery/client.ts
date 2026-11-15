import { workspaceFetch } from '../auth/transport'
import { randomUUID } from '../uuid'
import { authRequest, AuthError } from '../auth/client'
import type { ChatTerminal } from '../chats/model'

export type Availability = 'unchecked' | 'checking' | 'ready' | 'busy' | 'terminal' | 'saved' | 'unsupported' | 'unknown' | 'blocked'
export type RecoverySession = {
  id: string; title: string; provider: string; profile: string; project?: string; cwd?: string
  updatedAt: number; createdAt?: number; availability: Availability; source: 'suite' | 'provider'; terminal?: ChatTerminal | null
}
export type RecoveryCatalog = { sessions: RecoverySession[]; total: number; nextCursor: string | null; profiles: string[]; projects: string[]; partial: boolean; errors: string[] }
export type TerminalRecovery = { chatId: string; supported: boolean; availability: Availability; reason?: string | null; terminal?: ChatTerminal | null; conversation?: RecoverySession }

export async function recoveryRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  let csrfToken: string | undefined
  if (body !== undefined) csrfToken = (await authRequest<{ csrfToken: string }>('session')).csrfToken
  const response = await workspaceFetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken! },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('aixand-auth-check'))
    throw new AuthError(response.status, typeof value.message === 'string' ? value.message : 'Session recovery is unavailable. Try again shortly.')
  }
  return value as T
}

export function recoveryOperation(chatId: string, kind: 'open' | 'release') {
  const name = `aixand.recovery.${chatId}.${kind}`
  let key: string | null = null
  try { key = sessionStorage.getItem(name) } catch { /* The server association also deduplicates tabs. */ }
  if (!key) {
    key = randomUUID()
    try { sessionStorage.setItem(name, key) } catch { /* Runtime ownership remains durable on the server. */ }
  }
  return { key, done() { try { sessionStorage.removeItem(name) } catch { /* Storage may be unavailable. */ } } }
}
