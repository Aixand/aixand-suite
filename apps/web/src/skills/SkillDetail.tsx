import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Checkbox, CopyButton, Dialog, DropdownMenu, Icon, Popover, Select, TextField } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import { PageLoading } from '../components/PageLoading'
import { ResourceContent } from '../resources/editor/ResourceContent'
import { ResourceEditor, ResourceFilePicker } from '../resources/editor/ResourceEditor'
import { useResourceDraft } from '../resources/editor/drafts'
import { ProfileStatus } from '../agents/ProfileControls'
import { AssignSkillButton, SkillProfileUsage } from './SkillProfiles'
import type { Skill, SkillCatalog, SkillRelease } from './SkillsPage'

const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
export function SkillDetail({ agents, catalog, selection, onSelect, onRefresh, onCopy }: {
  agents: AgentsModel; catalog: SkillCatalog; selection: string; onSelect: (id: string) => void
  onRefresh: () => Promise<void>; onCopy: (path: string) => void
}) {
  const api = useRef(agents); api.current = agents
  const [detail, setDetail] = useState<Skill | null>(null)
  const [file, setFile] = useState('SKILL.md')
  const [text, setText] = useState('')
  const [binary, setBinary] = useState<string | null>(null)
  const [executable, setExecutable] = useState(false)
  const [snapshot, setSnapshot] = useState({ file: 'SKILL.md', text: '', binary: null as string | null, executable: false })
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [version, setVersion] = useState('1')
  const [publishing, setPublishing] = useState(false)
  const [validation, setValidation] = useState<Record<string, unknown> | null>(null)
  const [newFile, setNewFile] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [assignments, setAssignments] = useState(0)
  const generation = useRef(0)
  const upload = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (detail && window.matchMedia('(max-width: 760px)').matches) heading.current?.focus({ preventScroll: true }) }, [detail?.id, detail?.name])
  const dirty = editing && (text !== snapshot.text || binary !== snapshot.binary || executable !== snapshot.executable || file !== snapshot.file)
  const draft = useResourceDraft(dirty, busy && editing)
  const connected = agents.status === 'connected'
  const disabled = busy || !connected
  const editable = Boolean(detail?.editable && detail.digest && !selection.includes('@'))
  const family = catalog.entries.find(row => row.id === selection) ?? catalog.releases.find(row => row.reference === selection) ?? detail
  const drafts = catalog.entries.filter(row => row.source_id === family?.source_id && row.name === family?.name)
  const releases = catalog.releases.filter(row => row.source_id === family?.source_id && row.name === family?.name)
  const files = detail?.manifest?.files.map(row => row.path) ?? []
  function accept(content: string, path: string, record: Skill) {
    const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0))
    let value = '', data: string | null = null
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { data = content }
    const flag = record.manifest?.files.find(row => row.path === path)?.executable ?? false
    setFile(path); setText(value); setBinary(data); setExecutable(flag)
    setSnapshot({ file: path, text: value, binary: data, executable: flag })
  }
  useEffect(() => {
    if (!connected || detail) return
    const token = ++generation.current
    setLoading(true); setError('')
    void Promise.all([api.current.request<Skill>('skills-show', { entryId: selection }),
      api.current.request<{ content_b64: string }>('skills-file', { entryId: selection, file: 'SKILL.md' })]).then(([record, content]) => {
      if (generation.current !== token) return
      setDetail(record); accept(content.content_b64, 'SKILL.md', record)
    }).catch((cause: Error) => { if (generation.current === token) setError(cause.message) }).finally(() => { if (generation.current === token) setLoading(false) })
    return () => { generation.current++ }
  }, [connected, selection])
  async function read(path: string) {

    if (!detail) return
    const token = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await api.current.request<{ content_b64: string }>('skills-file', { entryId: selection, file: path })
      if (token === generation.current) accept(result.content_b64, path, detail)
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : 'Could not read this file.') }
    finally { if (token === generation.current) setLoading(false) }
  }
  async function act(action: () => Promise<void>, message: string) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action(); setNotice(message) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Skill operation failed.') }
    finally { setBusy(false) }
  }
  const save = () => { if (detail && dirty && !disabled) void act(async () => {
    const result = await agents.request<Skill>('skills-save', { entryId: selection, file, content_b64: binary ?? encode(new TextEncoder().encode(text)), executable, expectedDigest: detail.digest })
    setDetail(result); setSnapshot({ file, text, binary, executable }); setEditing(false); await onRefresh()
  }, 'Draft saved. Published releases and existing sessions retain their content.') }
  function download() {
    const bytes = binary ? Uint8Array.from(atob(binary), char => char.charCodeAt(0)) : new TextEncoder().encode(text)
    const url = URL.createObjectURL(new Blob([bytes.buffer])); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.split('/').at(-1) ?? file; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const selectedRelease = releases.find(row => row.reference === selection)
  const target = { kind: 'release' as const, store: catalog.store, reference: selection }
  const versionPicker = drafts.length + releases.length > 1 ? <Select label="Skill version" hideLabel variant="plain" value={selection} onChange={onSelect}
        options={[...drafts.map(row => ({ id: row.id, label: drafts.length > 1 ? `Draft · ${row.path}` : 'Working draft' })), ...releases.map(row => ({ id: row.reference, label: `Version ${row.version}${row.error ? ' · Unavailable' : ''}` }))]} />
    : <Badge>{selectedRelease ? `Version ${selectedRelease.version}` : detail?.editable ? 'Working draft' : 'Read only'}</Badge>
  if (!detail) return <div className="resource-reader-body">{error ? <Alert title="Skill unavailable" tone="warning">{error}<Button variant="ghost" onPress={() => onSelect('')}>Back to library</Button></Alert> : <PageLoading label="Loading skill…" size="panel" />}</div>
  return <section className="resource-overview" aria-label="Skill details">
    <header className="resource-heading"><div className="resource-heading-copy"><div className="resource-version-heading"><h2 ref={heading} tabIndex={-1}>{detail.name}</h2>{versionPicker}
      {detail.status !== 'valid' && <ProfileStatus tone="warning" label={detail.error?.message || 'Package needs review. Validate this skill to inspect its contents.'} />}</div>
      <p>{catalog.sources.find(row => row.id === detail.source_id)?.label || detail.source_id}</p>{(detail.metadata?.description || detail.manifest?.metadata?.description) && <p>{detail.metadata?.description || detail.manifest?.metadata?.description}</p>}</div>
      <div className="resource-heading-actions">
        {selectedRelease && !selectedRelease.error && <AssignSkillButton agents={agents} target={target} label={selection} disabled={disabled} onAssigned={() => setAssignments(value => value + 1)} />}
        {editable ? <Button size="sm" variant="secondary" disabled={disabled} onPress={() => setEditing(true)}>Edit skill</Button>
          : drafts.some(row => row.editable) ? <Button size="sm" variant="secondary" onPress={() => onSelect(drafts.find(row => row.editable)!.id)}>Open draft</Button>
            : <Button size="sm" variant="secondary" disabled={disabled} onPress={() => onCopy(detail.path)}>{selection.includes('@') ? 'Import editable copy' : 'Create editable copy'}</Button>}
        <DropdownMenu label="Skill actions" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="Skill actions"><Icon name="ellipsis" /></Button>}
          items={[{ id: 'validate', label: 'Validate package', disabled }, { id: 'publish', label: 'Publish release', disabled: disabled || !editable || detail.status !== 'valid' }, { id: 'download', label: 'Download file', disabled: loading }]}
          onAction={action => { if (action === 'publish') setPublishing(true); else if (action === 'download') download(); else void act(async () => { setValidation(await agents.request<Record<string, unknown>>('skills-validate', { entryId: selection })) }, 'Validation complete.') }} />
      </div>
    </header>
    <div className="resource-reader-body">
      {error && <Alert title="Skill needs attention" tone="warning">{error}</Alert>}{notice && <p role="status" className="carrier-muted">{notice}</p>}
          <div className="resource-reader-toolbar"><ResourceFilePicker files={files} value={file} onChange={path => { void read(path) }} disabled={disabled || loading} />
            {binary === null && <CopyButton text={text} variant="ghost" size="sm" />}</div>
          {loading ? <PageLoading label="Loading file…" size="panel" /> : binary ? <div className="resource-document"><h3>Binary file</h3><p>This file is preserved as bytes.</p><Button variant="secondary" onPress={download}>Download file</Button></div> : <ResourceContent text={text} file={file} label="Skill instructions" />}
      {selectedRelease && <SkillProfileUsage agents={agents} target={target} refresh={assignments} />}
      <details className="resource-detail-disclosure"><summary>Versions and source</summary>
        <div className="agent-skill-source">
          <dl className="agent-source-details"><dt>Source</dt><dd>{detail.source_id}</dd><dt>Location</dt><dd>{detail.path ?? catalog.store}</dd><dt>Content identity</dt><dd>{detail.digest}</dd><dt>Selection</dt><dd>{selection}</dd></dl>
          <div className="skill-version-list">{[...drafts.map(row => ({ id: row.id, label: 'Working draft' })), ...releases.map(row => ({ id: row.reference, label: `Version ${row.version}` }))].map(row =>
            <Button key={row.id} variant="secondary" size="sm" aria-pressed={row.id === selection} onPress={() => onSelect(row.id)}>{row.label}</Button>)}</div>
        </div>
      </details>
      {validation && <Alert title={validation.valid === false ? 'Validation needs attention' : 'Package validated'} tone={validation.valid === false ? 'warning' : 'success'}>
        <p>{validation.valid === false ? 'Review the validation details before publishing.' : 'The package check completed.'}</p><details><summary>Validation details</summary><pre>{JSON.stringify(validation, null, 2)}</pre></details></Alert>}

    </div>
    {editing && <ResourceEditor title={`Edit ${detail.name}`} subtitle="Skill draft" file={file} files={files} onFile={path => draft.guard(() => { void read(path) })}
      value={text} onChange={setText} label="Skill file contents" dirty={dirty} busy={busy} disabled={disabled || !editable || loading} binary={binary !== null} onSave={save}
      onCancel={() => draft.guard(() => { setFile(snapshot.file); setText(snapshot.text); setBinary(snapshot.binary); setExecutable(snapshot.executable); setEditing(false) })} error={error}
      notice={!connected ? 'Your edits are preserved. Reconnect to save.' : loading ? 'Loading file…' : undefined}>
      <DropdownMenu label="File actions" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="File actions"><Icon name="plus" /></Button>}
        items={[{ id: 'new', label: 'New file' }, { id: 'upload', label: 'Upload file' }, { id: 'download', label: 'Download file' }]}
        onAction={action => { if (action === 'download') download(); else draft.guard(() => { if (action === 'new') { setNewPath(''); setNewFile(true) } else upload.current?.click() }) }} />
      <Popover title="File settings" trigger={<Button variant="ghost" size="sm" iconOnly aria-label="File settings"><Icon name="settings" /></Button>}><Checkbox label="Executable file" isSelected={executable} onChange={setExecutable} disabled={disabled} /></Popover>
    <input ref={upload} hidden type="file" aria-label="Upload skill file" onChange={event => {
      const selected = event.target.files?.[0]; if (!selected) return
      event.target.value = ''
      if (selected.size > 36000) { setError('This editor supports files up to 36 KB. Use Skill Manager for larger files.'); return }
      const token = generation.current
      void selected.arrayBuffer().then(value => { if (token === generation.current) { setFile(selected.name); setBinary(encode(new Uint8Array(value))); setText('') } })
    }} />
    </ResourceEditor>}

    <Dialog title="New skill file" trigger={<Button hidden className="resource-dialog-trigger">New file</Button>} open={newFile} onOpenChange={setNewFile}
      footer={<><Button variant="ghost" onPress={() => setNewFile(false)}>Cancel</Button><Button disabled={!newPath.trim() || files.includes(newPath.trim())} onPress={() => { setFile(newPath.trim()); setText(''); setBinary(null); setExecutable(false); setNewFile(false) }}>Create file</Button></>}>
      <TextField label="File path" value={newPath} onChange={event => setNewPath(event.target.value)} hint="Relative to the skill package." />
    </Dialog>
    <Dialog title="Publish skill release" trigger={<Button hidden className="resource-dialog-trigger">Publish skill release</Button>} open={publishing} onOpenChange={open => { if (!busy) setPublishing(open) }}
      footer={<><Button variant="ghost" disabled={busy} onPress={() => setPublishing(false)}>Cancel</Button><Button disabled={disabled || !version.trim()} loading={busy} onPress={() => { void act(async () => {
        const result = await agents.request<SkillRelease>('skills-release', { entryId: selection, version, expectedDigest: detail.digest }); await onRefresh(); setPublishing(false); onSelect(result.reference)
      }, 'Release published. Profile assignments remain pinned to their selected versions.') }}>Publish release</Button></>}>
      <p>Publish this saved draft as an immutable version. Profiles and existing sessions keep their selected versions.</p>
      <TextField label="Release version" value={version} onChange={event => setVersion(event.target.value)} />
      {error && <p role="alert">{error}</p>}
    </Dialog>
    {draft.confirmation}
  </section>
}
