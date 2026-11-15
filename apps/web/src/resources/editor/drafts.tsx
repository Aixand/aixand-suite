import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfirmationDialog } from 'bbb-design'
import './editor.css'

const navigationEvent = 'aixand:resource-navigation'
export function requestResourceNavigation(proceed: () => void) {
  const event = new CustomEvent(navigationEvent, { cancelable: true, detail: proceed })
  if (window.dispatchEvent(event)) { proceed(); return true }
  return false
}

/** The same discard decision covers file changes, resource changes and app navigation. */
export function useResourceDraft(dirty: boolean, saving = false) {
  const [pending, setPending] = useState<(() => void) | null>(null)
  const state = useRef({ dirty, saving }); state.current = { dirty, saving }
  const guard = useCallback((action: () => void) => {
    if (state.current.saving) return
    if (state.current.dirty) setPending(() => action)
    else action()
  }, [])
  useEffect(() => {
    const navigate = (event: Event) => {
      if (!state.current.dirty && !state.current.saving) return
      event.preventDefault()
      guard((event as CustomEvent<() => void>).detail)
    }
    const unload = (event: BeforeUnloadEvent) => { if (state.current.dirty || state.current.saving) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener(navigationEvent, navigate)
    window.addEventListener('beforeunload', unload)
    return () => { window.removeEventListener(navigationEvent, navigate); window.removeEventListener('beforeunload', unload) }
  }, [guard])
  const confirmation = <ConfirmationDialog title="Discard your changes?" description="Your saved resource will stay as it was."
    open={Boolean(pending)} onOpenChange={open => { if (!open) setPending(null) }}
    trigger={<Button hidden className="resource-dialog-trigger">Discard changes</Button>} confirmLabel="Discard changes" cancelLabel="Keep editing" danger
    onConfirm={() => { const action = pending; setPending(null); action?.() }} />
  return { guard, confirmation, complete: (action: () => void) => { state.current = { dirty: false, saving: false }; action() } }
}
