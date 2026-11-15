import { randomUUID } from '../uuid'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, NumberField, Select, Textarea, TextField } from 'bbb-design'
import { McpDefinitionEditor } from '../agents/McpDefinitionEditor'
import type { ManagedCatalog, ManagedStatus } from './managed'
import { ContentDisclosure } from '../components/ContentDisclosure'
import { useResourceDraft } from './editor/drafts'

export type ResourceKind = 'prompts' | 'skills' | 'mcp'
type Request = <T>(operation: string, args?: object) => Promise<T>
export type SourceJob = { id: string; operation: string; status: string; step: string; result?: unknown; error?: { message: string } | null }
type Candidate = { id: string; name: string; description: string; type: string; preview?: string; preview_truncated?: boolean; files: string[]; file_count: number; definition?: unknown }
type Discovery = { discovery_id: string; source: { url: string; ref: string; commit: string; pinned: boolean }; candidates: Candidate[] }
const errorText = (value: unknown) => value instanceof Error ? value.message : 'The resource operation could not be completed.'
const active = (job: SourceJob | null) => Boolean(job && ['queued', 'running'].includes(job.status))

export function useSourceJob(request: Request, store: string, scope: string) {
  const storage = `aixand:resource-job:${store}:${scope}`
  const [job, setJob] = useState<SourceJob | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [identifier, setIdentifier] = useState(() => localStorage.getItem(storage) ?? '')
  const loadedStorage = useRef(storage)
  useEffect(() => {
    if (loadedStorage.current !== storage) {
      loadedStorage.current = storage; setIdentifier(localStorage.getItem(storage) ?? ''); setJob(null); setError('')
    }
  }, [storage])
  const api = useRef(request); api.current = request
  const submittingRef = useRef(false)
  const refresh = useCallback(async (id: string = identifier) => {
    if (!id) return
    try { setJob(await api.current<SourceJob>('source-job', { jobId: id })); setError('') }
    catch (cause) {
      setError(errorText(cause))
      if ((cause as { code?: string }).code === 'not_found') { localStorage.removeItem(storage); setIdentifier('') }
    }
  }, [identifier, storage])
  useEffect(() => {
    let current = true
    if (!identifier || submitting) return
    const poll = () => { if (current) void refresh() }
    poll()
    const timer = window.setInterval(poll, 1500)
    return () => { current = false; window.clearInterval(timer) }
  }, [identifier, refresh, submitting])
  useEffect(() => {
    if (job && !active(job)) { if (scope === 'add') localStorage.removeItem(storage); setIdentifier('') }
  }, [job, storage, scope])
  async function start(operation: string, value: object) {
    if (submittingRef.current || active(job) || identifier && !job) throw new Error('Check the saved operation status before starting another request.')
    submittingRef.current = true
    const key = randomUUID()
    localStorage.setItem(storage, key)
    setIdentifier(key); setJob(null); setSubmitting(true); setError('')
    try {
      const result = await api.current<SourceJob>('source-job-start', { operation, request: value, key })
      setJob(result)
      return result
    } catch (cause) { setError(`${errorText(cause)} Check the saved job status before retrying.`); throw cause }
    finally { submittingRef.current = false; setSubmitting(false) }
  }
  async function wait(row: SourceJob) {
    let value = row
    while (active(value)) {
      await new Promise(resolve => window.setTimeout(resolve, 250))
      value = await api.current<SourceJob>('source-job', { jobId: row.id })
      setJob(value)
    }
    if (value.status !== 'completed') throw new Error(value.error?.message ?? `Operation ${value.status}`)
    return value
  }
  return { job, error, identifier: identifier || job?.id || '', refresh: () => refresh(identifier || job?.id), start, wait, busy: submitting || active(job) || Boolean(identifier && !job),
    cancel: async () => { try { if (identifier) setJob(await api.current<SourceJob>('source-cancel', { jobId: identifier })) } catch (cause) { setError(errorText(cause)) } } }
}

