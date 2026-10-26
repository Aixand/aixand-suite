import { useId, useState } from 'react'
import { Button, Icon, TextField, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { Project } from './model'

export function NewProject({ open, onOpenChange, disabled, create, onCreated, onDiscover }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled: boolean
  create: (name: string, path: string) => Promise<Project>
  onCreated: (project: Project) => void
  onDiscover?: () => void
}) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const theme = useThemeAttributes()
  const descriptionId = useId()

  function close() {
    if (busy) return
    setError('')
    onOpenChange(false)
  }

  async function submit() {
    if (busy || disabled || !name.trim() || !path.trim()) return
    setBusy(true)
    setError('')
    try {
      const project = await create(name.trim(), path.trim())
      onCreated(project)
      onOpenChange(false)
      setName('')
      setPath('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project could not be created.')
    } finally { setBusy(false) }
  }

  return <ModalOverlay {...theme} className="bbb-theme bbb-modal-overlay" isOpen={open} isDismissable={!busy}
    onOpenChange={(value) => { if (!busy) { setError(''); onOpenChange(value) } }}>
    <Modal className="bbb-modal">
      <Dialog className="bbb-dialog" aria-describedby={descriptionId}>
        <div className="bbb-dialog__header">
          <div className="bbb-dialog__heading">
            <Heading slot="title">New project</Heading>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close dialog" disabled={busy} onPress={close}><Icon name="x" /></Button>
          </div>
          <p id={descriptionId} className="bbb-dialog__description">Each project needs a unique name and directory path. Parent and nested folders can be separate projects.</p>
        </div>
        <div className="bbb-dialog__body">
          {onDiscover && <Button variant="ghost" disabled={busy || disabled} onPress={onDiscover}>Discover projects instead</Button>}
          <form className="form-stack command-project-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <TextField label="Project name" value={name} maxLength={128} required autoFocus disabled={busy}
              onChange={(event) => setName(event.target.value)} />
            <TextField label="Project path" value={path} maxLength={4096} required disabled={busy}
              placeholder="/path/to/project" onChange={(event) => setPath(event.target.value)} />
            {error && <p role="alert">{error}</p>}
            <div className="command-project-form-actions">
              <Button variant="ghost" disabled={busy} onPress={close}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={disabled || busy || !name.trim() || !path.trim()}>Create project</Button>
            </div>
          </form>
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>
}
