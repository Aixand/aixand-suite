import { useEffect, useId, useRef, useState } from 'react'
import { Button, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { ChatDeletionChoice, ChatDeletionPreview } from './model'

export function DeleteConversation({ title, chatId, open, loadPreview, onClose, onDelete, onStop }: {
  title: string
  chatId?: string
  open: boolean
  loadPreview: (id: string) => Promise<ChatDeletionPreview>
  onClose: () => void
  onDelete: (choice?: ChatDeletionChoice) => Promise<void>
  onStop?: (choice: ChatDeletionChoice, stopToken?: string) => Promise<void>
}) {
  const theme = useThemeAttributes()
  const descriptionId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<ChatDeletionPreview | null>(null)
  const [scope, setScope] = useState<ChatDeletionChoice['scope'] | null>('conversation')
  const [loading, setLoading] = useState(Boolean(chatId))
  const [reload, setReload] = useState(0)
  const previewLoader = useRef(loadPreview)
  previewLoader.current = loadPreview

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError('')
    setPreview(null)
    setScope('conversation')
    setLoading(Boolean(chatId))
    if (chatId) void previewLoader.current(chatId).then((value) => {
      if (cancelled) return
      setPreview(value)
      setScope(value.childCount ? null : 'conversation')
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not check child conversations. Try again.')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [chatId, open, reload])

  const childCount = preview?.childCount ?? 0
  const choosing = !loading && Boolean(preview) && scope === null
  const ready = !loading && (!chatId || Boolean(preview))
  const deletingChildren = scope === 'subtree' && childCount > 0
  const activity = scope ? preview?.activity?.[scope] : undefined

  function choose(value: ChatDeletionChoice['scope']) {
    setScope(value)
    setError('')
  }

  function close() {
    if (busy) return
    setError('')
    onClose()
  }

  async function remove(stop = false) {
    if (busy || !ready || !scope) return
    setBusy(true)
    setError('')
    try {
      const choice = preview ? { scope, previewToken: preview.previewToken } : undefined
      if (stop && choice) await onStop?.(choice, activity?.stopToken)
      await onDelete(choice)
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this conversation. Try again.')
      if (chatId && preview) {
        try {
          const latest = await previewLoader.current(chatId)
          if (latest.previewToken !== preview.previewToken || latest.activity?.[scope]?.stopToken !== preview.activity?.[scope]?.stopToken) {
            setPreview(latest)
            const familyChanged = latest.previewToken !== preview.previewToken
            if (familyChanged) setScope(latest.childCount ? null : 'conversation')
            setError(familyChanged ? 'Child conversations changed. Review the deletion again before confirming.' : 'The active work changed. Review the deletion again before stopping it.')
          }
        } catch { /* Keep the original request available for a safe retry after a lost response. */ }
      }
    }
    finally { setBusy(false) }
  }

  return <ModalOverlay {...theme} className="bbb-theme bbb-modal-overlay" isOpen={open}
    isDismissable={!busy} isKeyboardDismissDisabled={busy} onOpenChange={(value) => { if (!value) close() }}>
    <Modal className="bbb-modal">
      <Dialog role="alertdialog" className="bbb-dialog command-delete-dialog" aria-describedby={descriptionId}>
        <div className="bbb-dialog__header">
          <Heading slot="title">{choosing ? 'Delete child conversations too?' : 'Delete conversation?'}</Heading>
          <p id={descriptionId} className="bbb-dialog__description">
            {loading ? 'Checking for child conversations…' : choosing ?
              `“${title}” has ${childCount} attached child ${childCount === 1 ? 'conversation' : 'conversations'}, including any nested children. Would you like to delete them too?` :
              deletingChildren ? `Delete “${title}” and all ${childCount} attached child ${childCount === 1 ? 'conversation' : 'conversations'}? All ${childCount + 1} conversations will be removed from your chat history. This can’t be undone.` :
                `Are you sure you want to delete “${title}”? This will remove it from your chat history and can’t be undone.${childCount ? ' Its child conversations will remain as independent conversations.' : ''}`}
          </p>
        </div>
        <div className="bbb-dialog__body">
          {!choosing && activity && (activity.remote || activity.hasWork) && <p role="note">
            {activity.workflowIds.length ? 'Deleting history lets the workflow continue, including later tasks. Cancel the workflow to stop its other tasks too.' :
              activity.remote ? 'Deleting history does not stop running work. If the device is offline, that work may continue until you reconnect and stop it.' :
                'Deleting history does not stop running work. You can stop retained work in Background work.'}
          </p>}
          {!choosing && activity?.hasWork && <p className="settings-help">You can manage retained work in Settings → Devices → Background work.</p>}
          {error && <p role="alert">{error}</p>}
          <div key={choosing ? 'choose' : 'confirm'} className="command-delete-dialog-actions">
            <Button variant="ghost" autoFocus disabled={busy} onPress={close}>Cancel</Button>
            {choosing ? <>
              <Button variant="secondary" onPress={() => choose('conversation')}>Keep children</Button>
              <Button variant="primary" onPress={() => choose('subtree')}>Include children</Button>
            </> : ready ? <>
              {childCount > 0 && <Button variant="ghost" disabled={busy} onPress={() => { setScope(null); setError('') }}>Back</Button>}
              {activity && (activity.activeChatIds.length > 0 || activity.workflowIds.length > 0) && onStop && <Button variant="secondary" disabled={busy} onPress={() => { void remove(true) }}>
                {activity.workflowIds.length ? 'Cancel workflow and delete' : 'Stop and delete'}
              </Button>}
              <Button variant="danger" loading={busy} disabled={busy} onPress={() => { void remove() }}>
                {deletingChildren ? `Delete all ${childCount + 1} conversations` : 'Delete conversation'}
              </Button>
            </> : !loading && <Button variant="secondary" onPress={() => setReload(value => value + 1)}>Retry</Button>}
          </div>
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>
}
