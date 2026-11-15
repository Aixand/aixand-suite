import type { IconName, SelectOption } from 'bbb-design'
import { mentionSlug } from './inboxReferences'

export type ComposerMentionOption = SelectOption & { keywords?: string[] }
export type ComposerMentionGroup = {
  id: string
  aliases?: string[]
  separator?: ':' | '/'
  label: string
  description: string
  icon: IconName
  options: ComposerMentionOption[]
  onSelect?: (id: string) => void
  onNavigate?: (id: string) => void
  insertText?: (id: string, followingText: string) => Promise<string | null>
  onOpen?: () => void
  browseOnly?: boolean
  onRetry?: () => void
  loading?: boolean
  error?: string
}

export function chatMentionLink(title: string, id: string) {
  const name = title.replace(/\s+/gu, ' ').trim() || 'Untitled chat'
  // Keep the saved name literal Markdown, including mention-like words inside it.
  const label = name.replaceAll('&', '&amp;').replaceAll('`', '&#96;').replace(/([\\[\]*_<>@])/g, '\\$1')
  return `[${label}](#/chat/${encodeURIComponent(id)})`
}

// Match names before descriptions, so a loose metadata match never outranks a name.
export function mentionScore(query: string, label: string, id: string, description = '', keywords: string[] = []) {
  const search = query.toLowerCase()
  const names = [label.toLowerCase(), mentionSlug(label), id.toLowerCase(), ...keywords.map(word => word.toLowerCase())]
  if (names.some(name => name === search)) return 0
  if (names.some(name => name.startsWith(search))) return 1
  if (names.some(name => name.includes(search))) return 2
  return description.toLowerCase().includes(search) ? 3 : Infinity
}

const RECENTS_KEY = 'aixand.chat.mention-recents.v1'
export function readMentionRecents(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(0, 32) : []
  } catch { return [] }
}
export function rememberMention(key: string, previous: string[]) {
  const next = [key, ...previous.filter(item => item !== key)].slice(0, 32)
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)) } catch { /* Keep recency in memory. */ }
  return next
}
