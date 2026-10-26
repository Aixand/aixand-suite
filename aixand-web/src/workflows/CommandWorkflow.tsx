import { useRef, useState } from 'react'
import { Button, DropdownMenu, Icon, useThemeAttributes } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { SavedWorkflow } from './library'
import { compileCanvas } from './builder/compileCanvas'

/** Import the executable graph explicitly; browser storage remains a draft library. */
export function CommandWorkflow({ workflow, agents, onOpen }: { workflow: SavedWorkflow; agents: AgentsModel; onOpen?: () => void }) {
  const theme = useThemeAttributes()
  const soft = theme['data-bbb-mode'] === 'dark'
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ key: string; args: object } | null>(null)
  async function save() {
    if (busy || saved || agents.status !== 'connected') return
    setBusy(true); setError('')
    try {
      if (!pending.current) {
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('aixand:workflow:' + workflow.id)))
        const hex = Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
        const list = await agents.request<{ workflows: { id: string; revision: number }[] }>('command-workflows')
        const previous = list.workflows.find(row => row.id === id)
        const compiled = compileCanvas(workflow.draft, 'command-' + workflow.id)
        pending.current = { key: crypto.randomUUID(), args: { title: workflow.draft.name, workflow: compiled.workflow,
          workflowId: id, ...(previous ? { expectedRevision: previous.revision } : {}) } }
      }
      await agents.request('command-workflow-save', { key: pending.current.key, ...pending.current.args })
      pending.current = null; setSaved(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not make the workflow available to supervisors.') }
    finally { setBusy(false) }
  }
  if (soft) return <div className="workflow-actions">
    {busy && <span role="status" className="workflow-action-status">Making available…</span>}
    {saved && <span role="status" className="workflow-action-status">Available to supervisors</span>}
    <DropdownMenu label={`Actions for ${workflow.draft.name || 'Untitled workflow'}`}
      trigger={<Button variant="ghost" size="sm" iconOnly
        aria-label={`Actions for ${workflow.draft.name || 'Untitled workflow'}`}><Icon name="ellipsis" /></Button>}
      items={[
        ...(onOpen ? [{ id: 'open', label: 'Open workflow' }] : []),
        { id: 'share', label: saved ? 'Available to supervisors' : 'Make available to supervisors',
          disabled: busy || saved || agents.status !== 'connected' },
      ]} onAction={action => { if (action === 'open') onOpen?.(); else if (action === 'share') void save() }} />
    {error && <p role="alert" className="workflow-action-error">{error}</p>}
  </div>
  return <div><Button variant="ghost" size="sm" disabled={busy || saved || agents.status !== 'connected'} loading={busy}
    onPress={() => { void save() }}>{saved ? 'Available to supervisors' : 'Make available to supervisors'}</Button>
    {error && <p role="alert">{error}</p>}</div>
}
