import { useEffect, useRef, useState } from 'react'
import { Button, Select, Textarea } from 'bbb-design'
import { JobsConnection } from './jobs'
import type { Continuation } from './jobs'
import { compileCanvas } from './compileCanvas'
import { createCanvasId } from './model'
import { useWorkflowLibrary } from '../library'
import type { Workspace } from '../../workspace/model'

export function ContinuationPanel({ jobId, context, exports = [{ id: '/result', label: 'Workflow result' }], workspace, navigate }: {
  jobId: string; context?: { projectId?: string; originChatId?: string }; exports?: { id: string; label: string }[];
  workspace?: Workspace; navigate?: (route: string) => void;
}) {
  const { workflows } = useWorkflowLibrary()
  const [selected, setSelected] = useState('')
  const [source, setSource] = useState(exports[0]?.id ?? '')
  const [destination, setDestination] = useState('previous_result')
  const [inputs, setInputs] = useState('{}')
  const [rows, setRows] = useState<Continuation[]>([])
  const [ready, setReady] = useState(false)
  const [supported, setSupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const connection = useRef<JobsConnection | null>(null)
  const target = workflows.find((workflow) => workflow.id === selected)
  let inputNames: string[] = []
  try { if (target) inputNames = Object.keys(compileCanvas(target.draft).workflow.workflow.inputs) } catch { /* Shown when submitting. */ }
  useEffect(() => {
    let alive = true
    let enabled = false
    const client = new JobsConnection(() => {
      void client.request<{ capabilities?: { workflow_continuations?: number[] } }>('health').then((health) => {
        if (!alive) return
        enabled = health.capabilities?.workflow_continuations?.includes(1) ?? false
        setSupported(enabled); setReady(true)
      }).catch((cause: Error) => { if (alive) setError(cause.message) })
    }, (message) => { if (alive) { setReady(false); setError(message) } })
    connection.current = client
    const timer = setInterval(() => {
      if (!enabled) return
      void client.request<{ continuations: Continuation[] }>('continuations', { id: jobId })
        .then((result) => { if (alive && Array.isArray(result.continuations)) setRows(result.continuations) }).catch(() => undefined)
    }, 1500)
    return () => { alive = false; clearInterval(timer); connection.current = null; client.close() }
  }, [jobId])
  async function register() {
    if (!target || !connection.current) return
    setBusy(true); setError('')
    const storageKey = `aixand.workflow.continuation.${jobId}.${target.id}`
    try {
      let attempt = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (!attempt) {
        const key = createCanvasId()
        const controllerId = target.draft.native?.controllerChatId || context?.originChatId
        const controller = workspace?.chats.chats.find(chat => chat.id === controllerId)
        const compiled = compileCanvas(target.draft, key, 2, {}, controller)
        let create: object | undefined
        if (compiled.needsProject) {
          const projectId = target.draft.native?.projectId || context?.projectId
          let originChatId = target.draft.native?.controllerChatId || context?.originChatId
          if (!projectId) throw new Error('Choose a project in the next workflow before scheduling it.')
          if (!originChatId) {
            if (!workspace || workspace.agents.status !== 'connected') throw new Error('Connect project chats before scheduling this workflow.')
            originChatId = createCanvasId()
            create = { key: originChatId, projectId, mode: 'work', profile: target.draft.native?.profile === '@auto' ? null : target.draft.native?.profile ?? null }
          }
          compiled.workflow.context = { ...compiled.workflow.context, projectId, originChatId }
        }
        const literals = JSON.parse(inputs)
        if (!literals || typeof literals !== 'object' || Array.isArray(literals)) throw new Error('Additional inputs must be a JSON object.')
        attempt = { id: jobId, key, target: { key, workflow: compiled.workflow, inputs: literals,
          metadata: { origin: 'aixand.workflow-builder', workflowId: target.id, suite_canvas: target.draft, suite_namespace: key } },
          input_map: source && inputNames.length ? { [inputNames.includes(destination) ? destination : inputNames[0]]: source } : {}, create }
        localStorage.setItem(storageKey, JSON.stringify(attempt))
      }
      if (attempt.create) await workspace?.chats.create(attempt.create)
      if (attempt.target.workflow.context?.originChatId && !attempt.policyPrepared) {
        if (!workspace) throw new Error('Connect project chats before scheduling access.')
        attempt.target.workflow = await workspace.chats.prepareWorkflow({ key: attempt.key, workflow: attempt.target.workflow })
        attempt.policyPrepared = true
        localStorage.setItem(storageKey, JSON.stringify(attempt))
      }
      const { create: _create, policyPrepared: _prepared, ...request } = attempt
      const result = await connection.current.request<Continuation>('continue', request)
      localStorage.removeItem(storageKey)
      setRows((previous) => [...previous.filter((row) => row.id !== result.id), result])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not schedule the next workflow. Retry to recover the saved request.') }
    finally { setBusy(false) }
  }
  async function cancel(id: string) {
    setBusy(true); setError('')
    try {
      const result = await connection.current?.request<Continuation>('cancel_continuation', { id })
      if (result) setRows((previous) => previous.map((row) => row.id === id ? result : row))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not cancel the follow-up.') }
    finally { setBusy(false) }
  }
  if (!supported) return null
  return <section aria-label="Next workflows">
    <h3>Next workflows</h3>
    <p className="wb-muted">Start another workflow after this run completes successfully. Its saved version will run even if you close this page.</p>
    <Select label="Next workflow" value={selected} options={[{ id: '', label: 'Choose a saved workflow' }, ...workflows.map((workflow) => ({ id: workflow.id, label: workflow.draft.name }))]}
      onChange={(id) => { setSelected(id); setDestination('previous_result') }} />
    {inputNames.length > 0 && <>
      <Select label="Pass result" value={source} options={[{ id: '', label: 'Supply inputs manually' }, ...exports]} onChange={setSource} />
      <Select label="Receive result in" value={inputNames.includes(destination) ? destination : inputNames[0]} options={inputNames.map((name) => ({ id: name, label: name }))}
        onChange={setDestination} />
      <Textarea label="Additional inputs (JSON)" value={inputs} rows={3} onChange={(event) => setInputs(event.target.value)} />
    </>}
    <Button variant="secondary" disabled={!ready || busy || !selected} onPress={() => { void register() }}>Schedule next workflow</Button>
    {error && <p role="alert" className="wb-run-error">{error}</p>}
    <ul aria-label="Scheduled follow-up workflows">{rows.map((row) => <li key={row.id}>
      <span>{row.state === 'waiting' ? 'Waiting for this run' : row.state}</span>
      {row.child_id && <Button variant="ghost" size="sm" onPress={() => navigate?.(`workflows/runs/${row.child_id}`)}>Open next run</Button>}
      {['waiting', 'ready', 'blocked'].includes(row.state) && <Button variant="ghost" size="sm" disabled={busy} onPress={() => { void cancel(row.id) }}>Cancel follow-up</Button>}
      {row.error && <p role="alert">{row.error.message}</p>}
    </li>)}</ul>
  </section>
}
