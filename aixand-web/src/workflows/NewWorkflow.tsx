import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Dialog, Select, TextField } from 'bbb-design'
import type { WorkflowTemplate } from './library'
import './library.css'

export function NewWorkflow({ trigger, create, onCreated }: {
  trigger: ReactElement
  create: (name: string, template?: WorkflowTemplate) => string
  onCreated: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [template, setTemplate] = useState<WorkflowTemplate>('blank')
  return (
    <Dialog title="New workflow" description="Give your workflow a name. You can add steps in the canvas."
      trigger={trigger} open={open} onOpenChange={(value) => {
        setOpen(value)
        setName('')
        setError('')
        setTemplate('blank')
      }}>
      <form className="form-stack" onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        try {
          const id = create(name, template)
          setOpen(false)
          setName('')
          setError('')
          onCreated(id)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Workflow could not be created.')
        }
      }}>
        <TextField label="Workflow name" value={name} required autoFocus maxLength={120}
          onChange={(event) => setName(event.target.value)} />
        <Select label="Starting point" value={template}
          options={[{ id: 'blank', label: 'Empty canvas' }, { id: 'brain-implementer', label: 'Brain and Implementer' }, { id: 'project-audit', label: 'Project audit → main inbox' }]}
          onChange={(value) => setTemplate(value as WorkflowTemplate)} />
        {template === 'brain-implementer' && <p className="wb-muted">Implementer owns the task and can consult Brain when it needs advice.</p>}
        {template === 'project-audit' && <p>Architecture and security audits run together. Task planning starts after both reports finish, then delivers the task list to your main inbox.</p>}
        {template === 'native-chat' && <p>Add project chats, connect report dependencies, and deliver the final result to your main inbox.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="workflow-create-actions">
          <Button variant="ghost" onPress={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" disabled={!name.trim()}>Create workflow</Button>
        </div>
      </form>
    </Dialog>
  )
}
