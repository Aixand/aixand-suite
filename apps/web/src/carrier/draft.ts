import { useState } from 'react'
import type { CarrierDraft } from './CarrierComposer'

export const CARRIER_DRAFT_KEY = 'aixand.carrier.draft.v1'
let memory: CarrierDraft | null | undefined
let memoryError = ''

function read() {
  if (memory !== undefined) return { draft: memory, error: memoryError }
  let source: string | null
  try { source = sessionStorage.getItem(CARRIER_DRAFT_KEY) }
  catch { return { draft: null, error: 'Browser storage is unavailable. Drafts will be kept for this visit, but cannot be restored after a reload.' } }
  if (!source) return { draft: null, error: '' }
  try {
    const value = JSON.parse(source)
    const draft = value?.draft
    if (value?.version !== 1 || !draft || !['mailbox', 'recipient', 'body', 'key'].every(key => typeof draft[key] === 'string')
      || !draft.mailbox || !draft.key || draft.body.length > 100_000 || typeof draft.attempted !== 'boolean'
      || draft.replyMessage && (!['id', 'sender', 'recipient', 'title', 'body', 'created_at'].every(key => typeof draft.replyMessage[key] === 'string')
        || !/^\d+$/.test(draft.replyMessage.id))) throw new Error('Invalid draft')
    return { draft: draft as CarrierDraft, error: '' }
  } catch {
    return { draft: null, error: 'Your saved draft could not be restored. Its browser copy has been kept.' }
  }
}

/** Tab-scoped drafts survive route changes and reloads without overwriting other tabs. */
export function useCarrierDraft() {
  const [initial] = useState(read)
  const [draft, updateDraft] = useState<CarrierDraft | null>(initial.draft)
  const [storageError, setStorageError] = useState(initial.error)
  function setDraft(next: CarrierDraft | null) {
    memory = next
    updateDraft(next)
    try {
      if (next) sessionStorage.setItem(CARRIER_DRAFT_KEY, JSON.stringify({ version: 1, draft: next }))
      else sessionStorage.removeItem(CARRIER_DRAFT_KEY)
      memoryError = ''
    } catch {
      memoryError = next ? 'Your draft is kept for this visit, but cannot be restored after a reload. Browser storage is unavailable.'
        : 'The draft is closed, but its saved browser copy could not be cleared. Browser storage is unavailable.'
    }
    setStorageError(memoryError)
  }
  return { draft, setDraft, storageError }
}
