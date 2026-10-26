import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Dialog, DropdownMenu, EmptyState, Icon } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { WorkspaceRenderer } from '../agents/AgentWorkspace'
import { usePrompts } from './model'
import type { Details, Pack } from './model'
import { errorMessage, firstFile } from './presentation'
import type { PromptSelection } from './presentation'
import { PromptLibrary } from './PromptLibrary'
import { PromptDetail } from './PromptDetail'
import { PromptHistory, PromptProfiles } from './PromptUsage'
import { PageLoading } from '../components/PageLoading'
import { PromptApplications } from './Applications'
import { ResourceSources } from '../skills/Sources'
import { PromptUsageLinks } from '../agents/resources'
import './prompts.css'
import { ResourceAdd } from '../resources/sources'
import { ManagedDetail, ManagedImport, ManagedList, managedMatches, useManaged } from '../resources/managed'

type View = 'library' | 'assignments' | 'history' | 'applications'
export function PromptsPage({ agents, workspace, route, navigate }: {
  agents: AgentsModel; workspace: WorkspaceRenderer; route: string; navigate: (route: string) => void
}) {
  const p = usePrompts(agents)
  const managed = useManaged('prompts', agents)
  const parameters = new URLSearchParams(route.split('?')[1])
  const candidate = parameters.get('view')
  const view: View = candidate === 'assignments' || candidate === 'history' || candidate === 'applications' ? candidate : 'library'
  const search = parameters.get('q') ?? ''
  const packId = parameters.get('pack') ?? ''
  const promptName = parameters.get('prompt') ?? undefined
  const managedPublisher = parameters.get('publisher') ?? ''
  const managedId = parameters.get('managed') ?? ''
  const managedItem = managed.catalog?.items.find(row => row.publisher_id === managedPublisher && row.id === managedId)
  const adding = parameters.get('import') === 'add'
  const managedImport = parameters.get('import') === 'managed'
  const wrongManagedStore = Boolean(parameters.get('managedStore') && managed.catalog && parameters.get('managedStore') !== managed.catalog.store_id)
  function selectManaged(row: import('../resources/managed').ManagedStatus) {
    setViewerOpen(true)
    update({ publisher: row.publisher_id, managed: row.id, managedStore: managed.catalog?.store_id ?? '', import: '', path: '', pack: '', prompt: '', view: '' })
  }
  const selection = useMemo<PromptSelection | null>(() => packId ? { packId, prompt: promptName } : null, [packId, promptName])
  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(parameters)
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key) }
    navigate(`agents/prompts${next.size ? '?' + next.toString() : ''}`)
  }
  const [revisions, setRevisions] = useState<Record<string, string>>({})
  const [details, setDetails] = useState<Details | null>(null)
  const requestedFile = parameters.get('file') ?? ''
  const [file, setFile] = useState(requestedFile)
  useEffect(() => { if (requestedFile) setFile(requestedFile) }, [requestedFile])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sources, setSources] = useState(false)
  const [reload, setReload] = useState(0)
  const [viewerOpen, setViewerOpen] = useState(Boolean(selection))
  const menu = useRef<HTMLButtonElement>(null)
  const lastSelection = useRef(selection)
  const pack = p.catalog?.packs.find(row => row.id === selection?.packId)
  const prompt = pack?.prompts.find(row => row.name === selection?.prompt)
  const initialLoading = !p.catalog && !p.error && p.status !== 'offline'
  const preferredRevisions = pack ? { ...revisions, [pack.name]: pack.id } : revisions

  useEffect(() => {
    if (lastSelection.current !== selection) { setDetails(null); setFile(''); setViewerOpen(Boolean(selection)); lastSelection.current = selection }
    if (!selection || !p.connected) return
    let active = true
    setError('')
    void p.request<Details>('prompts-show', selection).then(value => {
      if (!active) return
      setDetails(value)
      setFile(current => current && (current === 'pack.json' || current in value.files) ? current : firstFile(value, selection.prompt))
    }).catch((cause: unknown) => { if (active) setError(errorMessage(cause)) })
    return () => { active = false }
  }, [selection, p.connected, p.request, pack?.digest, pack?.status, reload])
  // Keep the selected revision in the tree when moving to a secondary view.
  useEffect(() => { if (pack) setRevisions(current => current[pack.name] === pack.id ? current : { ...current, [pack.name]: pack.id }) }, [pack])
  function inspect(row: Pack, name?: string) {
    setViewerOpen(true); setError(''); setNotice('')
    update({ view: '', pack: row.id, prompt: name ?? '', file: '', publisher: '', managed: '', managedStore: '', import: '' })
  }
  async function changed(message: string) { setNotice(message); await p.refresh() }
  async function saved(updated: Details) {
    if (selection?.packId === updated.entry.id) setDetails(updated)
    await changed('Draft saved.')
  }
  function changeView(next: View) {
    setNotice(''); setViewerOpen(next !== 'library')
    update({ view: next === 'library' ? '' : next, publisher: '', managed: '', managedStore: '', import: '' })
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.carrier-reader h2')?.focus({ preventScroll: true }))
  }
  const reader = adding ? <ResourceAdd kind="prompts" catalog={managed.catalog} request={managed.request} initialPath={parameters.get("path") ?? ""} onAdded={async row => { selectManaged(row); await managed.refresh() }} /> : managedImport ? <ManagedImport kind="prompts" catalog={managed.catalog} request={managed.request} onImported={async row => { await managed.refresh(); selectManaged(row) }} />
    : managedId && wrongManagedStore ? <div className="managed-reader"><h2>Another prompt store</h2><p>This link belongs to another manager store. Current store: {managed.catalog?.store}</p></div>
    : managedItem && managed.catalog ? <ManagedDetail key={`${managed.catalog.store_id}/${managedPublisher}/${managedId}`} kind="prompts" item={managedItem} catalog={managed.catalog} request={managed.request} onChanged={async () => { await managed.refresh(); await p.refresh() }} />
    : managedId ? <div className="managed-reader"><h2>Managed prompt unavailable</h2><p>{managed.error || 'Refresh the library or select another managed copy.'}</p></div>
    : initialLoading ? <PageLoading label="Loading prompts…" /> : view === 'library' ? selection && pack ? <PromptDetail
    onManagedCopy={pack.kind === "draft" && pack.path ? () => update({ import: "add", path: pack.path!, managed: "", publisher: "", pack: "", view: "" }) : undefined}
    pack={pack} prompt={prompt} selection={selection} details={details} file={file}
    onFile={value => { setFile(value); update({ file: value }) }} packs={p.catalog?.packs ?? []} consumers={p.catalog?.consumers ?? []}
    usage={<PromptUsageLinks pack={pack} prompt={selection.prompt} consumers={p.catalog?.consumers ?? []} profiles={agents.catalog?.profiles ?? []} />}
    initialBindingTarget={parameters.get('consumer') && parameters.get('profile') ? `${parameters.get('consumer')}/${parameters.get('profile')}` : undefined}
    request={p.request} connected={p.connected} error={error} onSaved={saved} onChanged={changed}
    onRetry={() => setReload(current => current + 1)}
    onRevision={next => inspect(next, next.prompts.find(row => row.name === selection.prompt)?.name ?? next.prompts[0]?.name)} />
    : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="file-text" title={selection ? 'Prompt unavailable' : 'Select a prompt'}
      description={selection ? 'Refresh the library or choose another prompt.' : 'Choose a prompt to read its content.'} /></div>
    : <div className="prompts-pane-scroll"><h2 className="prompts-secondary-title" tabIndex={-1}>
      {view === 'assignments' ? 'Profile assignments' : view === 'applications' ? 'Applications' : 'Used in sessions'}</h2>
      {(view === 'assignments' || view === 'history') && parameters.get('profile') && <div className="prompts-context-filter"><p className="prompts-note">{parameters.get('thread') ? 'Session' : 'Profile'}: {parameters.get('profile')}{parameters.get('thread') ? ` · ${parameters.get('thread')}` : ''}</p>
        <Button variant="ghost" size="sm" onPress={() => update({ profile: '', consumer: '', provider: '', thread: '' })}>{view === 'history' ? 'Show all sessions' : 'Show all assignments'}</Button></div>}

      {view === 'applications' ? <PromptApplications applications={p.catalog?.applications ?? []} sources={p.catalog?.sourceRegistrations ?? []}
        request={p.request} disabled={!p.connected} onChanged={p.refresh} /> : view === 'assignments'
        ? <PromptProfiles catalog={p.catalog} profiles={agents.catalog?.profiles ?? []} filterProfile={parameters.get('profile') ?? ''} filterConsumer={parameters.get('consumer') ?? ''} consumers={p.catalog?.consumers ?? []} request={p.request} connected={p.connected} onChanged={changed} />
        : <PromptHistory filterProfile={parameters.get('profile') ?? ''} filterThread={parameters.get('thread') ?? ''} filterProvider={parameters.get('provider') ?? ''} catalog={p.catalog} request={p.request} connected={p.connected} />}
    </div>
  return <>
    {workspace({ title: 'Prompts', description: view === 'library' ? 'Shared instructions and immutable releases' : view === 'assignments' ? 'Assignments' : view === 'history' ? 'Used in sessions' : 'Applications',
      primary: { label: 'Add prompt', disabled: !p.connected, onPress: () => update({ import: 'add', path: '', managed: '', publisher: '', pack: '', view: '' }) },
      selected: adding || managedImport || Boolean(managedId) || view !== 'library' || Boolean(selection && viewerOpen), onBack: () => { update({ view: '', publisher: '', managed: '', managedStore: '', import: '' }); setViewerOpen(false) },
      error: p.error || managed.error, notice,
      actions: <>
        <Button variant="ghost" size="sm" iconOnly aria-label={p.loading ? 'Refreshing prompts' : 'Refresh prompts'} disabled={!p.connected || p.loading}
          onPress={() => { void p.refresh(); void managed.refresh() }}><Icon name="refresh-cw" /></Button>
        <DropdownMenu label="Prompts menu" trigger={<Button ref={menu} variant="ghost" size="sm" iconOnly aria-label="Prompts menu"><Icon name="ellipsis" /></Button>}
          items={[{ id: 'library', label: 'Prompt library' }, { id: 'assignments', label: 'Assignments' }, { id: 'applications', label: 'Applications' },
            { id: 'history', label: 'Used in sessions' }, { id: 'import', label: 'Import managed copy' }, { id: 'sources', label: 'Registered sources' }]}
          onAction={id => { if (id === 'sources') setSources(true); else if (id === 'import') update({ import: 'managed', managed: '', publisher: '', pack: '', view: '' }); else changeView(id as View) }} />
      </>,
      list: <PromptLibrary packs={p.catalog?.packs ?? []} search={search} onSearch={q => update({ q })} revisions={preferredRevisions}
        managed={<ManagedList catalog={managed.catalog} query={search} publisher={managedPublisher} resource={managedId} onSelect={selectManaged} />}
        managedCount={managed.catalog?.items.filter(row => managedMatches(row, search)).length ?? 0}
        selection={view === 'library' ? selection : null} loading={p.loading || p.status === 'connecting'} onView={inspect} />,
      reader,
    })}
      <Dialog
        trigger={
          <Button hidden className="prompts-dialog-trigger">
            Registered sources
          </Button>
        }
        title="Registered sources"
        className="prompts-dialog"
        bodyClassName="prompts-form"
        open={sources}
        onOpenChange={(open) => {
          setSources(open)
          if (!open) requestAnimationFrame(() => menu.current?.focus())
        }}
        footer={(close) => (
          <Button variant="secondary" onPress={close}>
            Close
          </Button>
        )}
      >
        <ResourceSources kind="prompts" sources={p.catalog?.sourceRegistrations ?? []} request={p.request} disabled={!p.connected} onChanged={p.refresh} />
        {p.catalog?.sources.map((source) => (
          <div key={source.id}>
            <div className="prompts-pack-heading">
              <strong>{source.label}</strong>
              <Badge
                tone={source.status === 'available' ? 'neutral' : 'warning'}
              >
                {source.status}
              </Badge>
            </div>
            {source.error && (
              <p className="prompts-source-error">{source.error}</p>
            )}
          </div>
        ))}
        {!p.catalog?.sources.length && <p>No registered sources.</p>}
        {p.catalog && (
          <p className="prompts-note">
            Last checked {new Date(p.catalog.checked_at).toLocaleString()}
          </p>
        )}
      </Dialog>
  </>
}
