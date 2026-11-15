import { randomUUID } from '../uuid'
import { useRef, useState } from 'react'
import { Button, DropdownMenu, Icon } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { SavedWorkflow } from './library'
import { compileCanvas } from './builder/compileCanvas'

/** Import the executable graph explicitly; browser storage remains a draft library. */
export function CommandWorkflow({ workflow, agents, onOpen, onError }: { workflow: SavedWorkflow; agents: AgentsModel; onOpen?: () => void; onError?: (error: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ key: string; args: object } | null>(null)
  async function save() {
    if (busy || saved || agents.status !== 'connected') return
    setBusy(true); setError(''); onError?.('')
    try {
      if (!pending.current) {
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('aixand:workflow:' + workflow.id)))
        const hex = Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
        const list = await agents.request<{ workflows: { id: string; revision: number }[] }>('command-workflows')
        const previous = list.workflows.find(row => row.id === id)
        const compiled = compileCanvas(workflow.draft, 'command-' + workflow.id)
        pending.current = { key: randomUUID(), args: { title: workflow.draft.name, workflow: compiled.workflow,
          workflowId: id, ...(previous ? { expectedRevision: previous.revision } : {}) } }
      }
      await agents.request('command-workflow-save', { key: pending.current.key, ...pending.current.args })
      pending.current = null; setSaved(true)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not make the workflow available to supervisors.'
      setError(message); onError?.(message)
    }
    finally { setBusy(false) }
  }
  return <div className="workflow-actions">
    {(busy || saved) && <span role="status" className="bbb-visually-hidden">{busy ? 'Making available…' : 'Available to supervisors'}</span>}
    <DropdownMenu label={`Actions for ${workflow.draft.name || 'Untitled workflow'}`}
      trigger={<Button variant="ghost" size="sm" iconOnly
        aria-label={`Actions for ${workflow.draft.name || 'Untitled workflow'}`} aria-description={saved ? 'Available to supervisors' : undefined}><Icon name="ellipsis" /></Button>}
      items={[
        ...(onOpen ? [{ id: 'open', label: 'Open workflow' }] : []),
        { id: 'share', label: saved ? 'Available to supervisors' : 'Make available to supervisors',
          disabled: busy || saved || agents.status !== 'connected' },
      ]} onAction={action => { if (action === 'open') onOpen?.(); else if (action === 'share') void save() }} />
    {error && !onError && <p role="alert" className="workflow-action-error">{error}</p>}
  </div>
}
