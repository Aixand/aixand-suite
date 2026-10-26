import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Checkbox, ConfirmationDialog, Dialog, DropdownMenu, FileUpload, Icon, Popover, Select, TextField } from 'bbb-design'
import { ContentDisclosure } from '../components/ContentDisclosure'
import { ResourceContent } from './editor/ResourceContent'
import { ResourceEditor, ResourceFilePicker } from './editor/ResourceEditor'
import { CodeEditor } from './editor/LazyCodeEditor'
import { useResourceDraft } from './editor/drafts'
import type { AgentsModel } from '../agents/model'
import './managed.css'
import { ResourceSourcePanel, useSourceJob } from './sources'

export type InstallationStatus = { status: string; installation_required: boolean; reason?: string; recipe?: Record<string, unknown>; generation?: string }
export type ManagedStatus = {
  label?: string; source?: { kind: string; repository: string; url: string; ref: string; commit: string; pinned: boolean; interval_hours: number; label?: string }
  installation?: InstallationStatus; publisher_installation?: InstallationStatus
  publisher_id: string; id: string; revision: string; active_digest: string; sequence: number
  customized: boolean; reconciliation_required: boolean; baseline_known: boolean; tracking: boolean
  sync_error: { message: string } | null; error?: { message: string }
  upstream: { version: string | null; revision: number | null }; baseline: { version: string | null }
}
export type ManagedCatalog = { store: string; store_id: string; items: ManagedStatus[]; capabilities?: { source_jobs?: boolean; github?: boolean; create?: boolean; installation?: boolean } }
type Request = <T>(op: string, args?: object) => Promise<T>
type Side = { present: boolean; binary?: boolean; text?: string; value_type?: string; size?: number; digest?: string
  executable?: boolean | null; total?: number; next_offset?: number | null }
type Choice = { take: 'managed' | 'publisher' | 'baseline' } | { value: unknown } | { delete: true }
type Review = { status: ManagedStatus; store: string; store_id: string; name: string
  files: { path: string; label: string; conflicts: number; managed_changed: boolean; publisher_changed: boolean }[]
  conflicts: { path: string; file: string; resolved: boolean }[]; unresolved_count: number; valid: boolean
  validation_error: { message: string } | null; sides?: Record<string, Side>
  conflict_offset?: number; next_conflict_offset?: number | null
  selected_conflicts?: { path: string; resolved: boolean; sides: Record<string, Side> }[] }

const message = (error: unknown) => error instanceof Error ? error.message : 'Managed operation failed.'
const encode = (data: Uint8Array) => btoa(Array.from(data, byte => String.fromCharCode(byte)).join(''))
const decode = (data: string) => Uint8Array.from(atob(data), char => char.charCodeAt(0))