function SourceActivity({ state }: { state: ReturnType<typeof useSourceJob> }) {
  return <div className="resource-source-activity">
    {state.job && <p role="status">{state.job.operation}: {state.job.status}{active(state.job) ? ` · ${state.job.step}` : ''}</p>}
    {(state.error || state.job?.error) && <p role="alert">{state.error || state.job?.error?.message}</p>}
    {state.busy && <Button variant="secondary" size="sm" onPress={() => { void state.cancel() }}>Cancel operation</Button>}
    {state.identifier && <Button variant="ghost" size="sm" onPress={() => { void state.refresh() }}>Check job status</Button>}
  </div>
}

type ResourceAddProps = {
  kind: ResourceKind; catalog: ManagedCatalog | null; request: Request;
  onAdded: (item: ManagedStatus) => Promise<void>; initialPath?: string
}

// Prompt Manager owns synchronous local creation/import; Skill and MCP Managers
// own retained source jobs. Do not invent a second job service for prompt packs.
export function ResourceAdd(props: ResourceAddProps) {
  return props.kind === 'prompts' && !props.catalog?.capabilities?.source_jobs
    ? <PromptAdd {...props} /> : <SourceResourceAdd {...props} />
}

function PromptAdd({ catalog, request, onAdded, initialPath = '' }: ResourceAddProps) {
  const [mode, setMode] = useState<'create' | 'local'>(initialPath ? 'local' : 'create')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [role, setRole] = useState('system')
  const [path, setPath] = useState(initialPath)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const draft = useResourceDraft(Boolean(name || content || path), busy)
  async function save() {
    if (submitting.current || !catalog) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const item = await request<ManagedStatus>(mode === 'create' ? 'create' : 'import-local', {
        storeId: catalog.store_id, ...(mode === 'create' ? { name, content, role } : { path }),
      })
      draft.complete(() => { void onAdded(item) })
    } catch (cause) { setError(errorText(cause)) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <section className="managed-reader" aria-label="Add prompt">
    <h2>Add prompt</h2>
    <div className="resource-source-options" role="group" aria-label="Resource source">
      <Button variant="secondary" aria-pressed={mode === 'create'} disabled={busy} onPress={() => setMode('create')}>Create new</Button>
      <Button variant="secondary" aria-pressed={mode === 'local'} disabled={busy} onPress={() => setMode('local')}>Import local package</Button>
    </div>
    <form className="managed-form" onSubmit={event => { event.preventDefault(); void save() }}>
      {mode === 'create' ? <>
        <TextField label="Prompt name" value={name} onChange={event => setName(event.target.value)} required disabled={busy} />
        <Select label="Prompt role" value={role} onChange={setRole} disabled={busy} options={[{ id: 'system', label: 'System instructions' }, { id: 'user', label: 'User message' }, { id: 'assistant', label: 'Assistant message' }]} />
        <Textarea variant="outlined" label="Prompt text" value={content} onChange={event => setContent(event.target.value)} required disabled={busy} rows={12} />
      </> : <TextField label="Package directory on the Suite host" value={path} onChange={event => setPath(event.target.value)} required disabled={busy} />}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={!catalog || busy || (mode === 'create' ? !name || !content : !path)} loading={busy}>{mode === 'create' ? 'Create prompt' : 'Import local copy'}</Button>
    </form>
    {draft.confirmation}
  </section>
}

function SourceResourceAdd({ kind, catalog, request, onAdded, initialPath = '' }: {
  kind: ResourceKind; catalog: ManagedCatalog | null; request: Request; onAdded: (item: ManagedStatus) => Promise<void>; initialPath?: string
}) {
  const [mode, setMode] = useState<'choose' | 'create' | 'local' | 'github'>(initialPath ? 'local' : 'choose')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [role, setRole] = useState('system')
  const [path, setPath] = useState(initialPath)
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdirectory, setSubdirectory] = useState('')
  const [tracking, setTracking] = useState('auto')
  const [discovery, setDiscovery] = useState<Discovery | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [mcpEditor, setMcpEditor] = useState(false)
  const [error, setError] = useState('')
  const completed = useRef('')
  const savedMcp = useRef<ManagedStatus | null>(null)
  const state = useSourceJob(request, catalog?.store_id ?? kind, 'add')
  const dirty = Boolean(name || description || content || url || path || discovery)
  const draft = useResourceDraft(dirty, state.busy)
  const finish = useRef(onAdded); finish.current = onAdded
  useEffect(() => {
    if (state.job?.status !== 'completed' || completed.current === state.job.id) return
    completed.current = state.job.id
    if (state.job.operation === 'discover') {
      const value = state.job.result as Discovery
      setDiscovery(value); setSelected(value.candidates.length === 1 ? [value.candidates[0].id] : [])
      setMode('github')
    } else if (!(kind === 'mcp' && state.job.operation === 'create' && mcpEditor)) {
      const value = state.job.result as ManagedStatus | { items: ManagedStatus[] }
      const item = 'items' in value ? value.items[0] : value
      if (item) draft.complete(() => { void finish.current(item) })
    }
  }, [state.job, kind, draft, mcpEditor])
  const title = kind === 'prompts' ? 'prompt' : kind === 'skills' ? 'skill' : 'MCP server'
  async function run(operation: string, value: object) {
    setError('')
    try { await state.start(operation, value) } catch (cause) { setError(errorText(cause)) }
  }
  if (!catalog) return <section className="managed-reader"><h2>Add {title}</h2><p>Loading library…</p></section>
  if (!catalog.capabilities?.source_jobs) return <section className="managed-reader"><h2>Add {title}</h2><p>Update the manager packages to enable resource creation and GitHub imports.</p></section>
  return <section className="managed-reader resource-add"><h2>Add {title}</h2>
    <p>The manager keeps its own copy. Choose how to add it.</p>
    <div className="managed-actions" role="group" aria-label="Resource source">
      {([['create', kind === 'mcp' ? 'Configure manually' : 'Create new'], ['local', 'Import local package'], ['github', 'Import from GitHub']] as const).map(([value, label]) =>
        <Button key={value} variant="secondary" aria-pressed={mode === value} disabled={state.busy || value === 'github' && !catalog?.capabilities?.github} onPress={() => {
          setMode(value); if (value === 'create' && kind === 'mcp') setMcpEditor(true)
        }}>{label}</Button>)}
    </div>
    {mode === 'create' && kind !== 'mcp' && <form className="managed-form" onSubmit={event => { event.preventDefault(); void run('create', { name, description, content, role }) }}>
      <TextField label={kind === 'skills' ? 'Skill name' : 'Prompt name'} value={name} onChange={event => setName(event.target.value)} required pattern="[a-z0-9]+(-[a-z0-9]+)*" disabled={state.busy} />
      <TextField label={kind === 'skills' ? 'When to use this skill' : 'Description'} value={description} onChange={event => setDescription(event.target.value)} required={kind === 'skills'} disabled={state.busy} />
      {kind === 'prompts' && <Select label="Prompt role" value={role} onChange={setRole} options={[{ id: 'system', label: 'System instructions' }, { id: 'user', label: 'User message' }, { id: 'assistant', label: 'Assistant message' }]} />}
      <Textarea variant="outlined" label={kind === 'skills' ? 'Skill instructions' : 'Prompt text'} value={content} onChange={event => setContent(event.target.value)} required disabled={state.busy} rows={12} />
      <Button type="submit" disabled={state.busy || !name || !content}>Create {title}</Button>
    </form>}
    {mode === 'local' && <form className="managed-form" onSubmit={event => { event.preventDefault(); void run('import-local', { path }) }}>
      <TextField label={kind === 'mcp' ? 'Definition JSON file on the Suite host' : 'Package directory on the Suite host'} value={path} onChange={event => setPath(event.target.value)} required disabled={state.busy} />
      <Button type="submit" disabled={state.busy || !path}>Import local copy</Button>
    </form>}
    {mode === 'github' && <>
      <p>Paste a public GitHub repository or package link.</p>
      <form className="managed-form" onSubmit={event => { event.preventDefault(); setDiscovery(null); void run('discover', { url, ...(ref ? { ref } : {}), ...(subdirectory ? { path: subdirectory } : {}), ...(tracking === 'auto' ? {} : { track: tracking === 'track' }) }) }}>
        <TextField label="GitHub URL" type="url" placeholder="https://github.com/owner/repository" value={url} onChange={event => setUrl(event.target.value)} required disabled={state.busy} />
        <details><summary>Source options</summary><TextField label="Branch, tag, or commit (optional)" value={ref} onChange={event => setRef(event.target.value)} disabled={state.busy} />
          <TextField label="Package path (optional)" value={subdirectory} onChange={event => setSubdirectory(event.target.value)} disabled={state.busy} />
          <Select label="Update policy" value={tracking} onChange={setTracking} options={[{ id: 'auto', label: 'Track branches; pin tags and commits' }, { id: 'track', label: 'Track this reference' }, { id: 'pin', label: 'Pin this snapshot' }]} /></details>
        <Button type="submit" disabled={state.busy || !url}>Find resources</Button>
      </form>
      {discovery && <div className="resource-source-discovery"><h3>Choose resources to import</h3><p>{discovery.source.ref} · {discovery.source.commit.slice(0, 12)} · {discovery.source.pinned ? 'Pinned snapshot' : 'Tracking updates'}</p>
        {discovery.candidates.map(candidate => <section key={candidate.id}>
          <Checkbox label={candidate.name} isSelected={selected.includes(candidate.id)} disabled={state.busy} onChange={checked => setSelected(current => checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))} />
          <p>{candidate.description}</p><p>{candidate.file_count} files · {candidate.id}</p>
          <details><summary>Preview package</summary>{candidate.preview && <pre>{candidate.preview}</pre>}{candidate.preview_truncated && <p>Showing the start of the instructions. The complete package will be imported.</p>}<ul>{candidate.files.map(file => <li key={file}>{file}</li>)}</ul>
            {candidate.file_count > candidate.files.length && <p>Showing the first {candidate.files.length} files.</p>}
            {candidate.definition !== undefined && <pre>{JSON.stringify(candidate.definition, null, 2)}</pre>}</details>
        </section>)}
        {kind === 'prompts' && discovery.candidates.some(candidate => candidate.type === 'markdown') && <Select label="Imported document role" value={role} onChange={setRole} options={[{ id: 'system', label: 'System instructions' }, { id: 'user', label: 'User message' }, { id: 'assistant', label: 'Assistant message' }]} />}
        <Button disabled={state.busy || !selected.length} onPress={() => { void run('import', { discovery_id: discovery.discovery_id, selections: selected, role }) }}>Import selected resources</Button>
      </div>}
    </>}
    <SourceActivity state={state} />{error && <p role="alert">{error}</p>}{draft.confirmation}
    {mcpEditor && <McpDefinitionEditor definition={{ command: '', args: [], env_vars: [] }} connected={true} onCancel={() => setMcpEditor(false)}
      onSave={async (name, definition) => {
        const value = await state.wait(await state.start('create', { name, definition }))
        savedMcp.current = value.result as ManagedStatus
      }} onSaved={() => { if (savedMcp.current) draft.complete(() => { void finish.current(savedMcp.current!) }) }} />}
  </section>
}

