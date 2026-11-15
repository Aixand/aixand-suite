export type RecoveryEvent = { kind: 'open' | 'failure' | 'healthy' | 'crash'; chatId?: string }
let pending: RecoveryEvent | undefined

export function reportRecovery(event: RecoveryEvent) {
  if (event.kind === 'open' || event.kind === 'crash') pending = event
  window.dispatchEvent(new CustomEvent<RecoveryEvent>('aixand-recovery', { detail: event }))
}

export function takeRecoveryRequest() {
  const event = pending
  pending = undefined
  return event
}

export function currentChatId() {
  return window.location.hash.match(/^#\/(?:chat|command)\/([a-f0-9-]{36})(?:\?|$)/i)?.[1]
}