export function useManaged(kind: 'prompts' | 'skills' | 'mcp', agents: AgentsModel) {
  const api = useRef(agents); api.current = agents
  const [catalog, setCatalog] = useState<ManagedCatalog | null>(null)
  const [error, setError] = useState('')
  const pending = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (api.current.status !== 'connected') return
    if (pending.current) { again.current = true; return pending.current }
    const token = generation.current
    const task = (async () => {
      do {
        again.current = false
        try {
          const value = await api.current.request<ManagedCatalog>(`${kind}-managed-list`)
          if (generation.current === token && value?.items) { setCatalog(value); setError('') }
        } catch (error) { if (generation.current === token) setError(message(error)) }
      } while (again.current && generation.current === token)
    })()
    pending.current = task
    try { await task } finally { if (pending.current === task) pending.current = null }
  }, [kind])
  useEffect(() => {
    generation.current++; pending.current = null; again.current = false
    if (agents.status !== 'connected') return
    void refresh()
    const unsubscribe = agents.subscribe(event => { if ((event as { type: string }).type === `${kind === 'mcp' ? 'mcps' : kind}-changed`) void refresh() })
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 10000)
    return () => { generation.current++; pending.current = null; unsubscribe(); window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [agents.status, kind, refresh, agents.subscribe])
  const request = useCallback(<T,>(op: string, args: object = {}) => api.current.request<T>(`${kind}-managed-${op}`, args), [kind])
  useEffect(() => {
    if (agents.status !== 'connected' || !catalog?.capabilities?.source_jobs) return
    let mounted = true
    const check = () => { if (!document.hidden && mounted) void request('source-check-due', { storeId: catalog.store_id }).catch(() => {}) }
    check()
    const timer = window.setInterval(check, 60 * 60 * 1000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [agents.status, catalog?.store_id, catalog?.capabilities?.source_jobs, request])
  return { catalog, error, refresh, request }
}

export function ManagedBadges({ status }: { status: ManagedStatus }) {
  return <span className="managed-badges">
    {status.reconciliation_required ? <Badge tone="warning">Update needs review</Badge>
      : <Badge tone="neutral">{status.customized ? 'Customized' : 'Up to date'}</Badge>}
    {status.source?.pinned && <Badge tone="neutral">Pinned snapshot</Badge>}
    {!status.tracking && <Badge tone="neutral">Updates paused</Badge>}
    {status.installation?.installation_required && <Badge tone="warning">{status.installation.status === "setup_required" ? "Setup required" : "Installation required"}</Badge>}
    {status.sync_error && <Badge tone="warning">Update check failed</Badge>}
  </span>
}

export function managedMatches(item: ManagedStatus, query: string) {
  return `${item.publisher_id} ${item.id} ${item.label ?? ''} ${item.source?.label ?? ''} ${item.source?.repository ?? ''}`.toLowerCase().includes(query.toLowerCase())
}

export function ManagedList({ catalog, query = '', publisher, resource, onSelect }: {
  catalog: ManagedCatalog | null; query?: string; publisher: string; resource: string
  onSelect: (item: ManagedStatus) => void
}) {
  if (!catalog?.items.length) return null
  const items = catalog.items.filter(item => managedMatches(item, query))
  if (!items.length) return null
  return <section className="managed-library" aria-label="Managed library"><h2>Managed copies</h2>
    {items.map(item => <Button key={`${item.publisher_id}/${item.id}`} variant="ghost" className="carrier-message-row managed-library-row"
      aria-pressed={publisher === item.publisher_id && resource === item.id} onPress={() => onSelect(item)}>
      <span className="carrier-row-title">{item.label ?? item.source?.label ?? (item.id === 'default' ? item.publisher_id : item.id)}</span>
      <span className="carrier-row-preview">{item.publisher_id}{item.id === 'default' ? '' : ` · ${item.id}`}</span>
      {item.error ? <span role="status">{item.error.message}</span> : <ManagedBadges status={item} />}
    </Button>)}
  </section>
}

export function ManagedImport({ kind, catalog, request, onImported, initialPath = '' }: {
  kind: 'prompts' | 'skills' | 'mcp'; catalog: ManagedCatalog | null; request: Request; onImported: (item: ManagedStatus) => Promise<void>; initialPath?: string
}) {
  const [publisher, setPublisher] = useState('local')
  const [identifier, setIdentifier] = useState('default')
  const [path, setPath] = useState(initialPath)
  const [revision, setRevision] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  return <section className="managed-reader"><h2>Import a managed {kind === 'prompts' ? 'prompt pack' : 'skill'}</h2>
    <p>The manager saves its own complete copy. Publisher files remain unchanged.</p>
    <form className="managed-form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void request<ManagedStatus>('ensure', {
      publisherId: publisher, resourceId: identifier, storeId: catalog?.store_id, path,
      ...(revision ? { publisherRevision: Number(revision) } : {}),
    }).then(onImported).catch(error => setError(message(error))).finally(() => setBusy(false)) }}>
      <TextField label="Publisher ID" required pattern="[a-z][a-z0-9_-]{0,63}" value={publisher} onChange={event => setPublisher(event.target.value)} />
      <TextField label="Resource ID" required pattern="[a-z][a-z0-9_-]{0,63}" value={identifier} onChange={event => setIdentifier(event.target.value)} />
      <TextField label="Package directory" required value={path} onChange={event => setPath(event.target.value)} />
      <TextField label="Publisher revision (optional)" type="number" min={0} step={1} value={revision} onChange={event => setRevision(event.target.value)} />
      <Button type="submit" disabled={busy || !catalog}>Import managed copy</Button>
    </form>{error && <p role="alert">{error}</p>}
  </section>
}