export function ResourceSourcePanel({ kind, item, request, store, onChanged }: {
  kind: ResourceKind; item: ManagedStatus; request: Request; store: string; onChanged: () => Promise<void>
}) {
  const state = useSourceJob(request, store, `${item.publisher_id}/${item.id}`)
  const handled = useRef('')
  const changed = useRef(onChanged); changed.current = onChanged
  const [label, setLabel] = useState(item.label ?? item.source?.label ?? item.id)
  const [interval, setInterval] = useState(item.source?.interval_hours ?? 24)
  const [pinned, setPinned] = useState(item.source?.pinned ?? false)
  const [sourceRef, setSourceRef] = useState(item.source?.ref ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const identity = { publisherId: item.publisher_id, resourceId: item.id, storeId: store }
  const dirty = label !== (item.label ?? item.source?.label ?? item.id) || interval !== (item.source?.interval_hours ?? 24) || pinned !== (item.source?.pinned ?? false)
  const draft = useResourceDraft(dirty, saving)
  useEffect(() => {
    if (state.job && !active(state.job) && handled.current !== state.job.id) {
      handled.current = state.job.id; void changed.current()
    }
  }, [state.job])
  if (!item.source && !item.installation && !item.label) return null
  async function run(operation: string, requestValue: object) {
    try { setError(''); await state.start(operation, requestValue) } catch (cause) { setError(errorText(cause)) }
  }
  return <section className="resource-source-panel"><ContentDisclosure enabled title="Source and update settings" defaultOpen={state.busy || dirty || !!error || !!state.error || !!state.job?.error || !!item.installation?.installation_required}><h3>{item.source ? 'Source and updates' : 'Installation'}</h3>
    {item.source && <>
      <p><a href={item.source.url} target="_blank" rel="noreferrer">{item.source.repository}</a> · {item.source.ref} · {item.source.commit.slice(0, 12)}</p>
      <p>Active copy: revision {item.sequence}. Publisher changes are reviewed here before replacing customized content.</p>
      <Button variant="secondary" size="sm" disabled={state.busy || item.source.pinned || !item.tracking} onPress={() => { void run('check', { publisher: item.publisher_id, identifier: item.id, expected_revision: item.revision, force: true }) }}>Check for updates</Button>
    </>}
    {kind === 'mcp' && item.installation && <div className="resource-installation"><p>Accepted version: {item.installation.status.replaceAll('_', ' ')}</p>
      {item.installation.reason && <p>{item.installation.reason}</p>}
      {item.installation.recipe && <details><summary>Installation requirements</summary><pre>{JSON.stringify(item.installation.recipe, null, 2)}</pre><p>Installation may run package build scripts on this machine.</p></details>}
      {item.installation.installation_required && item.installation.recipe && <Button variant="secondary" disabled={state.busy} onPress={() => { void run('install', { publisher: item.publisher_id, identifier: item.id, expected_revision: item.revision, candidate: 'active' }) }}>Install accepted version</Button>}
      {item.reconciliation_required && item.publisher_installation?.installation_required && item.publisher_installation.recipe && <>
        <p>The publisher update needs installation. Your accepted version remains active while it is prepared.</p>
        <details><summary>Publisher installation requirements</summary><pre>{JSON.stringify(item.publisher_installation.recipe, null, 2)}</pre><p>Installation may run package build scripts on this machine.</p></details>
        <Button variant="secondary" disabled={state.busy} onPress={() => { void run('install', { publisher: item.publisher_id, identifier: item.id, expected_revision: item.revision, candidate: 'publisher' }) }}>Prepare publisher version</Button>
      </>}
    </div>}
    <details><summary>Resource settings</summary><form className="managed-form" onSubmit={event => {
      event.preventDefault(); setSaving(true); setError('')
      void request('source-settings', { ...identity, expectedRevision: item.revision, label, ...(item.source ? { intervalHours: interval, pinned } : {}) })
        .then(async () => { await changed.current() }).catch(cause => setError(errorText(cause))).finally(() => setSaving(false))
    }}><TextField label="Display name" value={label} onChange={event => setLabel(event.target.value)} required disabled={saving} />
      {item.source && <><Checkbox label="Pin this snapshot" isSelected={pinned} onChange={setPinned} disabled={saving} />
        <NumberField variant="outlined" label="Check interval in hours" minValue={1} maxValue={720} value={interval} onChange={setInterval} required disabled={saving} /></>}
      <Button type="submit" disabled={saving || !dirty}>Save resource settings</Button>
    </form></details>
    {item.source && <details><summary>Change branch, tag, or commit</summary>
      <TextField label="Source reference" value={sourceRef} onChange={event => setSourceRef(event.target.value)} disabled={state.busy} />
      <Button variant="secondary" disabled={state.busy || !sourceRef || sourceRef === item.source.ref} onPress={() => { void run('switch-source', { publisher: item.publisher_id, identifier: item.id, expected_revision: item.revision, ref: sourceRef }) }}>Preview reference change</Button>
      <p>Changing the source stages a version for review while your accepted copy remains active.</p>
    </details>}
    </ContentDisclosure>
    <SourceActivity state={state} />{error && <p role="alert">{error}</p>}{draft.confirmation}
    <p><a href="#/agents/profiles">Attach to a profile</a> or select it for an individual launch. Installation readiness is checked on the execution machine.</p>
  </section>
}
