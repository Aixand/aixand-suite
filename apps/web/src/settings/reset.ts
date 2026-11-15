export type ResetScope = 'chats' | 'everything'
export const resetPhrase = (scope: ResetScope) => scope === 'chats' ? 'RESET CHATS' : 'RESET EVERYTHING'
let pendingKey: string | undefined
export function setPendingReset(key?: string) { pendingKey = key }
export function isPendingReset(key: string) { return pendingKey === key }

export function clearResetStorage(scope: ResetScope) {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      const canonical = key
      if (scope === 'everything' ? /^aixand\./.test(key)
        : /^(aixand\.(chat|command|recovery)\.)/.test(canonical)) storage.removeItem(key)
      if (scope === 'chats' && canonical === 'aixand.home.visits.v1') {
        let visits: Record<string, unknown> = {}
        try {
          const stored: unknown = JSON.parse(storage.getItem(key) ?? '{}')
          if (stored && typeof stored === 'object' && !Array.isArray(stored)) visits = stored as Record<string, unknown>
        } catch { /* Discard malformed recency data. */ }
        storage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(visits)
          .filter(([id]) => !id.startsWith('chat:')))))
      }
    }
  }
}

const NOTICE_KEY = 'aixand.reset.notice'
const ONBOARDING_KEY = 'aixandResetOnboarding'

export function resetOnboardingRequested() {
  return window.history.state?.[ONBOARDING_KEY] === true
}

export function acknowledgeResetOnboarding() {
  const state = { ...window.history.state }
  delete state[ONBOARDING_KEY]
  window.history.replaceState(state, '')
}

export function finishReset(scope: ResetScope) {
  clearResetStorage(scope)
  try { sessionStorage.setItem(NOTICE_KEY, scope === 'chats' ? 'Chats reset successfully.' : 'Workspace reset successfully.') }
  catch { /* Completion does not depend on a browser notice. */ }
  const state = { ...window.history.state }
  if (scope === 'everything') state[ONBOARDING_KEY] = true
  window.history.replaceState(state, '', scope === 'everything' ? '#/home' : '#/settings?section=data')
  window.location.reload()
}

export function readResetNotice() {
  try { return sessionStorage.getItem(NOTICE_KEY) ?? '' } catch { return '' }
}
