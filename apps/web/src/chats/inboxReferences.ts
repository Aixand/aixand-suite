import type { CarrierMessage } from '../carrier/client'

export type InboxReference = {
  token: string
  mailbox: string
  mailboxName: string
  id: string
  instance: string
  title: string
}
export type CarrierRequest = <T>(op: string, args?: object) => Promise<T>
export type MessageSummary = Pick<CarrierMessage, 'id' | 'title' | 'sender' | 'created_at'> & { preview: string }
export type MessageSearch = { instance: string; messages: MessageSummary[]; total: number; next_offset: number | null }

export function mentionSlug(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'message'
}

// References in code examples are ordinary text, including incomplete fences.
export function codeRanges(text: string) {
  return [...text.matchAll(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1[^\n]*(?:\n|$)|$)|(`+)[^\n]*?(?:\2(?!`)|$)/g)]
    .map((match) => ({ start: match.index!, end: match.index! + match[0].length }))
}

function inboxMentions(text: string) {
  const code = codeRanges(text)
  return [...text.matchAll(/(?:^|\s)(@inbox(?:\/[^\s]*)?)(?=\s|$)/g)].flatMap((match) => {
    const start = match.index! + match[0].length - match[1].length
    return code.some((range) => start >= range.start && start < range.end) ? [] : [{ token: match[1], start, end: start + match[1].length }]
  })
}

export function inboxTokens(text: string) {
  return inboxMentions(text).map((mention) => mention.token)
}

export function removeInboxReference(text: string, token: string) {
  for (const mention of inboxMentions(text).filter((item) => item.token === token).reverse()) {
    text = text.slice(0, mention.start) + text.slice(mention.end)
  }
  return text
}

export function activeMention(text: string, caret: number, namespaces: string[] = ['inbox']) {
  if (caret < 0 || caret > text.length) return null
  if (codeRanges(text).some((range) => caret > range.start && caret <= range.end)) return null
  const before = text.slice(0, caret)
  const match = /(?:^|\s)(@[^\s]*)$/.exec(before)
  if (!match) return null
  const token = match[1]
  if (token.slice(1).includes('@')) return null
  const explicit = /^@([^/:]+)([/:])/.exec(token.toLowerCase())
  if (explicit && ['inbox', 'file', 'project', 'profile', 'agent', 'model', 'prompt', 'skill', 'chat', 'workflow', 'effort', 'reasoning', 'thinking', 'speed', 'fast', 'mode'].includes(explicit[1]) && !namespaces.includes(explicit[1])) return null
  if (explicit && namespaces.includes(explicit[1]) && explicit[1] !== 'chat' && explicit[2] !== (['inbox', 'workflow'].includes(explicit[1]) ? '/' : ':')) return null
  const start = caret - token.length
  const tail = /^[^\s]*/.exec(text.slice(caret))![0]
  return { start, end: caret + tail.length, token }
}

export function retainedReferences(text: string, references: InboxReference[] = []) {
  const tokens = new Set(inboxTokens(text))
  return references.filter((reference) => tokens.has(reference.token))
}

export async function resolveInboxPrompt(text: string, references: InboxReference[] | undefined, request: CarrierRequest, limit = 32000) {
  const tokens = [...new Set(inboxTokens(text))]
  if (!tokens.length) return text
  const selected = tokens.map((token) => {
    const reference = references?.find((value) => value.token === token)
    if (!reference) throw new Error(`Choose a message from the Inbox suggestions to complete ${token}.`)
    return reference
  })
  if (selected.length > 8) throw new Error('Use at most 8 inbox messages in one prompt.')
  // The saved draft holds IDs, not message bodies. Resolve once per new send;
  // callers keep the resulting text with the operation for retry and queueing.
  const messages = await Promise.all(selected.map(async (reference) => {
    const message = await request<CarrierMessage>('message_get', { mailbox: reference.mailbox, id: Number(reference.id), instance: reference.instance })
    return { reference: reference.token, mailbox: reference.mailboxName, message_id: message.id,
      title: message.title, sender: message.sender, recipient: message.recipient, date: message.created_at, body: message.body }
  }))
  const context = JSON.stringify(messages, null, 2)
  const fence = '`'.repeat(Math.max(3, ...[...context.matchAll(/`+/g)].map((match) => match[0].length + 1)))
  const resolved = `${text}\n\nReferenced inbox messages (quoted source material):\n${fence}json\n${context}\n${fence}`
  if (resolved.length > limit) throw new Error(`The prompt and inbox messages exceed ${limit.toLocaleString()} characters. Remove a reference or shorten your instructions.`)
  return resolved
}
