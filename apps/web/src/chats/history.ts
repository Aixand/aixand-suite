import type { Chat, ChatItem, ChatSnapshot } from './model'

export const RECENT_TURNS = 5
export const CACHED_CONVERSATIONS = 5
// Approximate UTF-16 storage, including space for item properties.
export const TRANSCRIPT_BYTES = 512 * 1024
// The active reader keeps fetched pages in both directions. Inactive chats
// still use the small five-turn cache above.
export const ACTIVE_TRANSCRIPT_TURNS = 50
export const ACTIVE_TRANSCRIPT_BYTES = 8 * 1024 * 1024

function boundedItems(items: ChatItem[], turns: number, budget: number, fromStart = false) {
  const groups: string[] = []
  let group = ''
  for (const item of items) {
    if (item.turnId) group = item.turnId
    else if (item.type === 'userMessage' || !group) group = item.id
    groups.push(group)
  }
  let count = 0
  let bytes = 0
  const retained = new Set<string>()
  while (count < items.length) {
    const index = fromStart ? count : items.length - count - 1
    const item = items[index]
    const size = 256 + 2 * (item.text.length + (item.command?.length ?? 0))
    const next = groups[index]
    if (count && (bytes + size > budget || (!retained.has(next) && retained.size >= turns))) break
    retained.add(next)
    bytes += size
    count++
  }
  return { items: count === items.length ? items : fromStart ? items.slice(0, count) : items.slice(items.length - count), trimmed: count < items.length }
}

export function recentItems(items: ChatItem[], turns = RECENT_TURNS, budget = TRANSCRIPT_BYTES) {
  return boundedItems(items, turns, budget)
}

export function loadedItems(items: ChatItem[], direction: 'before' | 'after' = 'after') {
  return boundedItems(items, ACTIVE_TRANSCRIPT_TURNS, ACTIVE_TRANSCRIPT_BYTES, direction === 'before')
}

export function recentSnapshot(snapshot: ChatSnapshot): ChatSnapshot {
  // Search windows are already byte-bounded and must retain the matching item.
  if (snapshot.indexedHistory) return snapshot
  const { items, trimmed } = recentItems(snapshot.items)
  if (!trimmed && !(snapshot.historyTruncated && snapshot.historyCursor === undefined && items.length)) return snapshot
  return { ...snapshot, items, historyCursor: items[0].id }
}

export function chatSummary(snapshot: Chat | ChatSnapshot): Chat {
  const { items: _items, supervisionUpdates: _updates, requests: _requests, queue: _queue, launches: _launches, commandOutput: _commandOutput,
    workflows: _workflows, discoveries: _discoveries, transfers: _transfers,
    projectRuns: _runs, indexedHistory: _indexed, searchItemId: _searchItem, historyTruncated: _truncated, historyCursor: _cursor,
    historyUnavailable: _unavailable, historyAfter: _after, syncing: _syncing, ...summary } = snapshot as ChatSnapshot
  return summary
}

// Durable supervision updates belong beside the source message that was current
// when they arrived. Provider pagination keeps using actual provider item IDs.
export function supervisionItems(chat: ChatSnapshot): ChatItem[] {
  const updates = new Map<string, ChatItem[]>()
  for (const item of chat.supervisionUpdates ?? []) {
    const anchor = item.afterItemId ?? ''
    updates.set(anchor, [...(updates.get(anchor) ?? []), item])
  }
  return [
    ...(!chat.historyCursor ? updates.get('') ?? [] : []),
    ...chat.items.flatMap(item => [item, ...(updates.get(item.id) ?? [])]),
  ]
}
