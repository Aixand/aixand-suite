import type { ChatItem } from './model'

export function sourceLabel(source: ChatItem['source']) {
  return source?.messageType === 'delegation_result' ? 'Result from' : 'Sent via'
}

export function sourceMessageText(text: string, source: ChatItem['source']) {
  if (source?.messageType !== 'delegation_result') return text
  try {
    const envelope = JSON.parse(text.slice(text.lastIndexOf('\n') + 1))
    if (envelope.kind !== 'delegation.result' || envelope.delegationId !== source.delegationId) return text
    if (typeof envelope.report === 'string') return envelope.report
    return 'The full report is saved in the spawned chat. The assistant will read it before continuing.'
  } catch { return text }
}
