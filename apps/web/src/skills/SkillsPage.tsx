import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, DropdownMenu, EmptyState, Icon, SearchField, Select, TextField } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { WorkspaceRenderer } from '../agents/AgentWorkspace'
import { PageLoading } from '../components/PageLoading'
import { SkillDetail } from './SkillDetail'
import { ResourceSources, type Source } from './Sources'
import './skills.css'
import '../resources/dialog.css'
import { ResourceAdd } from '../resources/sources'
import { ManagedDetail, ManagedImport, ManagedList, managedMatches, useManaged } from '../resources/managed'

export type SkillRelease = { reference: string; source_id: string; name: string; version: string; digest: string; error?: { message: string } }
type Manifest = { files: { path: string; size: number; executable: boolean; digest: string }[]; directories: string[]; metadata?: { description?: string } }
export type Skill = { id: string; source_id: string; name: string; path: string; editable: boolean; status: string; metadata?: { description?: string }; digest: string | null; manifest: Manifest | null; error?: { message: string } }
export type SkillCatalog = { store: string; store_id: string; sources: Source[]; entries: Skill[]; releases: SkillRelease[] }
function encode(value: Uint8Array) { return btoa(Array.from(value, byte => String.fromCharCode(byte)).join('')) }
export function SkillsPage({ agents, workspace, route, navigate }: {
  agents: AgentsModel; workspace: WorkspaceRenderer; route: string; navigate: (route: string) => void
}) {
  const managed = useManaged('skills', agents)
  const parameters = new URLSearchParams(route.split('?')[1])
  const selection = parameters.get('entry') ?? ''
  const query = parameters.get('q') ?? ''
  const view = parameters.get('view') ?? ''
  const managedPublisher = parameters.get('publisher') ?? ''
  const managedId = parameters.get('managed') ?? ''
  const adding = parameters.get('import') === 'add'
  const managedImport = parameters.get('import') === 'managed'
  const managedItem = managed.catalog?.items.find(row => row.publisher_id === managedPublisher && row.id === managedId)
  const wrongManagedStore = Boolean(parameters.get('managedStore') && managed.catalog && parameters.get('managedStore') !== managed.catalog.store_id)
  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(parameters)
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key) }
    navigate(`agents/skills${next.size ? '?' + next.toString() : ''}`)
  }
  const setSelection = (entry: string) => update({ entry, view: '', file: '', store: '', publisher: '', managed: '', managedStore: '', import: '' })
  const selectManaged = (row: import('../resources/managed').ManagedStatus) => update({ entry: '', view: '', publisher: row.publisher_id, managed: row.id, managedStore: managed.catalog?.store_id ?? '', import: '' })
  const search = useRef<HTMLInputElement>(null)
  const menu = useRef<HTMLButtonElement>(null)
  const [loading, setLoading] = useState(false)
  const api = useRef(agents); api.current = agents
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  const [source, setSource] = useState('')
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function refresh() { setCatalog(await api.current.request<SkillCatalog>('skills-catalog')) }
  useEffect(() => {
    if (agents.status !== 'connected') return
    let active = true
    setLoading(true)
    void api.current.request<SkillCatalog>('skills-catalog').then(value => { if (active) setCatalog(value) }).catch((e: Error) => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    const unsubscribe = api.current.subscribe(message => { if ((message as { type: string }).type === 'skills-changed') void refresh().catch((e: Error) => setError(e.message)) })
    return () => { active = false; unsubscribe() }
  }, [agents.status])
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setNotice('')
    try { await action(); await refresh(); setNotice(message) }
    catch (e) { setError(e instanceof Error ? e.message : 'Skill operation failed') }
    finally { setBusy(false) }
  }
  const disabled = busy || agents.status !== 'connected'
  const foreignStore = Boolean(parameters.get('store') && catalog && parameters.get('store') !== catalog.store)
  const initialLoading = !catalog && !error && agents.status !== 'offline'
  const families = new Map<string, { name: string; source: string; draft?: Skill; release?: SkillRelease }>()
  for (const row of catalog?.entries ?? []) {
    const key = `${row.source_id}/${row.name}`
    if (!families.has(key) || row.id === selection) families.set(key, { name: row.name, source: row.source_id, draft: row })
  }
  for (const row of catalog?.releases ?? []) {
    const key = `${row.source_id}/${row.name}`
    if (!families.has(key)) families.set(key, { name: row.name, source: row.source_id, release: row })
  }
  const rows = [...families.values()].filter(row => `${row.name} ${row.source}`.toLowerCase().includes(query.toLowerCase()))
  const creating = view === 'new'
  const sources = view === 'sources'
  const count = families.size + (managed.catalog?.items.length ?? 0)
  function closeDialog() { update({ view: '' }); requestAnimationFrame(() => menu.current?.focus()) }
  function createDraft() { void act(async () => {
    const result = await agents.request<Skill>('skills-create', { sourceId: source, name, ...(root ? { path: root } : {}), files: {
      'SKILL.md': { content_b64: encode(new TextEncoder().encode(`---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\nWrite skill instructions here.\n`)), executable: false },
    } }); setSelection(result.id)
  }, 'Draft created') }
  return <>{workspace({ title: 'Skills', description: initialLoading ? undefined : `${count} ${count === 1 ? 'skill' : 'skills'}`,
    selected: adding || managedImport || Boolean(managedId) || Boolean(selection), onBack: () => update({ entry: '', view: '', file: '', store: '', publisher: '', managed: '', managedStore: '', import: '' }), error: error || managed.error, notice,
    primary: { label: 'Add skill', onPress: () => update({ import: 'add', path: '', view: '', entry: '', managed: '', publisher: '' }), disabled },
    actions: <DropdownMenu label="Skills menu" trigger={<Button ref={menu} variant="ghost" size="sm" iconOnly aria-label="Skills menu"><Icon name="ellipsis" /></Button>}
        items={[{ id: 'refresh', label: 'Refresh skills', disabled: disabled || loading }, { id: 'new', label: 'Create a draft' }, { id: 'import', label: 'Import managed copy' }, { id: 'sources', label: 'Registered skill sources' }]}
        onAction={id => id === 'refresh' ? void act(async () => { await refresh(); await managed.refresh() }, 'Catalog refreshed') : id === 'import' ? update({ import: 'managed', view: '', entry: '', managed: '', publisher: '' }) : update({ view: String(id), import: '' })} />,
    controls: !initialLoading ? <SearchField ref={search} label="Search skills" placeholder="Search skills…" value={query} onChange={q => update({ q })} /> : undefined,
    list: <div className="carrier-message-scroll" aria-label="Skill library" aria-busy={loading}>
      <ManagedList compact catalog={managed.catalog} query={query} publisher={managedPublisher} resource={managedId} onSelect={selectManaged} />
      {initialLoading ? <PageLoading label="Loading skills…" size="panel" /> : <>
        {rows.map(row => <Button key={`${row.source}/${row.name}`} variant="ghost" className="carrier-message-row"
          aria-label={`${row.name} · ${row.source}`} aria-pressed={Boolean(selection && (row.draft?.id === selection || catalog?.releases.some(release => release.reference === selection && release.name === row.name && release.source_id === row.source)))}
          onPress={() => setSelection(row.draft?.id ?? row.release!.reference)}>
          <span className="carrier-row-title">{row.name}</span><span className="carrier-row-preview">{row.source} · {row.draft ? row.draft.editable ? 'Working draft' : 'Read only' : `Version ${row.release?.version}`}</span>
        </Button>)}
        {!rows.length && !managed.catalog?.items.some(row => managedMatches(row, query)) && <EmptyState headingLevel={2} icon="box" title={query ? 'No matching skills' : 'No discovered skills'}
          description={query ? 'Try another name or source.' : 'Register a skill directory or collection to get started.'} />}
      </>}
    </div>,
    reader: adding ? <ResourceAdd kind="skills" catalog={managed.catalog} request={managed.request} initialPath={parameters.get("path") ?? ""} onAdded={async row => { selectManaged(row); await managed.refresh() }} /> : managedImport ? <ManagedImport initialPath={parameters.get('path') ?? ''} kind="skills" catalog={managed.catalog} request={managed.request} onImported={async row => { await managed.refresh(); selectManaged(row) }} />
      : managedId && wrongManagedStore ? <div className="managed-reader"><h2>Another skill store</h2><p>This link belongs to another manager store. Current store: {managed.catalog?.store}</p></div>
      : managedItem && managed.catalog ? <ManagedDetail key={`${managed.catalog.store_id}/${managedPublisher}/${managedId}`} kind="skills" agents={agents} item={managedItem} catalog={managed.catalog} request={managed.request} onChanged={async () => { await managed.refresh(); await refresh() }} />
      : managedId ? <div className="managed-reader"><h2>Managed skill unavailable</h2><p>{managed.error || 'Refresh the library or select another managed copy.'}</p></div>
      : foreignStore ? <div className="carrier-reader-empty"><EmptyState headingLevel={2} title="Skill belongs to another store" description={`This assignment points to ${parameters.get('store')}. The current library is ${catalog?.store}. Open that store in Skill Manager to inspect it.`} /></div>
      : selection && catalog ? <SkillDetail key={`${catalog.store}/${selection}`} agents={agents} catalog={catalog} selection={selection} onSelect={setSelection} onRefresh={refresh}
        onCopy={path => update({ import: 'add', path, entry: '', view: '' })} /> : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="box" title="Select a skill"
        description="Review a package, edit a draft, or publish an immutable release for future sessions." /></div>,
  })}
    <Dialog title="Create a draft" className="resource-compact-dialog" bodyClassName="resource-dialog-fields" open={creating}
      trigger={<Button hidden className="resource-dialog-trigger">Create skill draft dialog</Button>} onOpenChange={open => { if (!open && !busy) closeDialog() }}
      footer={<><Button variant="ghost" disabled={busy} onPress={closeDialog}>Cancel</Button><Button disabled={disabled || !source || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)} loading={busy} onPress={createDraft}>Create skill draft</Button></>}>
      <Select label="Writable source" value={source} onChange={setSource} disabled={disabled} options={[{ id: '', label: 'Select a source' }, ...(catalog?.sources.filter(row => row.writable).map(row => ({ id: row.id, label: row.label || row.id })) ?? [])]} />
      <TextField label="Skill name" value={name} disabled={busy} onChange={event => setName(event.target.value)} required hint="Use lowercase words separated by hyphens." />
      <details className="resource-detail-disclosure" open={(catalog?.sources.find(row => row.id === source)?.paths.length ?? 0) > 1 || undefined}><summary>Collection location</summary>
        <TextField label="Collection root" value={root} disabled={busy} onChange={event => setRoot(event.target.value)} hint="Choose a root when the source has multiple directories." /></details>
      {error && <p role="alert">{error}</p>}
    </Dialog>
    <Dialog title="Registered skill sources" className="resource-compact-dialog" open={sources}
      trigger={<Button hidden className="resource-dialog-trigger">Skill sources dialog</Button>} onOpenChange={open => { if (!open) closeDialog() }}
      footer={<Button variant="secondary" onPress={closeDialog}>Close</Button>}>
      <ResourceSources kind="skills" sources={catalog?.sources ?? []} request={agents.request} disabled={disabled} onChanged={refresh} />
    </Dialog>
  </>
}