function CompareSide({ title, side }: { title: string; side?: Side }) {
  return <section className="managed-comparison-side"><h3>{title}</h3>
    {!side?.present ? <p>Not present</p> : side.binary ? <p>Binary file · {side.size} bytes</p>
      : <><pre>{side.text}</pre>{side.next_offset !== null && side.next_offset !== undefined && <p>Showing the first {side.text?.length} characters of {side.total}.</p>}</>}
    {side?.executable !== null && side?.executable !== undefined && <p>{side.executable ? 'Executable' : 'Not executable'}</p>}
  </section>
}

export function ManagedDetail({ kind, item, catalog, request, onChanged }: {
  kind: 'prompts' | 'skills' | 'mcp'; item: ManagedStatus; catalog: ManagedCatalog; request: Request; onChanged: () => Promise<void>
}) {
  const preparation = useSourceJob(request, catalog.store_id, `review/${item.publisher_id}/${item.id}`)
  const [editing, setEditing] = useState(false)
  const [creatingFile, setCreatingFile] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [fileDialog, setFileDialog] = useState<'new' | 'upload' | null>(null)
  const [newPath, setNewPath] = useState('')
  const [attachment, setAttachment] = useState<File | null>(null)
  const savedBuffer = useRef({ text: '', file: '', executable: false })
  const [data, setData] = useState<Review | null>(null)
  const [mode, setMode] = useState<'edit' | 'review' | 'history'>('edit')
  const [path, setPath] = useState('')
  const [file, setFile] = useState('')
  const [text, setText] = useState('')
  const [executable, setExecutable] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [previewed, setPreviewed] = useState('{}')
  const [history, setHistory] = useState<ManagedStatus[]>([])
  const [historyNext, setHistoryNext] = useState<number | null>(null)
  const [release, setRelease] = useState('v1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const draft = useResourceDraft(dirty, busy && editing)
  const epoch = useRef(0)
  const manualKinds = useRef<Record<string, string>>({})
  const selectedKey = `${catalog.store_id}/${item.publisher_id}/${item.id}`
  const identity = { publisherId: item.publisher_id, resourceId: item.id, storeId: catalog.store_id }
  const revision = data?.status.revision ?? item.revision
  const stale = Boolean(data && data.status.revision !== item.revision)
  const incomplete = Boolean(data?.sides?.managed.next_offset)
  function resolvedChoices() {
    return Object.fromEntries(Object.entries(choices).map(([pointer, choice]) => [pointer,
      'value' in choice && manualKinds.current[pointer] === 'json' && typeof choice.value === 'string'
        ? { value: JSON.parse(choice.value) as unknown } : choice])) as Record<string, Choice>
  }
  async function load(nextMode = mode, selectedPath = path, resolutions?: Record<string, Choice>, conflictOffset = 0) {
    const token = ++epoch.current
    const base = await request<Review>(nextMode === 'review' ? 'review' : 'show', { ...identity, ...(resolutions ? { resolutions } : {}) })
    const selected = base.files.some(row => row.path === selectedPath) ? selectedPath : base.files[0]?.path ?? ''
    const value = selected ? await request<Review>(nextMode === 'review' ? 'review' : 'show', { ...identity, path: selected,
      expectedRevision: base.status.revision, conflictOffset, ...(resolutions ? { resolutions } : {}) }) : base
    if (token !== epoch.current) return
    for (const conflict of value.selected_conflicts ?? []) manualKinds.current[conflict.path] = conflict.sides.managed.value_type ?? conflict.sides.publisher.value_type ?? 'text'
    setData(value); setPath(selected)
    if (nextMode !== 'review') {
      setCreatingFile(false)
      setText(value.sides?.managed.text ?? ''); setExecutable(Boolean(value.sides?.managed.executable))
      const label = value.files.find(row => row.path === selected)?.label ?? ''
      setFile(label); setDirty(false)
      savedBuffer.current = { text: value.sides?.managed.text ?? '', file: label, executable: Boolean(value.sides?.managed.executable) }
    }
    setPreviewed(JSON.stringify(resolutions ? choices : {}))
  }
  useEffect(() => {
    setData(null); setMode('edit'); setChoices({}); setDirty(false); setError(''); setNotice('')
    void load('edit', '').catch(error => setError(message(error)))
    return () => { epoch.current++ }
    // Keep editor/review buffers when polling reports a newer revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])
  async function act(action: () => Promise<unknown>, success = '') {
    setBusy(true); setError(''); setNotice('')
    try { await action(); if (success) setNotice(success) }
    catch (error) { setError(message(error)) }
    finally { setBusy(false) }
  }
  async function changed() { await onChanged(); await load('edit'); setMode('edit'); setEditing(false); setChoices({}) }
  async function upload(content: Uint8Array, name: string) {
    if (kind === 'mcp') {
      await request('save', { ...identity, definition: JSON.parse(new TextDecoder().decode(content)), expectedRevision: revision })
      await changed()
      return
    }
    if (content.length > 64 * 1024 * 1024) throw new Error('Files must be 64 MiB or smaller.')
    const started = await request<{ uploadId: string }>('upload-start', { ...identity, file: name, size: content.length,
      executable, expectedRevision: revision })
    try {
      for (let offset = 0; offset < content.length; offset += 32768) {
        await request('upload-chunk', { ...identity, uploadId: started.uploadId, offset, content_b64: encode(content.slice(offset, offset + 32768)) })
      }
      const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(content).buffer)
      const digest = 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
      await request('upload-finish', { ...identity, uploadId: started.uploadId, digest })
    } catch (error) {
      await request('upload-cancel', { ...identity, uploadId: started.uploadId }).catch(() => undefined)
      throw error
    }
    await changed()
  }
  async function readAll() {
    const chunks: Uint8Array[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const part: { content_b64: string; next_offset: number | null; total: number } = await request('file', { ...identity, file, expectedRevision: revision, offset })
      chunks.push(decode(part.content_b64)); offset = part.next_offset
    }
    const content = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
    let at = 0; for (const chunk of chunks) { content.set(chunk, at); at += chunk.length }
    return content
  }
  async function download() {
    const bytes = await readAll(); const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer])); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.split('/').at(-1) ?? 'file'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function apply(take?: 'managed' | 'publisher') {
    await request('apply', { ...identity, expectedRevision: revision, ...(take ? { take } : { resolutions: resolvedChoices() }) })
    await changed()
  }
  const side = data?.sides?.managed
  const fileEditable = creatingFile || !side?.binary && !incomplete
  const sourceSettings = catalog.capabilities?.source_jobs && <ResourceSourcePanel kind={kind} item={item} request={request} store={catalog.store_id} onChanged={onChanged} />
  const reloadControl = <Button variant="ghost" size="sm" disabled={busy} onPress={() => { void act(async () => {
    const buffer = { text, file, executable, dirty }; await load(mode === 'history' ? 'edit' : mode)
    if (buffer.dirty) { setText(buffer.text); setFile(buffer.file); setExecutable(buffer.executable); setDirty(true) }
  }, 'Latest revision loaded. Your unsaved edits and choices are retained; review before saving.') }}>Reload current revision</Button>
  const maintenanceControls = <ContentDisclosure enabled title="History and refresh">
      <Button variant="ghost" size="sm" disabled={busy || dirty} onPress={() => { setMode('history'); void act(async () => {
        const result = await request<{ items: ManagedStatus[]; next_offset: number | null }>('history', identity)
        setHistory(result.items); setHistoryNext(result.next_offset)
      }) }}>History</Button>
      {(!stale) && reloadControl}
      </ContentDisclosure>
  return <section className="managed-reader" aria-label="Managed resource details">
    <header className="resource-heading managed-resource-heading"><div className="resource-heading-copy"><h2 tabIndex={-1}>{item.label ?? item.source?.label ?? data?.name ?? item.id}</h2><p>{item.publisher_id} · {item.id}</p></div>
      <div className="resource-heading-actions">
        <Button size="sm" variant="secondary" disabled={busy || !data || incomplete || Boolean(side?.binary)} onPress={() => { setMode('edit'); setEditing(true) }}>Edit {kind === 'skills' ? 'skill' : kind === 'mcp' ? 'server' : 'prompt'}</Button>
        {kind !== 'mcp' && <DropdownMenu label="Resource actions" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="Resource actions"><Icon name="ellipsis" /></Button>}
          items={[{ id: 'publish', label: 'Publish release', disabled: busy || stale || dirty }, { id: 'new', label: 'New file', disabled: busy }, { id: 'upload', label: 'Upload file', disabled: busy }, { id: 'download', label: 'Download file', disabled: busy || stale || !file }, { id: 'delete', label: 'Delete file', danger: true, disabled: busy || stale || !file }]}
          onAction={action => { if (action === 'publish') setPublishing(true); else if (action === 'delete') draft.guard(() => setDeleting(true)); else if (action === 'download') { void act(download) } else draft.guard(() => { setNewPath(action === 'new' ? '' : file); setAttachment(null); setFileDialog(action as 'new' | 'upload') }) }} />}
      </div>
    </header>
    <div className="managed-overview-body">
    <ManagedBadges status={item} />

    {item.reconciliation_required && <p className="managed-update" role="status">{item.customized ? "Publisher update needs review. Your customized version is still active." : "Publisher update needs review. Your accepted version is still active."}</p>}
    {item.sync_error && <p role="alert">Update check failed: {item.sync_error.message}. The saved version remains available.</p>}
    {stale && <p role="status">This resource changed. Your unsaved work is retained. Reload the comparison before applying.</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {stale && reloadControl}
    <div className="managed-actions">
      {mode !== 'edit' && <Button variant="ghost" size="sm" disabled={busy || dirty} onPress={() => { setMode('edit'); void act(() => load('edit')) }}>Files</Button>}
      {item.reconciliation_required && <Button variant="secondary" size="sm" disabled={busy || dirty} onPress={() => { setMode('review'); setChoices({}); void act(() => load('review')) }}>Review update</Button>}

    </div>
    {mode === 'history' ? <div><h3>Revision history</h3>{history.map(row => <div className="managed-history-row" key={row.revision}>
      <span>Revision {row.sequence} · {row.baseline.version ?? 'Publisher snapshot'}</span>
      <Button variant="secondary" disabled={busy || row.active_digest === item.active_digest} onPress={() => { void act(async () => {
        await request('rollback', { ...identity, revision: row.revision, expectedRevision: item.revision }); await changed()
      }, 'Historical content restored. Publisher update tracking was preserved.') }}>Restore revision {row.sequence}</Button>
    </div>)}{historyNext !== null && <Button disabled={busy} onPress={() => { void act(async () => {
      const result = await request<{ items: ManagedStatus[]; next_offset: number | null }>('history', { ...identity, offset: historyNext })
      setHistory(rows => [...rows, ...result.items]); setHistoryNext(result.next_offset)
    }) }}>Load older revisions</Button>}</div>
      : !data ? <p role="status">Loading managed copy…</p> : <>
        {mode === 'review' && !data.status.baseline_known && <p>Original publisher baseline is unknown. Compare your imported content with the publisher version and choose what to keep.</p>}
        <div className="managed-files"><ResourceFilePicker files={data.files.map(row => row.label)} value={data.files.find(row => row.path === path)?.label ?? file}
          disabled={busy} onChange={label => draft.guard(() => { const selected = data.files.find(row => row.label === label); if (selected) void act(() => load(mode, selected.path, mode === 'review' ? resolvedChoices() : undefined)) })} /></div>
        {mode === 'review' ? <>
          <div className="managed-comparison">{data.status.baseline_known && <CompareSide title="Publisher baseline" side={data.sides?.baseline} />}
            <CompareSide title="Your active version" side={data.sides?.managed} /><CompareSide title="Publisher update" side={data.sides?.publisher} />
            <CompareSide title="Proposed result" side={data.sides?.proposed} />
          </div>
          {data.selected_conflicts?.map(conflict => <fieldset className="managed-conflict" key={conflict.path}><legend>Resolve {conflict.path}</legend>
            <Select variant="outlined" label={`Choice for ${conflict.path}`} value={'take' in (choices[conflict.path] ?? {}) ? (choices[conflict.path] as { take: string }).take : choices[conflict.path] ? 'manual' : ''}
              onChange={value => { setChoices(current => {
                const next = { ...current }; if (!value) delete next[conflict.path]
                else next[conflict.path] = value === 'manual' ? { value: conflict.sides.managed.text ?? conflict.sides.publisher.text ?? '' } : { take: value as 'managed' | 'publisher' }
                return next
              }) }}
              options={[{ id: '', label: 'Choose a resolution' }, { id: 'managed', label: 'Keep mine for this conflict' },
                { id: 'publisher', label: 'Use publisher for this conflict' },
                ...(!conflict.sides.managed.binary && !conflict.sides.publisher.binary && !conflict.sides.managed.next_offset && !conflict.sides.publisher.next_offset ? [{ id: 'manual', label: 'Edit the result' }] : [])]} />
            {choices[conflict.path] && 'value' in choices[conflict.path] && <CodeEditor label={`Merged value for ${conflict.path}`} file={manualKinds.current[conflict.path] === 'json' ? 'result.json' : file}
              value={typeof (choices[conflict.path] as { value: unknown }).value === 'string' ? (choices[conflict.path] as { value: string }).value : JSON.stringify((choices[conflict.path] as { value: unknown }).value, null, 2)}
              onChange={value => setChoices(current => ({ ...current, [conflict.path]: { value } }))} />}
          </fieldset>)}
          {Boolean(data.conflict_offset) && <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(() => load('review', path, resolvedChoices(), Math.max(0, (data.conflict_offset ?? 0) - 8))) }}>Previous conflicts</Button>}
          {data.next_conflict_offset !== null && data.next_conflict_offset !== undefined && <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(() => load('review', path, resolvedChoices(), data.next_conflict_offset ?? 0)) }}>Next conflicts</Button>}
          {data.validation_error && <p role="alert">{data.validation_error.message}</p>}
          <p>{data.unresolved_count} unresolved conflict(s).</p>
          <div className="managed-actions">
            <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(() => load('review', path, resolvedChoices()), 'Preview updated. The active version is unchanged.') }}>Preview choices</Button>
            {kind === 'mcp' && catalog.capabilities?.installation && (item.installation?.recipe || item.publisher_installation?.recipe) && <>
              <Button variant="secondary" disabled={busy || stale || preparation.busy || !data.valid || data.unresolved_count > 0 || previewed !== JSON.stringify(choices)} onPress={() => { void act(async () => {
                await preparation.start('install', { publisher: item.publisher_id, identifier: item.id, expected_revision: revision, candidate: 'reconciled', resolutions: resolvedChoices() })
              }, 'Runtime preparation started. Apply your reviewed choices after it completes.') }}>Prepare selected runtime</Button>
              {preparation.job && <p role="status">Runtime preparation: {preparation.job.status}</p>}
              {preparation.job?.error && <p role="alert">{preparation.job.error.message}</p>}
              {preparation.error && <p role="alert">{preparation.error}</p>}
            </>}
            <Button disabled={busy || stale || !data.valid || data.unresolved_count > 0 || previewed !== JSON.stringify(choices)}
              onPress={() => { void act(() => apply(), 'Reconciled update applied.') }}>Apply reconciled update</Button>
            <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(() => apply('managed'), 'Current version retained. This publisher update is reconciled.') }}>Keep current version</Button>
            <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(() => apply('publisher'), 'Publisher version accepted.') }}>Use publisher version</Button>
            <Button variant="ghost" disabled={busy} onPress={() => { setMode('edit'); void act(() => load('edit')) }}>Review later</Button>
          </div>
        </> : <div className="managed-reading">
          {side?.binary ? <p>Binary file · {side.size} bytes. Download it or upload a replacement.</p> : <ResourceContent text={text} file={file} label="Managed resource content" />}
          {incomplete && <p>The preview is truncated. Load the complete text before editing, or download the file.</p>}
          {incomplete && (side?.total ?? 0) <= 1024 * 1024 && <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(async () => { const complete = new TextDecoder('utf-8', { fatal: true }).decode(await readAll()); setText(complete); savedBuffer.current.text = complete; setData(current => current ? { ...current, sides: { ...current.sides, managed: { ...current.sides?.managed, text: complete, present: true, next_offset: null } } } : current) }) }}>Load complete text</Button>}
          {side?.binary && <Button variant="secondary" disabled={busy || stale} onPress={() => { void act(download) }}>Download file</Button>}
        </div>}
      </>}
    {<>{sourceSettings}{maintenanceControls}</>}
    <details className="managed-advanced"><summary>Versions and update controls</summary>
      <p>Publisher: {item.upstream.version ?? item.upstream.revision ?? 'Unversioned'} · Managed revision {item.sequence}</p>
      <p>Store: {catalog.store}</p><p>Content: {item.active_digest}</p>
      <Button variant="secondary" disabled={busy} onPress={() => { void act(async () => { await request('tracking', { ...identity, enabled: !item.tracking, expectedRevision: item.revision }); await changed() }, item.tracking ? 'Publisher tracking paused.' : 'Publisher tracking resumed.') }}>{item.tracking ? 'Pause publisher updates' : 'Resume publisher updates'}</Button>

    </details>
    </div>
    {editing && data && <ResourceEditor title={`Edit ${data.name}`} subtitle="Managed copy" file={file} files={data.files.map(row => row.label)}
      onFile={label => draft.guard(() => { const selected = data.files.find(row => row.label === label); if (selected) void act(() => load('edit', selected.path)) })}
      value={text} onChange={value => { setText(value); setDirty(value !== savedBuffer.current.text || file !== savedBuffer.current.file || executable !== savedBuffer.current.executable) }}
      label="Managed file contents" dirty={dirty} busy={busy} disabled={stale || !fileEditable || !file}
      onSave={() => { void act(() => upload(new TextEncoder().encode(text), file), 'Managed copy saved. Publisher files were not changed.') }}
      onCancel={() => draft.guard(() => { setText(savedBuffer.current.text); setFile(savedBuffer.current.file); setExecutable(savedBuffer.current.executable); setDirty(false); setCreatingFile(false); setEditing(false) })}
      error={error} notice={stale ? 'This resource changed. Your draft is preserved. Reload the current revision before saving.' : undefined}>
      {kind !== 'mcp' && <DropdownMenu label="File actions" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="File actions"><Icon name="plus" /></Button>}
        items={[{ id: 'new', label: 'New file', disabled: busy }, { id: 'upload', label: 'Upload file', disabled: busy }, { id: 'download', label: 'Download file', disabled: busy || stale || !file }, { id: 'delete', label: 'Delete file', danger: true, disabled: busy || stale || !file }]}
        onAction={action => { if (action === 'download') void act(download); else draft.guard(() => { if (action === 'delete') setDeleting(true); else { setNewPath(action === 'new' ? '' : file); setAttachment(null); setFileDialog(action as 'new' | 'upload') } }) }} />}
      {stale && <Button variant="secondary" size="sm" disabled={busy} onPress={() => { void act(async () => {
        const buffer = { text, file, executable, dirty }; await load('edit'); if (buffer.dirty) { setText(buffer.text); setFile(buffer.file); setExecutable(buffer.executable); setDirty(true) }
      }, 'Latest revision loaded. Your unsaved edits are retained.') }}>Reload current revision</Button>}
      {kind === 'skills' && <Popover title="File settings" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="File settings"><Icon name="settings" /></Button>}><Checkbox label="Executable file" isSelected={executable} disabled={busy} onChange={value => { setExecutable(value); setDirty(true) }} /></Popover>}
    </ResourceEditor>}
    <Dialog title={fileDialog === 'new' ? 'New resource file' : 'Upload resource file'} trigger={<Button hidden className="resource-dialog-trigger">Resource file</Button>} open={Boolean(fileDialog)} onOpenChange={open => { if (!open && !busy) setFileDialog(null) }}
      footer={<><Button variant="ghost" disabled={busy} onPress={() => setFileDialog(null)}>Cancel</Button><Button disabled={busy || !newPath || fileDialog === 'upload' && !attachment} loading={busy} onPress={() => {
        if (fileDialog === 'new') { setCreatingFile(true); setFile(newPath); setText(''); setDirty(true); setMode('edit'); setEditing(true); setFileDialog(null) }
        else if (attachment) void act(async () => { await upload(new Uint8Array(await attachment.arrayBuffer()), newPath); setFileDialog(null) }, 'Uploaded file saved in managed copy.')
      }}>{fileDialog === 'new' ? 'Create file' : 'Upload file'}</Button></>}>
      <TextField label="File path" value={newPath} onChange={event => setNewPath(event.target.value)} hint="Relative to the resource package." />
      {fileDialog === 'upload' && <FileUpload label="Upload replacement or supporting file" disabled={busy} multiple={false}
        files={attachment ? [{ id: 'attachment', file: attachment, status: 'ready' }] : []}
        onAdd={files => { const value = files[0]; setAttachment(value ?? null); if (value && !newPath) setNewPath(value.name) }}
        onRemove={() => setAttachment(null)} />}
      {error && <p role="alert">{error}</p>}
    </Dialog>
    <Dialog title="Publish immutable release" trigger={<Button hidden className="resource-dialog-trigger">Publish immutable release</Button>} open={publishing} onOpenChange={open => { if (!busy) setPublishing(open) }}
      footer={<><Button variant="ghost" disabled={busy} onPress={() => setPublishing(false)}>Cancel</Button><Button disabled={busy || stale || !release} loading={busy} onPress={() => { void act(async () => {
        const value = await request<{ reference?: string; name?: string; version?: string }>('release', { ...identity, expectedRevision: revision, version: release }); await onChanged(); setPublishing(false); setNotice(`Published ${value.reference ?? `${value.name}@${value.version}`}. Existing assignments remain pinned.`)
      }) }}>Publish release</Button></>}>
      <p>Publish the saved managed copy as an immutable version. Existing profile assignments remain pinned.</p><TextField label="Release version" value={release} onChange={event => setRelease(event.target.value)} />
      {error && <p role="alert">{error}</p>}
    </Dialog>
    <ConfirmationDialog title="Delete file?" description={`Remove ${file} from this managed copy. Publisher files stay unchanged.`}
      trigger={<Button hidden className="resource-dialog-trigger">Delete file</Button>} open={deleting} onOpenChange={open => { if (!busy) setDeleting(open) }}
      confirmLabel="Delete file" cancelLabel="Keep file" danger onConfirm={async () => { await act(async () => {
        await request('save', { ...identity, files: { [file]: null }, expectedRevision: revision }); await changed(); setDeleting(false)
      }, 'File removed from managed copy.') }} />
    {draft.confirmation}
  </section>
}
