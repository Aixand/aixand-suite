import { useRef, useState } from 'react'
import { Button, Dialog, Icon } from 'bbb-design'
import type { Profile } from './client'

export function DeleteProfileDialog({ profile, open, onOpenChange, disabled, active, onDelete, onDeleted, onTerminals, hideTrigger = false }: {
  profile: Profile
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled: boolean
  active: number
  onDelete: (profile: Profile) => Promise<void>
  onDeleted: () => void
  onTerminals: () => void
  hideTrigger?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const native = profile.profile === 'default'

  function changeOpen(next: boolean) {
    if (pending.current) return
    setError('')
    onOpenChange(next)
  }

  async function remove() {
    if (pending.current || disabled || native || active > 0) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await onDelete(profile)
      onOpenChange(false)
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this profile. Try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <Dialog title={`Delete ${profile.profile}?`} role="alertdialog" className="agents-delete-dialog"
    open={open} onOpenChange={changeOpen}
    description="Delete this profile's local configuration and agent history. Saved logins and retained terminal output stay available."
    trigger={<Button hidden={hideTrigger} style={hideTrigger ? { display: 'none' } : undefined} iconOnly variant="ghost" size="sm" className="agents-delete-trigger"
      aria-label={`Delete ${profile.profile}`} disabled={disabled || native}><Icon name="trash-2" /></Button>}
    footer={<>
      <Button variant="secondary" autoFocus disabled={busy} onPress={() => changeOpen(false)}>Cancel</Button>
      <Button variant="danger" disabled={disabled || native || active > 0 || busy} loading={busy}
        onPress={() => void remove()}>Delete profile</Button>
    </>}>
    {error && <p role="alert" className="agents-error">{error}</p>}
    {active > 0 && <div className="agents-sheet-form">
      <p>Stop this profile's active agents in Terminals before deleting it.</p>
      <Button variant="secondary" onPress={() => { changeOpen(false); onTerminals() }}>Open Terminals</Button>
    </div>}
  </Dialog>
}
