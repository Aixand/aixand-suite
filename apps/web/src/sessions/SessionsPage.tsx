import { useEffect, useRef, useState } from 'react'
import { Button, EmptyState, Icon, Popover, SearchField, Select } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { Profile, Provider, SavedSession } from '../agents/client'
import type { Project } from '../projects/model'
import type { WorkspaceRenderer } from '../agents/AgentWorkspace'
import { providerLabel } from '../agents/presentation'
import { PageLoading } from '../components/PageLoading'
import { messageTime } from '../carrier/CarrierMessageList'
import { SessionReader } from './SessionReader'
import { SessionForm } from './SessionForm'
import { useSessionLibrary } from './model'

export function SessionsPage({ agents: a, projects, navigate, route, workspace }: {
  agents: AgentsModel; projects: Project[]; navigate: (route: string) => void; route: string; workspace: WorkspaceRenderer
}) {
  const url = new URL(route, 'https://workspace.local/')
  const home = url.searchParams.get('home') ?? ''
  const cwd = url.searchParams.get('cwd') ?? ''
  const view = url.searchParams.get('view') ?? 'all'
  const query = url.searchParams.get('q') ?? ''
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  const parts = url.pathname.replace(/^\/agents\//, '').split('/').filter(Boolean)
  let identity = parts.length === 4 && ['codex', 'opencode'].includes(parts[1])
    ? { provider: parts[1] as Provider, profile: parts[2], id: parts[3] } : null
  if (identity) {
    try { identity.profile = decodeURIComponent(identity.profile); identity.id = decodeURIComponent(identity.id) }
    catch { identity = null }
  }
  const selectedKey = identity ? `${identity.provider}/${identity.profile}/${identity.id}` : ''
  const [loadedSession, setLoadedSession] = useState<SavedSession | null>(null)
  const [form, setForm] = useState<{ session?: SavedSession; customize?: boolean; profile?: Profile } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const library = useSessionLibrary(a, { ...(home ? { home } : {}), ...(cwd ? { cwd } : {}), view, query, offset })
  const data = library.data
  const selected = data?.sessions?.find((item) => item.key === selectedKey) ?? (loadedSession?.key === selectedKey ? loadedSession : null)
  const connected = a.status === 'connected'
  const initialProfile = a.catalog?.profiles.find(profile => profile.id === home)
  const primary = { label: 'New session', disabled: !connected || !a.catalog?.profiles.length, onPress: () => setForm({ profile: initialProfile }) }
  useEffect(() => { setForm(null) }, [route])
  function filters(patch: Record<string, string>) {
    const parameters = new URLSearchParams(url.searchParams)
    parameters.delete('offset')
    for (const [key, value] of Object.entries(patch)) { if (value) parameters.set(key, value); else parameters.delete(key) }
    navigate(`agents/sessions${parameters.size ? '?' + parameters.toString() : ''}`)
  }
  function select(session: SavedSession) {
    setLoadedSession(session)
    navigate(`agents/sessions/${session.provider}/${encodeURIComponent(session.profile)}/${encodeURIComponent(session.id)}${url.search}`)
  }
  function listRoute() { navigate(`agents/sessions${url.search}`); setForm(null) }
  const homes = data?.homes ?? a.catalog?.profiles ?? []
  const projectName = (path: string) => projects.find(project => project.path === path)?.name ?? path.split('/').at(-1) ?? path
  const homeName = homes.find(item => item.id === home)
  const filterSummary = [home ? homeName ? `${homeName.profile} · ${providerLabel(homeName.provider)}` : home : '', cwd ? projectName(cwd) : ''].filter(Boolean).join(' · ')
  const initialLoading = library.loading || !data && !library.error && a.status !== 'offline'
  const awaitingCatalog = initialLoading && !data
  const controls = <>
    <SearchField ref={search} label="Search sessions" placeholder="Search sessions…" value={query} onChange={value => filters({ q: value })} />
    <div className="session-list-filters">
      <Select label="Session status" hideLabel variant="subtle" value={view} onChange={value => filters({ view: value === 'all' ? '' : value })}
        options={[{ id: 'all', label: 'All sessions' }, { id: 'running', label: 'Running' }, { id: 'attention', label: 'Needs attention' }, { id: 'archived', label: 'Archived' }]} />
      <Popover title="Filter sessions" className="session-filter-popover" trigger={<Button iconOnly variant="ghost" size="sm"
        aria-label={`Filter sessions${filterSummary ? ', filters active' : ''}`}><Icon name="layers" />{filterSummary && <span className="session-filter-dot" />}</Button>}>
        <div className="session-filter-fields">
          <Select label="Profile" variant="subtle" value={home} onChange={value => filters({ home: value })}
            options={[{ id: '', label: 'All profiles' }, ...homes.map(item => ({ id: item.id, label: `${item.profile} · ${providerLabel(item.provider)}` })),
              ...(home && !homes.some(item => item.id === home) ? [{ id: home, label: home }] : [])]} />
          <Select label="Project" variant="subtle" value={cwd} onChange={value => filters({ cwd: value })}
            options={[{ id: '', label: 'All projects' }, ...[...new Set([...(data?.projects ?? []), ...(cwd ? [cwd] : [])])].map(path => ({ id: path, label: projectName(path), description: path }))]} />
          {filterSummary && <Button variant="ghost" size="sm" onPress={() => filters({ home: '', cwd: '' })}>Clear filters</Button>}
        </div>
      </Popover>
    </div>
    {filterSummary && <p className="session-filter-summary">{filterSummary}</p>}
  </>
  let previousDate = ''
  const list = <>
    <div className="carrier-message-scroll" aria-busy={initialLoading}>
      {(data?.sessions ?? []).map((session) => {
        const date = new Date(session.updatedAt).toDateString()
        const heading = date !== previousDate; previousDate = date
        return <div key={session.key}>
          {heading && <h2 className="carrier-date-group">{date === new Date().toDateString() ? 'Today' : new Date(session.updatedAt).toLocaleDateString()}</h2>}
          <Button variant="ghost" className="carrier-message-row" aria-pressed={session.key === selectedKey} onPress={() => select(session)}>
            <span className="carrier-row-top"><span className="carrier-row-sender">{session.profile} · {providerLabel(session.provider)}</span><time>{messageTime(new Date(session.updatedAt).toISOString())}</time></span>
            <span className="carrier-row-title">{session.title}</span><span className="carrier-row-preview">{projects.find((project) => project.path === session.cwd)?.name ?? session.cwd}</span>
            <span className="agent-session-state" data-state={session.state}>{session.state === 'running' ? 'Running' : session.state === 'attention' ? 'Needs attention' : session.archived ? 'Archived' : 'Saved'}</span>
          </Button>
        </div>
      })}
      {!data?.sessions?.length && (initialLoading ? <PageLoading label="Loading sessions…" size="panel" /> :
        <EmptyState headingLevel={2} icon="file-text" title={query ? 'No matching sessions' : 'No sessions here'} description={library.error || 'Saved sessions from your provider homes appear here.'} />)}
    </div>
    {!awaitingCatalog && <div className="carrier-pagination"><span>{data?.sessions?.length ? `${offset + 1}-${offset + data.sessions.length} of ${data.total}` : offset ? 'No sessions on this page' : '0 sessions'}</span>
      <Button variant="ghost" size="sm" iconOnly aria-label="Previous sessions" disabled={!offset || library.loading} onPress={() => filters({ offset: String(Math.max(0, offset - 25)) })}><Icon name="chevron-left" /></Button>
      <Button variant="ghost" size="sm" iconOnly aria-label="Next sessions" disabled={data?.nextOffset == null || library.loading} onPress={() => filters({ offset: String(data!.nextOffset) })}><Icon name="chevron-right" /></Button>
    </div>}
  </>
  const reader = form ? <SessionForm key={form.session?.key ?? 'new'} agents={a} projects={projects} initialProfile={form.profile} initialCwd={cwd || undefined}
    session={form.session} customize={form.customize} navigate={navigate} onClose={() => setForm(null)} />
    : identity ? <SessionReader key={selectedKey} agents={a} identity={identity} session={selected} navigate={navigate} onLoaded={setLoadedSession}
      onContinue={(session, customize) => setForm({ session, customize })} />
      : <div className="carrier-reader-empty"><EmptyState headingLevel={2} icon="file-text" title="Select a session" description="Read its transcript, resume it, or continue with another profile." /></div>
  return workspace({
    error: library.error || data?.errors?.join(' '),
    title: query ? 'Search results' : ({ all: 'All sessions', running: 'Running', attention: 'Needs attention', archived: 'Archived' }[view] ?? 'Sessions'),
    description: awaitingCatalog ? '' : data ? `${data.total} saved provider ${data.total === 1 ? 'conversation' : 'conversations'}` : 'Saved provider conversations', primary, selected: !!identity || !!form, onBack: listRoute, list, reader,
    actions: awaitingCatalog ? undefined : <Button iconOnly variant="ghost" size="sm" aria-label="Refresh sessions" disabled={!connected || library.loading} onPress={() => void library.refresh(true)}><Icon name="refresh-cw" /></Button>,
    controls: awaitingCatalog ? undefined : controls,
  })
}
