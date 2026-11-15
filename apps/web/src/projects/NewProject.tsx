import { useId, useState } from 'react'
import { Button, Icon, useThemeAttributes } from 'bbb-design'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import type { Project } from './model'
import { ProjectOnboardingPreview } from '../auth/ProjectOnboardingPreview'
import type { ProjectSelection } from '../auth/agentSetup'
import './new-project.css'

export function NewProject({ open, onOpenChange, disabled, create, onCreated, onDiscover }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled: boolean
  create: (name: string, path: string) => Promise<Project>
  onCreated: (project: Project) => void
  onDiscover?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const theme = useThemeAttributes()
  const descriptionId = useId()

  function close() {
    if (!busy) onOpenChange(false)
  }

  async function add(selection: ProjectSelection): Promise<ProjectSelection> {
    setBusy(true)
    const entries: ProjectSelection['entries'] = []
    const created: Project[] = []
    try {
      for (const entry of selection.entries) {
        if (entry.projectId) { entries.push(entry); continue }
        try {
          const project = await create(entry.name.trim(), entry.path)
          entries.push({ ...entry, projectId: project.id, error: undefined })
          created.push(project)
        } catch (cause) {
          entries.push({ ...entry, error: cause instanceof Error ? cause.message : 'Project could not be added.' })
        }
      }
      const result = { ...selection, entries }
      // Keep successful entries marked when retrying a partially failed selection.
      if (entries.every(entry => entry.projectId)) {
        onOpenChange(false)
        const project = created.at(-1)
        if (project) onCreated(project)
      }
      return result
    } finally { setBusy(false) }
  }

  return <ModalOverlay {...theme} className="bbb-theme bbb-modal-overlay" isOpen={open} isDismissable={!busy}
    onOpenChange={value => { if (!busy) onOpenChange(value) }}>
    <Modal className="bbb-modal new-project-modal">
      <Dialog className="bbb-dialog" aria-describedby={descriptionId}>
        <div className="bbb-dialog__header">
          <div className="bbb-dialog__heading">
            <Heading slot="title">Add projects</Heading>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close dialog" disabled={busy} onPress={close}><Icon name="x" /></Button>
          </div>
          <p id={descriptionId} className="bbb-dialog__description">Select project folders. Each project is named after its folder; you can review and rename selected projects.</p>
        </div>
        <div className="bbb-dialog__body">
          {onDiscover && <Button variant="ghost" disabled={busy || disabled} onPress={onDiscover}>Discover projects instead</Button>}
          <ProjectOnboardingPreview active={open} preview={false} disabled={disabled} onBack={close} onAdd={add} />
        </div>
      </Dialog>
    </Modal>
  </ModalOverlay>
}
