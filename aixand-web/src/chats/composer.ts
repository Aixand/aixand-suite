import { createChatDraft, type ChatDraft } from './draft'
import type { ResourceRequest } from '../agents/ResourcePicker'
import { requestId } from '../terminals/connection'

export type DraftConfiguration = {
  draftId: string
  profileId: string; backendChoice: string; modelChoice: { profileId: string; value: string }
  settings: Record<string, string | boolean>; resources: ResourceRequest; suiteTools: boolean
  backendAccess: string; mcpServers?: string[]
  followupMode?: 'steer' | 'queue'
}
const defaultConfiguration = (): DraftConfiguration => ({ draftId: requestId(), profileId: '', backendChoice: '', modelChoice: { profileId: '', value: '' },
  settings: {}, resources: {}, suiteTools: true, backendAccess: 'workspace-write' })

export type ChatAttempt = {
  op: 'launch' | 'send' | 'chat-create' | 'chat-send' | 'chat-steer' | 'chat-queue' | 'chat-config-set' | 'chat-command' | 'command-update'
  args: Record<string, unknown>
  frozenPrompt?: string
  firstCommand?: { name: string; arguments: string }
  preserveDraft?: boolean
  after?: { op: 'chat-send'; args: Record<string, unknown> }
}

type ComposerState = {
  sending: boolean
  actionBusy: boolean
  notice: string
  pendingAttempt: ChatAttempt | null
  draftChatId: string | null
  configuration: DraftConfiguration
  messages: PendingMessage[]
  messagesPaused: boolean
}

export type PendingMessage = {
  id: string; text: string; mode: 'steer' | 'queue'; status: 'waiting' | 'sending' | 'failed'
  attempt?: { op: 'chat-send' | 'chat-steer' | 'chat-queue'; args: Record<string, unknown> }
  error?: string; uncertain?: boolean
  draft?: ChatDraft
}

function createComposer(project = '', configuration = defaultConfiguration()) {
  const draft = createChatDraft()
  draft.set({ prompt: '', project })
  let state: ComposerState = { sending: false, actionBusy: false, notice: '', pendingAttempt: null, draftChatId: null, configuration, messages: [], messagesPaused: false }
  let storageKey = ''
  let delivering = false
  let deliver: ((message: PendingMessage, save: (attempt: NonNullable<PendingMessage['attempt']>) => void) => Promise<void>) | undefined
  const listeners = new Set<() => void>()
  function update(patch: Partial<ComposerState>) {
    state = { ...state, ...patch }
    if (storageKey) try {
      localStorage.setItem(storageKey, JSON.stringify({ messages: state.messages, messagesPaused: state.messagesPaused, followupMode: state.configuration.followupMode }))
    } catch { /* In-memory delivery remains available without browser storage. */ }
    for (const listener of listeners) listener()
  }
  async function drain() {
    if (delivering || !deliver || state.messagesPaused) return
    delivering = true
    try {
      while (!state.messagesPaused) {
        const message = state.messages[0]
        if (!message || message.status !== 'waiting') break
        update({ messages: state.messages.map(row => row.id === message.id ? { ...row, status: 'sending' } : row) })
        try {
          await deliver(message, attempt => {
            message.attempt = attempt
            update({ messages: state.messages.map(row => row.id === message.id ? { ...row, attempt } : row) })
          })
          update({ messages: state.messages.filter(row => row.id !== message.id) })
        } catch (error) {
          const uncertain = Boolean(message.attempt) && (!(error && typeof error === 'object' && 'uncertain' in error && error.uncertain === false) ||
            Boolean(error && typeof error === 'object' && 'code' in error && ['connection_lost', 'timeout', 'disconnected'].includes(String(error.code))))
          if (!uncertain && draft.isEmpty() && state.messages.length === 1) {
            draft.set(message.draft ?? { prompt: message.text, project: draft.getSnapshot().project })
            update({ messages: [], notice: error instanceof Error ? error.message : 'Message was rejected.' })
            break
          }
          update({ messages: state.messages.map(row => row.id === message.id ? { ...row, status: 'failed', uncertain,
            error: error instanceof Error ? error.message : 'Message delivery could not be confirmed.' } : row) })
          break
        }
      }
    } finally { delivering = false }
  }
  return {
    draft,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update,
    retain(id: string) {
      if (storageKey) return
      storageKey = `aixand.chat.delivery.${id}`
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
        if (saved && Array.isArray(saved.messages)) {
          const messages: PendingMessage[] = saved.messages.filter((row: PendingMessage) => typeof row?.id === 'string' && typeof row.text === 'string' &&
            ['steer', 'queue'].includes(row.mode) && ['waiting', 'sending', 'failed'].includes(row.status) &&
            (!row.attempt || ['chat-send', 'chat-steer', 'chat-queue'].includes(row.attempt.op) && row.attempt.args?.chatId === id && row.attempt.args?.key === row.id))
            .map((row: PendingMessage) => ({ ...row, status: 'failed', uncertain: Boolean(row.attempt), error: 'Delivery was interrupted. Retry to check the original request.' }))
          update({ messages, messagesPaused: Boolean(saved.messagesPaused), configuration: { ...state.configuration,
            followupMode: saved.followupMode === 'queue' ? 'queue' : 'steer' } })
        }
      } catch { /* Ignore invalid or unavailable browser storage. */ }
    },
    enqueue(message: PendingMessage, handler: NonNullable<typeof deliver>) {
      deliver = handler
      update({ messages: [...state.messages, message] })
      void drain()
    },
    retryMessage(id: string, handler: NonNullable<typeof deliver>) {
      deliver = handler
      update({ messages: state.messages.map(row => row.id === id ? { ...row, status: 'waiting', error: undefined } : row) })
      void drain()
    },
    removeMessage(id: string) {
      update({ messages: state.messages.filter(row => row.id !== id || row.status === 'sending') })
      void drain()
    },
    pauseMessages() { update({ messagesPaused: true }) },
    resumeMessages(handler: NonNullable<typeof deliver>) { deliver = handler; update({ messagesPaused: false }); void drain() },
    configure(patch: Partial<DraftConfiguration>) { update({ configuration: { ...state.configuration, ...patch } }) },
    begin(operation: 'sending' | 'actionBusy') {
      if (state[operation] || operation === 'sending' && state.actionBusy) return false
      update({ [operation]: true, notice: '' })
      return true
    },
  }
}

// Keep requests and their drafts alive when the user switches chats or pages.
// Each async operation retains its own composer, including its retry receipt.
export function createChatComposers() {
  const conversations = new Map<string, ReturnType<typeof createComposer>>()
  let draft = createComposer()
  return {
    getDraft: () => draft,
    newDraft(project = '', configuration?: DraftConfiguration) { return draft = createComposer(project, configuration ? { ...configuration, draftId: requestId() } : undefined) },
    forConversation(id: string, project = '') {
      let composer = conversations.get(id)
      if (!composer) {
        composer = createComposer(project)
        composer.retain(id)
        conversations.set(id, composer)
      }
      return composer
    },
    attach(id: string, composer: ReturnType<typeof createComposer>, retainDraft = false) {
      conversations.set(id, composer)
      composer.retain(id)
      if (draft === composer && !retainDraft) draft = createComposer()
    },
  }
}
