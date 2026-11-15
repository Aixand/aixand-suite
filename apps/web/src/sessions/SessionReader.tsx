import { useEffect, useRef, useState } from 'react'
import { Button, DropdownMenu, EmptyState, Icon, Popover, SearchField, Toolbar } from 'bbb-design'
import type { AgentsModel } from '../agents/model'
import type { SavedSession, SessionTranscript } from '../agents/client'
import { providerLabel } from '../agents/presentation'
import { MessageContent } from '../chats/MessageContent'
import { ActivityGroup, transcriptEntries } from '../chats/ActivityGroup'
import { PageLoading } from '../components/PageLoading'
import { SessionInstructions } from './SessionInstructions'

export function SessionReader({ agents: a, session, identity, navigate, onContinue, onLoaded, onBack }: {
  agents: AgentsModel; session?: SavedSession | null; identity: Pick<SavedSession, 'provider' | 'profile' | 'id'>
  navigate: (route: string) => void; onContinue: (session: SavedSession, customize: boolean) => void
  onLoaded?: (session: SavedSession) => void; onBack?: () => void
}) {
  const api = useRef(a); api.current = a
  const loaded = useRef(onLoaded); loaded.current = onLoaded
  const [history, setHistory] = useState<SessionTranscript | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [raw, setRaw] = useState(false)
  const [search, setSearch] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const detailsTrigger = useRef<HTMLButtonElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const previousKey = useRef('')
  const selected = session ?? history?.session
  const key = `${identity.provider}/${identity.profile}/${identity.id}`
  const online = a.status === 'connected'

  async function read(before?: number) {
    if (api.current.status !== 'connected') return
    const token = ++generation.current
    setLoading(true); setError('')
    try {
      const result = await api.current.request<SessionTranscript>('session-transcript', { ...identity, ...(before != null ? { before } : {}) })
      if (generation.current !== token) return
      setHistory((previous) => before != null && previous ? { ...result, items: [...result.items, ...previous.items] } : result)
      loaded.current?.(result.session)
    } catch (cause) {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : 'Transcript could not be loaded.')
    } finally { if (generation.current === token) setLoading(false) }
  }
  useEffect(() => {
    if (previousKey.current !== key) {
      setHistory(null); setError(''); setRaw(false); setSearch(null); setDetailsOpen(false); setInstructionsOpen(false)
      scroll.current?.scrollTo(0, 0)
      previousKey.current = key
    }
    if (online) void read()
    return () => { generation.current += 1 }
  }, [key, online])
  useEffect(() => {
    if (!online) return
    if (session?.state !== 'running') return
    const timer = setInterval(() => { if (!document.hidden && history?.nextBefore == null) void read() }, 5000)
    return () => clearInterval(timer)
  }, [online, key, session?.state, history?.nextBefore])
  const items = (history?.items ?? []).filter((item) => !search || item.text.toLowerCase().includes(search.toLowerCase()))
  return <>
    <Toolbar label="Session actions" className="carrier-reader-toolbar">
      {onBack && <Button variant="ghost" size="sm" onPress={onBack}><Icon name="chevron-left" />Profile</Button>}
      {selected?.terminalId ? <Button variant="secondary" size="sm" onPress={() => navigate(`terminals/${encodeURIComponent(selected.terminalId!)}`)}>Open terminal</Button>
        : <Button variant="secondary" size="sm" disabled={!online || !selected || selected.archived || selected.canResume === false} onPress={() => selected && onContinue(selected, false)}>Resume</Button>}
      <DropdownMenu label="More session actions" trigger={<Button iconOnly variant="ghost" size="sm" aria-label="More session actions"><Icon name="ellipsis" /></Button>}
        items={[{ id: 'continue', label: 'Continue with…', disabled: !online || !selected || !selected.canContinue || selected.archived }, { id: 'search', label: 'Search transcript' }, { id: 'raw', label: raw ? 'View conversation' : 'View raw records' },
          { id: 'refresh', label: 'Refresh transcript', disabled: !online || loading }, { id: 'copy', label: 'Copy session ID' }]}
        onAction={(action) => {
          if (action === 'continue') { if (selected) onContinue(selected, true) }
          else if (action === 'raw') setRaw(!raw)
          else if (action === 'search') setSearch(search === null ? '' : null)
          else if (action === 'refresh') void read()
          else void navigator.clipboard.writeText(selected?.nativeId ?? identity.id).catch(() => setError('Unable to copy the session ID.'))
        }} />
    </Toolbar>
    {search !== null && <div className="session-reader-search"><SearchField label="Search transcript" value={search} onChange={setSearch} autoFocus /></div>}
    <div className="carrier-reader-scroll" ref={scroll}>
      <header className="agent-session-heading"><div><h2 tabIndex={-1}>{selected?.title ?? 'Session transcript'}</h2>
      <p className="carrier-muted">{identity.profile} · {providerLabel(identity.provider)}{selected ? ` · ${selected.cwd.split('/').at(-1)}` : ''}</p></div>
      {selected && <Popover title="Session details" open={detailsOpen} onOpenChange={setDetailsOpen} trigger={<Button ref={detailsTrigger} iconOnly variant="ghost" size="sm" aria-label="Session details"><Icon name="info" /></Button>}><div className="session-details"><dl>
        <dt>Project directory</dt><dd>{selected.cwd}</dd><dt>Profile home</dt><dd>{selected.home}</dd>
        <dt>Recorded login</dt><dd>{selected.auth ?? 'Provider-managed login · account identity not recorded'}</dd>
        <dt>Saved instructions</dt><dd><Button className="session-instructions-trigger" variant="ghost" size="sm" onPress={() => { setDetailsOpen(false); setInstructionsOpen(true) }}>Inspect saved instructions</Button></dd>
        <dt>Session ID</dt><dd>{selected.nativeId ?? selected.id}</dd><dt>Last activity</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
        <dt>Associated runs</dt><dd>{selected.runIds?.join(', ') || 'No managed run linked'}</dd>
        {selected.archived && <><dt>History</dt><dd>Archived</dd></>}
      </dl></div></Popover>}</header>
      {error && <p className="carrier-error" role="alert">{error}</p>}
      {history?.error && <p className="carrier-muted" role="status">{history.error}</p>}
      {loading && !history ? <PageLoading label="Loading transcript…" size="panel" /> : <>
        {history?.nextBefore != null && <Button variant="ghost" size="sm" disabled={!online || loading} loading={loading}
          onPress={() => void read(history.nextBefore!)}>Load earlier messages</Button>}
        <div className="session-transcript">
          {raw ? items.map((item) => <details className="session-records" key={item.id}><summary>{item.type} · {item.id}</summary><pre>{item.raw ?? item.text}</pre></details>)
            : transcriptEntries(items).map((entry) => entry.kind === 'activity' ? <ActivityGroup key={entry.items[0].id} items={entry.items} active={false} />
              : <section key={entry.item.id} aria-label={entry.item.type === 'userMessage' ? 'User message' : 'Assistant message'}>
                <div className="session-message-heading"><strong>{entry.item.type === 'userMessage' ? 'You' : 'Assistant'}</strong>
                  {'timestamp' in entry.item && typeof entry.item.timestamp === 'string' && <time dateTime={entry.item.timestamp}>{new Date(entry.item.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}</div>
                <MessageContent text={entry.item.text} />
              </section>)}
          {history && !items.length && <EmptyState headingLevel={3} icon="file-text" title={search ? 'No matching messages' : 'No transcript messages available'}
            description={history.partial ? 'This provider could not supply a complete transcript.' : search ? 'Try another search.' : 'This session has no recorded conversation messages.'} />}
        </div>
        {!!items.length && <Button variant="ghost" size="sm" onPress={() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })}>Jump to latest</Button>}
      </>}
    </div>
    <SessionInstructions agents={a} identity={{ ...identity, id: selected?.nativeId ?? identity.id }} open={instructionsOpen} onOpenChange={open => { setInstructionsOpen(open); if (!open) requestAnimationFrame(() => detailsTrigger.current?.focus()) }} />
  </>
}
