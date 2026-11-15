import type { InboxReference } from './inboxReferences'
import type { FileReference } from './fileReferences'

export type ChatDraft = { prompt: string; project: string; inboxReferences?: InboxReference[]; fileReferences?: FileReference[] }

// Retain the draft across page navigation without making the workspace render
// on every keystroke. Only the composer subscribes to the full draft.
export function createChatDraft() {
  let draft: ChatDraft = { prompt: '', project: '' }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => draft,
    getProject: () => draft.project,
    isEmpty: () => !draft.prompt.trim(),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: ChatDraft) {
      if (Object.is(draft, next)) return
      draft = next
      for (const listener of listeners) listener()
    },
  }
}

export type ChatDraftStore = ReturnType<typeof createChatDraft>
